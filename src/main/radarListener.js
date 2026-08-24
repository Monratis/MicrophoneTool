import { EventEmitter } from 'node:events';

const SEEED_VID_PIDS = [
  { vid: 0x2886, pid: 0x802d }, // Seeed Studio XIAO ESP32-C6
  { vid: 0x303a, pid: 0x1001 }  // Espressif ESP32-C6 USB
];

/**
 * Nasłuch portu szeregowego radaru mmWave (Seeed MR60BHA2 na XIAO ESP32-C6).
 *
 * Parsuje dwa formaty danych:
 *  1. JSON per linia z firmware ESP32: {"presence":1,"distance":1.1}
 *  2. Surowe ramki binarne MR60BHA2 (nagłówek 0x53 0x59)
 *
 * Emituje zdarzenia:
 *  - 'desk'   po wykryciu obecności (debounce wejściowy, timeoutDeskMs)
 *  - 'away'   po zaniku obecności   (histereza wyjścia, timeoutAwayMs)
 *  - 'raw'    każda odebrana ramka/linia
 *  - 'status' zmiana stanu wewnętrznego: { presence, state, since }
 *  - 'error'  błąd portu
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
    this._mockInterval = null;
    this._mockState = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._lastPortName = null;
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

  /**
   * Rozpoczyna nasłuch. W trybie mock symuluje cykl obecności.
   * Brak urządzenia / błąd portu -> automatyczne ponawianie prób połączenia.
   */
  async start() {
    this._running = true;
    this._reconnectAttempts = 0;
    if (this.config.get('mockMode')) {
      return this._startMock();
    }
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
        baudRate: this.config.get('baudRate')
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

  /**
   * Automatyczne ponowienie połączenia z narastającym odstępem (5s -> 30s).
   */
  _scheduleReconnect() {
    if (!this._running || this.config.get('mockMode') || this._reconnectTimer) return;
    const delay = Math.min(30000, 5000 * Math.pow(1.5, this._reconnectAttempts++));
    console.warn(`[radar] port niedostępny, ponawiam za ${Math.round(delay / 1000)}s`);
    this.emit('status', { connected: false, nextReconnectMs: delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openPort();
    }, delay);
  }

  /**
   * Zatrzymuje nasłuch i czyści timery.
   */
  async stop() {
    this._running = false;
    clearTimeout(this.deskTimer);
    clearTimeout(this.awayTimer);
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._mockInterval) {
      clearInterval(this._mockInterval);
      this._mockInterval = null;
    }
    if (this.port && this.port.isOpen) {
      const p = this.port;
      this.port = null;
      await new Promise((resolve) => p.close(resolve));
    }
  }

  /**
   * Wybiera port: konfiguracyjny, albo autodetekcja po VID/PID Seeed/Espressif.
   */
  async _resolvePort() {
    const configured = this.config.get('port');
    if (configured && configured !== 'auto') {
      return configured;
    }
    try {
      const ports = await RadarListener.listPorts();
      const match = ports.find((p) =>
        SEEED_VID_PIDS.some((id) => Number(p.vendorId) === id.vid && Number(p.productId) === id.pid)
      );
      if (match) return match.path;
      if (ports.length > 0) {
        console.warn('[radar] brak znanego VID/PID, używam pierwszego portu:', ports[0].path);
        return ports[0].path;
      }
    } catch (err) {
      console.error('[radar] enumerate ports error:', err.message);
    }
    return null;
  }

  _onData(chunk) {
    const text = chunk.toString('utf8');
    this.emit('raw', text);

    // Tryb JSON (firmware ESP32)
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('{')) {
        try {
          const json = JSON.parse(trimmed);
          if (typeof json.presence === 'number' || typeof json.presence === 'boolean') {
            this.setPresence(Boolean(Number(json.presence)));
            continue;
          }
        } catch (_) {
          /* nie-JSON */
        }
      }
      this._parseBinaryFrame(Buffer.from(trimmed, 'hex'));
    }
  }

  /**
   * Parser ramki binarnej MR60BHA2: 53 59 len data... crc
   * Funkcja 0x01 (informacje o obecności) -> bajt obecności na pozycji 1 payloadu.
   */
  _parseBinaryFrame(buf) {
    if (buf.length < 4) return;
    if (buf[0] !== 0x53 || buf[1] !== 0x59) return;
    const len = buf[2];
    const dataEnd = 3 + len;
    if (buf.length < dataEnd) return;
    const data = buf.subarray(3, dataEnd - 1); // ostatni bajt to checksum
    if (data.length < 2) return;
    const func = data[0];
    if (func === 0x01 && data.length >= 2) {
      this.setPresence(data[1] === 0x01);
    }
  }

  /**
   * Wstrzykuje stan obecności; realizuje debounce wejścia (0.3s)
   * i histerezę wyjścia (3s).
   */
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

  // ------- Mock (brak urządzeń) -------

  _startMock() {
    console.log('[radar] MOCK MODE: symulacja obecności co 30s (15s przy biurku / 15s poza)');
    this._mockState = true;
    this.setPresence(true);
    this._mockInterval = setInterval(() => {
      this._mockState = !this._mockState;
      this.setPresence(this._mockState);
    }, 15000);
    return Promise.resolve();
  }

  /**
   * Ręczne wstrzyknięcie ramki (do testów bez urządzenia).
   */
  injectRaw(data) {
    this._onData(Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  /**
   * Ręczne wymuszenie stanu obecności (do testów / debugu).
   */
  injectPresence(present) {
    this.setPresence(present);
  }
}