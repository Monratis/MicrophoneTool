/*
 * DeskSense Native OS v2.0.0 (24GHz Edition) for Seeed XIAO ESP32-C6 + 24GHz mmWave for XIAO (101010001)
 *
 * Funkcjonalność:
 * 1. Natywny dekoder ramek binarnych radaru 24GHz (LD2410 / Seeed 24GHz protocol, 256000 baud).
 * 2. Błyskawiczna emisja stanu obecności ('Person Information' >> ON/OFF) w 1–3 sekundy po wyjściu.
 * 3. Emisja dystansu wykrytego celu ('Distance to detection object' >> XX cm).
 * 4. Passthru komend z PC (DeskSense) bezpośrednio do radaru UART.
 * 5. Wbudowana dioda LED na XIAO ESP32-C6 (GPIO15) jako wskaźnik obecności/statusu.
 * 6. Heartbeat telemetrii: [DeskSense] DeskSense Device FW=2.0.0-24G SENSOR=SEEED_24GHZ UPTIME=...s TEMP=...C
 * 7. Zero Wi-Fi, zerowy narzut sieciowy, bezpośrednia komunikacja po USB-CDC.
 */

#include <Arduino.h>
#include <HardwareSerial.h>

#define FIRMWARE_VERSION "2.0.0-24G"
#define SENSOR_MODEL     "SEEED_24GHZ"

// --- Piny i konfiguracja sprzętowa (XIAO ESP32-C6 Shield) ---
#define RADAR_RX_PIN    17    // D7 na XIAO
#define RADAR_TX_PIN    16    // D6 na XIAO
#define RADAR_BAUD      256000

#define ONBOARD_LED_PIN 15    // Żółta dioda LED na XIAO ESP32-C6 (active LOW)

HardwareSerial mmWaveSerial(1);

// --- Bufor odbiorczy ramki binarnej radaru ---
#define RX_RING_SIZE 512
uint8_t rxRing[RX_RING_SIZE];
size_t rxHead = 0;

// Bufor komend z PC (DeskSense)
#define PC_CMD_MAX 128
char pcCmdBuf[PC_CMD_MAX];
uint8_t pcCmdLen = 0;

// Stan obecności i telemetria
bool presence = false;
bool presenceInitialized = false;
uint16_t lastDistanceCm = 0;
uint8_t lastTargetState = 0xFF;

unsigned long lastPresenceEmit = 0;
unsigned long lastDistanceEmit = 0;
unsigned long lastDevInfoEmit = 0;
unsigned long lastRadarPacketMs = 0;

// Sterowanie wbudowaną diodą LED
void setStatusLed(bool on) {
  pinMode(ONBOARD_LED_PIN, OUTPUT);
  digitalWrite(ONBOARD_LED_PIN, on ? LOW : HIGH); // Active LOW na XIAO C6
}

void handlePcCommand(const char *cmd, uint8_t len) {
  if (len == 0) return;

  if (len == 10 && strncasecmp(cmd, "CMD:REBOOT", 10) == 0) {
    delay(50);
    ESP.restart();
    return;
  }

  // Przekazanie komendy konfiguracyjnej do radaru UART (Passthru)
  mmWaveSerial.write((const uint8_t *)cmd, len);
  mmWaveSerial.write('\n');
}

// --- Przetwarzanie ramki raportu danych radaru 24GHz (LD2410 / Seeed 24GHz) ---
// Format ramki podstawowej:
// Nagłówek: 0xF4 0xF3 0xF2 0xF1
// Długość:  uint16_t LE
// Typ:      0x01 (Basic / Target data) or 0x02 (Engineering)
// Target state: 0x00 (brak), 0x01 (ruchomy), 0x02 (statyczny), 0x03 (ruchomy + statyczny)
// Moving distance: uint16_t LE (cm)
// Moving energy:   uint8_t (0-100)
// Still distance:  uint16_t LE (cm)
// Still energy:    uint8_t (0-100)
// Detection distance: uint16_t LE (cm)
// Ogon:     0xF8 0xF7 0xF6 0xF5
void processReportPayload(const uint8_t *p, size_t len) {
  if (len < 8) return;
  unsigned long now = millis();
  lastRadarPacketMs = now;

  uint8_t targetState = p[0];
  uint16_t moveDist = (uint16_t)(p[1] | (p[2] << 8));
  // uint8_t moveEnergy = p[3];
  uint16_t stillDist = (uint16_t)(p[4] | (p[5] << 8));
  // uint8_t stillEnergy = p[6];
  uint16_t detectDist = (len >= 9) ? (uint16_t)(p[7] | (p[8] << 8)) : 0;

  bool hasPerson = (targetState != 0x00);

  // Aktualizacja i emisja obecności
  if (!presenceInitialized || hasPerson != presence || (now - lastPresenceEmit >= 2000)) {
    presence = hasPerson;
    presenceInitialized = true;
    lastPresenceEmit = now;
    setStatusLed(presence);
    Serial.printf("'Person Information' >> %s\r\n", presence ? "ON" : "OFF");
  }

  // Wybór najbardziej miarodajnego dystansu
  uint16_t effectiveDist = detectDist > 0 ? detectDist : (stillDist > 0 ? stillDist : moveDist);
  if (effectiveDist > 0 && (abs((int)effectiveDist - (int)lastDistanceCm) >= 2 || (now - lastDistanceEmit >= 250))) {
    lastDistanceCm = effectiveDist;
    lastDistanceEmit = now;
    Serial.printf("'Distance to detection object' >> %.2f cm\r\n", (float)effectiveDist);
  } else if (!hasPerson && lastDistanceCm > 0 && (now - lastDistanceEmit >= 1000)) {
    lastDistanceCm = 0;
    lastDistanceEmit = now;
    Serial.println("'Distance to detection object' >> 0.00 cm");
  }
}

