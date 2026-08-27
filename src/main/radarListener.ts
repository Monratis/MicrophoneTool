import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import AutoTuner from './autoTuner';
import { MedianFilter, ExponentialSmoothingFilter, PresenceDebounceFilter, DistanceFilter, IlluminanceFilter } from './signalFilter';
import { appendLog } from './logger';
import type Config from './config';
import type { DeskState, DetectedPerson, RadarTelemetry } from '../shared/types';

const KNOWN_VID_PIDS = [
  { vid: 0x2886, pid: 0x802d },
  { vid: 0x303a, pid: 0x1001 },
  { vid: 0x303a, pid: 0x1002 },
  { vid: 0x1a86, pid: 0x7523 },
  { vid: 0x1a86, pid: 0x55d4 },
  { vid: 0x10c4, pid: 0xea60 }
];

type PortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number];

interface RadarStatusEvent {
  port?: string;
  connected?: boolean;
  error?: string;
  nextReconnectMs?: number;
  presence?: boolean;
  state?: DeskState | null;
  pendingState?: DeskState;
  telemetry?: RadarTelemetry;
  since?: number;
}

interface Sample {
  distanceCm: number;
  heartRate: number;
  breathRate: number;
  isSeated: boolean;
  rawPresence: boolean;
}

type SerialPortCtor = typeof SerialPort;

export default class RadarListener extends EventEmitter {
  private readonly config: Config;
  private readonly autoTuner: AutoTuner;

  port: InstanceType<typeof SerialPort> | null = null;
  private SerialPortCtor: SerialPortCtor | null = null;

  presence = false;
  state: DeskState | null = null;
  private deskTimer: NodeJS.Timeout | null = null;
  private awayTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  reconnectAttempts = 0;
  private lastPortName: string | null = null;
  private petStreak = 0;
  private lineBuffer = '';
  private rawBuffer: Buffer = Buffer.alloc(0);

  // Znaczniki czasu dla niezależnego wygaszania telemetrycznego i watchdoga ciszy
  private lastPresencePacketTime = 0;
  private lastDistanceTime = 0;
  private lastHeartRateTime = 0;
  private lastBreathRateTime = 0;
  private lastAnyPacketTime = 0;
  private lastTargetCountTime = 0;

  // Cyfrowe filtry DSP dla całkowitej stabilizacji sygnału
  private distanceFilter = new DistanceFilter();
  private heartMedian = new MedianFilter(5);
  private heartEMA = new ExponentialSmoothingFilter(0.16, 2.0);
  private breathMedian = new MedianFilter(5);
  private breathEMA = new ExponentialSmoothingFilter(0.16, 1.5);
  private illuminanceFilter = new IlluminanceFilter(0.15, 2.0);
  private presenceFilter = new PresenceDebounceFilter(2000);
  private outOfGateStreak = 0;
  private lastLoggedLux: number | null = null;

// Wykrywanie niejednoznaczności celu: MR60BHA2 raportuje dystans/biometrię tylko
// dla JEDNEGO (najsilniejszego) celu. Kot obok użytkownika może "podkraść" odczyt.
// UWAGA: rozpiętość surowego dystansu NIE jest sygnałem kota — moduł naturalnie
// oscyluje 57-80 cm przy ruszającym się człowieku. Polegamy wyłącznie na twardych
// sygnałach: liczbie celów (>=2) i sygnaturze zwierzaka po ludzkim tętnie.
private radarAmbiguous = false;
  private ambigStreak = 0;
  private lastHumanHrAt = 0;

  telemetry: RadarTelemetry;

  constructor(config: Config) {
    super();
    this.config = config;
    this.autoTuner = new AutoTuner(config);
    this.telemetry = {
      presence: false,
      distanceCm: 0,
      distanceTrusted: true,
      targetCount: undefined,
      heartRate: 0,
      breathRate: 0,
      illuminanceLux: undefined,
      detectedPerson: 'unknown' as DetectedPerson,
      autoTuning: this.autoTuner.getStatus(),
      lastUpdate: 0
    };
  }

  private async loadSerialPort(): Promise<SerialPortCtor> {
    if (!this.SerialPortCtor) {
      const m = await import('serialport');
      const Ctor = (m.SerialPort || m.default?.SerialPort) as SerialPortCtor | undefined;
      if (!Ctor) {
        throw new Error('serialport: nie znaleziono eksportu SerialPort');
      }
      this.SerialPortCtor = Ctor;
    }
    return this.SerialPortCtor;
  }

  static async listPorts(): Promise<PortInfo[]> {
    try {
      return await SerialPort.list();
    } catch (err) {
      console.error('[radar] listPorts error:', (err as Error).message);
      return [];
    }
  }

