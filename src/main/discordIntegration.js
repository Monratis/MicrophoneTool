import net from 'node:net';
import { EventEmitter } from 'node:events';

const DISCORD_CLIENT_ID = '128000000000000000'; // Generic local RPC Client ID

const OPCODES = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
};

/**
 * Obsługa lokalnego IPC Discorda (Named Pipes \\.\pipe\discord-ipc-0..9).
 * Wymusza natychmiastowe odświeżenie silnika audio (Voice Engine) w Discordzie
 * po zmianie domyślnego mikrofonu Windows, eliminując lagi, opóźnienia i głuche pauzy.
 */
export default class DiscordIntegration extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.socket = null;
    this.connected = false;
    this._reconnectTimer = null;
    this._running = false;
  }

  start() {
    this._running = true;
    if (this.config.get('discordIntegration') !== false) {
      this._tryConnect();
    }
  }

  stop() {
    this._running = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (_) {}
      this.socket = null;
    }
    this.connected = false;
  }

  _tryConnect() {
    if (!this._running || this.connected) return;

    // Próbuj połączyć się z pipe discord-ipc-0 do 9
    const tryPipe = (index) => {
      if (index > 9 || !this._running) {
        this._scheduleReconnect();
        return;
      }

      const pipePath = `\\\\.\\pipe\\discord-ipc-${index}`;
      const sock = net.createConnection(pipePath);

      sock.once('connect', () => {
        this.socket = sock;
        this.connected = true;
        this._sendHandshake();
        this._setupSocket(sock);
      });

      sock.once('error', () => {
        sock.destroy();
        tryPipe(index + 1);
      });
    };

    tryPipe(0);
  }

  _setupSocket(sock) {
    sock.on('data', (buf) => {
      // Odbiór ramek z Discorda
      try {
        if (buf.length >= 8) {
          const op = buf.readInt32LE(0);
          const len = buf.readInt32LE(4);
          if (buf.length >= 8 + len) {
            const jsonStr = buf.slice(8, 8 + len).toString('utf8');
            const data = JSON.parse(jsonStr);
            this.emit('message', { op, data });
          }
        }
      } catch (_) {}
    });

    sock.on('close', () => {
      this.connected = false;
      this.socket = null;
      if (this._running) {
        this._scheduleReconnect();
      }
    });

    sock.on('error', () => {
      this.connected = false;
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
    });
  }

  _sendHandshake() {
    if (!this.socket || !this.connected) return;
    const payload = JSON.stringify({
      v: 1,
      client_id: DISCORD_CLIENT_ID
    });
    this._sendPacket(OPCODES.HANDSHAKE, payload);
  }

  _sendPacket(opcode, jsonPayload) {
    if (!this.socket || this.socket.destroyed) return;
    try {
      const payloadBuf = Buffer.from(jsonPayload, 'utf8');
      const header = Buffer.alloc(8);
      header.writeInt32LE(opcode, 0);
      header.writeInt32LE(payloadBuf.length, 4);
      this.socket.write(Buffer.concat([header, payloadBuf]));
    } catch (_) {}
  }

  _scheduleReconnect() {
    if (!this._running || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._tryConnect();
    }, 10000); // Ponawiaj co 10s w tle
  }

  /**
   * Wywoływane natychmiast po zmianie mikrofonu w systemie.
   * Wysyła do Discorda polecenie natychmiastowego przeładowania ustawień głosu.
   */
  async notifyDeviceChanged(deviceName) {
    if (!this.config.get('discordIntegration')) return;

    if (this.connected && this.socket) {
      try {
        const nonce = String(Date.now());
        const payload = JSON.stringify({
          cmd: 'SET_VOICE_SETTINGS',
          args: {
            input: {
              device_id: 'default'
            }
          },
          nonce
        });
        this._sendPacket(OPCODES.FRAME, payload);
        console.log(`[discord] Wysłano polecenie synchronizacji audio (${deviceName || 'default'})`);
      } catch (err) {
        console.warn('[discord] Błąd wysyłania komendy:', err.message);
      }
    }
  }
}
