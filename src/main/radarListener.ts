import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import AutoTuner from './autoTuner';
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

  private async openPort(): Promise<void> {
    if (!this.running) return;
    try {
      const SerialPort = await this.loadSerialPort();
      // stop() mogło przyjść w trakcie await (np. flasher zwalnia port COM)
      if (!this.running) return;
      const portName = this.lastPortName || (await this.resolvePort());
      if (!this.running) return;
      if (!portName) {
        this.emit('status', { connected: false, error: 'brak portu' } satisfies RadarStatusEvent);
        this.scheduleReconnect();
        return;
      }
      this.lastPortName = portName;
      this.lineBuffer = '';
      this.rawBuffer = Buffer.alloc(0);
      const port = new SerialPort({
        path: portName,
        baudRate: this.config.get('baudRate') || 115200
      });
      this.port = port;
      port.on('open', () => {
        this.reconnectAttempts = 0;
        this.emit('status', { port: portName, connected: true } satisfies RadarStatusEvent);
      });
      port.on('data', (chunk: Buffer) => this.onData(chunk));
      port.on('error', (err: Error) => {
        this.emit('status', { connected: false, error: err.message } satisfies RadarStatusEvent);
        this.scheduleReconnect();
      });
      port.on('close', () => {
        if (this.running) this.scheduleReconnect();
      });
    } catch (err) {
      this.emit('status', { connected: false, error: (err as Error).message } satisfies RadarStatusEvent);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    // Drabina: po wlaniu kabla łączymy się szybko (czułość na replug),
    // potem zwalniamy żeby nie meczyć portu przy dłuższej nieobecności.
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
    if (this.port && this.port.isOpen) {
      const p = this.port;
      this.port = null;
      await new Promise<void>((resolve) => p.close(() => resolve()));
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
      const line = this.lineBuffer.slice(0, idx).trim();
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (!line) continue;

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

      // ESPHome log formats
      if (line.includes('Got state') || line.includes('[sensor') || line.includes('[binary_sensor')) {
        const distMatch = line.match(/(?:distance|odległość|Distance to detection object)[^:]*:\s*(?:Got state\s*)?([0-9.]+)/i);
        if (distMatch) {
          const val = parseFloat(distMatch[1]);
          const distCm = val < 10 ? Math.round(val * 100) : Math.round(val);
          this.updateDistance(distCm);
        }
        const hrMatch = line.match(/(?:heart|tętno|Real-time heart rate|bpm)[^:]*:\s*(?:Got state\s*)?([0-9.]+)/i);
        if (hrMatch) {
          const bpm = Math.round(parseFloat(hrMatch[1]));
          if (bpm >= 30 && bpm <= 240) this.updateHeartRate(bpm);
        }
        const brMatch = line.match(/(?:breath|oddech|respiratory|Real-time respiratory rate|rpm)[^:]*:\s*(?:Got state\s*)?([0-9.]+)/i);
        if (brMatch) {
          const rpm = Math.round(parseFloat(brMatch[1]));
          if (rpm >= 5 && rpm <= 70) this.updateBreathRate(rpm);
        }
        if (/Person Information|Has Target|has_target|target_info|presence|occupancy/i.test(line)) {
          if (/ON|true|1/i.test(line)) {
            this.handleRawPresence(true);
            continue;
          } else if (/OFF|false|0/i.test(line)) {
            this.handleRawPresence(false);
            continue;
          }
        }
      }

      // Plain text formats
      const plainDistMatch = line.match(/^distance:\s*([0-9.]+)/i);
      if (plainDistMatch) {
        const val = parseFloat(plainDistMatch[1]);
        const distCm = val < 10 ? Math.round(val * 100) : Math.round(val);
        this.updateDistance(distCm);
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

  private scanBinaryFrames(): void {
    while (this.rawBuffer.length >= 4) {
      const start = this.rawBuffer.indexOf(Buffer.from([0x53, 0x59]));
      if (start === -1) {
        this.rawBuffer = this.rawBuffer.slice(-1);
        break;
      }
      if (start > 0) {
        this.rawBuffer = this.rawBuffer.slice(start);
      }
      if (this.rawBuffer.length < 4) break;

      const len = this.rawBuffer[3] || this.rawBuffer[2];
      const frameLen = Math.max(4, Math.min(len + 4, 48));

      if (this.rawBuffer.length < frameLen) {
        break;
      }

      const frame = this.rawBuffer.slice(0, frameLen);
      this.parseBinaryFrame(frame);
      this.rawBuffer = this.rawBuffer.slice(frameLen);
    }

    if (this.rawBuffer.length > 1024) {
      this.rawBuffer = Buffer.alloc(0);
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

  private updateDistance(distCm: number): void {
    if (distCm <= 0 || distCm > 800) return;
    this.telemetry.distanceCm = distCm;
    this.telemetry.lastUpdate = Date.now();

    this.feedAutoTuner({
      distanceCm: distCm,
      heartRate: this.telemetry.heartRate || 0,
      breathRate: this.telemetry.breathRate || 0,
      isSeated: Boolean(this.presence || this.state === 'desk'),
      rawPresence: this.presence
    });

    this.evaluateBiometrics();
    this.emit('telemetry', this.telemetry);
  }

  private updateHeartRate(bpm: number): void {
    this.telemetry.heartRate = bpm;
    this.telemetry.lastUpdate = Date.now();

    this.feedAutoTuner({
      distanceCm: this.telemetry.distanceCm || 0,
      heartRate: bpm,
      breathRate: this.telemetry.breathRate || 0,
      isSeated: Boolean(this.presence || this.state === 'desk'),
      rawPresence: this.presence
    });

    this.evaluateBiometrics();
    this.emit('telemetry', this.telemetry);
  }

  private updateBreathRate(rpm: number): void {
    this.telemetry.breathRate = rpm;
    this.telemetry.lastUpdate = Date.now();

    this.feedAutoTuner({
      distanceCm: this.telemetry.distanceCm || 0,
      heartRate: this.telemetry.heartRate || 0,
      breathRate: rpm,
      isSeated: Boolean(this.presence || this.state === 'desk'),
      rawPresence: this.presence
    });

    this.evaluateBiometrics();
    this.emit('telemetry', this.telemetry);
  }

  private evaluateBiometrics(): void {
    const hr = this.telemetry.heartRate || 0;
    const rpm = this.telemetry.breathRate || 0;
    const dist = this.telemetry.distanceCm || 0;

    // Klasyfikacja "pet" wymaga PERSISTENCJI (kilka kolejnych odczytów).
    // Pojedniczy skok tętna/oddechu u człowieka (stres, wysiłek) nie może
    // go przeklasyfikować na zwierzę i stłumić przełączenia.
    const isPetSignature =
      this.config.get('petFilterEnabled') !== false &&
      ((rpm > 22 && rpm <= 60) || (hr > 125 && hr <= 240));
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
    let effectivePresence = rawPresent;

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

      const curDist = this.telemetry.distanceCm || 0;

      if (curDist > 0 && (curDist < minGate || curDist > maxGate)) {
        effectivePresence = false;
      }
    }

    if (effectivePresence && this.config.get('biometricsEnabled')) {
      const action = this.config.get('personMismatchAction') || 'ignore';
      if (this.telemetry.detectedPerson === 'other' && action === 'ignore') {
        effectivePresence = false;
      }
    }

    this.telemetry.presence = effectivePresence;
    this.setPresence(effectivePresence);
  }

  resetAutoTuning(): ReturnType<AutoTuner['getStatus']> {
    const status = this.autoTuner.reset();
    this.telemetry.autoTuning = status;
    this.emit('telemetry', this.telemetry);
    return status;
  }

  setPresence(present: boolean): void {
    if (this.presence === present) return;
    this.presence = present;
    if (this.deskTimer) clearTimeout(this.deskTimer);
    if (this.awayTimer) clearTimeout(this.awayTimer);

    if (present) {
      this.deskTimer = setTimeout(() => this.setState('desk'), this.config.get('timeoutDeskMs'));
    } else {
      this.awayTimer = setTimeout(() => this.setState('away'), this.config.get('timeoutAwayMs'));
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
