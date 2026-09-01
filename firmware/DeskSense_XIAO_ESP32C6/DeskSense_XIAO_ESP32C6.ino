/*
 * DeskSense Native OS (v1.6.0) for Seeed XIAO ESP32-C6 + MR60BHA2 Kit
 *
 * Funkcjonalność:
 * 1. Natywny dekoder ramek binarnych MR60BHA2 (ESPHome/Seeed protocol).
 * 2. Emisja czystych, sformatowanych linii tekstowych ESPHome ('Entity' >> value).
 * 3. Bezpośrednie sterowanie diodą WS2812 RGB (GPIO1) przez komendy SET:LED=R,G,B,BRI.
 * 4. Obsługa czujnika oświetlenia BH1750 na I2C (SDA=22, SCL=23).
 * 5. Zerowy narzut sieciowy, brak Wi-Fi, błyskawiczna latencja, zero zakłóceń.
 * 6. Fuzja obecnosci (dwukierunkowa):
 *    - rawPresence=ON + brak bio -> wymuszamy OFF (kompensacja zaczepienia radaru o fotel),
 *    - rawPresence=OFF + bio zyje -> BLOKUJEMY OFF (ochrona migotania sprzętowego modulu).
 * 7. Heartbeat 'DeskSense Device FW=... UPTIME=...s TEMP=...C' — apka pokazuje
 *    realna wersje firmware i telemetrie ukladu.
 */

#include <Arduino.h>
#include <HardwareSerial.h>
#include <Wire.h>
#include <Adafruit_NeoPixel.h>

#define FIRMWARE_VERSION "1.8.0"

// --- Piny i konfiguracja sprzętowa ---
#define RADAR_RX_PIN    17
#define RADAR_TX_PIN    16
#define RADAR_BAUD      115200

#define RGB_LED_PIN     1
#define NUM_LEDS        1

#define I2C_SDA_PIN     22
#define I2C_SCL_PIN     23
#define BH1750_ADDR     0x23

HardwareSerial mmWaveSerial(1);
Adafruit_NeoPixel strip(NUM_LEDS, RGB_LED_PIN, NEO_GRB + NEO_KHZ800);

// --- Bufor odbiorczy ramki binarnej radaru ---
#define RX_RING_SIZE 1024
uint8_t rxRing[RX_RING_SIZE];
size_t rxHead = 0;

// Bufor komend z PC (DeskSense) — statyczny, bez alokacji heap
#define PC_CMD_MAX 128
char pcCmdBuf[PC_CMD_MAX];
uint8_t pcCmdLen = 0;

// --- Fuzja obecnosci (v1.8.0 — Lightning-Fast Departure & Solid Seated Protection) ---
#define FUSION_BIO_MIN_FRAMES  1       // ile ramek bio w oknie dowodzi zycia
#define FUSION_BIO_WINDOW_MS   1500UL  // okno wiarygodnosci bio (1.5 s)
#define FUSION_BIO_GAP_MS      2000UL  // podtrzymanie obecnosci przy bezruchu przez 2.0 s

// --- Bramki fizjologiczne człowieka ---
#define BIO_HR_MIN            38.0f   // minimalne ludzkie tętno
#define BIO_HR_MAX           210.0f   // maksymalne ludzkie tętno
#define BIO_RPM_MIN            3.0f   // minimalny aktywny oddech (spokojny oddech podczas czytania to 4-8 RPM)
#define BIO_RPM_MAX           45.0f   // maksymalny oddech

bool rawPresence = false;              // surowy bit obecności z modulu radaru
unsigned long lastBioEvidenceMs = 0;   // ostatnio potwierdzona wiarygodna bio
bool fusedOff = false;                 // fuzja aktualnie wymusza OFF mimo raw=ON

// Pierscienie probek dla dowodow zywotnosci
unsigned long bioFrameTimes[8];
uint8_t bioFrameIdx = 0;

// Ostatnio wyemitowane stany (do dedup i optymalizacji strumienia)
bool effPresence = false;
bool effInitialized = false;
float lastDistance = -1.0f;
float lastHeartRate = -1.0f;
float lastBreathRate = -1.0f;
uint32_t lastTargets = 999;
float lastLux = -1.0f;

unsigned long lastPresenceEmit = 0;
unsigned long lastPresenceEval = 0;
unsigned long lastDistanceEmit = 0;
unsigned long lastHeartEmit = 0;
unsigned long lastBreathEmit = 0;
unsigned long lastTargetsEmit = 0;
unsigned long lastLuxRead = 0;
unsigned long lastDevInfoEmit = 0;

