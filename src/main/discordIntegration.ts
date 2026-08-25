import net from 'node:net';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import type Config from './config';

// Fallback gdy config nie zawiera discordClientId — realny Application ID
const DISCORD_CLIENT_ID = '1238447097859145859';

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
  private ready = false;
  private authenticated = false;
  private authFlowRunning = false;
  private authFailures = 0;
  private lastAuthAttemptAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private running = false;
  private handshakeFailures = 0;
  /** Akumulator ramek — TCP dowolnie dzieli pakiety, trzeba składać. */
  private frameBuf = Buffer.alloc(0);
  /** nonce -> resolver odpowiedzi komendy (z timeoutem w wywołaniu). */
  private readonly pending = new Map<string, (v: { ok: boolean; data?: unknown }) => void>();

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
    this.ready = false;
    this.authenticated = false;
    this.frameBuf = Buffer.alloc(0);
    this.failAllPending();
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
        // Świeża sesja — bajty z poprzedniej zerwanej sesji nie mogą
        // zafałszować pierwszych ramek.
        this.frameBuf = Buffer.alloc(0);
        // Najpierw czytnik danych, potem handshake — inaczej odpowiedź
        // "Ready" od Discorda przepada zanim ktokolwiek ją odczyta.
        this.setupSocket(sock);
        this.sendHandshake();
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
      // Akumulacja: jedna porcja z TCP może zawierać ułamek ramki albo
      // kilka ramek naraz — przetwarzamy wyłącznie kompletne pakiety.
      this.frameBuf = Buffer.concat([this.frameBuf, buf]);
      while (this.frameBuf.length >= 8) {
        const len = this.frameBuf.readInt32LE(4);
        if (len < 0 || len > 10 * 1024 * 1024) {
          console.warn('[discord] Nieprawidłowa długość ramki — resync bufora');
          this.frameBuf = Buffer.alloc(0);
          return;
        }
        if (this.frameBuf.length < 8 + len) break;
        const op = this.frameBuf.readInt32LE(0);
        const payload = this.frameBuf.slice(8, 8 + len);
        this.frameBuf = this.frameBuf.slice(8 + len);
        try {
          this.handleFrame(op, JSON.parse(payload.toString('utf8')));
        } catch {
          /* nie-JSON payload — ignoruj */
        }
      }
    });

    sock.on('close', () => {
      const wasReady = this.ready;
      this.connected = false;
      this.ready = false;
      this.authenticated = false;

      this.socket = null;
      this.failAllPending();
      if (this.running) {
        // Zamknięcie bez READY = odrzucony handshake (np. zły client_id).
        // Po 3 porażkach schodzimy na 5 minut — nie meczymy Discorda co 10 s.
        if (!wasReady) {
          this.handshakeFailures++;
          if (this.handshakeFailures === 3) {
            console.error(
              '[discord] Powtarzające się odrzucenia handshake — sprawdź discordClientId ' +
                '(Application ID z Discord Developer Portal). Kolejne próby co 5 min.'
            );
          }
        } else {
          this.handshakeFailures = 0;
        }
        const delay =
          !wasReady && this.handshakeFailures >= 3 ? 5 * 60 * 1000 : 10000;
        this.scheduleReconnect(delay);
      }
    });

    sock.on('error', () => {
      this.connected = false;
      this.ready = false;
      this.authenticated = false;
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
    });
  }

  private handleFrame(op: number, payload: any): void {
    // Opcode 2 = CLOSE — Discord zamyka sesję (np. błędny client_id)
    if (op === 2) {
      console.warn(`[discord] Serwer zamknął sesję: ${JSON.stringify(payload?.data ?? payload)}`);
      if (payload?.data?.code === 4004 || /client.?id/i.test(JSON.stringify(payload))) {
        console.error(
          '[discord] Prawdopodobnie nieprawidłowy discordClientId w configu — RPC wymaga ' +
            'Application ID z Discord Developer Portal. Ustaw własny ID, aby presety działały.'
        );
      }
      this.socket?.destroy();
      return;
    }
    if (op !== 1 || !payload || typeof payload !== 'object') return;

    // READY = handshake zaakceptowany
    if (payload.evt === 'READY') {
      this.handshakeFailures = 0;
      this.ready = true;
      console.log('[discord] Sesja RPC gotowa (READY)');
      if (!this.authenticated) {
        void this.authorizeFlow();
      }
      return;
    }


    // Odpowiedź komendy po nonce
    const nonce = typeof payload.nonce === 'string' ? payload.nonce : undefined;
    if (nonce && this.pending.has(nonce)) {
      const resolve = this.pending.get(nonce)!;
      this.pending.delete(nonce);
      if (payload.cmd === 'AUTHORIZE' || payload.cmd === 'AUTHENTICATE') {
        // Pełna ramka diagnostycznie — puste data przy przyjętej zgodzie
        // wskazuje np. brak Redirect URI w konfiguracji apki.
        console.log(`[discord] ${payload.cmd} raw: ${JSON.stringify(payload).slice(0, 600)}`);
      }
      const isError =
        payload.evt === 'error' ||
        (typeof payload.status === 'number' && payload.status >= 400);
      if (isError) {
        console.warn(`[discord] ${String(payload.cmd)} odrzucone: ${JSON.stringify(payload.data ?? payload.message ?? '')}`);
      }
      resolve({ ok: !isError, data: payload.data });
    }
  }

  private failAllPending(): void {
    for (const [nonce, resolve] of this.pending) {
      resolve({ ok: false });
      this.pending.delete(nonce);
    }
  }

  /**
   * Pełny OAuth flow dla komend głosowych (4006 bez tego):
   * AUTHORIZE (popup zgody w kliencie) → code → wymiana na token
   * (wymaga discordClientSecret z config.json) → AUTHENTICATE.
   */
  private async authorizeFlow(): Promise<void> {
    if (this.authFlowRunning || this.authenticated || !this.ready) return;
    // Odmowa autoryzacji nie może pchać popupa co 10 s: po 2 odmowach
    // kolejne próby najwcześniej po 5 minutach.
    if (this.authFailures >= 2 && Date.now() - this.lastAuthAttemptAt < 5 * 60 * 1000) return;
    this.authFlowRunning = true;
    this.lastAuthAttemptAt = Date.now();
    try {
      const secret = (this.config.get('discordClientSecret') || '').trim();
      if (!secret) {
        console.error(
          '[discord] Brak discordClientSecret w config.json — presety głosowe wymagają autoryzacji OAuth (scope rpc.voice.write).'
        );
        return;
      }
      const authResp = await this.rpcCommand('AUTHORIZE', {
        client_id: this.config.get('discordClientId'),
        scopes: ['rpc', 'rpc.voice.read', 'rpc.voice.write']
      });
      const code = (authResp.data as { code?: string } | undefined)?.code;
      if (!authResp.ok || !code) {
        this.authFailures++;
        console.warn('[discord] AUTHORIZE odrzucone:', JSON.stringify(authResp.data ?? null).slice(0, 300));
        return;
      }
      this.authFailures = 0;
      const token = await this.exchangeToken(code);
      if (!token) return;
      const auth = await this.rpcCommand('AUTHENTICATE', { access_token: token });
      if (auth.ok) {
        this.authenticated = true;
        const username = (auth.data as { user?: { username?: string } } | undefined)?.user?.username;
        console.log(`[discord] Zalogowano${username ? ` jako ${username}` : ''} — presety głosowe aktywne`);
      } else {
        console.warn('[discord] AUTHENTICATE odrzucone:', JSON.stringify(auth.data ?? null).slice(0, 300));
      }
    } finally {
      this.authFlowRunning = false;
    }
  }

  /** Wymiana kodu autoryzacji na access token (POST /api/oauth2/token). */
  private exchangeToken(code: string): Promise<string | null> {
    return new Promise((resolve) => {
      const body = new URLSearchParams({
        client_id: this.config.get('discordClientId'),
        client_secret: (this.config.get('discordClientSecret') || '').trim(),
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.get('discordRedirectUri') || 'http://localhost'
      }).toString();
      const req = https.request(
        {
          hostname: 'discord.com',
          path: '/api/oauth2/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
          }
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(data) as { access_token?: string; error?: string };
              if (json.access_token) resolve(json.access_token);
              else {
                console.warn('[discord] Token exchange błąd:', JSON.stringify(json).slice(0, 300));
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('error', (e) => {
        console.warn('[discord] Token exchange error:', e.message);
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  }

  private sendHandshake(): void {
    if (!this.socket || !this.connected) return;
    const payload = JSON.stringify({
      v: 1,
      client_id: this.config.get('discordClientId') || DISCORD_CLIENT_ID
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

  private scheduleReconnect(delay = 10000): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.tryConnect();
    }, delay);
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

  /** Wspólny wysyłacz komendy RPC z weryfikacją odpowiedzi po nonce. */
  private rpcCommand(cmd: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown }> {
    if (!this.connected || !this.ready || !this.socket || this.socket.destroyed) {
      return Promise.resolve({ ok: false });
    }
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify({ cmd, args, nonce });
    return new Promise<{ ok: boolean; data?: unknown }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        resolve({ ok: false });
      }, 3000);
      this.pending.set(nonce, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      this.sendPacket(OPCODES.FRAME, payload);
    });
  }

  /**
   * Ustawia profil głosowy aktywnego mikrofonu w Discordzie:
   * bramkę VAD (threshold dB), Krisp, AGC i usuwanie echa.
   * Wymaga zaakceptowanego handshake (READY). Odpowiedź Discorda weryfikowana
   * po nonce — porażki NIE przechodzą już po cichu.
   */
  async applyMicSettings(opts: { gateDb?: number; krisp?: boolean; agc?: boolean; echo?: boolean }): Promise<boolean> {
    if (!this.config.get('discordIntegration')) return false;
    if (!this.connected || !this.ready || !this.authenticated) return false;
    try {
      const args: Record<string, unknown> = {};
      if (typeof opts.gateDb === 'number') {
        const clamped = Math.max(-90, Math.min(0, Math.round(opts.gateDb)));
        args.mode = {
          type: 'VOICE_ACTIVITY',
          auto_threshold: false,
          threshold: clamped
        };
      }
      if (typeof opts.krisp === 'boolean') args.noise_suppression = opts.krisp;
      if (typeof opts.agc === 'boolean') args.automatic_gain_control = opts.agc;
      if (typeof opts.echo === 'boolean') args.echo_cancellation = opts.echo;
      if (Object.keys(args).length === 0) return false;

      const reply = await this.rpcCommand('SET_VOICE_SETTINGS', args);
      console.log(
        `[discord] SET_VOICE_SETTINGS ${JSON.stringify(opts)} -> ok=${reply.ok} data=${JSON.stringify(reply.data ?? null).slice(0, 300)}`
      );
      return reply.ok;
    } catch (err) {
      console.warn('[discord] Błąd ustawiania profilu głosowego:', (err as Error).message);
      return false;
    }
  }

  async setVoiceGate(thresholdDb: number): Promise<boolean> {
    return this.applyMicSettings({ gateDb: thresholdDb });
  }
}
