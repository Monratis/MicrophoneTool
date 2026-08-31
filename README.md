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

Kod mikrokontrolera znajduje się w `firmware/DeskSense_XIAO_ESP32C6/DeskSense_XIAO_ESP32C6.ino`.

### Wgrywanie przez `arduino-cli`:

```powershell
# 1. Zamknij DeskSense przed otwarciem portu COM:
Get-Process | Where-Object { $_.ProcessName -like "*DeskSense*" } | Stop-Process -Force -ErrorAction SilentlyContinue

# 2. Kompilacja:
arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "firmware\DeskSense_XIAO_ESP32C6"

# 3. Wgrywanie (np. na port COM3):
arduino-cli upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "firmware\DeskSense_XIAO_ESP32C6"
```

Możesz także skorzystać z **wbudowanego kreatora flashowania USB** w panelu ustawień aplikacji DeskSense (wykorzystuje `esptool-js` bezpośrednio w oknie programu).

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