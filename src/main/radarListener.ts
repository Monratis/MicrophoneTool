import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import AutoTuner from './autoTuner';
import { MedianFilter, ExponentialSmoothingFilter, PresenceDebounceFilter, DistanceFilter } from './signalFilter';
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
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  reconnectAttempts = 0;
  private lastPortName: string | null = null;
  private petStreak = 0;
  private lineBuffer = '';
  private rawBuffer: Buffer = Buffer.alloc(0);

  // Cyfrowe filtry DSP dla całkowitej stabilizacji sygnału
  private distanceFilter = new DistanceFilter();
  private heartMedian = new MedianFilter(5);
  private heartEMA = new ExponentialSmoothingFilter(0.2);
  private breathMedian = new MedianFilter(5);
  private breathEMA = new ExponentialSmoothingFilter(0.2);
  private presenceFilter = new PresenceDebounceFilter(2500);
  private outOfGateStreak = 0;
  private lastLoggedLux: number | null = null;

  telemetry: RadarTelemetry;

  constructor(config: Config) {
    super();
    this.config = config;
    this.autoTuner = new AutoTuner(config);
    this.telemetry = {
      presence: false,
      distanceCm: 0,
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
    await this.openPort();
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
        if (this.running) this.scheduleReconnect();
      });
    } catch (err: any) {
      appendLog('RADAR', `Błąd otwierania portu: ${err.message || err}`);
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
          if (json.distance !== undefined) this.updateDistance(Number(json.distance));
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
      if (line.includes('state') || line.includes('[sensor') || line.includes('[binary_sensor')) {
        const esphomeMatch = line.match(/'([^']+)':\s*(?:Sending state|Got state|state:?)\s*([^\s,;]+)/i);
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

          // Dystans
          if (entity.includes('distance') || entity.includes('odległość') || entity.includes('dystans') || entity.includes('detection object')) {
            const val = parseFloat(stateVal);
            if (Number.isFinite(val) && val > 0) {
              const distCm = val < 10 && !line.toLowerCase().includes('cm') ? Math.round(val * 100) : Math.round(val);
              this.updateDistance(distCm);
              this.handleRawPresence(true);
            }
          }

          // Tętno
          if (entity.includes('heart') || entity.includes('tętno') || entity.includes('bpm')) {
            const bpm = Math.round(parseFloat(stateVal));
            if (bpm >= 30 && bpm <= 240) {
              this.updateHeartRate(bpm);
              this.handleRawPresence(true);
            }
          }

          // Oddech
          if (entity.includes('breath') || entity.includes('oddech') || entity.includes('respiratory') || entity.includes('rpm')) {
            const rpm = Math.round(parseFloat(stateVal));
            if (rpm >= 2 && rpm <= 70) {
              this.updateBreathRate(rpm);
              this.handleRawPresence(true);
            }
          }

          // Liczba wykrytych obiektów (Target Number)
          if (entity.includes('target number') || entity.includes('targets')) {
            const count = parseFloat(stateVal);
            if (Number.isFinite(count)) {
              this.handleRawPresence(count > 0);
              continue;
            }
          }

          // Encje binarne obecności (Person Information, Has Target, Someone Present itp.)
          if (
            entity.includes('person') ||
            entity.includes('presence') ||
            entity.includes('occupan') ||
            entity.includes('has target') ||
            entity.includes('someone') ||
            entity.includes('target_info')
          ) {
            const upperState = stateVal.toUpperCase();
            if (upperState === 'ON' || upperState === 'TRUE' || upperState === '1') {
              this.handleRawPresence(true);
              continue;
            } else if (upperState === 'OFF' || upperState === 'FALSE' || upperState === '0') {
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
          const distMatch = line.match(/(?:distance|odległość|Distance to detection object)[^:]*:\s*(?:(?:Got|Sending)\s+state\s+)?([0-9.]+)/i);
          if (distMatch) {
            const val = parseFloat(distMatch[1]);
            if (val > 0) {
              const distCm = val < 10 && !line.toLowerCase().includes('cm') ? Math.round(val * 100) : Math.round(val);
              this.updateDistance(distCm);
            }
          }
          const hrMatch = line.match(/(?:heart|tętno|Real-time heart rate|bpm)[^:]*:\s*(?:(?:Got|Sending)\s+state\s+)?([0-9.]+)/i);
          if (hrMatch) {
            const bpm = Math.round(parseFloat(hrMatch[1]));
            if (bpm >= 30 && bpm <= 240) this.updateHeartRate(bpm);
          }
          const brMatch = line.match(/(?:breath|oddech|respiratory|Real-time respiratory rate|rpm)[^:]*:\s*(?:(?:Got|Sending)\s+state\s+)?([0-9.]+)/i);
          if (brMatch) {
            const rpm = Math.round(parseFloat(brMatch[1]));
            if (rpm >= 2 && rpm <= 70) this.updateBreathRate(rpm);
          }
          const presenceMatch = line.match(/(?:person information|has target|has_target|target_info|presence|occupancy|target number)[^:]*:\s*(?:(?:Got|Sending)\s+state\s+)?(ON|OFF|true|false|[0-9.]+)/i);
          if (presenceMatch) {
            const st = presenceMatch[1].toUpperCase();
            if (st === 'ON' || st === 'TRUE' || parseFloat(st) > 0) {
              this.handleRawPresence(true);
              continue;
            } else if (st === 'OFF' || st === 'FALSE' || parseFloat(st) === 0) {
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
        }
      }
      const plainHrMatch = line.match(/^heart_rate:\s*([0-9.]+)/i);
      if (plainHrMatch) {
        this.updateHeartRate(Math.round(parseFloat(plainHrMatch[1])));
      }
      const plainBrMatch = line.match(/^breath_rate:\s*([0-9.]+)/i);
      if (plainBrMatch) {
        this.updateBreathRate(Math.round(parseFloat(plainBrMatch[1])));
      }

      if (/^(presence|someone|occupied|target:\s*1|desk)/i.test(line)) {
        if (/0|false|nobody|away|empty/i.test(line)) {
          this.handleRawPresence(false);
        } else {
          this.handleRawPresence(true);
        }
      } else if (/^(nobody|away|unoccupied|target:\s*0|empty)/i.test(line)) {
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
  private scanBinaryFrames(): void {
    while (this.rawBuffer.length >= 8) {
      if (this.rawBuffer[0] !== 0x01) {
        const idx = this.rawBuffer.indexOf(0x01);
        if (idx === -1) {
          this.rawBuffer = Buffer.alloc(0);
          return;
        }
        this.rawBuffer = this.rawBuffer.slice(idx);
        continue;
      }

      const len = (this.rawBuffer[3] << 8) | this.rawBuffer[4];
      if (len > 64) {
        this.rawBuffer = this.rawBuffer.slice(1);
        continue;
      }
      const total = 8 + len + 1;
      if (this.rawBuffer.length < total) return;

      const frame = this.rawBuffer.subarray(0, total);
      let hc = 0;
      for (let i = 0; i < 7; i++) hc ^= frame[i];
      if ((~hc & 0xff) !== frame[7]) {
        this.rawBuffer = this.rawBuffer.slice(1);
        continue;
      }
      let dc = 0;
      for (let i = 8; i < 8 + len; i++) dc ^= frame[i];
      if ((~dc & 0xff) !== frame[8 + len]) {
        this.rawBuffer = this.rawBuffer.slice(1);
        continue;
      }

      const type = (frame[5] << 8) | frame[6];
      this.dispatchRadarFrame(type, frame.subarray(8, 8 + len));
      this.rawBuffer = this.rawBuffer.slice(total);
    }
  }

  /** Float z payloadu — Seeed wysyła bajty odwrócone względem LE. */
  private payloadFloat(p: Buffer): number {
    if (p.length < 4) return NaN;
    return Buffer.from([p[3], p[2], p[1], p[0]]).readFloatLE(0);
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
        break;
      }
      case 0x0a14: {
        const rpm = Math.round(this.payloadFloat(p));
        if (rpm >= 5 && rpm <= 70) this.updateBreathRate(rpm);
        break;
      }
      case 0x0a16: {
        const f = this.payloadFloat(p);
        if (Number.isFinite(f) && f > 0 && f <= 800) {
          // Firmware potrafi raportować w metrach albo cm — heurystyka jak w ścieżce tekstowej
          const cm = f < 10 ? Math.round(f * 100) : Math.round(f);
          this.updateDistance(cm);
        }
        break;
      }
      default:
        break;
    }
  }

  private parseBinaryFrame(buf: Buffer): void {
    if (buf.length < 4 || buf[0] !== 0x53 || buf[1] !== 0x59) return;

    for (let i = 2; i < buf.length - 1; i++) {
      if (buf[i] === 0x0a && buf[i + 1] === 0x16 && i + 3 < buf.length) {
        const dist = (buf[i + 2] << 8) | buf[i + 3];
        this.updateDistance(dist > 500 ? Math.round(dist / 10) : dist);
      }
      if (buf[i] === 0x0a && buf[i + 1] === 0x15 && i + 2 < buf.length) {
        const bpm = buf[i + 2];
        if (bpm >= 30 && bpm <= 240) {
          this.updateHeartRate(bpm);
        }
      }
      if (buf[i] === 0x0a && buf[i + 1] === 0x14 && i + 2 < buf.length) {
        const rpm = buf[i + 2];
        if (rpm >= 5 && rpm <= 70) {
          this.updateBreathRate(rpm);
        }
      }
      if ((buf[i] === 0x80 || buf[i] === 0x01) && buf[i + 1] === 0x01 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this.handleRawPresence(val === 0x01);
        return;
      }
      if (buf[i] === 0x0f && buf[i + 1] === 0x09 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this.handleRawPresence(val === 0x01);
        return;
      }
      if (buf[i] === 0x80 && buf[i + 1] === 0x02 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this.handleRawPresence(val === 0x01 || val === 0x02);
        return;
      }
    }
  }

  private feedAutoTuner(sample: Sample): void {
    this.autoTuner.feedSample(sample);
    this.telemetry.autoTuning = this.autoTuner.getStatus();
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
      `${t.presence ? 1 : 0}|${t.distanceCm ?? 0}|${t.heartRate ?? 0}|${t.breathRate ?? 0}|${t.illuminanceLux ?? ''}|` +
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
      `${t.presence ? 1 : 0}|${t.distanceCm ?? 0}|${t.heartRate ?? 0}|${t.breathRate ?? 0}|${t.illuminanceLux ?? ''}|` +
      `${t.detectedPerson ?? ''}|${tun?.mode ?? ''}|${Math.floor((tun?.samplesCount ?? 0) / 10)}|` +
      `${Math.round((tun?.noiseFloor ?? 0) / 5)}`
    );
  }

  private applySmoothingConfig(): void {
    const mode = this.config.get('radarSmoothingMode') || 'ultra';
    this.distanceFilter.setMode(mode);
    if (mode === 'ultra') {
      this.heartMedian.setSize(5);
      this.heartEMA.setAlpha(0.16);
      this.breathMedian.setSize(5);
      this.breathEMA.setAlpha(0.16);
      this.presenceFilter.setHoldOffMs(1800);
    } else if (mode === 'balanced') {
      this.heartMedian.setSize(5);
      this.heartEMA.setAlpha(0.25);
      this.breathMedian.setSize(5);
      this.breathEMA.setAlpha(0.25);
      this.presenceFilter.setHoldOffMs(1200);
    } else {
      this.heartMedian.setSize(3);
      this.heartEMA.setAlpha(0.5);
      this.breathMedian.setSize(3);
      this.breathEMA.setAlpha(0.5);
      this.presenceFilter.setHoldOffMs(600);
    }
  }

  private updateDistance(distCm: number): void {
    if (distCm <= 0 || distCm > 800) return;
    this.applySmoothingConfig();

    const smoothedCm = this.distanceFilter.push(distCm);

    this.telemetry.distanceCm = smoothedCm;
    this.telemetry.lastUpdate = Date.now();

    appendLog('RADAR-DSP', `Dystans: ${smoothedCm} cm (surowy: ${distCm} cm)`);

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
    if (bpm < 30 || bpm > 240) return;
    this.applySmoothingConfig();

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
    if (rpm < 2 || rpm > 70) return;
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
    const rounded = Math.round(lux * 10) / 10;
    this.telemetry.illuminanceLux = rounded;
    this.telemetry.lastUpdate = Date.now();
    if (this.lastLoggedLux === null || Math.abs(rounded - this.lastLoggedLux) >= 0.2) {
      this.lastLoggedLux = rounded;
      appendLog('RADAR-DSP', `Światło: ${rounded} lx`);
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
      return;
    }

    if (!this.config.get('biometricsEnabled')) {
      this.telemetry.detectedPerson = dist > 0 ? 'me' : 'unknown';
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
        : (this.config.get('userSeatingDistanceMin') ?? 50);

    const distMax =
      autoTuningOn && dynamicGate.isCalibrated
        ? dynamicGate.maxGateCm
        : (this.config.get('userSeatingDistanceMax') ?? 95);

    let matches = true;

    if (hr > 0 && (hr < hrMin || hr > hrMax)) {
      matches = false;
    }
    if (dist > 0 && (dist < distMin || dist > distMax)) {
      matches = false;
    }

    this.telemetry.detectedPerson = matches ? 'me' : 'other';
  }

  private handleRawPresence(rawPresent: boolean): void {
    this.applySmoothingConfig();

    const curDist = this.telemetry.distanceCm || 0;
    // Micro-Presence: podtrzymuje obecność przy mikro-zanikach pakietów TYLKO gdy
    // tętno człowieka jest aktywne ORAZ dystans znajduje się w aktywnej strefie biurka.
    const hasActiveBiometrics =
      Boolean(this.telemetry.heartRate && this.telemetry.heartRate >= 35) &&
      curDist > 0 &&
      Date.now() - (this.telemetry.lastUpdate || 0) < 2000;

    const effectiveRaw = rawPresent || (this.presence && hasActiveBiometrics);

    this.presenceFilter.process(effectiveRaw, (stablePresence) => {
      let effectivePresence = stablePresence;

      if (effectivePresence && this.config.get('petFilterEnabled') !== false) {
        if (this.telemetry.detectedPerson === 'pet') {
          effectivePresence = false;
        }
      }

      if (effectivePresence && this.config.get('radarDistanceGateEnabled')) {
        const autoTuningOn = this.config.get('radarAutoTuningEnabled') !== false;
        const dynamicGate = this.autoTuner.getDynamicGate();

        const minGate =
          autoTuningOn && dynamicGate.isCalibrated
            ? dynamicGate.minGateCm
            : Number(this.config.get('radarMinDistanceCm') ?? 40);

        const maxGate =
          autoTuningOn && dynamicGate.isCalibrated
            ? dynamicGate.maxGateCm
            : Number(this.config.get('radarMaxDistanceCm') ?? 110);

        // Histereza korytarza: margines tolerancji 6 cm i wymóg min. 3 kolejnych odczytów poza strefą
        if (curDist > 0 && (curDist < minGate - 6 || curDist > maxGate + 6)) {
          this.outOfGateStreak++;
          if (this.outOfGateStreak >= 3) {
            effectivePresence = false;
          }
        } else {
          this.outOfGateStreak = 0;
        }
      } else {
        this.outOfGateStreak = 0;
      }

      if (effectivePresence && this.config.get('biometricsEnabled')) {
        const action = this.config.get('personMismatchAction') || 'ignore';
        if (this.telemetry.detectedPerson === 'other' && action === 'ignore') {
          effectivePresence = false;
        }
      }

      if (!effectivePresence) {
        this.telemetry.heartRate = 0;
        this.telemetry.breathRate = 0;
        this.telemetry.distanceCm = 0;
        this.telemetry.detectedPerson = 'unknown';
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
    if (typeof data.distanceCm === 'number' && Number.isFinite(data.distanceCm) && data.distanceCm > 0) {
      this.updateDistance(data.distanceCm);
    }
    if (typeof data.heartRate === 'number' && Number.isFinite(data.heartRate) && data.heartRate > 0) {
      this.updateHeartRate(data.heartRate);
    }
    if (typeof data.breathRate === 'number' && Number.isFinite(data.breathRate) && data.breathRate > 0) {
      this.updateBreathRate(data.breathRate);
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