bool bh1750Available = false;

// --- Suma kontrolna XOR z inwersją (~XOR) ---
static inline uint8_t calcChecksum(const uint8_t *data, size_t len) {
  uint8_t cs = 0;
  for (size_t i = 0; i < len; i++) {
    cs ^= data[i];
  }
  return (uint8_t)(~cs);
}

// --- Bezpośrednie sterowanie diodą WS2812 ---
void applyLed(uint8_t r, uint8_t g, uint8_t b, uint8_t brightness) {
  strip.setBrightness(constrain(brightness, 0, 100));
  strip.setPixelColor(0, strip.Color(r, g, b));
  strip.show();
}

void handlePcCommand(const char *cmd, uint8_t len) {
  if (len == 0) return;

  // SET:LED=R,G,B,BRI — sterowanie dioda WS2812
  if (len > 8 && strncmp(cmd, "SET:LED=", 8) == 0) {
    int r = 0, g = 0, b = 0, bri = 25;
    // Parsowanie wartosci CSV recznie (bez String::substring)
    const char *p = cmd + 8;
    r = atoi(p);
    p = strchr(p, ',');
    if (p) { g = atoi(++p); p = strchr(p, ','); }
    if (p) { b = atoi(++p); p = strchr(p, ','); }
    if (p) { bri = atoi(++p); }
    applyLed((uint8_t)constrain(r, 0, 255),
             (uint8_t)constrain(g, 0, 255),
             (uint8_t)constrain(b, 0, 255),
             (uint8_t)constrain(bri, 0, 100));
    return;
  }

  if (len == 10 && strncasecmp(cmd, "CMD:REBOOT", 10) == 0) {
    delay(50);
    ESP.restart();
    return;
  }

  // Przekazanie komendy konfiguracyjnej do radaru
  mmWaveSerial.write((const uint8_t *)cmd, len);
  mmWaveSerial.write('\n');
}

// --- Dowody zywotnosci (v1.8.0) ---
void noteBioFrame(unsigned long now) {
  bioFrameTimes[bioFrameIdx] = now;
  bioFrameIdx = (bioFrameIdx + 1) & 7;
  uint8_t recent = 0;
  for (uint8_t i = 0; i < 8; i++) {
    if (now - bioFrameTimes[i] <= FUSION_BIO_WINDOW_MS) recent++;
  }
  if (recent >= FUSION_BIO_MIN_FRAMES) {
    lastBioEvidenceMs = now;
  }
}

unsigned long lastRadarPacketMs = 0;

// --- Fuzja obecnosci: jedyny punkt emisji 'Person Information' ---
// rawPresence = to, co mowi modul radaru; effPresence = to, co wysylamy do PC.
// Fuzja ochronna (v1.8.0):
//   rawPresence=ON -> ZAWSZE obecny (zero sztucznego gaszenia po 1.5s bezruchu)
//   rawPresence=OFF + bio zyje -> blokujemy fałszywy OFF (ochrona przy spokojnym oglądaniu/siedzeniu)
void updatePresenceOutput(unsigned long now) {
  // Awaryjny watchdog: jesli przez ponad 8 sekund brak jakiegokolwiek pakietu UART z sensora
  if (lastRadarPacketMs > 0 && (now - lastRadarPacketMs > 8000)) {
    rawPresence = false;
  }
  bool eff = rawPresence;

  bool bioAlive = (lastBioEvidenceMs > 0) && (now - lastBioEvidenceMs <= FUSION_BIO_GAP_MS);

  // Ochrona obecności: jeśli radar sprzętowo gubi klatkę, ale biometria jeszcze żyje
  if (!eff && bioAlive) {
    eff = true;
  }
  fusedOff = false;

  if (!effInitialized || eff != effPresence || (now - lastPresenceEmit >= 2000)) {
    effPresence = eff;
    effInitialized = true;
    lastPresenceEmit = now;
    Serial.printf("'Person Information' >> %s\r\n", eff ? "ON" : "OFF");
  }
}

