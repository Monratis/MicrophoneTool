# HANDOVER — DeskSense / XIAO ESP32-C6 + MR60BHA2 (Stan i Instrukcja)

Przekazanie pełnej wiedzy sprzętowej, firmware'owej i aplikacyjnej dla kolejnego agenta AI i dewelopera.
Data: 28.08.2026.
Stan: **DeskSense Native OS v1.4.0 (Wgrany na COM3 — dodana fuzja obecnosci)**.

---

## 1. Architektura sprzętowa (Seeed MR60BHA2 Kit)

- **Mikrokontroler:** Seeed Studio XIAO ESP32-C6 (`ESP32-C6FH4`, 4MB Flash, RISC-V, USB-CDC).
- **Radar mmWave 60GHz (MR60BHA2):**
  - Połączenie UART: `RX: GPIO17`, `TX: GPIO16` na baudzie `115200` (`8N1`).
  - Strumień danych radaru: Ramki binarne z nagłówkiem `0x01` oraz ramki Seeed `0x53 0x59`.
  - Kluczowe typy ramek:
    - `0x0F09` — Obecność człowieka (People Exist / Has Target, uint16 LE, `!= 0` oznacza `ON`).
    - `0x0A16` — Dystans klatki piersiowej w **cm** (`[u32 flag][float distance_cm LE]` na offsecie 4).
    - `0x0A15` — Tętno w **BPM** (`float LE`).
    - `0x0A14` — Częstotliwość oddechu w **RPM** (`float LE`).
    - `0x0A04` / `0x0A08` — Liczba śledzonych celów (Target Number, `uint32 LE`).
- **Dioda statusowa (WS2812 RGB):**
  - Pojedyncza dioda adresowalna podłączona pod pin **`GPIO1`**.
  - Sterowanie programowe: Biblioteka `Adafruit_NeoPixel` (sprzętowy sterownik RMT ESP32).
  - Kolory w DeskSense: Zielony (`#22c55e` dla DESK), Bursztynowy (`#f59e0b` dla AWAY), Czerwony (`#ef4444` dla MUTE) + ściemnianie 0–100%.
- **Czujnik natężenia światła (BH1750):**
  - Magistrala I2C: `SDA: GPIO22`, `SCL: GPIO23`, adres `0x23`.
  - Inicjalizacja: Power ON (`0x01`) $\rightarrow$ Continuous H-Resolution (`0x10`), przelicznik `lux = raw / 1.2f`.

---

## 2. Firmware: DeskSense Native OS v1.4.0

- **Ścieżka do kodu źródłowego:** `firmware/DeskSense_XIAO_ESP32C6/DeskSense_XIAO_ESP32C6.ino`
- **Rozmiar binarki:** ~315 KB (zaledwie 24% pamięci programu i 5% RAM ESP32-C6).
- **Zasada działania:**
  1. Mikrokontroler czyta surowe ramki binarne z UART radaru i w locie je waliduje sumami kontrolnymi (~XOR).
  2. Wypisuje do USB-CDC czyste, sformatowane linie tekstowe (standard formatu logów ESPHome):
     ```text
     'Person Information' >> ON
     'Distance to detection object' >> 74.62 cm
     'Real-time heart rate' >> 105 bpm
     'Real-time respiratory rate' >> 16
     'Target Number' >> 1
     'Seeed MR60BHA2 Illuminance' >> 0.8 lx
     ```
  3. Obsługuje dwukierunkowe komendy tekstowe z PC (`SET:LED=R,G,B,BRI\r\n` oraz `CMD:REBOOT\r\n`).
  4. Zapobiega jakimkolwiek kolizjom bajtów binarnych ze strumieniem tekstowym.
  5. **Fuzja obecnosci (v1.4.0)**: modul MR60BHA2 potrafi trzymac People Exist=ON na
     statycznym odbiciu (fotel/krzeslo) po wyjsciu uzytkownika. Firmware liczy dowody
     zywotnosci: swieza biometria (tetno/oddech) i ruch dystansu. Gdy oba zamilkna na
     `FUSION_GAP_MS` (3 s, `#define` w .ino), emituje `'Person Information' >> OFF`
     mimo ON z modulu; powrot natychmiastowy po bio lub ruchu dystansu. Diagnostyka:
     linie `[DeskSense] Fuzja obecnosci -> OFF/ON` w strumieniu (apka loguje je jako RADAR-RAW).

---

## 3. Instrukcja Flashowania (Gotowe komendy PowerShell)

### Środowisko narzędziowe:
- **arduino-cli:** `C:\Users\Monra\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe`
- **FQBN płytki:** `esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc`
- **Port:** `COM3`

### Krok po kroku:
```powershell
# 1. ZAWSZE zamknij procesy DeskSense przed kompilacją/wgrywaniem (żeby zwolnić port COM3):
Get-Process | Where-Object { $_.ProcessName -like "*DeskSense*" } | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Kompilacja firmware'u:
& "C:\Users\Monra\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "d:\MicrophoneTool\firmware\DeskSense_XIAO_ESP32C6"

# 3. Wgranie (Upload) na port COM3:
& "C:\Users\Monra\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "d:\MicrophoneTool\firmware\DeskSense_XIAO_ESP32C6"
```

### Alternatywne wgranie fabrycznego obrazu ESPHome (.bin):
```powershell
python -m esptool --chip esp32c6 --port COM3 --baud 460800 write_flash 0x0 "d:\MicrophoneTool\firmware\seeedstudio-mr60bha2-kit-esp32c6.factory.bin"
```

---

## 4. Krytyczne fakty i pułapki (Gotchas)

1. **USB-CDC DTR/RTS Handshake:**
   Na ESP32-C6 z `CDCOnBoot=cdc`, sterownik USB CDC w Windows nie przesyła strumienia dopóki aplikacja nie ustawi sygnałów DTR i RTS na `true`.
   W `src/main/radarListener.ts`:
   ```ts
   port.set({ dtr: true, rts: true });
   ```
2. **Sterowanie diodą WS2812 na ESP32-C6 (RISC-V):**
   Wbudowane w stary core `neopixelWrite` lub makra `#ifdef` nie działały prawidłowo. **Wymagana jest biblioteka `Adafruit_NeoPixel`**, która korzysta z hardware RMT na pinie GPIO1.
3. **Format linii w DeskSense:**
   Parser w `src/main/radarListener.ts` przetwarza linie pasujące do regexu:
   `/'([^']+)'\s*(?::\s*(?:Sending state|Got state|state:?)|\s*>>)\s*([^\s,;]+)/i`
4. **Weryfikacja zmian:**
   Przed każdym commitem i zakończeniem zadania należy uruchomić:
   ```bash
   npm run typecheck
   ```