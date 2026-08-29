# AGENTS.md — zasady pracy i wiedza o projekcie

Instrukcje dla agentów AI i deweloperów pracujących nad tym repozytorium.

## Projekt

**DeskSense** (by Monra) — automatyczne przełączanie domyślnego mikrofonu Windows wg obecności
użytkownika przy biurku (radar mmWave Seeed MR60BHA2 na XIAO ESP32-C6 przez USB/COM).
Aplikacja Electron działa w System Tray. Język komunikatów UI i komentarzy: **polski**.

## Stack

- Electron 44 + electron-vite 5 + electron-builder 26
- TypeScript strict (main, preload, renderer — wszystko w `src/**/*`)
- `serialport` (native), `esptool-js` (firmware flasher), `adm-zip`, `iconv-lite`
- Natywny moduł audio: C# `src/native/AudioSwitcher.exe` (CoreAudio daemon), kompilowany `csc.exe` z .NET Framework 4
- Renderer: Vanilla TS (bez Reacta), bundle ~65 kB

## Struktura

```
scripts/build.mjs          # cały pipeline builda (UŻYWAJ GO, nie gołego electron-builder!)
src/shared/types.ts        # jedyne źródło prawdy typów (main + preload + renderer)
src/main/index.ts          # kompozyt; logika w modułach poniżej
src/main/appContext.ts     # kontekst DI (AppContext), ścieżki, autostart, cleanup %TEMP%, toggleMuteWithFeedback
src/main/config.ts         # Config (atomic save + .bak) i DEFAULTS AppConfig
src/main/appController.ts  # spina radar -> audio/Discord/signalrgb/screen; snooze, retry, watchdog driftu
src/main/radarListener.ts  # COM/ESPHome parser radaru, filtry DSP, bramki, LED sensora
src/main/autoTuner.ts      # adaptacyjna strefa fotela (persist do configu)
src/main/signalFilter.ts   # MedianFilter / DistanceFilter / BiometricFilter / IlluminanceFilter
src/main/activityWatcher.ts # aktywność wejściowa (powerMonitor) — ratunek obecności
src/main/deviceWatcher.ts  # watchdog mikrofonów i portów COM (push events)
src/main/screenManager.ts  # czarny wygaszacz (niezależny od DPMS) + DPMS, overlay per-monitor
src/main/audioController.ts # fasada audio -> soundVolumeView
src/main/soundVolumeView.ts # daemon AudioSwitcher.exe (stdin/stdout) + fallback CLI/kompilacja
src/main/discordIntegration.ts # Discord RPC: OAuth, synchronizacja wejścia, profile głosu
src/main/signalrgbIntegration.ts # SignalRGB REST (away/desk akcje oświetlenia)
src/main/haIntegration.ts  # Home Assistant WebSocket: zewnętrzna telemetria radaru
src/main/updater.ts        # GitHub Releases: check/download/install
src/main/diagRecorder.ts   # rejestrator surowego strumienia radaru (kalibracja progów)
src/main/diagSession.ts    # sesja diagnostyczna "Wyjście z pokoju"
src/main/logger.ts         # ring buffer logów diagnostycznych
src/main/tray.ts           # ikony + menu tray
src/main/settingsWindow.ts # okno ustawień
src/main/ipc.ts            # handlery IPC
src/native/*.cs            # AudioSwitcher (audio CoreAudio daemon), IconGenerator (ikony .ico/.png)
bin/                       # skompilowane EXE natywne (trackowane w git!)
releases/                  # artefakty do publikacji (*.exe NIE są w gicie — patrz niżej)
```

## Komendy

```bash
npm run typecheck        # tsc --noEmit strict — MUSI przechodzić przed commitem
npm run dev              # dev z HMR
node scripts/build.mjs all        # portable + installer
node scripts/build.mjs portable   # tylko portable
npm run package:installer         # tylko NSIS
```

1. **Integralność instalatora NSIS & Ikony**:
   NIGDY nie modyfikuj binarek instalatora NSIS (`Setup *.exe`) zewnętrznymi narzędziami
   (rcedit, `BeginUpdateResource` z Windows API) po zbudowaniu przez `electron-builder`.
   NSIS wbudowuje wewnętrzną sumę kontrolną CRC (`CRCCheck`) — jakakolwiek modyfikacja nagłówków PE
   lub sekcji `.rsrc` po fakcie powoduje błąd "NSIS Error: Installer integrity check has failed".
   Ikony (`build/icon.ico`, `build/icon.png`, `resources/*`) są generowane przez `IconGenerator.cs`
   w punkcie 2 `scripts/build.mjs` PRZED wywołaniem electron-builder, dzięki czemu electron-builder
   i makensis wbudowują je natywnie i poprawnie w instalator, portable oraz aplikację.

