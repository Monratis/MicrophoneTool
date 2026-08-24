# Auto Audio Input Switcher

Automatyczne przełączanie domyślnego mikrofonu w systemie Windows między **mikrofonem
biurkowym** a **zestawem słuchawkowym** w zależności od fizycznej obecności użytkownika
przy biurku. Obecność jest wykrywana sprzętowo przez radar mmWave (60 GHz) podpięty
po USB jako wirtualny port szeregowy.

Aplikacja działa w **System Tray** — bez okna na starcie. Panel ustawień otwiera się
z menu tray (prawy klik) lub kliknięciem ikony.

---

## 1. Zasada działania

```
Radar mmWave (USB/COM)  -->  Electron (Node.js)  -->  SoundVolumeView.exe  -->  Windows audio
```

- **Przy biurku (obecność)** → domyślny mikrofon: **HyperX QuadCast 2**
- **Poza biurkiem (brak obecności)** → domyślny mikrofon: **mikrofon słuchawek**

Zmiana obecności → debounce/histereza → `SoundVolumeView /SetDefault "<nazwa>" all`.

---

## 2. Architektura sprzętowa

| Element             | Urządzenie                                | Rola                                   | Połączenie               |
|---------------------|-------------------------------------------|----------------------------------------|--------------------------|
| Radar obecności     | Seeed MR60BHA2 + XIAO ESP32-C6 (USB CDC)  | detekcja obecności/oddechu, 60 GHz      | USB-C → port COM (vCP)   |
| Mikrofon biurkowy   | HyperX QuadCast 2                          | domyślne wejście przy biurku            | USB-C (na stałe)         |
| Mikrofon słuchawek  | bezprzewodowy zestaw z mikrofonem          | domyślne wejście po odejściu od biurka  | odbiornik USB / KVM      |

---

## 3. Architektura oprogramowania

| Warstwa          | Technologia                                   |
|------------------|-----------------------------------------------|
| Proces główny    | Electron + Node.js (CommonJS/ESM, bundle Vite)|
| Komunikacja COM  | `serialport` (native, prebuilt dla Electron)   |
| Przełączanie audio | `SoundVolumeView.exe` (NirSoft) — `/SetDefault` |
| UI               | React 18 + TypeScript + Vite (electron-vite)  |
| IPC              | `contextBridge` + `ipcMain.handle`            |

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

## 6. Samoleczenie (auto-heal)

Soft sam rozwiązuje problemy, gdzie się da:

| Problem                                   | Rozwiązanie                                                          |
|-------------------------------------------|----------------------------------------------------------------------|
| Brak `SoundVolumeView.exe`                | automatyczne pobranie z nirsoft.net do `%APPDATA%/tools` (125 KB)    |
| Błędna nazwa mikrofonu w configu          | wykrycie listy urządzeń nagrywających, poprawka nazwy, ponowienie    |
| Nieudane `/SetDefault`                    | auto-heal nazwy → retry                                               |
| Port COM niedostępny / odpięty USB        | auto-reconnect z backoffem 5 s → 30 s (x1.5)                          |
| Zmiana mock/baud w panelu                 | automatyczny restart radaru                                           |
| Nazwy urządzeń nie istnieją przy starcie  | automatyczna poprawka na wykryte                                      |

Nazwy urządzeń dobierane są heurystycznie: mikrofon biurkowy (np. zawiera „QuadCast”)
vs. słuchawki („Headset/Headphones/Słuchawki”), z odrzuceniem „Stereo Mix”, „Line In”,
„Microphone Array” itp. (CSV z `/scomma`, dekodowanie CP1250).

---

## 7. Menu tray

- `Stan: Przy biurku / Poza biurkiem`
- `Tryb: Auto (radar) / QuadCast 2 / Słuchawki`
- `Port: <COM>`
- `Ustawienia…` (otwiera panel)
- Tryby radio: `Tryb automatyczny (radar)` / `Wymuś mikrofon: QuadCast 2` / `Wymuś mikrofon: Słuchawki`
- `Odśwież / wykryj port COM`
- `Wyjdź`

Lewy klik / podwójny klik na ikonę → otwarcie panelu ustawień. Ikona zmienia kolor:
zielony = przy biurku, bursztyn = poza biurkiem.

---

## 8. Konfiguracja (`config.json`)

Lokalizacja (kolejność priorytetów):

1. dev: `config.json` w katalogu projektu
2. portable: `config.json` obok exe (przenośność między uruchomieniami)
3. wbudowany szablon w `resources/`
4. fallback: `%APPDATA%/auto-audio-input-switcher/config.json`

