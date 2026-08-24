import { EventEmitter } from 'node:events';

const KNOWN_VID_PIDS = [
  { vid: 0x2886, pid: 0x802d }, // Seeed Studio XIAO ESP32-C6
  { vid: 0x303a, pid: 0x1001 }, // Espressif ESP32-C6 Native USB JTAG/Serial
  { vid: 0x303a, pid: 0x1002 }, // Espressif ESP32-C6 CDC
  { vid: 0x1a86, pid: 0x7523 }, // CH340
  { vid: 0x1a86, pid: 0x55d4 }, // CH9102 / CH343
  { vid: 0x10c4, pid: 0xea60 }  // CP210x
];

/**
 * Nasłuch portu szeregowego radaru mmWave 60GHz (Seeed MR60BHA2 + XIAO ESP32-C6).
 * Obsługuje ramki binarne Seeed TinyFrame (0x53 0x59), pakiety JSON oraz strumienie tekstowe.
 */
export default class RadarListener extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
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
      // 1. Dopasowanie po VID/PID
      const match = ports.find((p) =>
        KNOWN_VID_PIDS.some((id) =>
          (p.vendorId && parseInt(p.vendorId, 16) === id.vid) &&
          (!id.pid || (p.productId && parseInt(p.productId, 16) === id.pid))
        )
      );
      if (match) return match.path;

      // 2. Dopasowanie po nazwie producenta
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
          if (typeof json.presence !== 'undefined') {
            this.setPresence(Boolean(Number(json.presence)));
            continue;
          }
          if (typeof json.occupied !== 'undefined') {
            this.setPresence(Boolean(Number(json.occupied)));
            continue;
          }
          if (typeof json.target !== 'undefined') {
            this.setPresence(Boolean(Number(json.target)));
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

      // Plain text formats
      if (/^(presence|someone|occupied|target:\s*1|desk)/i.test(line)) {
        if (/0|false|nobody|away|empty/i.test(line)) {
          this.setPresence(false);
        } else {
          this.setPresence(true);
        }
      } else if (/^(nobody|away|unoccupied|target:\s*0|empty)/i.test(line)) {
        this.setPresence(false);
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
        // brak nagłówka, zostaw ostatni bajt w razie ucięcia
        this._rawBuffer = this._rawBuffer.slice(-1);
        break;
      }
      if (start > 0) {
        this._rawBuffer = this._rawBuffer.slice(start);
      }
      if (this._rawBuffer.length < 4) break;

      // Seeed TinyFrame format: 0x53 0x59 [Control/Cmd] [Len] ...
      const len = this._rawBuffer[3] || this._rawBuffer[2];
      const frameLen = Math.max(4, Math.min(len + 4, 32));

      if (this._rawBuffer.length < frameLen) {
        // Czekaj na pełną ramkę
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

    // Obsługa różnych wariantów ramek MR60BHA2:
    for (let i = 2; i < buf.length - 1; i++) {
      // 1. Standardowy kod obecności 0x80 (Human presence) -> 0x01 (Presence status)
      if (buf[i] === 0x80 && buf[i + 1] === 0x01 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this.setPresence(val === 0x01);
        return;
      }
      // 2. Kod obecności 0x01 0x01 (Presence status)
      if (buf[i] === 0x01 && buf[i + 1] === 0x01 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this.setPresence(val === 0x01);
        return;
      }
      // 3. Kod celu 0x0F 0x09 (Target detected)
      if (buf[i] === 0x0F && buf[i + 1] === 0x09 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this.setPresence(val === 0x01);
        return;
      }
      // 4. Ruch ciała 0x80 0x02 (Movement: 1=moving, 2=stationary, 0=none)
      if (buf[i] === 0x80 && buf[i + 1] === 0x02 && i + 2 < buf.length) {
        const val = buf[i + 2];
        this.setPresence(val === 0x01 || val === 0x02);
        return;
      }
    }
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
      since: Date.now()
    });
  }

  _setState(state) {
    if (this.state === state || !this._running) return;
    this.state = state;
    this.emit(state, Date.now());
    this.emit('status', { presence: this.presence, state, since: Date.now() });
  }
}