import net from 'node:net';
import { EventEmitter } from 'node:events';
import type Config from './config';

const DISCORD_CLIENT_ID = '128000000000000000';

const OPCODES = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
} as const;

export default class DiscordIntegration extends EventEmitter {
  private readonly config: Config;
  private socket: net.Socket | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  start(): void {
    this.running = true;
    if (this.config.get('discordIntegration') !== false) {
      this.tryConnect();
    }
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.connected = false;
  }

  private tryConnect(): void {
    if (!this.running || this.connected) return;

    const tryPipe = (index: number): void => {
      if (index > 9 || !this.running) {
        this.scheduleReconnect();
        return;
      }

      const pipePath = `\\\\.\\pipe\\discord-ipc-${index}`;
      const sock = net.createConnection(pipePath);

      sock.once('connect', () => {
        this.socket = sock;
        this.connected = true;
        this.sendHandshake();
        this.setupSocket(sock);
      });

      sock.once('error', () => {
        sock.destroy();
        tryPipe(index + 1);
      });
    };

    tryPipe(0);
  }

  private setupSocket(sock: net.Socket): void {
    sock.on('data', (buf: Buffer) => {
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
      } catch {
        /* ignore */
      }
    });

    sock.on('close', () => {
      this.connected = false;
      this.socket = null;
      if (this.running) {
        this.scheduleReconnect();
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

  private sendHandshake(): void {
    if (!this.socket || !this.connected) return;
    const payload = JSON.stringify({
      v: 1,
      client_id: DISCORD_CLIENT_ID
    });
    this.sendPacket(OPCODES.HANDSHAKE, payload);
  }

  private sendPacket(opcode: number, jsonPayload: string): void {
    if (!this.socket || this.socket.destroyed) return;
    try {
      const payloadBuf = Buffer.from(jsonPayload, 'utf8');
      const header = Buffer.alloc(8);
      header.writeInt32LE(opcode, 0);
      header.writeInt32LE(payloadBuf.length, 4);
      this.socket.write(Buffer.concat([header, payloadBuf]));
    } catch {
      /* ignore */
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryConnect();
    }, 10000);
  }

  async notifyDeviceChanged(deviceName: string | null): Promise<void> {
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
        this.sendPacket(OPCODES.FRAME, payload);
        console.log(`[discord] Wysłano polecenie synchronizacji audio (${deviceName || 'default'})`);
      } catch (err) {
        console.warn('[discord] Błąd wysyłania komendy:', (err as Error).message);
      }
    }
  }
}
