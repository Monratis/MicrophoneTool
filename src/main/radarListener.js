import { EventEmitter } from 'node:events';
import AutoTuner from './autoTuner.js';

const KNOWN_VID_PIDS = [
  { vid: 0x2886, pid: 0x802d }, // Seeed Studio XIAO ESP32-C6
  { vid: 0x303a, pid: 0x1001 }, // Espressif ESP32-C6 Native USB JTAG/Serial
  { vid: 0x303a, pid: 0x1002 }, // Espressif ESP32-C6 CDC
  { vid: 0x1a86, pid: 0x7523 }, // CH340
  { vid: 0x1a86, pid: 0x55d4 }, // CH9102 / CH343
  { vid: 0x10c4, pid: 0xea60 }  // CP210x
];

/**
 * Zaawansowany nasłuch i dekoder radaru Seeed mmWave 60GHz (MR60BHA2 + XIAO ESP32-C6).
 * Obsługuje:
 *  - Ramki TinyFrame 0x53 0x59 (obecność, odległość w cm, tętno BPM, oddech RPM)
 *  - Pakiety JSON i strumienie tekstowe
 *  - Samoadaptacyjny Auto-Tuning do pozycji fotela, szumu tła i biometrii użytkownika
 *  - Bramkę odległości (Spatial Distance Gate) eliminującą fałszywe wykrycia w tle
 *  - Inteligentne rozróżnianie zwierząt domowych (Kot / Pies - szybki oddech >22 RPM, tętno >125 BPM)
 *  - Rozróżnianie tożsamości na bazie biometrii (Ty vs Narzeczona / Inni)
 */
