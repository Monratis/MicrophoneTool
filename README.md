# DeskSense (by Monra)

Inteligentne, automatyczne przełączanie domyślnego mikrofonu w systemie Windows (CoreAudio)
na podstawie fizycznej obecności użytkownika przy biurku, wykrywanej sprzętowo przez radar
mmWave 60 GHz (Seeed Studio MR60BHA2 na mikrokontrolerze XIAO ESP32-C6 przez USB/COM).

Aplikacja działa cicho w **System Tray** (zasobniku systemowym) i nie obciąża procesora (0% CPU).
Panel ustawień i dashboard telemetryczny otwiera się po kliknięciu ikony w trayu.

---

## 🚀 Szybki start (dla developerów i agentów AI)

### Wymagania systemowe
- **System**: Windows 10 / 11 (64-bit)
- **Środowisko**: Node.js `>= 20.x`, npm `>= 10.x`
- **.NET Framework**: 4.0 / 4.8 (standardowo obecny w Windows 10/11) — używany przez wbudowany kompilator `csc.exe` do natywnych modułów audio i głosu

### Krok po kroku: Instalacja i uruchomienie

```powershell
# 1. Klonowanie repozytorium
git clone https://github.com/Monratis/MicrophoneTool.git
cd MicrophoneTool

# 2. Instalacja zależności (npm + natywne moduły serialport)
npm install

# 3. Weryfikacja typów TypeScript (zero błędów)
npm run typecheck

# 4. Uruchomienie w trybie developerskim z Hot Reload (HMR)
npm run dev
```

---

## 🛠️ Budowanie wydań produkcyjnych (Build & Packaging)

> ⚠️ **ZASADA**: Do budowania paczek zawsze używaj `node scripts/build.mjs` (lub skrótów `npm run package:*`), a nie gołego `electron-builder`. Skrypt budujący automatycznie kompiluje natywne binarki C#, generuje ikony wysokiej rozdzielczości, zarządza procesami w tle i tworzy spójne sumy kontrolne dla Auto-Updatera.

```powershell
# Pełny build: Wersja przenośna (Portable) + Instalator (NSIS Setup) + sumy latest.yml
node scripts/build.mjs all
# (lub: npm run package:all)

# Tylko wersja przenośna (DeskSense (Portable).exe w katalogu releases/)
node scripts/build.mjs portable
# (lub: npm run package:portable)

# Tylko instalator Windows (DeskSense Setup X.Y.Z.exe w katalogu releases/)
node scripts/build.mjs installer
# (lub: npm run package:installer)
```

Pliki wyjściowe trafiają do katalogu `releases/`:
- `DeskSense (Portable).exe` — pojedynczy plik .exe, nie wymaga instalacji
- `DeskSense Setup <wersja>.exe` — instalator z kreatorem
- `latest.yml` — metadane i sumy kontrolne SHA512 dla wbudowanego Auto-Updatera

---

## 🔄 Jak działa Auto-Update (Weryfikacja Portable i Instalatora)

DeskSense posiada wbudowany mechanizm aktualizacji (`src/main/updater.ts`), który pobiera wydania z GitHub Releases i potrafi samodzielnie zaktualizować aplikację w obu wariantach:

