# AGENTS.md — zasady pracy i wiedza o projekcie

Instrukcje dla agentów AI i deweloperów pracujących nad tym repozytorium.

## Projekt

**DeskSense** (by Monra) — automatyczne przełączanie domyślnego mikrofonu Windows wg obecności
użytkownika przy biurku (radar mmWave Seeed MR60BHA2 na XIAO ESP32-C6 przez USB/COM).
Aplikacja Electron działa w System Tray. Język komunikatów UI i komentarzy: **polski**.

## Stack

- Electron 43 + electron-vite 5 + electron-builder 26
- TypeScript strict (main, preload, renderer — wszystko w `src/**/*`)
- `serialport` (native), `esptool-js` (firmware flasher), `adm-zip`, `iconv-lite`
- Natywny moduł audio: C# `src/native/AudioSwitcher.exe` (CoreAudio daemon), kompilowany `csc.exe` z .NET Framework 4
- Renderer: Vanilla TS (bez Reacta), bundle ~65 kB

## Struktura

```
scripts/build.mjs          # cały pipeline builda (UŻYWAJ GO, nie gołego electron-builder!)
src/shared/types.ts        # jedyne źródło prawdy typów (main + preload + renderer)
src/main/index.ts          # kompozyt; logika w modułach poniżej
src/main/appContext.ts     # kontekst DI (AppContext), ścieżki, autostart, cleanup %TEMP%
src/main/logger.ts         # ring buffer logów diagnostycznych
src/main/tray.ts           # ikony + menu tray
src/main/settingsWindow.ts # okno ustawień
src/main/ipc.ts            # handlery IPC
src/native/*.cs            # AudioSwitcher (audio), IconPatcher (ikony PE), IconGenerator
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

## Krytyczne pułapki (nauczone boleśnie)

1. **PE overlay / IconPatcher**: `BeginUpdateResource` (Windows API) GUBI overlay pliku PE.
   Instalatory NSIS/portable trzymają cały payload (~105 MB) w overlay — patchowanie ikony
   bez zapisania i doklejenia overlay'a UCIĄŁO binarki do ~400 KB (martwe EXE).
   `src/native/IconPatcher.cs` robi to poprawnie — nie usuwaj tej logiki.
   `build.mjs` ma guard: fail hard gdy rozmiar po patchu < 90% przed patchem.

2. **Wiszący build**: stara instancja apki (tray!) blokuje pliki wyjściowe → makensis czeka
   W NIESKOŃCZONOŚCI ("output file is locked for writing"). `build.mjs` ubija procesy
   `DeskSense*` przed pakowaniem. Nie testuj ręcznie gołym electron-builderem.

3. **esptool-js MUSI być wbundlowany**: surowe ESM z importami bez rozszerzeń (`./util`)
   → crash `ERR_MODULE_NOT_FOUND` na starcie w packaged app.
   `electron.vite.config.mjs`: `externalizeDepsPlugin({ exclude: ['esptool-js'] })`.

4. **latest.yml**: electron-builder zapisuje w nim ZSANITOWANE nazwy plików
   (`DeskSense-Setup-0.2.0.exe`) a realny plik ma spacje. Po patchu ikon hash'e
   są przeliczane w `build.mjs` (dopasowanie po normalizacji, oba formaty yml).
   Nie kopiuj latest.yml z dist/ bezpośrednio.

5. **GitHub limit 100 MB/plik**: `releases/*.exe` są w `.gitignore`. Binarki trafiają
   na GitHub Releases (updater pobiera je stamtąd przez API). Nie commituj ich.

6. **Push protection**: żadnych tokenów/PAT w kodzie. `githubToken` pochodzi z env
   `GITHUB_TOKEN` lub `%APPDATA%/Audio Switcher/config.json` (niezależny od repo).

7. **productName** siedzi w `package.json → build.productName` (NIE top-level).

8. **Ikony w packaged app**: dev czyta z `build/`, paczka z `resources/resources/icon.png`
   (extraResources). Używaj helperów z `appContext.ts`, nie hardcode'uj ścieżek.

## Zasady pracy

1. **Weryfikacja obowiązkowa** przed zgłoszeniem końca pracy:
   - `npm run typecheck` — zero błędów,
   - przy zmianach main process: `node scripts/build.mjs portable` + smoke test:
     ```powershell
     Start-Process 'D:\MicrophoneTool\releases\DeskSense (Portable).exe'
     Start-Sleep 12; Get-Process | Where-Object { $_.Name -like 'DeskSense*' }
     # potem: Get-Process ... | Stop-Process -Force
     ```
   - "5 processes alive" = OK; brak procesów = crash main process.

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

8. Testy E2E nie istnieją — jedynym testem integracyjnym jest smoke test uruchomienia
   portable + `npm run typecheck`. Nie mockować tego pomijając.
