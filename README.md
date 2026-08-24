# Auto Audio Input Switcher (mmWave + Electron Tray)

Automatyczne przełączanie domyślnego mikrofonu w Windows między mikrofonem biurkowym
a zestawem słuchawkowym w zależności od fizycznej obecności użytkownika przy biurku,
wykrywanej przez radar mmWave (Seeed MR60BHA2 na XIAO ESP32-C6) podpięty po USB (COM).

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

## Instalacja

```bash
npm install
```

## Uruchomienie

```bash
npm start
```

Aplikacja startuje bez okna — mieszka w System Tray. Menu prawym przyciskiem:

- `Stan: Przy biurku / Poza biurkiem`
- `Tryb automatyczny (radar)`
- `Wymuś mikrofon: QuadCast 2` / `Wymuś mikrofon: Słuchawki`
- `Port COM` / `Odśwież / wykryj port COM`
- `Wyjdź`

Lewy klik na ikonę tray przełącza manualnie mikrofon (bez radaru).

## Konfiguracja (`config.json`)

Konfiguracja jest tworzona/odczytywana z katalogu userData Electrona
(`%APPDATA%/auto-audio-input-switcher/config.json`). Pola:

| Pole               | Domyślne                             | Opis                                   |
|--------------------|--------------------------------------|----------------------------------------|
| `port`             | `"auto"`                             | port COM lub autodetekcja VID/PID       |
| `baudRate`         | `115200`                             | prędkość portu szeregowego              |
| `micDeskName`      | `"Microphone (HyperX QuadCast 2)"`   | dokładna nazwa z SoundVolumeView       |
| `micHeadsetName`   | `"Microphone (Headset)"`             | dokładna nazwa z SoundVolumeView       |
| `timeoutAwayMs`    | `3000`                               | histereza wyjścia (zanik obecności)     |
| `timeoutDeskMs`    | `300`                                | debounce wejścia (pojawienie się)       |
| `mockMode`         | `true`                               | symulacja radaru bez urządzenia         |

Nazwy urządzeń sprawdzisz: `bin/SoundVolumeView.exe` — kolumna `Default`, wiersze
urządzeń nagrywających (`Recording`). Nazwa musi być dokładna (bez typu `[Recording]`).

## Tryb mock

`mockMode: true` — radar symuluje cykl 15s przy biurku / 15s poza, więc całość da się
przetestować bez sprzętu (przełącza mikrofon co 15s).

## Budowa (Windows)

```bash
npx electron-builder --win portable
```

## Struktura

```
main.js                 proces główny Electron: tray, menu, spięcie
src/config.js           konfiguracja + domyślne wartości
src/audioController.js  wywołanie SoundVolumeView.exe /SetDefault
src/radarListener.js    port COM, parser JSON/MR60BHA2, histereza
src/appController.js    stan maszyny: tryb auto/manual + przełączanie
bin/SoundVolumeView.exe narzędzie NirSoft (do umieszczenia)
```