1. **Wariant zainstalowany (NSIS Setup)**:
   - Aplikacja wykrywa nowszą wersję w kanale GitHub Releases.
   - Pobiera plik `DeskSense Setup <wersja>.exe` do `%TEMP%\DeskSense-Update\`.
   - Przy zatwierdzeniu generuje proces wsadowy `desksense_update_run_installer.bat`, zamyka działającą instancję i uruchamia cichą aktualizację `/S`, po czym restartuje DeskSense.

2. **Wariant przenośny (Portable)**:
   - Aplikacja wykrywa, że działa z pojedynczego pliku EXE (`PORTABLE_EXECUTABLE_FILE`).
   - Pobiera `DeskSense (Portable).exe`.
   - Generuje skrypt `desksense_update_restart.bat`, zamyka program, czeka na zwolnienie blokady pliku, atomowo nadpisuje uruchomiony plik `.exe` i uruchamia zaktualizowany proces.

---

## 🏗️ Architektura i Główne Moduły

```
MicrophoneTool/
├── bin/                       # Skompilowane natywne binarki Windows (.exe)
│   ├── AudioSwitcher.exe      # Daemon CoreAudio (zmiana domyślnego mikrofonu Windows)
│   └── VoiceListener.exe      # C# silnik przechwytywania audio i bramki VAD
├── firmware/                  # Kod źródłowy mikrokontrolera radaru
│   └── DeskSense_XIAO_ESP32C6/
│       └── DeskSense_XIAO_ESP32C6.ino # DeskSense Native OS v1.5 dla XIAO ESP32-C6
├── scripts/
│   └── build.mjs              # Główny, zoptymalizowany pipeline builda
├── src/
│   ├── main/                  # Główny proces Electron (TypeScript)
│   │   ├── appContext.ts      # Kontener DI, ścieżki zasobów, autostart Windows
│   │   ├── appController.ts   # Automat stanów obecności (DESK <-> AWAY, debounce, drift)
│   │   ├── audioController.ts # Zarządzanie urządzeniami audio Windows CoreAudio
│   │   ├── haIntegration.ts   # Integracja Home Assistant (WebSocket + REST + Pokoje/Obszary)
│   │   ├── discordIntegration.ts # Discord RPC (wyciszenie, zmiana profilu głosu)
│   │   ├── signalrgbIntegration.ts # SignalRGB REST API (efekty świetlne)
│   │   ├── voiceManager.ts    # Silnik komend głosowych (Whisper AI + Windows Speech)
│   │   ├── radarListener.ts   # Parser portu szeregowego radaru mmWave MR60BHA2
│   │   ├── updater.ts         # Silnik aktualizacji GitHub Releases
│   │   └── ipc.ts             # Obsługa komunikacji IPC
│   ├── native/                # Źródła C# (.NET Framework 4.0 / csc.exe)
│   │   ├── AudioSwitcher.cs   # Windows CoreAudio WASAPI & IPolicyConfig COM
│   │   ├── VoiceListener.cs   # Dźwiękowy silnik VAD / WASAPI Capture
│   │   └── IconGenerator.cs   # Generator ikon systemowych i zasobnika
│   ├── preload/               # Bezpieczny mostek contextBridge
│   ├── renderer/              # Lekki interfejs użytkownika (Vanilla TS + Vite, ~65 kB)
│   │   └── src/
│   │       ├── homeView.ts    # Dashboard na żywo: telemetria, radar-scope, mikrofony
│   │       ├── integrationsPanels.ts # Konfiguracja Home Assistant, Discord, SignalRGB
│   │       ├── voicePanel.ts  # Konfigurator komend głosowych i akcji HA
│   │       ├── settingsPanels.ts # Ustawienia progów, portów COM, biometrii
│   │       └── events.ts      # Podpięcie zdarzeń UI
│   └── shared/
│       └── types.ts           # Jedyne źródło prawdy definicji typów w projekcie
```

---

## 📡 Integracje

### 1. Home Assistant OS (HAOS)
- **Dwukierunkowy WebSocket**: subskrypcja zdarzeń `state_changed` oraz synchronizacja stanów.
- **Przeglądanie wg Pokoi / Obszarów (Areas)**: inteligentny picker pobierający strukturę obszarów i urządzeń z HAOS.
- **Wykonywanie akcji i komend**: sterowanie oświetleniem (włącz/wyłącz, jasność %, kolory RGB z palety), przełącznikami, scenami, multimediami i klimatyzacją.
- **Obsługa przycisków sprzętowych**: przyciski w HAOS do wyciszania mikrofonu czy włączania pauzy automatyki.

### 2. Discord RPC
- Automatyczne wyciszanie/odciszanie na Discordzie.
- Synchronizacja urządzenia wejściowego i profili czułości głosu.

### 3. SignalRGB
- Zmiana oświetlenia PC i peryferiów zależnie od obecności przy biurku (`DESK` vs `AWAY`).

### 4. Komendy Głosowe & Whisper AI
- Wykrywanie fraz aktywacyjnych i komend mowy.
- Wywoływanie automatyzacji Home Assistant, uruchamianie aplikacji, sterowanie multimediami i skrótami klawiszowymi.

---

## ⚡ Wgrywanie Firmware'u Sensora (XIAO ESP32-C6 + MR60BHA2)

Kod źródłowy firmware'u (DeskSense Native OS v1.6.0 z fuzją obecności i dowodami żywotności) znajduje się w folderze:
`firmware/DeskSense_XIAO_ESP32C6/DeskSense_XIAO_ESP32C6.ino`

Obsługiwany sprzęt:
- **Mikrokontroler**: Seeed Studio XIAO ESP32-C6 (4MB Flash, USB-CDC)
- **Radar mmWave**: Seeed Studio MR60BHA2 60 GHz (piny: RX=17, TX=16 na UART1, 115200 baud)
- **Dioda statusowa**: WS2812 RGB (GPIO 1)
- **Czujnik natężenia światła**: BH1750 (I2C: SDA=22, SCL=23, adres `0x23`)

---

### Metoda 1: Wgrywanie przez terminal (`arduino-cli`) — Krok po kroku

Jeśli nie masz jeszcze `arduino-cli`, zainstaluj je w Windows komendą:
```powershell
winget install Arduino.arduino-cli
```
*(lub pobierz plik `.exe` ze strony https://arduino.github.io/arduino-cli/)*

#### Krok 1: Dodanie repozytorium płytek ESP32
```powershell
arduino-cli config init --overwrite
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
```

#### Krok 2: Instalacja rdzenia ESP32 (Core)
```powershell
arduino-cli core update-index
arduino-cli core install esp32:esp32
```

#### Krok 3: Instalacja wymaganych bibliotek (Dependencies)
Firmware wymaga biblioteki do sterowania diodą adresowalną WS2812 RGB:
```powershell
arduino-cli lib install "Adafruit NeoPixel"
```
*(Czujnik światła BH1750 korzysta z wbudowanej w rdzeń magistrali `Wire.h` i nie wymaga dodatkowych zewnętrznych bibliotek).*

#### Krok 4: Wykrycie portu COM płytki XIAO ESP32-C6
Podłącz płytkę kablem USB-C do komputera i wpisz:
```powershell
arduino-cli board list
```
*(Zapamiętaj numer portu, np. `COM3` lub `COM5`).*

#### Krok 5: Zamknięcie DeskSense (Zwolnienie portu COM)
Aplikacja DeskSense nie może blokować portu szeregowego podczas programowania:
```powershell
Get-Process | Where-Object { $_.ProcessName -like "*DeskSense*" } | Stop-Process -Force -ErrorAction SilentlyContinue
```

#### Krok 6: Kompilacja i Wgranie Firmware'u (Upload)
*(Zastąp `COM3` numerem swojego wykrytego portu z Kroku 4)*:

```powershell
# 1. Kompilacja:
arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "firmware\DeskSense_XIAO_ESP32C6"