| Pole                 | Domyślne                             | Opis                                       |
|----------------------|--------------------------------------|--------------------------------------------|
| `port`               | `"auto"`                             | port COM lub autodetekcja VID/PID           |
| `baudRate`           | `115200`                             | prędkość portu szeregowego                  |
| `micDeskName`        | `"Microphone (HyperX QuadCast 2)"`   | dokładna nazwa mikrofonu biurkowego         |
| `micHeadsetName`     | `"Microphone (Headset)"`             | dokładna nazwa mikrofonu słuchawek          |
| `timeoutAwayMs`      | `3000`                               | histereza wyjścia (zanik obecności)         |
| `timeoutDeskMs`      | `300`                                | debounce wejścia (pojawienie się)           |
| `mockMode`           | `true`                               | symulacja radaru bez urządzenia             |
| `autoStart`          | `false`                              | start z systemem (ukryty w tray)            |
| `autoDetectDevices`  | `true`                               | auto-poprawa nazw urządzeń                  |
| `autoDownloadTools`  | `true`                               | auto-pobranie SoundVolumeView z sieci       |

> Nazwy urządzeń sprawdzisz uruchamiając `SoundVolumeView.exe` — kolumna `Default`,
> wiersze urządzeń nagrywających (`Recording`). Nazwa musi być dokładna, bez typu
> `[Recording]`. Można też użyć przycisku **„Wykryj urządzenia nagrywające”** w panelu.

---

## 9. IPC (most preload → renderer)

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

## 10. Instalacja i uruchomienie

Wymagania: Node.js >= 20.

```bash
npm install          # instaluje zależności + rebuild native (serialport) dla Electron
npm run dev          # electron-vite dev (HMR)
npm start            # preview zbudowanej wersji
npm run typecheck    # tsc --noEmit
```

### Build portable (Windows)

```bash
npm run package:win
```

Wynik: `dist/Auto Audio Switch <wersja>.exe` — pojedynczy przenośny plik, bez instalatora.

Build używa `--config.win.signAndEditExecutable=false` (pomija podpisywanie/edycję
zasobów exe) — omija wymóg winCodeSign/symlinków (brak Developer Mode na Windows).

> Uwaga: w `dist/win-unpacked/` znajduje się pełny katalog aplikacji — można go
> uruchomić bezpośrednio.

---

## 11. Tryb mock

`mockMode: true` — radar symulowany: 15 s przy biurku / 15 s poza. Cała logika
(przełączanie, panel, auto-heal) działa bez sprzętu. Przełączenia mock wykonują
realne `SoundVolumeView /SetDefault`, więc przy obecnym narzędziu zobaczysz faktyczną
zmianę mikrofonu.

---

## 12. Struktura projektu

```
├── main.js → przeniesione do src/main/index.js
├── src/
│   ├── main/                    # proces główny Electron
│   │   ├── index.js             # tray, okno, IPC, autostart, samoleczenie
│   │   ├── config.js            # konfiguracja + domyślne wartości
│   │   ├── audioController.js   # kontroler audio (ensure narzędzia, wykrywanie)
│   │   ├── soundVolumeView.js   # pobieranie narzędzia, eksport CSV, /SetDefault
│   │   ├── radarListener.js     # port COM, parsery, histereza, auto-reconnect
│   │   └── appController.js     # state machine: tryby + przełączanie (pending)
│   ├── preload/                 # bridge IPC (contextBridge)
│   │   └── index.js
│   └── renderer/                # panel ustawień (React + TS + Vite)
│       ├── index.html
│       └── src/  (main.tsx, App.tsx, styles.css, global.d.ts)
├── bin/                         # opcjonalna kopia SoundVolumeView.exe
├── config.json                  # konfiguracja dev
├── electron.vite.config.mjs     # konfiguracja builda (main/preload/renderer)
├── tsconfig.json
└── package.json
```

---

## 13. Rozwiązywanie problemów

| Objaw                                | Przyczyna / rozwiązanie                                          |
|--------------------------------------|------------------------------------------------------------------|
| „Nie udało się ustawić mikrofonu”    | brak `SoundVolumeView.exe` → sprawdź auto-pobranie (sieć) lub wrzuć do `bin/` |
| zła nazwa w configu                  | użyj „Wykryj urządzenia nagrywające” albo wpisz nazwę z SoundVolumeView |
| radar nie wykryty (COM)              | sprawdź VID/PID (sec. 5.3); odłącz/podłącz USB; wybierz port ręcznie |
| przełączanie na chwilę zanika        | zwiększ `timeoutAwayMs` (histereza)                              |
| brak reakcji po zmianie ustawień     | zmiana mock/baud/port restartuje radar automatycznie             |
| Chrome: „Unable to move the cache”   | drobny błąd GPU cache — nie wpływa na działanie                  |

---

## 14. Uwagi / dalszy rozwój

- Firmware ESP32-C6: wystarczy pętla odczytująca status MR60BHA2 i wysyłająca
  `{"presence":0|1}` po UART (format JSON z sekcji 5.1).
- Opcjonalnie: wgranie ramek binarnych MR60BHA2 bezpośrednio (sekcja 5.2) —
  XIAO passthrough UART→USB.
- Możliwość podmiany narzędzia audio na natywny addon (np. `win-audio-fork`) —
  wymaga Visual Studio/prebuildów; obecnie używany SoundVolumeView (zero kompilacji).

---

## 15. Licencja

MIT