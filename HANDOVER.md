# HANDOVER — DeskSense / MR60BHA2 (kot vs użytkownik)

Przekazanie wiedzy dla kolejnego agenta. Data: 27.08.2026. Stan: FW = stock V4.3.1 (działa).

## 1. Cel

DeskSense (Electron, Windows) przełącza domyślny mikrofon wg obecności użytkownika
przy biurku, wykrywanej radarem mmWave **Seeed MR60BHA2 na XIAO ESP32-C6** (USB/COM3).

Problem: MR60BHA2 raportuje dystans/tętno/oddech tylko dla JEDNEGO (najsilniejszego)
celu. Kot przy biurku "podkrada" odczyt → apka może błędnie wygaszać obecność
(fałszywe AWAY → mikrofon na słuchawki, gdy użytkownik siedzi).

## 2. Protokół MR60BHA2 (ZWERYFIKOWANE wobec kodu ESPHome)

- Ramki natywne: SOF `0x01`, id BE(2), len BE(2), type BE(2), head cksum (XOR ~inv), data, data cksum.
- **Wszystkie pola numeryczne są byte-swapped**: czytaj odwrócone → LE.
  W apce: `payloadFloat(p)` = `Buffer.from([p[3],p[2],p[1],p[0]]).readFloatLE(0)`; `payloadU32` analogicznie.
- Typy (ESPHome / moduł):
  - `0x0F09` obecność: u16 reversed, `!=0`
  - `0x0A16` dystans: `[u32 rangeFlag][f32 odległość]` — **float na offsecie 4**, wartość w **cm**
    (log: `74.62000 cm`, brak filtra w YAML). Heurystyka: `f<10 ? f*100 : f`.
  - `0x0A15` tętno f32 swapped, `0x0A14` oddech f32 swapped
  - `0x0A04`/`0x0A08` point cloud: `[u32 liczba celów swapped] + N×{x f32, y f32, dop i32, cluster i32}` (wszystko swapped)
- **Format logów ESPHome zależy od wersji**:
  - stary: `'Entity': Sending state 74.62 cm`
  - nowy (V4.3.1): `'Entity' >> 74.62 cm` — także binarny sensor obecności `'Person Information' >> ON`
  - Apka parsuje OBA (regex w `radarListener.ts` ~linia 461 + fallbacki).

## 3. Zmiany w apce (ta sesja) — stan: typecheck ✓, portable zbudowany

- `src/shared/types.ts`: `radarAmbiguityGuardEnabled` (config), `distanceTrusted`, `targetCount` (telemetry).
- `src/main/config.ts`: `radarAmbiguityGuardEnabled: true` (default).
- `src/main/radarListener.ts`:
  - parser `>>` + `Sending state`,
  - `targetCount` z linii `'Target Number'` + binarnie `0x0A04/0x0A08`,
  - **guard niejednoznaczności** (`radarAmbiguous`): sygnały = `multiTarget` (`targetCount>=2`)
    OR `petAfterHuman` (pet vitals w 10s po ludzkim tętnie, `lastHumanHrAt`),
  - **NIE używaj rozpiętości dystansu** (usunięte!): moduł naturalnie oscyluje 57-80 cm
    przy ruszającym się człowieku — dawało fałszywe "CEL NIEPEWNY" bez kota,
  - gdy ambiguous: bramka odległości / filtr zwierzaka / mismatch NIE nadpisują obecności;
    auto-tuner nie karmiony; `outOfGateStreak` resetowany przy wejściu w ambiguity,
  - fix binarnego `0x0A16` (float na offset 4),
  - watchdog decay `targetCount` (stale → `undefined`),
  - **`telemetry.targetCount` default = `undefined`** (nie 0!) — 0 = brak danych.
- `src/renderer/src/main.ts`: raport "Kopiuj dla AI" = 200 ramek bez szumu
  (wyklucza lux `bh1750`/`Illuminance`, dedup powtórek, RADAR-DSP tylko przy zmianie wartości);
  scope pokazuje "⚠️ Cel niepewny"; raport pokazuje `Cele: —` gdy brak danych.

## 4. FIRMWARE — ROZSTRZYGNIĘTE (ważne!)

- Urządzenie było **pre-flashed przez Seeed**: stary ESPHome (`Sending state`, **bez** `num_targets`).
- **Stock V4.3.1** (`firmware/seeedstudio-mr60bha2-kit-esp32c6.factory.bin`, GitHub Releases Seeed,
  wydany 2026-02-28, budowany CI esphome stable ~2026.2.2):
  MA `num_targets`, loguje `>>`, **DZIAŁA — ZWERYFIKOWANE** (sensory płyną, `'Target Number' >> 1`,
  `'Person Information' >> ON`). **To jest obecny FW na urządzeniu i REKOMENDACJA.**