2. **Wiszący build**: stara instancja apki (tray!) blokuje pliki wyjściowe → makensis czeka
   W NIESKOŃCZONOŚCI ("output file is locked for writing"). `build.mjs` ubija procesy
   `DeskSense*` przed pakowaniem. Zawsze buduj przez `node scripts/build.mjs`.

3. **esptool-js MUSI być wbundlowany**: surowe ESM z importami bez rozszerzeń (`./util`)
   → crash `ERR_MODULE_NOT_FOUND` na starcie w packaged app.
   `electron.vite.config.mjs`: `externalizeDepsPlugin({ exclude: ['esptool-js'] })`.

4. **latest.yml & blockmap**: electron-builder generuje `latest.yml` oraz `.blockmap` w `dist/`.
   `build.mjs` kopiuje je do `releases/` w stanie nienaruszonym (hashe sha512 i rozmiary
   są idealnie zsynchronizowane z instalatorem).

5. **GitHub limit 100 MB/plik**: `releases/*.exe` są w `.gitignore`. Binarki trafiają
   na GitHub Releases (updater pobiera je stamtąd przez API). Nie commituj ich.

6. **Push protection**: żadnych tokenów/PAT w kodzie. `githubToken` pochodzi z env
   `GITHUB_TOKEN` lub `%APPDATA%/Audio Switcher/config.json` (niezależny od repo).

7. **productName** siedzi w `package.json → build.productName` (NIE top-level).

8. **Ikony w packaged app**: dev czyta z `build/`, paczka z `resources/resources/icon.png`
   (extraResources). Używaj helperów z `appContext.ts`, nie hardcode'uj ścieżek.

9. **Firmware Sensora & Flashowanie (XIAO ESP32-C6 + MR60BHA2)**:
   - **Hardware**: XIAO ESP32-C6 (4MB Flash, USB-CDC), radar MR60BHA2 (RX:17, TX:16, 115200), dioda WS2812 (GPIO1), czujnik światła BH1750 (I2C SDA:22, SCL:23, adres 0x23).
   - **Kod źródłowy**: `firmware/DeskSense_XIAO_ESP32C6/DeskSense_XIAO_ESP32C6.ino` (DeskSense Native OS v1.5.0 — fuzja obecności z dowodami żywotności + heartbeat FW/UPTIME/TEMP).
   - **Kompilacja i flashowanie przez arduino-cli**:
     ```powershell
     # 1. Zawsze ubij DeskSense przed otwarciem portu COM3:
     Get-Process | Where-Object { $_.ProcessName -like "*DeskSense*" } | Stop-Process -Force -ErrorAction SilentlyContinue
     
     # 2. Kompilacja:
     & "C:\Users\Monra\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "d:\MicrophoneTool\firmware\DeskSense_XIAO_ESP32C6"
     
     # 3. Wgrywanie (Upload):
     & "C:\Users\Monra\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "d:\MicrophoneTool\firmware\DeskSense_XIAO_ESP32C6"
     ```
   - **Wgrywanie stock ESPHome (.bin fallback)**:
     ```powershell
     python -m esptool --chip esp32c6 --port COM3 --baud 460800 write_flash 0x0 "d:\MicrophoneTool\firmware\seeedstudio-mr60bha2-kit-esp32c6.factory.bin"
     ```
   - **Ważne dla portu szeregowego USB-CDC**: ESP32-C6 wymaga `port.set({ dtr: true, rts: true })` po otwarciu portu w Node.js `serialport`.
   - **Komendy sterujące PC -> ESP32**: `SET:LED=R,G,B,BRI\r\n` (sterowanie diodą WS2812 w locie), `CMD:REBOOT\r\n`.

## Zasady pracy

1. **Weryfikacja obowiązkowa** przed zgłoszeniem końca pracy:
   - `npm run typecheck` — zero błędów.

2. **Typy**: nowe interfejsy IPC/dane → `src/shared/types.ts`, nigdy lokalne duplikaty.
   Main/preload/renderer korzystają z tych samych definicji.

3. **Moduły**: nowa logika main process → osobny moduł, dostęp przez `AppContext`.
   Nie wracamy do mega-index.js ani globalnego stanu.

4. **Komentarze**: polski (istniejąca konwencja), tylko tam gdzie nieoczywiste.
   Bez emoji w kodzie.

5. **Commit messages**: Conventional Commits (feat/fix/refactor/perf/docs/chore),
   temat ≤ 50 znaków, body po angielsku lub polsku opisujące DLACZEGO.

6. **Nie ruszać** bez potrzeby: `src/native/AudioSwitcher.cs` (stabilny, COM/IPolicyConfig),
   kolejność kroków w `scripts/build.mjs` (patch ikon PRZED re-hash latest.yml jest celowy).

7. **Ścieżki Windows**: buduj przez `path.join`, porty COM przez VID/PID z
   `KNOWN_VID_PIDS` (radarListener.ts).

8. Testy E2E nie istnieją — wystarczy weryfikacja przez `npm run typecheck`.
