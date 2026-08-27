# Auto Audio Input Switcher

Automatyczne przełączanie domyślnego mikrofonu w systemie Windows między **mikrofonem
biurkowym** a **zestawem słuchawkowym** w zależności od fizycznej obecności użytkownika
przy biurku. Obecność jest wykrywana sprzętowo przez radar mmWave (60 GHz) podpięty
po USB jako wirtualny port szeregowy.

Aplikacja działa w **System Tray** — bez okna na starcie. Panel ustawień otwiera się
z menu tray (prawy klik) lub kliknięciem ikony.

Projekt posiada **wbudowany natywny moduł sterowania audio Windows CoreAudio (AudioSwitcher)**,
dzięki czemu działa natychmiast po pobraniu, w 100% offline i **nie wymaga instalowania ani pobierania zewnętrznego programu SoundVolumeView**.

---

## 1. Zasada działania

```
Radar mmWave (USB/COM)  -->  Electron (Node.js)  -->  AudioSwitcher.exe (CoreAudio)  -->  Windows audio
```

- **Przy biurku (obecność)** → domyślny mikrofon: **HyperX QuadCast 2**
- **Poza biurkiem (brak obecności)** → domyślny mikrofon: **mikrofon słuchawek**

Zmiana obecności → debounce/histereza → natywne przełączenie audio przez API Windows CoreAudio (`IPolicyConfig`).

---

## 2. Architektura sprzętowa

| Element             | Urządzenie                                | Rola                                   | Połączenie               |
|---------------------|-------------------------------------------|----------------------------------------|--------------------------|
| Radar obecności     | Seeed MR60BHA2 + XIAO ESP32-C6 (USB CDC)  | detekcja obecności/oddechu, 60 GHz      | USB-C → port COM (vCP)   |
| Mikrofon biurkowy   | HyperX QuadCast 2                          | domyślne wejście przy biurku            | USB-C (na stałe)         |
| Mikrofon słuchawek  | bezprzewodowy zestaw z mikrofonem          | domyślne wejście po odejściu od biurka  | odbiornik USB / KVM      |

---

## 3. Architektura oprogramowania