export default class RadarListener extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.autoTuner = new AutoTuner(config);
    this.port = null;
    this.SerialPort = null;
    this.presence = false;
    this.state = null; // 'desk' | 'away'
    this.deskTimer = null;
    this.awayTimer = null;
    this._running = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._lastPortName = null;
    this._lineBuffer = '';
    this._rawBuffer = Buffer.alloc(0);

    // Telemetria biometryczna na żywo i stan auto-tuningu
    this.telemetry = {
      presence: false,
      distanceCm: 0,
      heartRate: 0,
      breathRate: 0,
      detectedPerson: 'unknown', // 'me' | 'other' | 'pet' | 'unknown'
      autoTuning: this.autoTuner.getStatus(),
      lastUpdate: 0
    };
  }

  async _loadSerialPort() {
    if (!this.SerialPort) {
      const m = await import('serialport');
      this.SerialPort = m.SerialPort || m.default.SerialPort;
    }
    return this.SerialPort;
  }

  static async listPorts() {
    try {
      const m = await import('serialport');
      const SerialPort = m.SerialPort || m.default.SerialPort;
      return await SerialPort.list();
    } catch (err) {
      console.error('[radar] listPorts error:', err.message);
      return [];
    }
  }

  async start() {
    this._running = true;
    this._reconnectAttempts = 0;
    await this._openPort();
  }

  async _openPort() {
    if (!this._running) return;
    try {
      const SerialPort = await this._loadSerialPort();
      const portName = this._lastPortName || await this._resolvePort();
      if (!portName) {
        this.emit('status', { connected: false, error: 'brak portu' });
        this._scheduleReconnect();
        return;
      }
      this._lastPortName = portName;
      const port = new SerialPort({
        path: portName,
        baudRate: this.config.get('baudRate') || 115200
      });
      this.port = port;
      port.on('open', () => {
        this._reconnectAttempts = 0;
        this.emit('status', { port: portName, connected: true });
      });
      port.on('data', (chunk) => this._onData(chunk));
      port.on('error', (err) => {
        this.emit('status', { connected: false, error: err.message });
        this._scheduleReconnect();
      });
      port.on('close', () => {
        if (this._running) this._scheduleReconnect();
      });
    } catch (err) {
      this.emit('status', { connected: false, error: err.message });
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (!this._running || this._reconnectTimer) return;
    const delay = 2500;
    this._lastPortName = null;
    this.emit('status', { connected: false, nextReconnectMs: delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openPort();
    }, delay);
  }

  async stop() {
    this._running = false;
    clearTimeout(this.deskTimer);
    clearTimeout(this.awayTimer);
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.port && this.port.isOpen) {
      const p = this.port;
      this.port = null;
      await new Promise((resolve) => p.close(resolve));
    }
  }

  async _resolvePort() {
    const configured = this.config.get('port');
    if (configured && configured !== 'auto') {
      return configured;
    }
    try {
      const ports = await RadarListener.listPorts();
      const match = ports.find((p) =>
        KNOWN_VID_PIDS.some((id) =>
          (p.vendorId && parseInt(p.vendorId, 16) === id.vid) &&
          (!id.pid || (p.productId && parseInt(p.productId, 16) === id.pid))
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
      console.error('[radar] enumerate ports error:', err.message);
    }
    return null;
  }

  _onData(chunk) {
    if (this.listenerCount('raw') > 0) {
      this.emit('raw', chunk.toString('utf8'));
    }

    // 1. Akumulacja i skanowanie ramek binarnych 0x53 0x59 (Seeed MR60BHA2)
    this._rawBuffer = Buffer.concat([this._rawBuffer, chunk]);
    this._scanBinaryFrames();

    // 2. Przetwarzanie linii tekstowych i JSON
    this._lineBuffer += chunk.toString('utf8');
    let idx;
    while ((idx = this._lineBuffer.indexOf('\n')) >= 0) {
      const line = this._lineBuffer.slice(0, idx).trim();
      this._lineBuffer = this._lineBuffer.slice(idx + 1);
      if (!line) continue;

      // JSON format
      if (line.charCodeAt(0) === 123) {
        try {
          const json = JSON.parse(line);
          if (typeof json.distance !== 'undefined') {
            this._updateDistance(Number(json.distance));
          }
          if (typeof json.heartRate !== 'undefined' || typeof json.heart_rate !== 'undefined' || typeof json.bpm !== 'undefined') {
            this._updateHeartRate(Number(json.heartRate || json.heart_rate || json.bpm));
          }
          if (typeof json.breathRate !== 'undefined' || typeof json.breath_rate !== 'undefined' || typeof json.rpm !== 'undefined') {
            this._updateBreathRate(Number(json.breathRate || json.breath_rate || json.rpm));
          }
          if (typeof json.presence !== 'undefined') {
            this._handleRawPresence(Boolean(Number(json.presence)));
            continue;
          }
          if (typeof json.occupied !== 'undefined') {
            this._handleRawPresence(Boolean(Number(json.occupied)));
            continue;
          }
          if (typeof json.target !== 'undefined') {
            this._handleRawPresence(Boolean(Number(json.target)));
            continue;
          }
        } catch (_) {}
      }

      // Hex string format
      if (/^(53\s*59)/i.test(line)) {
        const hex = line.replace(/[^0-9a-fA-F]/g, '');
        if (hex.length >= 8) {
          this._parseBinaryFrame(Buffer.from(hex, 'hex'));
          continue;
        }
      }

      // ESPHome log formats (np. [D][sensor:...]: 'Real-time respiratory rate': Got state 14.00)
      if (line.includes('Got state') || line.includes('[sensor') || line.includes('[binary_sensor')) {
        // Distance
        const distMatch = line.match(/(?:distance|odległość|Distance to detection object)[^:]*:\s*(?:Got state\s*)?([0-9.]+)/i);
        if (distMatch) {
          const val = parseFloat(distMatch[1]);
          // ESPHome często raportuje odległość w metrach (np. 0.75 m = 75 cm)
          const distCm = val < 10 ? Math.round(val * 100) : Math.round(val);
          this._updateDistance(distCm);
        }
        // Heart Rate
        const hrMatch = line.match(/(?:heart|tętno|Real-time heart rate|bpm)[^:]*:\s*(?:Got state\s*)?([0-9.]+)/i);
        if (hrMatch) {
          const bpm = Math.round(parseFloat(hrMatch[1]));
          if (bpm >= 30 && bpm <= 240) this._updateHeartRate(bpm);
        }
        // Breath Rate
        const brMatch = line.match(/(?:breath|oddech|respiratory|Real-time respiratory rate|rpm)[^:]*:\s*(?:Got state\s*)?([0-9.]+)/i);
        if (brMatch) {
          const rpm = Math.round(parseFloat(brMatch[1]));
          if (rpm >= 5 && rpm <= 70) this._updateBreathRate(rpm);
        }
        // Presence / Binary Sensor
        if (/Person Information|Has Target|has_target|target_info|presence|occupancy/i.test(line)) {
          if (/ON|true|1/i.test(line)) {
            this._handleRawPresence(true);
            continue;
          } else if (/OFF|false|0/i.test(line)) {
            this._handleRawPresence(false);
            continue;
          }
        }
      }

      // Plain text formats (np. Arduino Serial.printf "breath_rate: 14.00", "distance: 0.75")
      const plainDistMatch = line.match(/^distance:\s*([0-9.]+)/i);
      if (plainDistMatch) {
        const val = parseFloat(plainDistMatch[1]);
        const distCm = val < 10 ? Math.round(val * 100) : Math.round(val);
        this._updateDistance(distCm);
      }
      const plainHrMatch = line.match(/^heart_rate:\s*([0-9.]+)/i);
      if (plainHrMatch) {
        this._updateHeartRate(Math.round(parseFloat(plainHrMatch[1])));
      }
      const plainBrMatch = line.match(/^breath_rate:\s*([0-9.]+)/i);
      if (plainBrMatch) {
        this._updateBreathRate(Math.round(parseFloat(plainBrMatch[1])));
      }

      if (/^(presence|someone|occupied|target:\s*1|desk)/i.test(line)) {
        if (/0|false|nobody|away|empty/i.test(line)) {
          this._handleRawPresence(false);
        } else {
          this._handleRawPresence(true);
        }
      } else if (/^(nobody|away|unoccupied|target:\s*0|empty)/i.test(line)) {
        this._handleRawPresence(false);
      }
    }

    if (this._lineBuffer.length > 4096) {
      this._lineBuffer = '';
    }
  }

  _scanBinaryFrames() {
    while (this._rawBuffer.length >= 4) {
      const start = this._rawBuffer.indexOf(Buffer.from([0x53, 0x59]));
      if (start === -1) {
        this._rawBuffer = this._rawBuffer.slice(-1);
        break;
      }
      if (start > 0) {
        this._rawBuffer = this._rawBuffer.slice(start);
      }
      if (this._rawBuffer.length < 4) break;

      const len = this._rawBuffer[3] || this._rawBuffer[2];
      const frameLen = Math.max(4, Math.min(len + 4, 48));

      if (this._rawBuffer.length < frameLen) {
        break;
      }

      const frame = this._rawBuffer.slice(0, frameLen);
      this._parseBinaryFrame(frame);
      this._rawBuffer = this._rawBuffer.slice(frameLen);
    }

    if (this._rawBuffer.length > 1024) {
      this._rawBuffer = Buffer.alloc(0);
    }
  }

  _parseBinaryFrame(buf) {
    if (buf.length < 4 || buf[0] !== 0x53 || buf[1] !== 0x59) return;

    for (let i = 2; i < buf.length - 1; i++) {
      // 1. Odległość celu (Distance 0x0A 0x16 w cm lub mm)
      if (buf[i] === 0x0A && buf[i + 1] === 0x16 && i + 3 < buf.length) {
        const dist = (buf[i + 2] << 8) | buf[i + 3];
        this._updateDistance(dist > 500 ? Math.round(dist / 10) : dist);
      }
      // 2. Tętno (Heart Rate 0x0A 0x15 w BPM)
      if (buf[i] === 0x0A && buf[i + 1] === 0x15 && i + 2 < buf.length) {
        const bpm = buf[i + 2];
        if (bpm >= 30 && bpm <= 240) {
          this._updateHeartRate(bpm);
        }
      }
      // 3. Oddech (Breath Rate 0x0A 0x14 w RPM)
      if (buf[i] === 0x0A && buf[i + 1] === 0x14 && i + 2 < buf.length) {
        const rpm = buf[i + 2];
        if (rpm >= 5 && rpm <= 70) {
          this._updateBreathRate(rpm);
        }
      }
      // 4. Obecność człowieka (Presence status 0x80 0x01 / 0x01 0x01 / 0x0F 0x09)
      if ((buf[i] === 0x80 || buf[i] === 0x01) && buf[i + 1] === 0x01 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this._handleRawPresence(val === 0x01);
        return;
      }
      if (buf[i] === 0x0F && buf[i + 1] === 0x09 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this._handleRawPresence(val === 0x01);
        return;
      }
      // 5. Ruch ciała 0x80 0x02
      if (buf[i] === 0x80 && buf[i + 1] === 0x02 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this._handleRawPresence(val === 0x01 || val === 0x02);
        return;
      }
    }
  }

  _updateDistance(distCm) {
    if (distCm <= 0 || distCm > 800) return;
    this.telemetry.distanceCm = distCm;
    this.telemetry.lastUpdate = Date.now();

    this.autoTuner.feedSample({
      distanceCm: distCm,
      heartRate: this.telemetry.heartRate,
      breathRate: this.telemetry.breathRate,
      isSeated: this.presence || this.state === 'desk',
      rawPresence: this.presence
    });
    this.telemetry.autoTuning = this.autoTuner.getStatus();

    this._evaluateBiometrics();
    this.emit('telemetry', this.telemetry);
  }

  _updateHeartRate(bpm) {
    this.telemetry.heartRate = bpm;
    this.telemetry.lastUpdate = Date.now();

    this.autoTuner.feedSample({
      distanceCm: this.telemetry.distanceCm,
      heartRate: bpm,
      breathRate: this.telemetry.breathRate,
      isSeated: this.presence || this.state === 'desk',
      rawPresence: this.presence
    });
    this.telemetry.autoTuning = this.autoTuner.getStatus();

    this._evaluateBiometrics();
    this.emit('telemetry', this.telemetry);
  }

  _updateBreathRate(rpm) {
    this.telemetry.breathRate = rpm;
    this.telemetry.lastUpdate = Date.now();

    this.autoTuner.feedSample({
      distanceCm: this.telemetry.distanceCm,
      heartRate: this.telemetry.heartRate,
      breathRate: rpm,
      isSeated: this.presence || this.state === 'desk',
      rawPresence: this.presence
    });
    this.telemetry.autoTuning = this.autoTuner.getStatus();

    this._evaluateBiometrics();
    this.emit('telemetry', this.telemetry);
  }

  /**
   * Ocenia tożsamość celu (Człowiek/Ty vs Narzeczona vs Zwierzę domowe Kot/Pies).
   */
  _evaluateBiometrics() {
    const hr = this.telemetry.heartRate;
    const rpm = this.telemetry.breathRate;
    const dist = this.telemetry.distanceCm;

    // 1. Rozpoznawanie zwierząt domowych (Kot / Pies):
    // Kot: tętno 140-220 BPM, oddech 22-40 RPM.
    // Pies: tętno 100-160 BPM, oddech 20-35 RPM.
    const isPetSignature = (rpm > 22 && rpm <= 60) || (hr > 125 && hr <= 240);
    if (this.config.get('petFilterEnabled') !== false && isPetSignature) {
      this.telemetry.detectedPerson = 'pet';
      return;
    }

    // 2. Jeśli biometria wyłączona -> oznacz jako człowiek
    if (!this.config.get('biometricsEnabled')) {
      this.telemetry.detectedPerson = isPetSignature ? 'pet' : (dist > 0 ? 'me' : 'unknown');
      return;
    }

    // 3. Dopasowanie Twojego profilu biometrycznego (z uwzględnieniem wyuczonego Auto-Tuningu)
    const adaptedBio = this.autoTuner.getAdaptedBiometrics();
    const autoTuningOn = this.config.get('radarAutoTuningEnabled') !== false;

    const hrMin = (autoTuningOn && adaptedBio.isCalibrated)
      ? adaptedBio.heartRateMin
      : (this.config.get('userHeartRateMin') ?? 55);

    const hrMax = (autoTuningOn && adaptedBio.isCalibrated)
      ? adaptedBio.heartRateMax
      : (this.config.get('userHeartRateMax') ?? 78);

    const dynamicGate = this.autoTuner.getDynamicGate();
    const distMin = (autoTuningOn && dynamicGate.isCalibrated)
      ? dynamicGate.minGateCm
      : (this.config.get('userSeatingDistanceMin') ?? 50);

    const distMax = (autoTuningOn && dynamicGate.isCalibrated)
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

  /**
   * Sprawdza bramkę odległości, filtr zwierząt oraz tożsamość przed zatwierdzeniem obecności.
   */
  _handleRawPresence(rawPresent) {
    let effectivePresence = rawPresent;

    // 1. Filtr zwierząt domowych (Pet Filter - ignoruj kota/psa)
    if (effectivePresence && this.config.get('petFilterEnabled') !== false) {
      if (this.telemetry.detectedPerson === 'pet') {
        effectivePresence = false;
      }
    }

    // 2. Filtr bramki odległości (Spatial Distance Gate + Auto-Tuning Dynamic Gate)
    if (effectivePresence && this.config.get('radarDistanceGateEnabled')) {
      const autoTuningOn = this.config.get('radarAutoTuningEnabled') !== false;
      const dynamicGate = this.autoTuner.getDynamicGate();

      const minGate = (autoTuningOn && dynamicGate.isCalibrated)
        ? dynamicGate.minGateCm
        : Number(this.config.get('radarMinDistanceCm') ?? 40);

      const maxGate = (autoTuningOn && dynamicGate.isCalibrated)
        ? dynamicGate.maxGateCm
        : Number(this.config.get('radarMaxDistanceCm') ?? 110);

      const curDist = this.telemetry.distanceCm;

      if (curDist > 0 && (curDist < minGate || curDist > maxGate)) {
        // Obiekt poza strefą fotela (np. ktoś w tle pokoju lub zwierzę na podłodze)
        effectivePresence = false;
      }
    }

    // 3. Filtr tożsamości biometrycznej (Ty vs Narzeczona/Inni)
    if (effectivePresence && this.config.get('biometricsEnabled')) {
      const action = this.config.get('personMismatchAction') || 'ignore';
      if (this.telemetry.detectedPerson === 'other' && action === 'ignore') {
        effectivePresence = false;
      }
    }

    this.telemetry.presence = effectivePresence;
    this.setPresence(effectivePresence);
  }

  resetAutoTuning() {
    const status = this.autoTuner.reset();
    this.telemetry.autoTuning = status;
    this.emit('telemetry', this.telemetry);
    return status;
  }

  setPresence(present) {
    if (this.presence === present) return;
    this.presence = present;
    clearTimeout(this.deskTimer);
    clearTimeout(this.awayTimer);

    if (present) {
      this.deskTimer = setTimeout(() => this._setState('desk'), this.config.get('timeoutDeskMs'));
    } else {
      this.awayTimer = setTimeout(() => this._setState('away'), this.config.get('timeoutAwayMs'));
    }
    this.emit('status', {
      presence: present,
      state: this.state,
      pendingState: present ? 'desk' : 'away',
      telemetry: this.telemetry,
      since: Date.now()
    });
  }

  _setState(state) {
    if (this.state === state || !this._running) return;
    this.state = state;
    this.emit(state, Date.now());
    this.emit('status', { presence: this.presence, state, telemetry: this.telemetry, since: Date.now() });
  }
}