# 2. Wgrywanie:
arduino-cli upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "firmware\DeskSense_XIAO_ESP32C6"
```

---

### Metoda 2: Wgrywanie przez graficzne Arduino IDE 2.x

1. Pobierz i zainstaluj **Arduino IDE 2.x**.
2. Wejdź w `File` $\rightarrow$ `Preferences` i w polu **Additional boards manager URLs** wklej:
   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
3. Otwórz menedżer płytek (`Tools` $\rightarrow$ `Board` $\rightarrow$ `Boards Manager...`), wyszukaj **esp32** (od Espressif Systems) i kliknij **Install**.
4. Otwórz menedżer bibliotek (`Tools` $\rightarrow$ `Manage Libraries...`), wyszukaj **Adafruit NeoPixel** (od Adafruit) i kliknij **Install**.
5. Otwórz plik `firmware/DeskSense_XIAO_ESP32C6/DeskSense_XIAO_ESP32C6.ino`.
6. W menu `Tools` ustaw:
   - **Board**: `XIAO_ESP32C6`
   - **USB CDC On Boot**: `Enabled` (Kluczowe dla komunikacji USB Serial!)
   - **Port**: wybierz wykryty port `COMx (XIAO ESP32C6)`
7. Kliknij ikonę strzałki **Upload** (Wgraj).

---

### Metoda 3: Wbudowany Web Flasher w DeskSense (Zero instalacji narzędzi!)

Jeśli nie chcesz instalować Arduino CLI ani IDE, DeskSense posiada wbudowany silnik flashowania USB (`esptool-js`):
1. Uruchom aplikację DeskSense i wejdź w zakładkę **Sensor / Radar**.
2. W sekcji **Flashowanie sensora** kliknij przycisk **Wgraj firmware fabryczny**.
3. Aplikacja automatycznie sflashuje mikrokontroler przez USB bez żadnych zewnętrznych kompilatorów.

---

## 📋 Standardy i Weryfikacja Kodu

Przed każdym commitem należy uruchomić:
```powershell
npm run typecheck
```
Kompilator TypeScript (`tsc --noEmit`) musi zakończyć pracę z kodem wyjścia `0` i brakiem błędów.

---

## 📄 Licencja

Projekt objęty licencją **MIT**.
Autor: **Monra**