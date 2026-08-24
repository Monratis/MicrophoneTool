# Auto Audio Input Switcher (mmWave + Electron Tray)

Automatyczne przełączanie domyślnego mikrofonu w Windows między mikrofonem biurkowym
a zestawem słuchawkowym w zależności od fizycznej obecności użytkownika przy biurku,
wykrywanej przez radar mmWave (Seeed MR60BHA2 na XIAO ESP32-C6) podpięty po USB (COM).

Aplikacja działa w System Tray (bez okna na starcie). Panel ustawień otwiera się
z menu tray lub kliknięciem ikony.

## Wymagania sprzętowe

| Element            | Urządzenie                                | Rola                                   |
|--------------------|-------------------------------------------|----------------------------------------|
| Radar obecności    | Seeed MR60BHA2 + XIAO ESP32-C6 (USB CDC)  | detekcja obecności (COM port)          |
| Mikrofon biurkowy  | HyperX QuadCast 2                          | domyślny, gdy użytkownik przy biurku    |
| Mikrofon słuchawek | zestaw bezprzewodowy z mikrofonem          | domyślny po odejściu od biurka         |

## Wymagania programowe

- Node.js >= 20
- `SoundVolumeView.exe` (NirSoft) umieszczony w `./bin/`
  — pobierz: https://www.nirsoft.net/utils/sound_volume_view.html

## Instalacja i uruchomienie (dev)

```bash
npm install
npm run dev        # electron-vite z HMR, okno ustawień
npm start          # preview zbudowanej wersji
```

## Build (portable, Windows)

```bash
npm run package:win
```

Wynik: `dist/Auto Audio Switch <wersja>.exe` — pojedynczy przenośny plik
(nie wymaga instalatora). Budowany z `--config.win.signAndEditExecutable=false`
(bez podpisywania/edycji zasobów exe — omija potrzebę winCodeSign).

## Funkcje

- **System Tray** — ikona zmienia kolor wg stanu (zielony = przy biurku, bursztyn = poza),
  tooltip ze stanem i trybem.
- **Panel ustawień** (React + Vite, ciemny UI) otwierany z tray / kliknięciem ikony:
  - status na żywo (radar, obecność, aktywny mikrofon)
  - tryb pracy: Auto (radar) / QuadCast 2 / Słuchawki
  - wybór portu COM (lista z detekcją VID/PID Seeed)
  - nazwy urządzeń audio, czasy histerezy, baud rate
  - tryb mock (symulacja radaru bez sprzętu)
- **Autostart** — włącz/wyłącz start wraz z systemem (ukryty w tray).

## Konfiguracja (`config.json`)

W dev używany jest `config.json` z katalogu projektu; w buildzie przenośnym
plik jest kopiowany do katalogu obok exe (`resources/`). Pola:

| Pole               | Domyślne                             | Opis                                   |
|--------------------|--------------------------------------|----------------------------------------|
| `port`             | `"auto"`                             | port COM lub autodetekcja VID/PID       |
| `baudRate`         | `115200`                             | prędkość portu szeregowego              |
| `micDeskName`      | `"Microphone (HyperX QuadCast 2)"`   | dokładna nazwa z SoundVolumeView       |
| `micHeadsetName`   | `"Microphone (Headset)"`             | dokładna nazwa z SoundVolumeView       |
| `timeoutAwayMs`    | `3000`                               | histereza wyjścia (zanik obecności)     |
| `timeoutDeskMs`    | `300`                                | debounce wejścia (pojawienie się)       |
| `mockMode`         | `true`                               | symulacja radaru bez urządzenia         |
| `autoStart`        | `false`                              | start z systemem (ukryty)               |

Nazwy urządzeń sprawdzisz: `bin/SoundVolumeView.exe` — kolumna `Default`, wiersze
urządzeń nagrywających (`Recording`). Nazwa musi być dokładna.

## Tryb mock

`mockMode: true` — radar symuluje cykl 15s przy biurku / 15s poza, więc całość da się
przetestować bez sprzętu (przełącza mikrofon co 15s).

## Struktura

```
src/main/index.js        proces główny Electron: tray, okno, IPC, autostart
src/main/config.js       konfiguracja + domyślne wartości
src/main/audioController.js  wywołanie SoundVolumeView.exe /SetDefault
src/main/radarListener.js    port COM, parser JSON/MR60BHA2, histereza
src/main/appController.js    stan maszyny: tryb auto/manual + przełączanie
src/preload/index.js     bridge IPC (contextBridge)
src/renderer/            panel ustawień (React + TS)
bin/SoundVolumeView.exe  narzędzie NirSoft (do umieszczenia)
electron.vite.config.mjs konfiguracja builda
```