- **Wszystkie lokalne custom buildy ŁAMIĄ sensory** (WiFi/API/HA działają, ZERO logów sensorów):
  1. esphome **2026.8.1** + external `limengdu/...@main` + heartbeat → brak sensorów
  2. 2026.8.1 + external bez heartbeat → brak
  3. 2026.8.1 + **wbudowane** `seeed_mr60bha2` + `bh1750` → brak
  4. 2026.8.1 + **oryginalny kit YAML 1:1** → brak  ← definitywnie toolchain, nie YAML/komponent
  5. esphome **2026.2.2** (era CI) → **NIE KOMPILUJE SIĘ**: platforma
     `pioarduino/platform-espressif32 55.03.37` + framework-espidf 5.5.2 → 
     `Failed to resolve component 'esp_hal_ieee802154'` (brakujący komponent w pioarduino).
- **Wniosek**: to lokalny toolchain (PlatformIO lokalny vs Docker CI Seeed). Prawdopodobny
  winowajca dla 2026.8.1: esp-idf 5.5.5 UART na esp32-c6 (UART RX nie dostarcza ramek).
  NIE odtwarzane lokalnie — patrz "Następne kroki".

## 5. Jak kompilować (działająca metoda lokalna — ale wyniki ZŁAMANE, patrz §4)

- Python 3.13 + pip, esphome **2026.8.1** (`pip install esphome`). 2026.2.2 też działa pip (ale nie kompiluje).
- **ESP-IDF nie buduje pod Git Bash**: `idf_tools.py` sprawdza `'MSYSTEM' in os.environ`
  → "MSys/Mingw is not supported". `env -u` NIE działa (bash tool reinicjalizuje env).
  **Fix: wrapper Pythona** usuwający klucze MSYS z `os.environ` przed startem esphome:
  `C:\Users\Monra\AppData\Local\Temp\opencode\run_esphome.py`
- Kompilacja: `python run_esphome.py compile <yaml>` (workdir `firmware/`).
- Wynik: `.esphome/build/seeedstudio-mr60bha2-kit/build/firmware.factory.bin`
- Flash: `python -m esptool --chip esp32c6 --port COM3 --baud 460800 write_flash 0x0 <factory.bin>`
  (**najpierw `taskkill -F -IM DeskSense.exe`** — apka trzyma COM3; w bashu `taskkill /F` się psuje, użyj `-F`).
- Port: COM3, ESP32-C6 (VID 303A PID 1001). USB-CDC wymaga DTR/RTS
  (`port.set({dtr:true,rts:true})`); po resecie odczekaj na re-enumerację portu.
- WiFi: `M_2.4g` / `grandlinerayman33` (użytkownik nie dba o ekspozycję). V4.3.1 i tak łączy
  się po zapisanych w NVS danych — nowy flash NIE kasuje NVS (partycja poza zakresem 1MB).

## 6. Pliki firmware (`firmware/`)

| plik | status |
|---|---|
| `seeedstudio-mr60bha2-kit-esp32c6.factory.bin` | stock V4.3.1 — **DZIAŁA, obecny FW** |
| `kit-original.yaml` | oryginalny kit YAML z Seeed main (1:1) |
| `kit-original-local.factory.bin` | lokalny build 2026.8.1 tego YAML — sensory martwe |
| `seeedstudio-mr60bha2-kit-stable.yaml` | wbudowane komponenty + WiFi + heartbeat (sensory martwe) |
| `DeskSense-MR60BHA2-stable.factory.bin` | build z powyższego |
| `seeedstudio-mr60bha2-kit-heartbeat.yaml` | external component + heartbeat (martwe) |
| `seeedstudio-mr60bha2-kit-nohb.yaml` | external component bez heartbeat (martwe) |
| `DeskSense-MR60BHA2-heartbeat.factory.bin` / `-nohb.factory.bin` | buildy |

## 7. Następne kroki (gdyby custom FW był potrzebny)

1. **Docker**: buduj przez `esphome/esphome` image (to, co robi CI Seeed) — spójny toolchain.
   Na tej maszynie brak dockera.
2. Albo napraw platformę: override `platform_version` w `platformio_options` na nowszy
   `pioarduino/platform-espressif32` (55.03.38+?), który zawiera `esp_hal_ieee802154`.
3. Albo znajdź wersję esphome między 2026.2 a 2026.8, która i kompiluje, i daje UART RX na c6.
4. Cel: wbudowane komponenty + `num_targets` heartbeat 5s + WiFi → sensory działają.
5. **Bez custom FW apka też działa**: V4.3.1 raportuje liczbę celów na ZMIANĘ — gdy kot
   wchodzi/wychodzi, `Target Number` się zmienia → apka łapie `Cele: 2` → guard trzyma obecność.
   Jedyna luka: start apki przy już-stabilnej liczbie → "Cele: —" (guard drzemie do zmiany).

## 8. Inne fakty sesji

- HA 2026.8.3 (192.168.1.30) łączy się do API urządzenia (192.168.1.195, WiFi M_2.4g).
- Apka build: `node scripts/build.mjs portable` → `releases/DeskSense (Portable).exe` (build ubija DeskSense).
- `npm run typecheck` przechodzi.
- Przycisk "Kopiuj dla AI": 200 przefiltrowanych logów (bez lux-spamu, dedup).
- Test "Kopiuj dla AI" z nowym FW: raport pokazuje `Cele: —` dopóki liczba się nie zmieni.