// --- Odczyt bufora kołowego dla protokołu 24GHz ---
void parseRadarStream() {
  while (rxHead >= 10) {
    // Szukanie nagłówka ramki danych (0xF4 0xF3 0xF2 0xF1)
    if (!(rxRing[0] == 0xF4 && rxRing[1] == 0xF3 && rxRing[2] == 0xF2 && rxRing[3] == 0xF1)) {
      // Szukanie kolejnego potencjalnego nagłówka
      size_t nextHdr = 1;
      while (nextHdr + 3 < rxHead) {
        if (rxRing[nextHdr] == 0xF4 && rxRing[nextHdr+1] == 0xF3 && rxRing[nextHdr+2] == 0xF2 && rxRing[nextHdr+3] == 0xF1) {
          break;
        }
        nextHdr++;
      }
      memmove(rxRing, &rxRing[nextHdr], rxHead - nextHdr);
      rxHead -= nextHdr;
      continue;
    }

    uint16_t dataLen = (uint16_t)(rxRing[4] | (rxRing[5] << 8));
    size_t totalFrameLen = 4 + 2 + dataLen + 4; // Header(4) + Len(2) + Payload(dataLen) + Tail(4)

    if (totalFrameLen > RX_RING_SIZE) {
      // Uszkodzona ramka — przesuń o 4 bajty
      memmove(rxRing, &rxRing[4], rxHead - 4);
      rxHead -= 4;
      continue;
    }

    if (rxHead < totalFrameLen) {
      // Czekamy na resztę pakietu
      return;
    }

    // Weryfikacja ogona (0xF8 0xF7 0xF6 0xF5)
    size_t tailIdx = 6 + dataLen;
    if (rxRing[tailIdx] == 0xF8 && rxRing[tailIdx+1] == 0xF7 && rxRing[tailIdx+2] == 0xF6 && rxRing[tailIdx+3] == 0xF5) {
      // Sprawdzenie typu danych (bajt 6: 0x01 / 0x02)
      if (dataLen >= 2) {
        processReportPayload(&rxRing[7], dataLen - 1);
      }
      memmove(rxRing, &rxRing[totalFrameLen], rxHead - totalFrameLen);
      rxHead -= totalFrameLen;
    } else {
      // Błąd ogona — przesuń o 1 bajt i szukaj dalej
      memmove(rxRing, &rxRing[1], rxHead - 1);
      rxHead -= 1;
    }
  }
}

void setup() {
  Serial.begin(115200);
  unsigned long start = millis();
  while (!Serial && (millis() - start < 1500)) {
    delay(10);
  }

  setStatusLed(false);

  // Inicjalizacja UART radaru 24GHz (256000 baud)
  mmWaveSerial.setRxBufferSize(512);
  mmWaveSerial.setTxBufferSize(256);
  mmWaveSerial.begin(RADAR_BAUD, SERIAL_8N1, RADAR_RX_PIN, RADAR_TX_PIN);

  Serial.printf("\n[DeskSense OS v%s initialized | SENSOR=%s]\r\n", FIRMWARE_VERSION, SENSOR_MODEL);
}

void loop() {
  // 1. Odbiór bajtów z radaru 24GHz do bufora kołowego
  while (mmWaveSerial.available() > 0) {
    if (rxHead < RX_RING_SIZE) {
      rxRing[rxHead++] = (uint8_t)mmWaveSerial.read();
    } else {
      size_t keep = RX_RING_SIZE / 2;
      memmove(rxRing, &rxRing[RX_RING_SIZE - keep], keep);
      rxHead = keep;
    }
  }

  // 2. Parsowanie strumienia binarnego radaru
  parseRadarStream();

  // 3. Obsługa komend z PC (DeskSense Passthru)
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (pcCmdLen > 0) {
        while (pcCmdLen > 0 && pcCmdBuf[pcCmdLen - 1] == ' ') pcCmdLen--;
        pcCmdBuf[pcCmdLen] = '\0';
        handlePcCommand(pcCmdBuf, pcCmdLen);
        pcCmdLen = 0;
      }
    } else if (pcCmdLen < PC_CMD_MAX - 1) {
      pcCmdBuf[pcCmdLen++] = c;
    }
  }

  // 4. Watchdog braku transmisji z sensora (> 5 s)
  unsigned long now = millis();
  if (lastRadarPacketMs > 0 && (now - lastRadarPacketMs > 5000)) {
    if (presence) {
      presence = false;
      setStatusLed(false);
      Serial.println("'Person Information' >> OFF");
    }
  }

  // 5. Heartbeat telemetrii sprzętowej co 5 sekund
  if (now - lastDevInfoEmit >= 5000) {
    lastDevInfoEmit = now;
    Serial.printf("[DeskSense] DeskSense Device FW=%s SENSOR=%s UPTIME=%lus TEMP=%.1fC\r\n",
                  FIRMWARE_VERSION, SENSOR_MODEL, (unsigned long)(now / 1000UL), temperatureRead());
  }

  delay(1);
}