// --- Dekoder ramek binarnych MR60BHA2 ---
void processRadarPayload(uint16_t type, const uint8_t *payload, size_t len) {
  unsigned long now = millis();
  lastRadarPacketMs = now;

  switch (type) {
    case 0x0F09: { // Obecność człowieka (People Exist)
      if (len >= 2) {
        uint16_t val = (uint16_t)(payload[0] | (payload[1] << 8));
        rawPresence = (val != 0);
        updatePresenceOutput(now);
      }
      break;
    }

    case 0x0A16: { // Dystans klatki piersiowej [u32 flag LE][float distance_cm LE]
      if (len >= 8) {
        uint32_t flag = (uint32_t)(payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24));
        if (flag != 0) {
          float dist = 0.0f;
          memcpy(&dist, &payload[4], sizeof(float));
          if (dist > 0.0f && dist <= 200.0f) {
            if (fabs(dist - lastDistance) >= 0.5f || (now - lastDistanceEmit >= 100)) {
              lastDistance = dist;
              lastDistanceEmit = now;
              Serial.printf("'Distance to detection object' >> %.2f cm\r\n", dist);
            }
          } else if (lastDistance > 0.0f) {
            lastDistance = 0.0f;
            lastDistanceEmit = now;
            Serial.println("'Distance to detection object' >> 0.00 cm");
          }
        }
      }
      updatePresenceOutput(now);
      break;
    }

    case 0x0A15: { // Tętno (Heart Rate)
      if (len >= 4) {
        float bpm = 0.0f;
        memcpy(&bpm, payload, sizeof(float));
        if (bpm >= BIO_HR_MIN && bpm <= BIO_HR_MAX) {
          noteBioFrame(now);
          if (fabs(bpm - lastHeartRate) >= 1.0f || (now - lastHeartEmit >= 1000)) {
            lastHeartRate = bpm;
            lastHeartEmit = now;
            Serial.printf("'Real-time heart rate' >> %.0f bpm\r\n", bpm);
          }
        }
      }
      updatePresenceOutput(now);
      break;
    }

    case 0x0A14: { // Oddech (Respiratory Rate)
      if (len >= 4) {
        float rpm = 0.0f;
        memcpy(&rpm, payload, sizeof(float));
        if (rpm >= BIO_RPM_MIN && rpm <= BIO_RPM_MAX) {
          noteBioFrame(now);
          if (fabs(rpm - lastBreathRate) >= 1.0f || (now - lastBreathEmit >= 1000)) {
            lastBreathRate = rpm;
            lastBreathEmit = now;
            Serial.printf("'Real-time respiratory rate' >> %.0f\r\n", rpm);
          }
        }
      }
      updatePresenceOutput(now);
      break;
    }

    case 0x0A04:
    case 0x0A08: { // Liczba celów (Target Number)
      if (len >= 4) {
        uint32_t targets = (uint32_t)(payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24));
        if (targets != lastTargets || (now - lastTargetsEmit >= 2000)) {
          lastTargets = targets;
          lastTargetsEmit = now;
          Serial.printf("'Target Number' >> %u\r\n", (unsigned int)targets);
        }
      }
      break;
    }
  }
}

// --- Odczyt bufora kołowego i wyodrębnianie ramek SOF 0x01 ---
void parseRadarStream() {
  while (rxHead >= 8) {
    if (rxRing[0] != 0x01) {
      // Szukanie początku następnej ramki
      size_t nextSof = 1;
      while (nextSof < rxHead && rxRing[nextSof] != 0x01) {
        nextSof++;
      }
      memmove(rxRing, &rxRing[nextSof], rxHead - nextSof);
      rxHead -= nextSof;
      continue;
    }

    uint16_t dataLen = (uint16_t)((rxRing[3] << 8) | rxRing[4]);
    uint16_t frameType = (uint16_t)((rxRing[5] << 8) | rxRing[6]);
    size_t totalLen = 8 + dataLen + 1;

    if (rxHead < totalLen) {
      // Czekamy na resztę pakietu
      return;
    }

    // Weryfikacja sumy kontrolnej nagłówka
    uint8_t expectedHeaderCs = calcChecksum(rxRing, 7);
    if (expectedHeaderCs != rxRing[7]) {
      // Błąd nagłówka — przesuń o 1 bajt
      memmove(rxRing, &rxRing[1], rxHead - 1);
      rxHead -= 1;
      continue;
    }

    // Weryfikacja sumy kontrolnej danych
    uint8_t expectedDataCs = calcChecksum(&rxRing[8], dataLen);
    if (expectedDataCs != rxRing[8 + dataLen]) {
      // Błąd danych — przesuń o 1 bajt
      memmove(rxRing, &rxRing[1], rxHead - 1);
      rxHead -= 1;
      continue;
    }

    // Ramka jest w 100% poprawna — przetwarzamy
    processRadarPayload(frameType, &rxRing[8], dataLen);

    // Usunięcie przetworzonej ramki z bufora
    memmove(rxRing, &rxRing[totalLen], rxHead - totalLen);
    rxHead -= totalLen;
  }
}

