# DeskSense Firmware & Configurations

Katalog zawiera wsady Native OS (Arduino C++) oraz konfiguracje ESPHome dla sensorów radaru mmWave używanych z DeskSense.

---

## Dostępne Sensory i Konfiguracje

| Sensor | Częstotliwość | Przeznaczenie | Typowy czas odejścia | Plik ESPHome YAML | Wsad Native OS (Arduino) |
|---|---|---|---|---|---|
| **Seeed Studio MR60BHA2 Kit** | 60 GHz | Precyzyjna biometria (oddech, tętno, sen, światło BH1750, LED WS2812) | ~25–30 s (sprzętowy bufor snu) | `seeedstudio-mr60bha2-60ghz.yaml` | `DeskSense_XIAO_ESP32C6/` |
| **Seeed Studio 24GHz for XIAO (101010001)** | 24 GHz | Błyskawiczna detekcja strefowa biurka (obecność statyczna i ruchoma) | **1–3 s** (natychmiastowe cięcie) | `seeedstudio-24ghz-xiao.yaml` | `DeskSense_24GHz_XIAO/` |

---

## 1. Wgrywanie wsadu Native OS (Arduino CLI)

### Sensor 60GHz (Seeed MR60BHA2 Kit)
```powershell
# Kompilacja:
& "C:\Users\Monra\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "d:\MicrophoneTool\firmware\DeskSense_XIAO_ESP32C6"

# Wgrywanie na port COM3:
& "C:\Users\Monra\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "d:\MicrophoneTool\firmware\DeskSense_XIAO_ESP32C6"
```

### Sensor 24GHz (Seeed 101010001 Shield for XIAO)
```powershell
# Kompilacja:
& "C:\Users\Monra\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "d:\MicrophoneTool\firmware\DeskSense_24GHz_XIAO"

# Wgrywanie na port COM3:
& "C:\Users\Monra\AppData\Local\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" upload -p COM3 --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc "d:\MicrophoneTool\firmware\DeskSense_24GHz_XIAO"
```

---

## 2. Wgrywanie wsadu ESPHome

### Kompilacja i wgranie przez ESPHome CLI:
```powershell
# Dla sensora 60GHz:
esphome run seeedstudio-mr60bha2-60ghz.yaml

# Dla sensora 24GHz:
esphome run seeedstudio-24ghz-xiao.yaml
```

---

## 3. Komunikacja Passthru PC <-> Sensor
Oba firmware'y Native OS przesyłają surowe linie tekstowe kompatybilne z DeskSense:
- `'Person Information' >> ON` / `'Person Information' >> OFF`
- `'Distance to detection object' >> XX.XX cm`
- Heartbeat co 5 s: `[DeskSense] DeskSense Device FW=... SENSOR=MR60BHA2|SEEED_24GHZ UPTIME=...s TEMP=...C`
- Passthru komend: aplikacja DeskSense może wysyłać komendy UART bezpośrednio do radaru.