  async start(): Promise<void> {
    this.running = true;
    this.reconnectAttempts = 0;
    this.startWatchdog();
    await this.openPort();
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.onWatchdogTick(), 1000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private onWatchdogTick(): void {
    if (!this.running) return;
    const now = Date.now();

    let telemetryChanged = false;

    // Gdy obecność jest aktywna (presence == true), NIE wygaszamy dystansu ani filtrów!
    // Radar Seeed w spoczynku wysyła dystans co kilka sekund.
    // Dystans jest zerowany wyłącznie gdy użytkownik naprawdę opuści biurko (handleRawPresence(false)).
    if (!this.presence) {
      if (this.telemetry.distanceCm && this.lastDistanceTime > 0 && now - this.lastDistanceTime > 3500) {
        this.telemetry.distanceCm = 0;
        this.telemetry.distanceTrusted = true;
        this.distanceFilter.reset();
        this.radarAmbiguous = false;
        this.ambigStreak = 0;
        telemetryChanged = true;
      }
      if (this.telemetry.heartRate && this.lastHeartRateTime > 0 && now - this.lastHeartRateTime > 3500) {
        this.telemetry.heartRate = 0;
        this.heartMedian.reset();
        this.heartEMA.reset();
        telemetryChanged = true;
      }
      if (this.telemetry.breathRate && this.lastBreathRateTime > 0 && now - this.lastBreathRateTime > 3500) {
        this.telemetry.breathRate = 0;
        this.breathMedian.reset();
        this.breathEMA.reset();
        telemetryChanged = true;
      }
    } else {
      // W trakcie aktywnej obecności wygaszamy biometrię tylko przy bardzo długiej ciszy (>25s)
      if (this.telemetry.heartRate && this.lastHeartRateTime > 0 && now - this.lastHeartRateTime > 25000) {
        this.telemetry.heartRate = 0;
        telemetryChanged = true;
      }
      if (this.telemetry.breathRate && this.lastBreathRateTime > 0 && now - this.lastBreathRateTime > 25000) {
        this.telemetry.breathRate = 0;
        telemetryChanged = true;
      }
    }

    // Wygaszanie liczby celów — sensor przestał raportować point cloud
    if (this.telemetry.targetCount !== undefined && this.lastTargetCountTime > 0 && now - this.lastTargetCountTime > 6000) {
      this.telemetry.targetCount = undefined;
      this.updateAmbiguity();
      telemetryChanged = true;
    }

    if (telemetryChanged) {
      this.evaluateBiometrics();
      this.scheduleTelemetry();
    }

    // 2. Watchdog obecności: jeśli aplikacja uważa, że użytkownik jest przy biurku,
    // ale od >8000 ms nie przyszedł ŻADEN pakiet z portu szeregowego
    if (this.presence) {
      const lastActiveTime = Math.max(
        this.lastPresencePacketTime,
        this.lastDistanceTime,
        this.lastHeartRateTime,
        this.lastBreathRateTime,
        this.lastAnyPacketTime
      );
      const silenceDuration = lastActiveTime > 0 ? now - lastActiveTime : 8000;

      if (silenceDuration > 8000) {
        appendLog(
          'RADAR',
          `Brak jakiegokolwiek sygnału z radaru przez ${(silenceDuration / 1000).toFixed(1)}s — automatyczne wygaszenie obecności (watchdog)`
        );
        this.handleRawPresence(false);
      }
    }
  }

  private async releasePortLocks(portName: string): Promise<void> {
    try {
      const currentPid = process.pid;
      const { exec } = await import('node:child_process');
      await new Promise<void>((resolve) => {
        exec(
          `powershell -NoProfile -Command "Get-Process | Where-Object { ($_.Name -like '*AudioSwitcher*' -or ($_.Name -like '*DeskSense*' -and $_.Id -ne ${currentPid})) } | Stop-Process -Force"`,
          () => resolve()
        );
      });
      appendLog('RADAR', `Wymuszono zwolnienie blokad portu ${portName}`);
    } catch {
      /* ignore */
    }
  }

  private async openPort(): Promise<void> {
    if (!this.running) return;
    try {
      const SerialPort = await this.loadSerialPort();
      // stop() mogło przyjść w trakcie await (np. flasher zwalnia port COM)
      if (!this.running) return;
      const portName = await this.resolvePort();
      if (!this.running) return;
      if (!portName) {
        this.emit('status', { connected: false, error: 'brak portu' } satisfies RadarStatusEvent);
        this.scheduleReconnect();
        return;
      }
      this.lastPortName = portName;
      this.lineBuffer = '';
      this.rawBuffer = Buffer.alloc(0);

      // Zwolnij ewentualny stary uchwyt przed otwarciem nowego
      if (this.port) {
        try {
          this.port.removeAllListeners();
          if (this.port.isOpen) this.port.close(() => {});
          this.port.destroy();
        } catch {}
        this.port = null;
      }

      const port = new SerialPort({
        path: portName,
        baudRate: this.config.get('baudRate') || 115200,
        autoOpen: true,
        hupcl: false
      });
      this.port = port;
      port.on('open', () => {
        this.reconnectAttempts = 0;
        try {
          // Na ESP32-C6 USB-CDC DTR=true oraz RTS=true są wymagane
          // do poprawnej sygnalizacji gotowości odbiornika (CDC ACM handshake).
          port.set({ dtr: true, rts: true }, () => {
            try {
              port.flush(() => {
                port.write('\r\n', () => {});
              });
            } catch {}
          });
        } catch {
          /* ignore */
        }
        this.emit('status', { port: portName, connected: true } satisfies RadarStatusEvent);
      });
      port.on('data', (chunk: Buffer) => this.onData(chunk));
      port.on('error', async (err: Error) => {
        try {
          port.removeAllListeners();
          port.destroy();
        } catch {}
        this.port = null;
        appendLog('RADAR', `Błąd portu ${portName}: ${err.message}`);
        this.handleRawPresence(false);
        if (/access denied|locked|ebusy|in use|permission/i.test(err.message)) {
          await this.releasePortLocks(portName);
        }
        this.emit('status', { connected: false, error: err.message } satisfies RadarStatusEvent);
        this.scheduleReconnect();
      });
      port.on('close', () => {
        try {
          port.removeAllListeners();
        } catch {}
        this.port = null;
        this.handleRawPresence(false);
        if (this.running) this.scheduleReconnect();
      });
    } catch (err: any) {
      appendLog('RADAR', `Błąd otwierania portu: ${err.message || err}`);
      this.handleRawPresence(false);
      if (/access denied|locked|ebusy|in use|permission/i.test(String(err.message || err))) {
        await this.releasePortLocks(this.lastPortName || 'COM');
      }
      this.emit('status', { connected: false, error: (err as Error).message } satisfies RadarStatusEvent);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    // Drabina: po wpięciu kabla łączymy się szybko (czułość na replug),
    // potem zwalniamy żeby nie męczyć portu przy dłuższej nieobecności.
    const delay =
      this.reconnectAttempts < 3 ? 600 : this.reconnectAttempts < 8 ? 1500 : 2500;
    this.reconnectAttempts++;
    this.lastPortName = null;
    this.emit('status', { connected: false, nextReconnectMs: delay } satisfies RadarStatusEvent);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openPort();
    }, delay);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopWatchdog();
    if (this.deskTimer) clearTimeout(this.deskTimer);
    if (this.awayTimer) clearTimeout(this.awayTimer);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.port) {
      const p = this.port;
      this.port = null;
      try {
        p.removeAllListeners();
        if (p.isOpen) {
          await new Promise<void>((resolve) => p.close(() => resolve()));
        }
        p.destroy();
      } catch {}
    }
    this.handleRawPresence(false);
  }

  private async resolvePort(): Promise<string | null> {
    const configured = this.config.get('port');
    if (configured && configured !== 'auto') {
      return configured;
    }
    try {
      const ports = await RadarListener.listPorts();
      const match = ports.find(
        (p) =>
          KNOWN_VID_PIDS.some((id) =>
            Boolean(p.vendorId && parseInt(p.vendorId, 16) === id.vid) &&
            (!id.pid || Boolean(p.productId && parseInt(p.productId, 16) === id.pid))
          )
      );
      if (match) return match.path;

      const mfgMatch = ports.find((p) =>
        /seeed|espressif|esp32|silicon labs|ch340|ch9102|ftdi/i.test(p.manufacturer || '')
      );
      if (mfgMatch) return mfgMatch.path;

      if (ports.length > 0) {
        console.warn('[radar] brak znanego VID/PID, wybieram port:', ports[0].path);
        return ports[0].path;
      }
    } catch (err) {
      console.error('[radar] enumerate ports error:', (err as Error).message);
    }
    return null;
  }

  private onData(chunk: Buffer): void {
    this.lastAnyPacketTime = Date.now();
    if (this.listenerCount('raw') > 0) {
      this.emit('raw', chunk.toString('utf8'));
    }

    this.rawBuffer = Buffer.concat([this.rawBuffer, chunk]);
    this.scanBinaryFrames();

    this.lineBuffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.lineBuffer.indexOf('\n')) >= 0) {
      let line = this.lineBuffer.slice(0, idx).trim();
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (!line) continue;

      // Oczyszczanie z sekwencji kolorów ANSI (np. logi ESPHome \x1B[0;36m)
      line = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim();
      if (!line) continue;

      // Binarny strumień przecieka do bufora tekstowego (ramki zawierają
      // bajty 0x0A w polach typu) — linie z niedozwolonymi znakami kontrolnymi odrzucamy.
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(line)) continue;

      // Logowanie surowego odczytu tekstowego z sensora
      appendLog('RADAR-RAW', line);

      // JSON format
      if (line.charCodeAt(0) === 123) {
        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (json.distance !== undefined) {
            const dist = Number(json.distance);
            if (dist > 0) {
              this.updateDistance(dist);
            } else {
              this.updateDistance(0);
              this.handleRawPresence(false);
            }
          }
          if (
            json.heartRate !== undefined ||
            json.heart_rate !== undefined ||
            json.bpm !== undefined
          ) {
            this.updateHeartRate(Number(json.heartRate || json.heart_rate || json.bpm));
          }
          if (
            json.breathRate !== undefined ||
            json.breath_rate !== undefined ||
            json.rpm !== undefined
          ) {
            this.updateBreathRate(Number(json.breathRate || json.breath_rate || json.rpm));
          }
          if (json.presence !== undefined) {
            this.handleRawPresence(Boolean(Number(json.presence)));
            continue;
          }
          if (json.occupied !== undefined) {
            this.handleRawPresence(Boolean(Number(json.occupied)));
            continue;
          }
          if (json.target !== undefined) {
            this.handleRawPresence(Boolean(Number(json.target)));
            continue;
          }
        } catch {
          /* ignore */
        }
      }

      // Hex string format
      if (/^(53\s*59)/i.test(line)) {
        const hex = line.replace(/[^0-9a-fA-F]/g, '');
        if (hex.length >= 8) {
          this.parseBinaryFrame(Buffer.from(hex, 'hex'));
          continue;
        }
      }

      // ESPHome log formats (np. 'Distance to detection object': Sending state 74.62000 cm...)
      // ESPHome log formats (np. 'Distance to detection object': Sending state 74.62000 cm...)
      if (line.includes('state') || line.includes('[sensor') || line.includes('[binary_sensor')) {
        // ESPHome log formats. Starsze firmware loguje 'X': Sending state 74.62 cm,
        // nowsze (np. kit V4.3.1) 'X' >> 74.62 cm. Obsługujemy obie formy.
        const esphomeMatch = line.match(/'([^']+)'\s*(?::\s*(?:Sending state|Got state|state:?)|\s*>>)\s*([^\s,;]+)/i);
        if (esphomeMatch) {
          const entity = esphomeMatch[1].toLowerCase();
          const stateVal = esphomeMatch[2].trim();

          // Natężenie światła / Illuminance (BH1750 z zestawu Seeed)
          if (entity.includes('illuminance') || entity.includes('światł') || entity.includes('lux') || entity.includes('lx')) {
            const lux = parseFloat(stateVal);
            if (Number.isFinite(lux) && lux >= 0) {
              this.updateIlluminance(lux);
            }
          }

          // Dystans: Pomiary > 0 aktualizują filtr i potwierdzają obecność.
          // Zero/brak odczytu NIE gasi obecności (to tylko chwilowy brak locka fazy radaru).
          if (entity.includes('distance') || entity.includes('odległość') || entity.includes('dystans') || entity.includes('detection object')) {
            const val = parseFloat(stateVal);
            if (Number.isFinite(val) && val > 0) {
              const distCm = val < 10 && !line.toLowerCase().includes('cm') ? Math.round(val * 100) : Math.round(val);
              this.updateDistance(distCm);
              this.handleRawPresence(true);
            }
          }

          // Tętno: Pomiary w normie potwierdzają obecność.
          if (entity.includes('heart') || entity.includes('tętno') || entity.includes('bpm')) {
            const bpm = Math.round(parseFloat(stateVal));
            if (bpm >= 30 && bpm <= 240) {
              this.updateHeartRate(bpm);
              this.handleRawPresence(true);
            } else if (bpm === 0) {
              this.updateHeartRate(0);
            }
          }

          // Oddech: Pomiary w normie potwierdzają obecność.
          if (entity.includes('breath') || entity.includes('oddech') || entity.includes('respiratory') || entity.includes('rpm')) {
            const rpm = Math.round(parseFloat(stateVal));
            if (rpm >= 2 && rpm <= 70) {
              this.updateBreathRate(rpm);
              this.handleRawPresence(true);
            } else if (rpm === 0) {
              this.updateBreathRate(0);
            }
          }

          // Liczba wykrytych obiektów (Target Number) — kluczowe dla odróżnienia
          // kota od użytkownika: >=2 cele przy obecnym człowieku = niejednoznaczność.
          // Liczba 0 przy bezruchu NIE gasi obecności.
          if (entity.includes('target number') || entity.includes('targets')) {
            const count = Math.round(parseFloat(stateVal));
            if (Number.isFinite(count) && count >= 0) {
              this.telemetry.targetCount = Math.max(0, Math.min(5, count));
              this.lastTargetCountTime = Date.now();
              this.updateAmbiguity();
              if (count > 0) {
                this.handleRawPresence(true);
              }
              continue;
            }
          }

          // Encje binarne obecności (Person Information, Has Target, Someone Present itp.)
          // To jest NADRZĘDNE ŹRÓDŁO PRAWDY (Primary Hardware Authority) o obecności człowieka.
          if (
            entity.includes('person') ||
            entity.includes('presence') ||
            entity.includes('occupan') ||
            entity.includes('has target') ||
            entity.includes('has_target') ||
            entity.includes('someone') ||
            entity.includes('target_info')
          ) {
            const upperState = stateVal.toUpperCase();
            if (upperState === 'ON' || upperState === 'TRUE' || upperState === '1') {
              this.handleRawPresence(true);
              continue;
            } else if (upperState === 'OFF' || upperState === 'FALSE' || upperState === '0' || upperState === 'CLEAR') {
              this.handleRawPresence(false);
              continue;
            }
          }
        } else {
          // Bezpośrednie dopasowanie illuminance z logu BH1750
          const bhMatch = line.match(/(?:illuminance|natężenie|światło)[^=:]*[=:]\s*([0-9.]+)\s*(?:lx|lux)?/i);
          if (bhMatch) {
            const lux = parseFloat(bhMatch[1]);
            if (Number.isFinite(lux) && lux >= 0) {
              this.updateIlluminance(lux);
            }
          }

          // Fallback dla innych linii logów ESPHome
          const distMatch = line.match(/(?:distance|odległość|Distance to detection object)[^:]*?(?::\s*(?:(?:Got|Sending)\s+state\s+)?|>>\s*)([0-9.]+)/i);
          if (distMatch) {
            const val = parseFloat(distMatch[1]);
            if (val > 0) {
              const distCm = val < 10 && !line.toLowerCase().includes('cm') ? Math.round(val * 100) : Math.round(val);
              this.updateDistance(distCm);
              this.handleRawPresence(true);
            }
          }
          const hrMatch = line.match(/(?:heart|tętno|Real-time heart rate|bpm)[^:]*?(?::\s*(?:(?:Got|Sending)\s+state\s+)?|>>\s*)([0-9.]+)/i);
          if (hrMatch) {
            const bpm = Math.round(parseFloat(hrMatch[1]));
            if (bpm >= 30 && bpm <= 240) {
              this.updateHeartRate(bpm);
              this.handleRawPresence(true);
            } else if (bpm === 0) {
              this.updateHeartRate(0);
            }
          }
          const brMatch = line.match(/(?:breath|oddech|respiratory|Real-time respiratory rate|rpm)[^:]*?(?::\s*(?:(?:Got|Sending)\s+state\s+)?|>>\s*)([0-9.]+)/i);
          if (brMatch) {
            const rpm = Math.round(parseFloat(brMatch[1]));
            if (rpm >= 2 && rpm <= 70) {
              this.updateBreathRate(rpm);
              this.handleRawPresence(true);
            } else if (rpm === 0) {
              this.updateBreathRate(0);
            }
          }
          const presenceMatch = line.match(/(?:person information|has target|has_target|target_info|presence|occupancy)[^:]*?(?::\s*(?:(?:Got|Sending)\s+state\s+)?|>>\s*)(ON|OFF|true|false|[0-9.]+)/i);
          if (presenceMatch) {
            const st = presenceMatch[1].toUpperCase();
            if (st === 'ON' || st === 'TRUE' || (parseFloat(st) > 0 && !isNaN(parseFloat(st)))) {
              this.handleRawPresence(true);
              continue;
            } else if (st === 'OFF' || st === 'FALSE') {
              this.handleRawPresence(false);
              continue;
            }
          }
        }
      }

      // Plain text formats
      const plainDistMatch = line.match(/^distance:\s*([0-9.]+)/i);
      if (plainDistMatch) {
        const val = parseFloat(plainDistMatch[1]);
        if (val > 0) {
          const distCm = val < 10 ? Math.round(val * 100) : Math.round(val);
          this.updateDistance(distCm);
          this.handleRawPresence(true);
        }
      }
      const plainHrMatch = line.match(/^heart_rate:\s*([0-9.]+)/i);
      if (plainHrMatch) {
        const bpm = Math.round(parseFloat(plainHrMatch[1]));
        if (bpm >= 30 && bpm <= 240) {
          this.updateHeartRate(bpm);
          this.handleRawPresence(true);
        } else if (bpm === 0) {
          this.updateHeartRate(0);
        }
      }
      const plainBrMatch = line.match(/^breath_rate:\s*([0-9.]+)/i);
      if (plainBrMatch) {
        const rpm = Math.round(parseFloat(plainBrMatch[1]));
        if (rpm >= 2 && rpm <= 70) {
          this.updateBreathRate(rpm);
          this.handleRawPresence(true);
        } else if (rpm === 0) {
          this.updateBreathRate(0);
        }
      }

      if (/^(presence|someone|occupied|target:\s*1|desk)/i.test(line)) {
        if (/0|false|nobody|away|empty|clear/i.test(line)) {
          this.handleRawPresence(false);
        } else {
          this.handleRawPresence(true);
        }
      } else if (/^(nobody|away|unoccupied|target:\s*0|empty|clear)/i.test(line)) {
        this.handleRawPresence(false);
      }
    }

    if (this.lineBuffer.length > 4096) {
      this.lineBuffer = '';
    }
  }

  /**
   * Parser binarnego protokołu MR60BHA2 (wg implementacji referencyjnej
   * ESPHome seeed_mr60bha2):
   *   [0]=0x01 | [1..2]=id BE | [3..4]=len BE | [5..6]=type BE
   *   [7]=cksum nagłówka (XOR b0..b6, inv) | [8..8+len)=payload | ostatni=cksum danych
   * Typy: 0x0A14 oddech, 0x0A15 tętno, 0x0A16 dystans, 0x0F09 obecność.
   */
  /**
   * Parser binarnego protokołu Seeed MR60BHA2 (zarówno surowe ramki fabryczne 0x53 0x59,
   * jak i ramki ESPHome seeed_mr60bha2 0x01).
   */
  private scanBinaryFrames(): void {
    while (this.rawBuffer.length >= 7) {
      // Szukanie początku ramki (0x53 0x59 lub 0x01)
      if (
        this.rawBuffer[0] !== 0x01 &&
        !(this.rawBuffer[0] === 0x53 && this.rawBuffer.length >= 2 && this.rawBuffer[1] === 0x59)
      ) {
        let nextIdx = -1;
        for (let i = 1; i < this.rawBuffer.length; i++) {
          if (
            this.rawBuffer[i] === 0x01 ||
            (this.rawBuffer[i] === 0x53 && i + 1 < this.rawBuffer.length && this.rawBuffer[i + 1] === 0x59)
          ) {
            nextIdx = i;
            break;
          }
        }
        if (nextIdx === -1) {
          this.rawBuffer =
            this.rawBuffer.length > 0 && this.rawBuffer[this.rawBuffer.length - 1] === 0x53
              ? this.rawBuffer.subarray(this.rawBuffer.length - 1)
              : Buffer.alloc(0);
          return;
        }
        this.rawBuffer = this.rawBuffer.subarray(nextIdx);
        continue;
      }

      // 1. Obsługa fabrycznej ramki binarnej Seeed mmWave (0x53 0x59 ...)
      if (this.rawBuffer[0] === 0x53 && this.rawBuffer.length >= 2 && this.rawBuffer[1] === 0x59) {
        if (this.rawBuffer.length < 7) return;
        const len = (this.rawBuffer[4] << 8) | this.rawBuffer[5];
        if (len > 64) {
          this.rawBuffer = this.rawBuffer.subarray(2);
          continue;
        }
        const total = 6 + len + 1;
        if (this.rawBuffer.length < total) return;

        const frame = this.rawBuffer.subarray(0, total);
        let sum = 0;
        for (let i = 0; i < total - 1; i++) {
          sum = (sum + frame[i]) & 0xff;
        }
        if (sum === frame[total - 1]) {
          this.parseBinaryFrame(frame);
          this.rawBuffer = this.rawBuffer.subarray(total);
          continue;
        } else {
          this.rawBuffer = this.rawBuffer.subarray(2);
          continue;
        }
      }

      // 2. Obsługa ramki binarnej ESPHome (0x01 ...)
      if (this.rawBuffer[0] === 0x01) {
        if (this.rawBuffer.length < 8) return;
        const len = (this.rawBuffer[3] << 8) | this.rawBuffer[4];
        if (len > 64) {
          this.rawBuffer = this.rawBuffer.subarray(1);
          continue;
        }
        const total = 8 + len + 1;
        if (this.rawBuffer.length < total) return;

        const frame = this.rawBuffer.subarray(0, total);
        let hc = 0;
        for (let i = 0; i < 7; i++) hc ^= frame[i];
        if ((~hc & 0xff) !== frame[7]) {
          this.rawBuffer = this.rawBuffer.subarray(1);
          continue;
        }
        let dc = 0;
        for (let i = 8; i < 8 + len; i++) dc ^= frame[i];
        if ((~dc & 0xff) !== frame[8 + len]) {
          this.rawBuffer = this.rawBuffer.subarray(1);
          continue;
        }

        const type = (frame[5] << 8) | frame[6];
        this.dispatchRadarFrame(type, frame.subarray(8, 8 + len));
        this.rawBuffer = this.rawBuffer.subarray(total);
      }
    }
  }

  /** Float z payloadu — Seeed wysyła bajty odwrócone względem LE. */
  private payloadFloat(p: Buffer): number {
    if (p.length < 4) return NaN;
    return Buffer.from([p[3], p[2], p[1], p[0]]).readFloatLE(0);
  }

  /** U32 z payloadu — te same odwrócone bajty co float (do licznika celów / dop / cluster). */
  private payloadU32(p: Buffer): number {
    if (p.length < 4) return 0;
    return Buffer.from([p[3], p[2], p[1], p[0]]).readUInt32LE(0);
  }

  private dispatchRadarFrame(type: number, p: Buffer): void {
    switch (type) {
      case 0x0f09: {
        // Obecność: uint16 odwrócone, dowolna wartość != 0
        if (p.length >= 2) {
          const v = (p[1] << 8) | p[0];
          this.handleRawPresence(v !== 0);
        }
        break;
      }
      case 0x0a15: {
        const bpm = Math.round(this.payloadFloat(p));
        if (bpm >= 30 && bpm <= 240) this.updateHeartRate(bpm);
        else if (bpm === 0) this.updateHeartRate(0);
        break;
      }
      case 0x0a14: {
        const rpm = Math.round(this.payloadFloat(p));
        if (rpm >= 5 && rpm <= 70) this.updateBreathRate(rpm);
        else if (rpm === 0) this.updateBreathRate(0);
        break;
      }
      case 0x0a16: {
        // Dystans: [u32 rangeFlag][f32 odległość] — float na offsecie 4.
        // Wartość w cm (ESPHome loguje 74.62 cm bez konwersji); starsze firmware
        // potrafi wysyłać metry — heurystyka jak w ścieżce tekstowej.
        if (p.length >= 8 && p[0] !== 0) {
          const f = this.payloadFloat(p.subarray(4));
          if (Number.isFinite(f) && f > 0 && f <= 800) {
            const cm = f < 10 ? Math.round(f * 100) : Math.round(f);
            this.updateDistance(cm);
            this.handleRawPresence(true);
          }
        }
        break;
      }
      case 0x0a04:
      case 0x0a08: {
        // Point cloud / Target Info: [u32 liczba celów] + N × {x f32, y f32, dop i32, cluster i32}
        if (p.length >= 4) {
          const count = this.payloadU32(p.subarray(0, 4));
          this.telemetry.targetCount = Math.max(0, Math.min(5, count));
          this.lastTargetCountTime = Date.now();
          this.updateAmbiguity();
          this.scheduleTelemetry();
        }
        break;
      }
      default:
        break;
    }
  }

  private parseBinaryFrame(buf: Buffer): void {
    if (buf.length < 6 || buf[0] !== 0x53 || buf[1] !== 0x59) return;

    const control = buf[2];
    const command = buf[3];
    const len = (buf[4] << 8) | buf[5];
    const payload = buf.subarray(6, 6 + len);

    // 1. Obecność / Status obecności człowieka
    if (
      (control === 0x80 && command === 0x01) ||
      (control === 0x0f && (command === 0x09 || command === 0x01)) ||
      (control === 0x01 && command === 0x01)
    ) {
      if (payload.length >= 1) {
        const val = payload[0];
        this.handleRawPresence(val !== 0x00);
      }
      return;
    }

    // 2. Ruch / Aktywność (Motion)
    if ((control === 0x80 && command === 0x02) || (control === 0x0f && command === 0x02)) {
      if (payload.length >= 1) {
        const val = payload[0];
        this.handleRawPresence(val === 0x01 || val === 0x02);
      }
      return;
    }

    // 3. Parametr ruchu ciała
    if (control === 0x80 && command === 0x03) {
      if (payload.length >= 1 && payload[0] > 0) {
        this.handleRawPresence(true);
      }
      return;
    }

    // 4. Dystans (Distance)
    if ((control === 0x0a && (command === 0x16 || command === 0x03)) || control === 0x84) {
      if (payload.length >= 4) {
        const f = this.payloadFloat(payload);
        if (Number.isFinite(f) && f > 0 && f <= 800) {
          const cm = f < 10 ? Math.round(f * 100) : Math.round(f);
          this.updateDistance(cm);
          this.handleRawPresence(true);
        }
      } else if (payload.length >= 2) {
        const raw = (payload[0] << 8) | payload[1];
        if (raw > 0) {
          const dist = raw > 500 && raw < 10000 ? Math.round(raw / 10) : raw;
          this.updateDistance(dist);
          this.handleRawPresence(true);
        }
      }
      return;
    }

    // 5. Tętno (Heart Rate)
    if ((control === 0x0a && (command === 0x15 || command === 0x02)) || control === 0x85) {
      const bpm = payload.length >= 4 ? Math.round(this.payloadFloat(payload)) : payload[0];
      if (bpm >= 30 && bpm <= 240) {
        this.updateHeartRate(bpm);
        this.handleRawPresence(true);
      } else if (bpm === 0) {
        this.updateHeartRate(0);
      }
      return;
    }

    // 6. Oddech (Breath Rate)
    if ((control === 0x0a && (command === 0x14 || command === 0x01)) || control === 0x86) {
      const rpm = payload.length >= 4 ? Math.round(this.payloadFloat(payload)) : payload[0];
      if (rpm >= 2 && rpm <= 70) {
        this.updateBreathRate(rpm);
        this.handleRawPresence(true);
      } else if (rpm === 0) {
        this.updateBreathRate(0);
      }
      return;
    }
  }

  private feedAutoTuner(sample: Sample): void {
    // Niejednoznaczny cel (kot) — nie karmimy auto-tunera dystansem/biometrią
    // należącymi do kota, bo zafałszowałyby wyuczoną strefę biurka.
    if (this.radarAmbiguous) return;
    this.autoTuner.feedSample(sample);
    this.telemetry.autoTuning = this.autoTuner.getStatus();
  }

  /**
   * Ocena wiarygodności celu: MR60BHA2 raportuje tylko JEDEN dystans (najsilniejszy
   * cel). Kot w pobliżu biurka powoduje albo (a) przeskakiwanie celu — duża rozpiętość
   * odczytów w oknie, albo (b) nagłe pojawienie się sygnatury zwierzaka po ludzkim
   * tętnie. W obu przypadkach dystans NIE należy do użytkownika — oznaczamy go jako
   * niewiarygodny i wstrzymujemy nadpisywanie obecności bramką/filtrem zwierzaka.
   */
  private updateAmbiguity(): void {
    if (this.config.get('radarAmbiguityGuardEnabled') === false) {
      this.ambigStreak = 0;
      this.setAmbiguous(false);
      return;
    }

    // Radar śledzi >=2 cele jednocześnie (kot + użytkownik): pojedynczy odczyt
    // dystansu/biometrii NIE należy wiarygodnie do użytkownika.
    const multiTarget = (this.telemetry.targetCount ?? 0) >= 2;

    // Sygnatura zwierzaka tuż po ludzkim tętnie = radar przeskoczył z użytkownika na kota,
    // a obecność człowieka (binarny sygnał) wciąż jest prawdziwa — nie wygaszaj obecności.
    const petAfterHuman =
      this.presence &&
      this.telemetry.detectedPerson === 'pet' &&
      this.lastHumanHrAt > 0 &&
      Date.now() - this.lastHumanHrAt < 10000;

    // Histereza na 3 kolejnych odczytach (stabilizacja sygnału).
    this.ambigStreak = multiTarget || petAfterHuman ? Math.min(5, this.ambigStreak + 1) : Math.max(0, this.ambigStreak - 1);
    this.setAmbiguous(this.ambigStreak >= 3);
  }

  private setAmbiguous(ambiguous: boolean): void {
    if (this.radarAmbiguous === ambiguous) return;
    this.radarAmbiguous = ambiguous;
    this.telemetry.distanceTrusted = !ambiguous;
    if (ambiguous) {
      // Nie pozwól, by stary licznik "poza strefą" z okresu przed kotem
      // natychmiast wygasił obecność po wyjściu z niejednoznaczności.
      this.outOfGateStreak = 0;
      appendLog('RADAR-AMBIG', 'Wykryto niejednoznaczność celu (kot?) — wstrzymano bramkę odległości i filtr zwierzaka');
    } else {
      appendLog('RADAR-AMBIG', 'Cel znów jednoznaczny — bramka odległości i filtr zwierzaka aktywne');
    }
  }

  private lastTelemetryEmit = 0;
  private telemetryFlushTimer: NodeJS.Timeout | null = null;
  private lastTelemetrySig = '';

  /**
   * Emisja telemetrii: sensor wypycha dane w kółko, więc wysyłamy do UI
   * WYŁĄCZNIE gdy coś się realnie zmieniło (sygnatura pól widocznych dla
   * użytkownika; adaptacyjne EMA kwantyzowane, żeby dryf nie generował
   * fałszywych zmian) i nie częściej niż ~8 Hz.
   */
  private scheduleTelemetry(): void {
    const t = this.telemetry;
    const tun = t.autoTuning;
    const sig =
      `${t.presence ? 1 : 0}|${t.distanceCm ?? 0}|${t.distanceTrusted === false ? 0 : 1}|${t.targetCount ?? 0}|${t.heartRate ?? 0}|${t.breathRate ?? 0}|${t.illuminanceLux ?? ''}|` +
      `${t.detectedPerson ?? ''}|${tun?.mode ?? ''}|${Math.floor((tun?.samplesCount ?? 0) / 10)}|` +
      `${Math.round((tun?.noiseFloor ?? 0) / 5)}`;
    if (sig === this.lastTelemetrySig) return;

    const now = Date.now();
    const since = now - this.lastTelemetryEmit;
    if (since >= 120) {
      this.lastTelemetryEmit = now;
      this.lastTelemetrySig = sig;
      this.emit('telemetry', this.telemetry);
      return;
    }
    if (this.telemetryFlushTimer) return;
    this.telemetryFlushTimer = setTimeout(() => {
      this.telemetryFlushTimer = null;
      // Sygnatura mogła się cofnąć do ostatnio wysłanej — wtedy cisza
      if (this.lastTelemetrySig === this.buildTelemetrySig()) return;
      this.lastTelemetryEmit = Date.now();
      this.lastTelemetrySig = this.buildTelemetrySig();
      this.emit('telemetry', this.telemetry);
    }, 120 - since);
  }

  private buildTelemetrySig(): string {
    const t = this.telemetry;
    const tun = t.autoTuning;
    return (
      `${t.presence ? 1 : 0}|${t.distanceCm ?? 0}|${t.distanceTrusted === false ? 0 : 1}|${t.targetCount ?? 0}|${t.heartRate ?? 0}|${t.breathRate ?? 0}|${t.illuminanceLux ?? ''}|` +
      `${t.detectedPerson ?? ''}|${tun?.mode ?? ''}|${Math.floor((tun?.samplesCount ?? 0) / 10)}|` +
      `${Math.round((tun?.noiseFloor ?? 0) / 5)}`
    );
  }

  private applySmoothingConfig(): void {
    const mode = this.config.get('radarSmoothingMode') || 'ultra';
    this.distanceFilter.setMode(mode);
    if (mode === 'ultra') {
      this.heartMedian.setSize(5);
      this.heartEMA.setAlpha(0.12);
      this.heartEMA.setDeadband(2.0);
      this.breathMedian.setSize(5);
      this.breathEMA.setAlpha(0.12);
      this.breathEMA.setDeadband(1.5);
      this.presenceFilter.setHoldOffMs(2000);
    } else if (mode === 'balanced') {
      this.heartMedian.setSize(5);
      this.heartEMA.setAlpha(0.20);
      this.heartEMA.setDeadband(1.5);
      this.breathMedian.setSize(5);
      this.breathEMA.setAlpha(0.20);
      this.breathEMA.setDeadband(1.0);
      this.presenceFilter.setHoldOffMs(1500);
    } else {
      this.heartMedian.setSize(3);
      this.heartEMA.setAlpha(0.6);
      this.heartEMA.setDeadband(0);
      this.breathMedian.setSize(3);
      this.breathEMA.setAlpha(0.6);
      this.breathEMA.setDeadband(0);
      this.presenceFilter.setHoldOffMs(600);
    }
  }

  private updateDistance(distCm: number): void {
    if (distCm <= 0 || distCm > 800) {
      return;
    }
    this.lastDistanceTime = Date.now();
    this.applySmoothingConfig();

    const smoothedCm = this.distanceFilter.push(distCm);
    const env = this.distanceFilter.getEnvelope();
    const envInfo = env.span > 0 ? ` [obwiednia ciała/fotela: ${env.front}–${env.back} cm]` : '';

    this.telemetry.distanceCm = smoothedCm;
    this.telemetry.lastUpdate = Date.now();

    appendLog(
      'RADAR-DSP',
      `Dystans: ${smoothedCm} cm (surowy: ${distCm} cm)${envInfo}${this.radarAmbiguous ? ' — CEL NIEPEWNY (kot?)' : ''}`
    );

    this.feedAutoTuner({
      distanceCm: smoothedCm,
      heartRate: this.telemetry.heartRate || 0,
      breathRate: this.telemetry.breathRate || 0,
      isSeated: Boolean(this.presence || this.state === 'desk'),
      rawPresence: this.presence
    });

    this.evaluateBiometrics();
    this.scheduleTelemetry();
  }

  private updateHeartRate(bpm: number): void {
    if (bpm < 30 || bpm > 240) {
      if (bpm === 0) {
        this.telemetry.heartRate = 0;
        this.heartMedian.reset();
        this.heartEMA.reset();
      }
      return;
    }
    this.lastHeartRateTime = Date.now();
    this.applySmoothingConfig();

    // Pamiętamy, że radar mierzył tętno typowe dla człowieka. Gdy później nagle
    // pojawia się sygnatura zwierzaka przy OBECNEJ obecności — radar przeskoczył
    // na kota, a nie że człowiek wyszedł (patrz updateAmbiguity).
    if (bpm >= 45 && bpm <= 110) {
      this.lastHumanHrAt = Date.now();
    }

    const medianBpm = this.heartMedian.push(bpm);
    const smoothedBpm = this.heartEMA.push(medianBpm);

    this.telemetry.heartRate = smoothedBpm;
    this.telemetry.lastUpdate = Date.now();

    appendLog('RADAR-DSP', `Tętno: ${smoothedBpm} BPM (surowe: ${bpm} BPM)`);

    this.feedAutoTuner({
      distanceCm: this.telemetry.distanceCm || 0,
      heartRate: smoothedBpm,
      breathRate: this.telemetry.breathRate || 0,
      isSeated: Boolean(this.presence || this.state === 'desk'),
      rawPresence: this.presence
    });

    this.evaluateBiometrics();
    this.scheduleTelemetry();
  }

  private updateBreathRate(rpm: number): void {
    if (rpm < 2 || rpm > 70) {
      if (rpm === 0) {
        this.telemetry.breathRate = 0;
        this.breathMedian.reset();
        this.breathEMA.reset();
      }
      return;
    }
    this.lastBreathRateTime = Date.now();
    this.applySmoothingConfig();

    const medianRpm = this.breathMedian.push(rpm);
    const smoothedRpm = this.breathEMA.push(medianRpm);

    this.telemetry.breathRate = smoothedRpm;
    this.telemetry.lastUpdate = Date.now();

    appendLog('RADAR-DSP', `Oddech: ${smoothedRpm} RPM (surowy: ${rpm} RPM)`);

    this.feedAutoTuner({
      distanceCm: this.telemetry.distanceCm || 0,
      heartRate: this.telemetry.heartRate || 0,
      breathRate: smoothedRpm,
      isSeated: Boolean(this.presence || this.state === 'desk'),
      rawPresence: this.presence
    });

    this.evaluateBiometrics();
    this.scheduleTelemetry();
  }

  private updateIlluminance(lux: number): void {
    if (lux < 0 || lux > 120000) return;
    const smoothed = this.illuminanceFilter.push(lux);
    this.telemetry.illuminanceLux = smoothed;
    if (this.lastLoggedLux === null || Math.abs(smoothed - this.lastLoggedLux) >= 2.0) {
      this.lastLoggedLux = smoothed;
      appendLog('RADAR-DSP', `Światło: ${smoothed} lx`);
    }
    this.scheduleTelemetry();
  }

  private evaluateBiometrics(): void {
    const hr = this.telemetry.heartRate || 0;
    const rpm = this.telemetry.breathRate || 0;
    const dist = this.telemetry.distanceCm || 0;

    // Klasyfikacja "pet" wymaga PERSISTENCJI (kilka kolejnych odczytów).
    // Zwierzę (pies/kot) charakteryzuje się ZARÓWNO bardzo szybkim oddechem (>26-30 RPM),
    // jak i bardzo wysokim tętnem (>120 BPM). Człowiek z oddechem 22-28 RPM (np. po ruchu/mówieniu)
    // i normalnym tętnem spoczynkowym (45-110 BPM) nie może być oznaczony jako zwierzak.
    const isPetSignature =
      this.config.get('petFilterEnabled') !== false &&
      !(hr >= 45 && hr <= 110) &&
      (
        (hr > 125 && hr <= 240 && (rpm > 24 || rpm === 0)) ||
        (rpm > 30 && rpm <= 65 && (hr > 115 || hr === 0))
      );
    this.petStreak = isPetSignature ? Math.min(20, this.petStreak + 1) : 0;
    const petConfirmed = this.petStreak >= 4;
    if (petConfirmed) {
      this.telemetry.detectedPerson = 'pet';
      this.updateAmbiguity();
      return;
    }

    if (!this.config.get('biometricsEnabled')) {
      this.telemetry.detectedPerson = dist > 0 || this.presence ? 'me' : 'unknown';
      this.updateAmbiguity();
      return;
    }

    const adaptedBio = this.autoTuner.getAdaptedBiometrics();
    const autoTuningOn = this.config.get('radarAutoTuningEnabled') !== false;

    const hrMin =
      autoTuningOn && adaptedBio.isCalibrated
        ? adaptedBio.heartRateMin
        : (this.config.get('userHeartRateMin') ?? 55);

    const hrMax =
      autoTuningOn && adaptedBio.isCalibrated
        ? adaptedBio.heartRateMax
        : (this.config.get('userHeartRateMax') ?? 78);

    const dynamicGate = this.autoTuner.getDynamicGate();
    const distMin =
      autoTuningOn && dynamicGate.isCalibrated
        ? dynamicGate.minGateCm
        : (this.config.get('userSeatingDistanceMin') ?? 45);

    const distMax =
      autoTuningOn && dynamicGate.isCalibrated
        ? dynamicGate.maxGateCm
        : (this.config.get('userSeatingDistanceMax') ?? 115);

    let matches = true;

    if (hr > 0 && (hr < hrMin || hr > hrMax)) {
      matches = false;
    }
    if (dist > 0 && (dist < distMin || dist > distMax)) {
      matches = false;
    }

    this.telemetry.detectedPerson = matches ? 'me' : 'other';
    this.updateAmbiguity();
  }

  private handleRawPresence(rawPresent: boolean): void {
    this.lastPresencePacketTime = Date.now();
    this.applySmoothingConfig();

    this.presenceFilter.process(rawPresent, (stablePresence) => {
      let effectivePresence = stablePresence;
      const curDist = this.telemetry.distanceCm || 0;

      if (effectivePresence && this.radarAmbiguous) {
        // Radar nie potrafi rozstrzygnąć, który cel to użytkownik (kot + człowiek).
        // Jedynym wiarygodnym sygnałem jest binarne wykrycie CZŁOWIEKA — nie
        // nadpisujemy obecności bramką odległości ani filtrem zwierzaka.
        appendLog(
          'RADAR',
          'Cel niejednoznaczny (kot?) — utrzymuję obecność z sygnału obecności człowieka'
        );
      } else if (effectivePresence) {
        if (this.config.get('petFilterEnabled') !== false && this.telemetry.detectedPerson === 'pet') {
          effectivePresence = false;
        }

        if (this.config.get('radarDistanceGateEnabled')) {
          const autoTuningOn = this.config.get('radarAutoTuningEnabled') !== false;
          const dynamicGate = this.autoTuner.getDynamicGate();

          const minGate =
            autoTuningOn && dynamicGate.isCalibrated
              ? dynamicGate.minGateCm
              : Number(this.config.get('radarMinDistanceCm') ?? 40);

          const maxGate =
            autoTuningOn && dynamicGate.isCalibrated
              ? dynamicGate.maxGateCm
              : Number(this.config.get('radarMaxDistanceCm') ?? 115);

          // Histereza korytarza: margines tolerancji 8 cm i wymóg min. 6 kolejnych odczytów poza strefą
          if (curDist > 0 && (curDist < minGate - 8 || curDist > maxGate + 8)) {
            this.outOfGateStreak++;
            if (this.outOfGateStreak >= 6) {
              effectivePresence = false;
            }
          } else {
            this.outOfGateStreak = 0;
          }
        } else {
          this.outOfGateStreak = 0;
        }
      }

      if (!effectivePresence) {
        this.telemetry.heartRate = 0;
        this.telemetry.breathRate = 0;
        this.telemetry.distanceCm = 0;
        this.telemetry.distanceTrusted = true;
        this.telemetry.targetCount = undefined;
        this.telemetry.detectedPerson = 'unknown';
        this.petStreak = 0;
        this.outOfGateStreak = 0;
        this.radarAmbiguous = false;
        this.ambigStreak = 0;
        this.lastHumanHrAt = 0;
        this.heartMedian.reset();
        this.heartEMA.reset();
        this.breathMedian.reset();
        this.breathEMA.reset();
        this.distanceFilter.reset();
      }

      this.telemetry.presence = effectivePresence;
      this.evaluateBiometrics();
      this.scheduleTelemetry();
      this.setPresence(effectivePresence);
    });
  }

  resetAutoTuning(): ReturnType<AutoTuner['getStatus']> {
    const status = this.autoTuner.reset();
    this.telemetry.autoTuning = status;
    this.scheduleTelemetry();
    return status;
  }

  /**
   * Zasilanie silnika telemetrii i detekcji obecności z zewnętrznego źródła
   * (np. integracji z Home Assistant OS / HAOS przez sieć LAN/Wi-Fi).
   */
  feedExternalTelemetry(data: {
    presence?: boolean;
    distanceCm?: number;
    heartRate?: number;
    breathRate?: number;
    source?: string;
  }): void {
    this.lastAnyPacketTime = Date.now();
    if (typeof data.distanceCm === 'number' && Number.isFinite(data.distanceCm)) {
      if (data.distanceCm > 0) {
        this.updateDistance(data.distanceCm);
      } else {
        this.updateDistance(0);
        this.handleRawPresence(false);
      }
    }
    if (typeof data.heartRate === 'number' && Number.isFinite(data.heartRate)) {
      if (data.heartRate > 0) {
        this.updateHeartRate(data.heartRate);
      } else {
        this.updateHeartRate(0);
      }
    }
    if (typeof data.breathRate === 'number' && Number.isFinite(data.breathRate)) {
      if (data.breathRate > 0) {
        this.updateBreathRate(data.breathRate);
      } else {
        this.updateBreathRate(0);
      }
    }
    if (typeof data.presence === 'boolean') {
      this.handleRawPresence(data.presence);
    }
  }

  setPresence(present: boolean): void {
    if (this.presence === present) return;
    this.presence = present;
    if (this.deskTimer) clearTimeout(this.deskTimer);
    if (this.awayTimer) clearTimeout(this.awayTimer);

    if (present) {
      // Koercja: śmieciowa wartość z configu (NaN/ujemna) nie może
      // zamienić debouncera w natychmiastowe flappy przełączanie.
      const deskMs = Math.max(0, Number(this.config.get('timeoutDeskMs')) || 300);
      this.deskTimer = setTimeout(() => this.setState('desk'), deskMs);
    } else {
      const awayMs = Math.max(250, Number(this.config.get('timeoutAwayMs')) || 3000);
      this.awayTimer = setTimeout(() => this.setState('away'), awayMs);
    }
    this.emit('status', {
      presence: present,
      state: this.state,
      pendingState: present ? 'desk' : 'away',
      telemetry: this.telemetry,
      since: Date.now()
    } satisfies RadarStatusEvent);
  }

  private setState(state: DeskState): void {
    if (this.state === state || !this.running) return;
    this.state = state;
    this.emit(state, Date.now());
    this.emit('status', {
      presence: this.presence,
      state,
      telemetry: this.telemetry,
      since: Date.now()
    } satisfies RadarStatusEvent);
  }
}