// --- Inicjalizacja sensora światła BH1750 ---
void initBH1750() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  delay(50);

  Wire.beginTransmission(BH1750_ADDR);
  Wire.write(0x01); // Power ON
  if (Wire.endTransmission() == 0) {
    delay(10);
    Wire.beginTransmission(BH1750_ADDR);
    Wire.write(0x10); // Continuous H-Resolution Mode
    if (Wire.endTransmission() == 0) {
      bh1750Available = true;
    }
  }
}

void readAndSendBH1750() {
  if (!bh1750Available) return;
  if (Wire.requestFrom(BH1750_ADDR, 2) == 2) {
    uint16_t raw = (uint16_t)((Wire.read() << 8) | Wire.read());
    float lux = raw / 1.2f;
    if (fabs(lux - lastLux) >= 0.5f || (millis() - lastLuxRead >= 2000)) {
      lastLux = lux;
      Serial.printf("'Seeed MR60BHA2 Illuminance' >> %.1f lx\r\n", lux);
    }
  }
}

void setup() {
  Serial.begin(115200);
  unsigned long start = millis();
  while (!Serial && (millis() - start < 1500)) {
    delay(10);
  }

  // Inicjalizacja diody statusowej WS2812 (domyślnie wyłączona)
  strip.begin();
  applyLed(0, 0, 0, 0);

  // Inicjalizacja BH1750
  initBH1750();

  // Inicjalizacja UART radaru
  mmWaveSerial.setRxBufferSize(1024);
  mmWaveSerial.setTxBufferSize(512);
  mmWaveSerial.begin(RADAR_BAUD, SERIAL_8N1, RADAR_RX_PIN, RADAR_TX_PIN);

  // Dowody zywotnosci liczymy od startu — radar "przyklejony" do fotela juz
  // przy bootcie wypadnie w OFF po FUSION_GAP_MS bez bio i bez netto ruchu.
  lastBioEvidenceMs = millis();

  Serial.printf("\n[DeskSense OS v%s initialized | SENSOR=MR60BHA2]\r\n", FIRMWARE_VERSION);
}

void loop() {
  // 1. Odbiór bajtów z radaru do bufora kołowego
  while (mmWaveSerial.available() > 0) {
    if (rxHead < RX_RING_SIZE) {
      rxRing[rxHead++] = (uint8_t)mmWaveSerial.read();
    } else {
      // Overflow: zachowaj nowsza polowe bufora (tam moze byc poczatek ramki)
      size_t keep = RX_RING_SIZE / 2;
      memmove(rxRing, &rxRing[RX_RING_SIZE - keep], keep);
      rxHead = keep;
    }
  }

  // 2. Parsowanie strumienia i emisja linii tekstowych
  parseRadarStream();

  // 3. Obsługa komend sterujących z PC (DeskSense)
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (pcCmdLen > 0) {
        // Trim trailing spaces
        while (pcCmdLen > 0 && pcCmdBuf[pcCmdLen - 1] == ' ') pcCmdLen--;
        pcCmdBuf[pcCmdLen] = '\0';
        handlePcCommand(pcCmdBuf, pcCmdLen);
        pcCmdLen = 0;
      }
    } else if (pcCmdLen < PC_CMD_MAX - 1) {
      pcCmdBuf[pcCmdLen++] = c;
    }
  }

  // 4. Pomiar światła co 1 sekundę
  unsigned long now = millis();
  if (now - lastLuxRead >= 1000) {
    lastLuxRead = now;
    readAndSendBH1750();
  }

  // 5. Heartbeat telemetrii ukladu co 5 s (apka parsuje FW/SENSOR/UPTIME/TEMP/LUX)
  if (now - lastDevInfoEmit >= 5000) {
    lastDevInfoEmit = now;
    if (bh1750Available && lastLux >= 0.0f) {
      Serial.printf("[DeskSense] DeskSense Device FW=%s SENSOR=MR60BHA2 UPTIME=%lus TEMP=%.1fC LUX=%.1f\r\n",
                    FIRMWARE_VERSION, (unsigned long)(now / 1000UL), temperatureRead(), lastLux);
    } else {
      Serial.printf("[DeskSense] DeskSense Device FW=%s SENSOR=MR60BHA2 UPTIME=%lus TEMP=%.1fC\r\n",
                    FIRMWARE_VERSION, (unsigned long)(now / 1000UL), temperatureRead());
    }
  }

  // 6. Regularna ewaluacja fuzji obecności co 50 ms (nawet gdy radar milczy po odejściu człowieka)
  if (now - lastPresenceEval >= 50) {
    lastPresenceEval = now;
    updatePresenceOutput(now);
  }

  delay(1);
}
