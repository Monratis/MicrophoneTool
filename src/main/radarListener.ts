import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import AutoTuner from './autoTuner';
import { MedianFilter, DistanceFilter, IlluminanceFilter } from './signalFilter';
import { appendLog } from './logger';
import type Config from './config';
import type ActivityWatcher from './activityWatcher';
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
  private lineBuffer = '';
  private rawBuffer: Buffer = Buffer.alloc(0);

  // Znaczniki czasu dla niezależnego wygaszania telemetrycznego i watchdoga ciszy
  private lastPresencePacketTime = 0;
  private lastDistanceTime = 0;
  private lastHeartRateTime = 0;
  private lastBreathRateTime = 0;
  private lastTargetCountTime = 0;

  // Filtry uśredniające (5 odczytów)
  private distanceFilter = new DistanceFilter(5);
  private heartFilter = new MedianFilter(5);
  private breathFilter = new MedianFilter(5);
  private illuminanceFilter = new IlluminanceFilter(5);
  private petStreak = 0;

  // Potwierdzenie obecności: ostatni moment, w którym radar dostarczył TWARDY
  // dowód na realnego człowieka przy biurku (dystans w bramce / biometria /
  // aktywność wejściowa). Brak odświeżenia przez ghostTimeoutMs = fałszywy cel.
  private lastCorroboratedAt = 0;
  /** Lockout po wykryciu fałszywego celu: bit obecności nie może go ponownie
   *  włączyć, dopóki nie przyjdzie realne potwierdzenie człowieka. */
  private ghostLockoutUntil = 0;
  private lastLockoutLogAt = 0;

  private activityWatcher: ActivityWatcher | null = null;

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

  setActivityWatcher(watcher: ActivityWatcher): void {
    this.activityWatcher = watcher;
    watcher.on('activity', ({ freshInput }) => {
      if (this.config.get('userInputPresenceEnabled') === false) return;
      if (!this.presence && freshInput) {
        appendLog('RADAR', 'Potwierdzono powrót do biurka aktywnością klawiatury/myszy (instant wake)');
        this.handleRawPresence(true);
      } else if (this.presence) {
        this.lastPresencePacketTime = Date.now();
        this.markCorroborated();
      }
    });
  }

  /** Twardy dowód na realnego człowieka przy biurku (dystans/biometria/aktywność). */
  private markCorroborated(): void {
    this.lastCorroboratedAt = Date.now();
    // Realny dowód = powrót człowieka — natychmiast zdejmij lockout fałszywego celu
    this.ghostLockoutUntil = 0;
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

    if (!this.presence) {
      if (this.telemetry.distanceCm && this.lastDistanceTime > 0 && now - this.lastDistanceTime > 3000) {
        this.telemetry.distanceCm = 0;
        this.distanceFilter.reset();
        telemetryChanged = true;
      }
      if (this.telemetry.heartRate && this.lastHeartRateTime > 0 && now - this.lastHeartRateTime > 3000) {
        this.telemetry.heartRate = 0;
        this.heartFilter.reset();
        telemetryChanged = true;
      }
      if (this.telemetry.breathRate && this.lastBreathRateTime > 0 && now - this.lastBreathRateTime > 3000) {
        this.telemetry.breathRate = 0;
        this.breathFilter.reset();
        telemetryChanged = true;
      }
    } else {
      // W trakcie obecności wygaszamy biometrię jeśli brak aktualizacji >20s
      if (this.telemetry.heartRate && this.lastHeartRateTime > 0 && now - this.lastHeartRateTime > 20000) {
        this.telemetry.heartRate = 0;
        telemetryChanged = true;
      }
      if (this.telemetry.breathRate && this.lastBreathRateTime > 0 && now - this.lastBreathRateTime > 20000) {
        this.telemetry.breathRate = 0;
        telemetryChanged = true;
      }
    }

    if (this.telemetry.targetCount !== undefined && this.lastTargetCountTime > 0 && now - this.lastTargetCountTime > 5000) {
      this.telemetry.targetCount = undefined;
      telemetryChanged = true;
    }

    if (telemetryChanged) {
      this.scheduleTelemetry();
    }

    // Watchdog obecności: jeśli obecność aktywna, ale brak jakiegokolwiek sygnału z radaru przez >8s i brak aktywności myszy/klawiatury -> wygaś
    if (this.presence) {
      const lastDetectionTime = Math.max(
        this.lastPresencePacketTime,
        this.lastDistanceTime,
        this.lastHeartRateTime,
        this.lastBreathRateTime
      );
      const silenceDuration = lastDetectionTime > 0 ? now - lastDetectionTime : 10000;
      const isInputActive = this.activityWatcher?.isUserActiveRecently(15) ?? false;

      if (silenceDuration > 8000 && !isInputActive) {
        appendLog(
          'RADAR',
          `Brak jakiegokolwiek sygnału z radaru przez ${(silenceDuration / 1000).toFixed(1)}s — automatyczne wygaszenie obecności (watchdog)`
        );
        this.handleRawPresence(false);
        return;
      }

      // Watchdog fałszywego celu ("duch"): MR60BHA2 potrafi "zablokować" bit obecności
      // na 1 (statyczny obiekt / kot bez biometrii / odbicie), gdy użytkownik wyszedł.
      // Sam bit obecności NIE jest tu potwierdzeniem — liczą się twarde dowody:
      // świeży dystans w bramce, biometria albo aktywność klawiatury/myszy.
      // Działa tylko gdy radar faktycznie strumieniuje dane koreboracyjne (dystans/bio)
      // — instalacje presence-only ("nohb") bez tych strumieni nie są karane.
      const streamsCorroboration =
        this.lastDistanceTime > 0 || this.lastHeartRateTime > 0 || this.lastBreathRateTime > 0;
      const ghostTimeoutMs = Math.max(3000, Number(this.config.get('ghostTimeoutMs')) || 12000);
      if (
        streamsCorroboration &&
        this.lastCorroboratedAt > 0 &&
        now - this.lastCorroboratedAt > ghostTimeoutMs
      ) {
        const ghostSeconds = ((now - this.lastCorroboratedAt) / 1000).toFixed(1);
        appendLog(
          'RADAR',
          `Bit obecności trzymany bez potwierdzenia przez ${ghostSeconds}s (brak dystansu w bramce/biometrii) — fałszywy cel, wygaszam obecność`
        );
        const lockoutMs = Math.max(10000, Number(this.config.get('ghostLockoutMs')) || 60000);
        this.ghostLockoutUntil = now + lockoutMs;
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

          // Dystans: Pomiary > 0 aktualizują filtr dystansu i sprawdzają bramkę odległości.
          if (entity.includes('distance') || entity.includes('odległość') || entity.includes('dystans') || entity.includes('detection object')) {
            const val = parseFloat(stateVal);
            if (Number.isFinite(val) && val > 0) {
              const distCm = val < 10 && !line.toLowerCase().includes('cm') ? Math.round(val * 100) : Math.round(val);
              this.updateDistance(distCm);
            } else if (val === 0) {
              this.updateDistance(0);
              this.handleRawPresence(false);
            }
          }

          // Tętno: Pomiary biometryczne aktualizują telemetrię (nie wymuszają obecności)
          if (entity.includes('heart') || entity.includes('tętno') || entity.includes('bpm')) {
            const bpm = Math.round(parseFloat(stateVal));
            if (bpm >= 30 && bpm <= 240) {
              this.updateHeartRate(bpm);
            } else if (bpm === 0) {
              this.updateHeartRate(0);
            }
          }

          // Oddech: Pomiary biometryczne aktualizują telemetrię (nie wymuszają obecności)
          if (entity.includes('breath') || entity.includes('oddech') || entity.includes('respiratory') || entity.includes('rpm')) {
            const rpm = Math.round(parseFloat(stateVal));
            if (rpm >= 2 && rpm <= 70) {
              this.updateBreathRate(rpm);
            } else if (rpm === 0) {
              this.updateBreathRate(0);
            }
          }

          // Liczba wykrytych obiektów (Target Number)
          if (entity.includes('target number') || entity.includes('targets')) {
            const count = Math.round(parseFloat(stateVal));
            if (Number.isFinite(count) && count >= 0) {
              this.telemetry.targetCount = Math.max(0, Math.min(5, count));
              this.lastTargetCountTime = Date.now();
              if (count === 0) {
                this.handleRawPresence(false);
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
            } else if (val === 0) {
              this.updateDistance(0);
            }
          }
          const hrMatch = line.match(/(?:heart|tętno|Real-time heart rate|bpm)[^:]*?(?::\s*(?:(?:Got|Sending)\s+state\s+)?|>>\s*)([0-9.]+)/i);
          if (hrMatch) {
            const bpm = Math.round(parseFloat(hrMatch[1]));
            if (bpm >= 30 && bpm <= 240) {
              this.updateHeartRate(bpm);
            } else if (bpm === 0) {
              this.updateHeartRate(0);
            }
          }
          const brMatch = line.match(/(?:breath|oddech|respiratory|Real-time respiratory rate|rpm)[^:]*?(?::\s*(?:(?:Got|Sending)\s+state\s+)?|>>\s*)([0-9.]+)/i);
          if (brMatch) {
            const rpm = Math.round(parseFloat(brMatch[1]));
            if (rpm >= 2 && rpm <= 70) {
              this.updateBreathRate(rpm);
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
        } else if (val === 0) {
          this.updateDistance(0);
        }
      }
      const plainHrMatch = line.match(/^heart_rate:\s*([0-9.]+)/i);
      if (plainHrMatch) {
        const bpm = Math.round(parseFloat(plainHrMatch[1]));
        if (bpm >= 30 && bpm <= 240) {
          this.updateHeartRate(bpm);
        } else if (bpm === 0) {
          this.updateHeartRate(0);
        }
      }
      const plainBrMatch = line.match(/^breath_rate:\s*([0-9.]+)/i);
      if (plainBrMatch) {
        const rpm = Math.round(parseFloat(plainBrMatch[1]));
        if (rpm >= 2 && rpm <= 70) {
          this.updateBreathRate(rpm);
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

  /** Float z ramki ESPHome (0x01) — radar wysyła go w kolejności little-endian. */
  private espFloat(p: Buffer): number {
    if (p.length < 4) return NaN;
    return p.readFloatLE(0);
  }

  /** U32 z ramki ESPHome (0x01) — little-endian. */
  private espU32(p: Buffer): number {
    if (p.length < 4) return 0;
    return p.readUInt32LE(0);
  }

  /** U16 z ramki ESPHome (0x01) — little-endian. */
  private espU16(p: Buffer): number {
    if (p.length < 2) return 0;
    return p.readUInt16LE(0);
  }

  private dispatchRadarFrame(type: number, p: Buffer): void {
    switch (type) {
      case 0x0f09: {
        // Obecność: uint16 LE, dowolna wartość != 0
        if (p.length >= 2) {
          const v = this.espU16(p);
          if (v !== 0) {
            this.handleRawPresence(true);
          } else {
            this.handleRawPresence(false);
          }
        }
        break;
      }
      case 0x0a15: {
        const bpm = Math.round(this.espFloat(p));
        if (bpm >= 30 && bpm <= 240) this.updateHeartRate(bpm);
        else if (bpm === 0) this.updateHeartRate(0);
        break;
      }
      case 0x0a14: {
        const rpm = Math.round(this.espFloat(p));
        if (rpm >= 5 && rpm <= 70) this.updateBreathRate(rpm);
        else if (rpm === 0) this.updateBreathRate(0);
        break;
      }
      case 0x0a16: {
        // Dystans: [u32 rangeFlag LE][f32 odległość LE] — float na offsecie 4.
        if (p.length >= 8 && this.espU32(p) !== 0) {
          const f = this.espFloat(p.subarray(4));
          if (Number.isFinite(f) && f > 0 && f <= 800) {
            const cm = f < 10 ? Math.round(f * 100) : Math.round(f);
            this.updateDistance(cm);
          } else if (f === 0) {
            this.updateDistance(0);
          }
        }
        break;
      }
      case 0x0a04:
      case 0x0a08: {
        // Point cloud / Target Info: [u32 liczba celów] + N × {x f32, y f32, dop i32, cluster i32}
        if (p.length >= 4) {
          const count = this.espU32(p);
          this.telemetry.targetCount = Math.max(0, Math.min(5, count));
          this.lastTargetCountTime = Date.now();
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
        if (val !== 0x00) {
          this.handleRawPresence(true);
        } else {
          this.handleRawPresence(false);
        }
      }
      return;
    }

    // 2. Ruch / Aktywność (Motion)
    if ((control === 0x80 && command === 0x02) || (control === 0x0f && command === 0x02)) {
      if (payload.length >= 1) {
        const val = payload[0];
        if (val === 0x01 || val === 0x02) {
          this.handleRawPresence(true);
        } else {
          this.handleRawPresence(false);
        }
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
        } else if (f === 0) {
          this.updateDistance(0);
        }
      } else if (payload.length >= 2) {
        const raw = (payload[0] << 8) | payload[1];
        if (raw > 0) {
          const dist = raw > 500 && raw < 10000 ? Math.round(raw / 10) : raw;
          this.updateDistance(dist);
        } else if (raw === 0) {
          this.updateDistance(0);
        }
      }
      return;
    }

    // 5. Tętno (Heart Rate)
    if ((control === 0x0a && (command === 0x15 || command === 0x02)) || control === 0x85) {
      const bpm = payload.length >= 4 ? Math.round(this.payloadFloat(payload)) : payload[0];
      if (bpm >= 30 && bpm <= 240) {
        this.updateHeartRate(bpm);
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
      } else if (rpm === 0) {
        this.updateBreathRate(0);
      }
      return;
    }
  }

  private feedAutoTuner(sample: Sample): void {
    this.autoTuner.feedSample(sample);
    this.telemetry.autoTuning = this.autoTuner.getStatus();
  }

  private lastTelemetryEmit = 0;
  private telemetryFlushTimer: NodeJS.Timeout | null = null;
  private lastTelemetrySig = '';

  private scheduleTelemetry(): void {
    const t = this.telemetry;
    const tun = t.autoTuning;
    const sig =
      `${t.presence ? 1 : 0}|${t.distanceCm ?? 0}|${t.targetCount ?? 0}|${t.heartRate ?? 0}|${t.breathRate ?? 0}|${t.illuminanceLux ?? ''}|` +
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
      `${t.presence ? 1 : 0}|${t.distanceCm ?? 0}|${t.targetCount ?? 0}|${t.heartRate ?? 0}|${t.breathRate ?? 0}|${t.illuminanceLux ?? ''}|` +
      `${t.detectedPerson ?? ''}|${tun?.mode ?? ''}|${Math.floor((tun?.samplesCount ?? 0) / 10)}|` +
      `${Math.round((tun?.noiseFloor ?? 0) / 5)}`
    );
  }

  private applySmoothingConfig(): void {
    const mode = this.config.get('radarSmoothingMode') || 'ultra';
    this.distanceFilter.setMode(mode);
    if (mode === 'raw') {
      this.heartFilter.setSize(1);
      this.breathFilter.setSize(1);
    } else if (mode === 'balanced') {
      this.heartFilter.setSize(3);
      this.breathFilter.setSize(3);
    } else {
      this.heartFilter.setSize(5);
      this.breathFilter.setSize(5);
    }
  }

  private updateDistance(distCm: number): void {
    if (distCm <= 0 || distCm > 800) {
      this.telemetry.distanceCm = 0;
      this.distanceFilter.reset();
      return;
    }
    this.lastDistanceTime = Date.now();
    this.applySmoothingConfig();

    const smoothedCm = this.distanceFilter.push(distCm);
    this.telemetry.distanceCm = smoothedCm;
    this.telemetry.lastUpdate = Date.now();

    // Dystans w aktywnej strefie fotela = dowód obecności. Dystans potwierdza
    // człowieka, gdy biometria była ostatnio widziana (krótka przerwa w HR/BR nie
    // zabija obecności) albo radar w ogóle jej nie raportuje (instalacja presence-only).
    const gateEnabled = this.config.get('radarDistanceGateEnabled') !== false;
    const minGate = Number(this.config.get('radarMinDistanceCm') ?? 40);
    const maxGate = Number(this.config.get('radarMaxDistanceCm') ?? 110);
    const nowMs = Date.now();
    const bioRecent = this.lastHeartRateTime > nowMs - 20000 || this.lastBreathRateTime > nowMs - 20000;
    const bioEver = this.lastHeartRateTime > 0 || this.lastBreathRateTime > 0;
    if (!gateEnabled && smoothedCm > 0) {
      // Bez bramki każdy realny dystans potwierdza obecność
      this.markCorroborated();
    } else if (smoothedCm >= minGate && smoothedCm <= maxGate && (!bioEver || bioRecent)) {
      // W bramce i (presence-only) albo (człowiek potwierdzony biometrią niedawno)
      this.markCorroborated();
    }

    appendLog('RADAR-DSP', `Dystans: ${smoothedCm} cm (surowy: ${distCm} cm)`);

    this.feedAutoTuner({
      distanceCm: smoothedCm,
      heartRate: this.telemetry.heartRate || 0,
      breathRate: this.telemetry.breathRate || 0,
      isSeated: Boolean(this.presence || this.state === 'desk'),
      rawPresence: this.presence
    });

    this.scheduleTelemetry();
  }

  private isPetDetected(): boolean {
    if (this.config.get('petFilterEnabled') === false) return false;
    const hr = this.telemetry.heartRate || 0;
    const br = this.telemetry.breathRate || 0;

    // Normalne tętno człowieka (45-115 BPM) lub brak odczytu tętna (hr === 0) wyklucza zwierzaka
    if (hr === 0 || (hr >= 45 && hr <= 115)) {
      return false;
    }

    // Prawdziwy kot/zwierzak na fotelu: tętno > 125 BPM ORAZ oddech > 28 RPM przez kilka odczytów
    return hr >= 125 && hr <= 240 && br >= 28 && br <= 65;
  }

  private checkPetPresence(): boolean {
    if (this.isPetDetected()) {
      this.petStreak = Math.min(10, this.petStreak + 1);
    } else {
      this.petStreak = 0;
    }
    return this.petStreak >= 4;
  }

  private updateHeartRate(bpm: number): void {
    if (bpm < 30 || bpm > 240) {
      if (bpm === 0) {
        this.telemetry.heartRate = 0;
        this.heartFilter.reset();
      }
      return;
    }
    this.lastHeartRateTime = Date.now();
    this.applySmoothingConfig();

    const smoothedBpm = this.heartFilter.push(bpm);
    this.telemetry.heartRate = smoothedBpm;
    this.telemetry.lastUpdate = Date.now();

    appendLog('RADAR-DSP', `Tętno: ${smoothedBpm} BPM (surowe: ${bpm} BPM)`);
    this.markCorroborated();

    this.feedAutoTuner({
      distanceCm: this.telemetry.distanceCm || 0,
      heartRate: smoothedBpm,
      breathRate: this.telemetry.breathRate || 0,
      isSeated: Boolean(this.presence || this.state === 'desk'),
      rawPresence: this.presence
    });

    this.scheduleTelemetry();
  }

  private updateBreathRate(rpm: number): void {
    if (rpm < 2 || rpm > 70) {
      if (rpm === 0) {
        this.telemetry.breathRate = 0;
        this.breathFilter.reset();
      }
      return;
    }
    this.lastBreathRateTime = Date.now();
    this.applySmoothingConfig();

    const smoothedRpm = this.breathFilter.push(rpm);
    this.telemetry.breathRate = smoothedRpm;
    this.telemetry.lastUpdate = Date.now();

    appendLog('RADAR-DSP', `Oddech: ${smoothedRpm} RPM (surowy: ${rpm} RPM)`);
    this.markCorroborated();

    this.feedAutoTuner({
      distanceCm: this.telemetry.distanceCm || 0,
      heartRate: this.telemetry.heartRate || 0,
      breathRate: smoothedRpm,
      isSeated: Boolean(this.presence || this.state === 'desk'),
      rawPresence: this.presence
    });

    this.scheduleTelemetry();
  }

  private updateIlluminance(lux: number): void {
    if (lux < 0 || lux > 120000) return;
    const smoothed = this.illuminanceFilter.push(lux);
    this.telemetry.illuminanceLux = smoothed;
    this.scheduleTelemetry();
  }

  private handleRawPresence(rawPresent: boolean): void {
    if (rawPresent) {
      this.lastPresencePacketTime = Date.now();
    }

    let effectivePresence = rawPresent;

    // 0. Lockout fałszywego celu: po wykryciu ducha bit obecności nie może
    //    samodzielnie wznowić obecności. Realne dowody (dystans w bramce /
    //    biometria / aktywność) i tak działają — odświeżają lastCorroboratedAt
    //    i czyszczą lockout w markCorroborated().
    const isInputActiveNow = this.activityWatcher?.isUserActiveRecently(15) ?? false;
    if (effectivePresence && Date.now() < this.ghostLockoutUntil && !isInputActiveNow) {
      // Odnawiamy lockout przy każdym "gołym" bicie presence — duch nie odblokuje
      // się po upływie okna, chyba że przyjdzie prawdziwy dowód człowieka.
      const lockoutMs = Math.max(10000, Number(this.config.get('ghostLockoutMs')) || 60000);
      this.ghostLockoutUntil = Date.now() + lockoutMs;
      if (Date.now() - this.lastLockoutLogAt > 30000) {
        this.lastLockoutLogAt = Date.now();
        appendLog(
          'RADAR',
          `Ignoruję bit obecności — w lockoucie po fałszywym celu (${((this.ghostLockoutUntil - Date.now()) / 1000).toFixed(0)}s). Czekam na twardy dowód.`
        );
      }
      effectivePresence = false;
    }

    // 1. Filtr zwierzaka (kot na fotelu)
    const isPet = this.checkPetPresence();
    if (effectivePresence && isPet) {
      effectivePresence = false;
    }

    // 2. Aktywność wejściowa (klawiatura / mysz) - potwierdzenie człowieka
    if (!effectivePresence) {
      const isInputActive = this.activityWatcher?.isUserActiveRecently(15) ?? false;
      if (isInputActive) {
        appendLog('RADAR', 'Utrzymuję obecność przy biurku — aktywność klawiatury/myszy');
        effectivePresence = true;
        this.petStreak = 0;
      }
    }

    if (!effectivePresence) {
      if (isPet) {
        this.telemetry.detectedPerson = 'pet';
      } else {
        this.telemetry.heartRate = 0;
        this.telemetry.breathRate = 0;
        this.telemetry.distanceCm = 0;
        this.telemetry.distanceTrusted = true;
        this.telemetry.targetCount = undefined;
        this.telemetry.detectedPerson = 'unknown';
        this.heartFilter.reset();
        this.breathFilter.reset();
        this.distanceFilter.reset();
      }
    } else {
      this.telemetry.detectedPerson = 'me';
    }

    this.telemetry.presence = effectivePresence;
    this.scheduleTelemetry();
    this.setPresence(effectivePresence);
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
      if (data.presence) {
        this.handleRawPresence(true);
      } else {
        this.handleRawPresence(false);
      }
    }
  }

  setPresence(present: boolean): void {
    if (this.presence === present) return;
    this.presence = present;
    if (present) {
      // Start sesji obecności: nadajemy punkt odniesienia do watchdoga fałszywego celu.
      // Jeśli bit obecności leci, ale żaden twardy dowód (dystans w bramce / biometria /
      // aktywność) nie odświeży go przez GHOST_TIMEOUT_MS — wygaszamy.
      if (this.lastCorroboratedAt === 0) {
        this.lastCorroboratedAt = Date.now();
      }
    } else {
      // Zamknięcie sesji obecności: zeruj potwierdzenie, żeby kolejna sesja
      // (duch po powrocie) też wymagała twardych dowodów.
      this.lastCorroboratedAt = 0;
    }
    if (this.deskTimer) {
      clearTimeout(this.deskTimer);
      this.deskTimer = null;
    }
    if (this.awayTimer) {
      clearTimeout(this.awayTimer);
      this.awayTimer = null;
    }

    if (present) {
      const deskMs = Math.max(0, Number(this.config.get('timeoutDeskMs')) || 300);
      this.deskTimer = setTimeout(() => {
        this.deskTimer = null;
        this.setState('desk');
      }, deskMs);
    } else {
      const awayMs = Math.max(250, Number(this.config.get('timeoutAwayMs')) || 2000);
      this.awayTimer = setTimeout(() => {
        this.awayTimer = null;
        this.setState('away');
      }, awayMs);
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