| Warstwa            | Technologia                                                        |
|--------------------|--------------------------------------------------------------------|
| Proces główny      | Electron + Node.js (CommonJS/ESM, bundle Vite)                     |
| Komunikacja COM    | `serialport` (native, prebuilt dla Electron)                        |
| Przełączanie audio | **AudioSwitcher.exe** (wbudowany moduł C# / Windows CoreAudio COM) |
| UI                 | React 18 + TypeScript + Vite (electron-vite)                       |
| IPC                | `contextBridge` + `ipcMain.handle`                                 |

Stack builda: **electron-vite** (main/preload/renderer) + **electron-builder** (portable).

---

## 4. Logika działania (state machine)

Stany: `desk` (przy biurku) / `away` (poza biurkiem). Wejście: zdarzenia z radaru.

| Przejście | Warunek                                    | Opóźnienie (domyślne) | Cel                            |
|-----------|--------------------------------------------|------------------------|--------------------------------|
| → desk    | wykryta obecność w strefie (<= 1.2 m)      | `timeoutDeskMs` = 300  | debounce wejścia — szybka reakcja |
| → away    | brak obecności/oddechu                     | `timeoutAwayMs` = 3000 | histereza wyjścia — ochrona przed chwilowym zanikiem |

Tryby pracy:

- **`auto`** — przełączanie wg stanu radaru (tryb domyślny)
- **`desk`** — wymuszenie mikrofonu biurkowego
- **`headset`** — wymuszenie mikrofonu słuchawek

Przełączenia nie kolidują ze sobą: podczas trwającej operacji najnowsze żądanie jest
kolejkowane i wykonane po zakończeniu (pending-state).

---

## 5. Protokół radaru (radarListener.js)

Port szeregowy: baud **115200** (konfigurowalne). Obsługiwane dwa formaty:

### 5.1 JSON (firmware ESP32)

Linia po linii, np.:

```json
{"presence":1,"distance":1.1}
```

`presence`: `0` (brak) / `1` (obecność).

### 5.2 Surowe ramki binarne MR60BHA2

Format: `0x53 0x59 <len> <data...> <checksum>`

- funkcja `0x01` (informacje o obecności) → bajt obecności w payload (`0x01` = obecny)

### 5.3 Auto-detekcja portu

Port wybierany jest z configu lub wykrywany po VID/PID:

| Producent  | VID    | PID    |
|------------|--------|--------|
| Seeed Studio XIAO ESP32-C6 | `0x2886` | `0x802D` |
| Espressif ESP32-C6         | `0x303A` | `0x1001` |

---

## 6. Passthrough na XIAO ESP32-C6 (wymagany firmware)

XIAO ESP32-C6 musi działać jako **transparentny mostek** między radarem a PC —
przekazuje ramki radaru z UART0 na port USB (COM). Bez tego DeskSense nie dostaje żadnych danych.

### Dlaczego passthrough

Radar MR60BHA2 jest w kitcie fabrycznie podpięty do UART0 XIAO:

- D6 (GPIO16, TX) → RX radaru
- D7 (GPIO17, RX) → TX radaru

Port USB-C XIAO pojawia się w Windows jako `COMx` (VID `0x303A` / PID `0x1001`).
Passthrough łączy te dwa światy na **115200 baud**.

### Wgrywanie przez Arduino IDE

1. Zainstaluj **Arduino IDE 2.x**.
2. `File → Preferences` → pole *Additional boards manager URLs*:
   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
   → `Tools → Board → Boards Manager…` → zainstaluj **esp32 by Espressif** (v3.x).
3. `Tools → Manage Libraries…` → zainstaluj **Seeed_Arduino_mmWave**.
4. `File → Examples → Seeed_Arduino_mmWave → passthrough_mode`.
5. Wybierz płytkę: **XIAO_ESP32C6** (FQBN `esp32:esp32:XIAO_ESP32C6` — UWAGA:
   architektura to `esp32`, **nie** `esp32c6`).
6. Wybierz port COM (XIAO ESP32-C6) i kliknij **Upload**.
7. Serial Monitor na **115200**: powinien pokazywać strumień binarnych ramek
   (zaczynających się od bajtu `0x01`). Pusto = mostek nie działa / zły firmware.

### Wgrywanie przez arduino-cli (terminal)

```bash
arduino-cli core update-index
arduino-cli core install esp32:esp32
arduino-cli lib install Seeed_Arduino_mmWave
arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32C6 passthrough_mode
arduino-cli upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32C6 passthrough_mode
```

### Co robi ten kod

Dwukierunkowy mostek na 115200: `Serial` (USB-CDC) ↔ `mmWaveSerial(0)` (UART0 = D6/D7 radaru).
Przykład z biblioteki (wymaga `#include "Seeed_Arduino_mmWave.h"` — używa tylko nagłówka).

### Dane

Radar streamuje **surowe ramki binarne ESPHome (`0x01`)** — to samo, co parsuje
`radarListener.ts`. Floaty w tych ramkach są **little-endian** (typy: `0x0A14` oddech,
`0x0A15` tętno, `0x0A16` dystans, `0x0F09` obecność). Ramki fabryczne `0x53 0x59`
są nadal obsługiwane.

---

## 7. Samoleczenie (auto-heal)

Soft sam rozwiązuje problemy, gdzie się da:

| Problem                                   | Rozwiązanie                                                          |
|-------------------------------------------|----------------------------------------------------------------------|
| Brak pliku binarnego audio                | automatyczna kompilacja `AudioSwitcher.cs` przez wbudowany `csc.exe` |
| Błędna nazwa mikrofonu w configu          | wykrycie listy urządzeń nagrywających, poprawka nazwy, ponowienie    |
| Nieudane przełączenie                     | auto-heal nazwy → retry                                               |
| Port COM niedostępny / odpięty USB        | auto-reconnect (2.5 s) i wykrycie ponownego wpięcia USB               |
| Zmiana baud w panelu                      | automatyczny restart radaru                                           |
| Nazwy urządzeń nie istnieją przy starcie  | automatyczna poprawka na wykryte                                      |

Nazwy urządzeń dobierane są heurystycznie: mikrofon biurkowy (np. zawiera „QuadCast”, „Rode”, „Yeti”)
vs. słuchawki („Headset/Headphones/Słuchawki”), z odrzuceniem „Stereo Mix”, „Line In”,
„Microphone Array” itp.

---

## 8. Menu tray

- `Stan: Przy biurku / Poza biurkiem`
- `Tryb: Auto (radar) / Biurkowy / Słuchawki`
- `Port: <COM>`
- `Ustawienia…` (otwiera panel)
- `Wycisz / Odcisz mikrofon (Ctrl+Shift+M)`
- Tryby radio: `Tryb automatyczny (radar)` / `Wymuś mikrofon biurkowy` / `Wymuś mikrofon słuchawek`
- `Sprawdź aktualizacje…`
- `Odśwież / wykryj port COM`
- `Wyjdź`

Lewy klik / podwójny klik na ikonę → otwarcie panelu ustawień. Ikona zmienia kolor:
zielony = przy biurku, bursztyn = poza biurkiem.

---

## 9. Konfiguracja (`config.json`)

Lokalizacja: `%APPDATA%/Audio Switcher/config.json`

| Pole                 | Domyślne                             | Opis                                       |
|----------------------|--------------------------------------|--------------------------------------------|
| `port`               | `"auto"`                             | port COM lub autodetekcja VID/PID           |
| `baudRate`           | `115200`                             | prędkość portu szeregowego                  |
| `micDeskName`        | `"Microphone (HyperX QuadCast 2)"`   | nazwa / fragment nazwy mikrofonu biurkowego |
| `micHeadsetName`     | `"Microphone (Headset)"`             | nazwa / fragment nazwy mikrofonu słuchawek  |
| `timeoutAwayMs`      | `3000`                               | histereza wyjścia (zanik obecności)         |
| `timeoutDeskMs`      | `300`                                | debounce wejścia (pojawienie się)           |
| `autoStart`          | `false`                              | start z systemem (ukryty w tray)            |
| `autoDetectDevices`  | `true`                               | auto-poprawa nazw urządzeń                  |
| `autoDownloadTools`  | `true`                               | opcjonalny fallback pobierania SoundVolumeView |
| `notifications`      | `true`                               | dymki powiadomień Windows                   |
| `muteOnAway`         | `false`                              | wyciszanie mikrofonu po odejściu od biurka  |
| `globalShortcut`     | `"CommandOrControl+Shift+M"`         | globalny skrót klawiszowy wyciszenia        |
| `githubRepo`         | `"Monratis/MicrophoneTool"`          | repozytorium wydań dla Auto-Updatera        |

> Nazwy urządzeń możesz wpisać ręcznie lub kliknąć przycisk **„Wykryj urządzenia nagrywające”** w panelu ustawień.

---

## 10. IPC (most preload → renderer)

| Kanał             | Typ      | Opis                                            |
|-------------------|----------|-------------------------------------------------|
| `state:get`       | invoke   | pełny snapshot (stan, tryb, radar, config)      |
| `state:mode`      | invoke   | ustawienie trybu (`auto`/`desk`/`headset`)      |
| `ports:list`      | invoke   | lista portów COM                                |
| `ports:set`       | invoke   | ustaw port + restart radaru                     |
| `config:update`   | invoke   | zapis zmian configu (+ restart radaru gdy trzeba)|
| `devices:detect`  | invoke   | wykrycie urządzeń nagrywających + poprawka nazw |
| `config:reset`    | invoke   | przywrócenie domyślnych wartości                |
| `window:close`    | send     | ukrycie okna (działanie w tray)                 |
| `push:event`      | on       | zdarzenia na żywo: `snapshot`, `toast`          |

---

## 11. Instalacja i budowanie

Wymagania programowe:
- Node.js >= 20
- Windows 10 / 11 (moduł audio używa standardowego API Windows CoreAudio / .NET)

```bash
npm install          # instaluje zależności + przygotowuje moduły
npm run dev          # uruchomienie deweloperskie z HMR (okno ustawień)
npm start            # preview zbudowanej wersji
npm run typecheck    # weryfikacja typów TypeScript
```

### Budowanie aplikacji (zoptymalizowane pod wielowątkowość CPU)

Aplikacja posiada zoptymalizowany skrypt budowania dopasowujący się do liczby wątków procesora:

1. **Zwykły plik `.exe` (klikasz i działa natychmiast bez instalacji)**:
   ```bash
   npm run package:app
   ```
   Wynik (gotowy w ~5 sekund): `dist/win-unpacked/Auto Audio Switch.exe` — uruchamiasz bezpośrednio. Plik konfiguracyjny tworzy się automatycznie w `%APPDATA%\Audio Switcher\config.json`.

2. **Instalator Windows (Setup Wizard)**:
   ```bash
   npm run package:installer
   ```
   Wynik: `dist/Auto Audio Switch Setup 0.2.0.exe` — instalator z kreatorem.

3. **Budowanie obu wariantów na raz**:
   ```bash
   npm run package:all
   ```

---

## 12. Struktura projektu

```
├── src/
│   ├── main/                    # proces główny Electron
│   │   ├── index.js             # tray, okno, IPC, autostart, samoleczenie
│   │   ├── config.js            # konfiguracja + domyślne wartości
│   │   ├── audioController.js   # kontroler audio (ensure narzędzia, wykrywanie)
│   │   ├── soundVolumeView.js   # backend audio (wbudowany AudioSwitcher / fallback)
│   │   ├── radarListener.js     # port COM, parsery, histereza, auto-reconnect
│   │   └── appController.js     # state machine: tryby + przełączanie (pending)
│   ├── native/                  # natywny kod C# modułu audio
│   │   └── AudioSwitcher.cs     # obsługa CoreAudio (WASAPI + IPolicyConfig)
│   ├── preload/                 # bridge IPC (contextBridge)
│   │   └── index.js
│   └── renderer/                # panel ustawień (React + TS + Vite)
│       ├── index.html
│       └── src/  (main.tsx, App.tsx, styles.css, global.d.ts)
├── bin/                         # wbudowany AudioSwitcher.exe (oraz opcjonalny SoundVolumeView.exe)
├── config.json                  # konfiguracja dev
├── electron.vite.config.mjs     # konfiguracja builda (main/preload/renderer)
├── tsconfig.json
└── package.json
```

---

## 14. Rozwiązywanie problemów

| Objaw                                | Przyczyna / rozwiązanie                                          |
|--------------------------------------|------------------------------------------------------------------|
| „Nie udało się ustawić mikrofonu”    | sprawdź czy mikrofon jest podłączony i aktywny w systemie Windows |
| zła nazwa w configu                  | użyj „Wykryj urządzenia nagrywające” albo wpisz nazwę z ustawień dźwięku Windows |
| radar nie wykryty (COM)              | sprawdź VID/PID (sec. 5.3); odłącz/podłącz USB; wybierz port ręcznie |
| COM jest, ale brak danych            | wgraj firmware passthrough na XIAO (sec. 6) — mostek UART→USB |
| przełączanie na chwilę zanika        | zwiększ `timeoutAwayMs` (histereza)                              |
| brak reakcji po zmianie ustawień     | zmiana mock/baud/port restartuje radar automatycznie             |
| Chrome: „Unable to move the cache”   | drobny błąd GPU cache — nie wpływa na działanie                  |

---

## 15. Licencja

MIT