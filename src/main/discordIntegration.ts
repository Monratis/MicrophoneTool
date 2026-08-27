import net from 'node:net';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import type Config from './config';
import { appendLog } from './logger';

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
  private username = '';
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

    // READY = handshake zaakceptowany.
    // Jeśli mamy zapisany token w configu, uwierzytelniamy automatycznie w tle.
    if (payload.evt === 'READY') {
      this.handshakeFailures = 0;
      this.ready = true;
      console.log('[discord] Sesja RPC gotowa (READY)');
      void this.tryAutoAuthenticate();
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
        payload.evt === 'ERROR' ||
        (typeof payload.data?.code === 'number' && payload.data.code >= 4000) ||
        (typeof payload.status === 'number' && payload.status >= 400);
      if (isError) {
        const errMsg = payload.data?.message || payload.message || JSON.stringify(payload.data ?? '');
        console.warn(`[discord] ${String(payload.cmd)} odrzucone: ${errMsg}`);
        appendLog('DISCORD', `Błąd komendy ${String(payload.cmd)}: ${errMsg}`);
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

  /** Zapisuje tokeny OAuth2 do pliku konfiguracyjnego */
  private saveTokens(accessToken: string, refreshToken?: string): void {
    this.config.set('discordAccessToken', accessToken);
    if (refreshToken) {
      this.config.set('discordRefreshToken', refreshToken);
    }
    this.config.save();
  }

  /** Czyści zapisane tokeny w konfiguracji */
  private clearTokens(): void {
    this.config.set('discordAccessToken', '');
    this.config.set('discordRefreshToken', '');
    this.config.save();
  }

  /**
   * Cicha próba automatycznego uwierzytelnienia sesji RPC zapisanym tokenem.
   * Jeśli token wygasł, próbuje odświeżyć go za pomocą refresh_token.
   */
  private async tryAutoAuthenticate(): Promise<void> {
    if (!this.ready || this.authenticated || this.authFlowRunning || !this.socket || this.socket.destroyed) {
      return;
    }

    const accessToken = (this.config.get('discordAccessToken') || '').trim();
    const refreshTokenStr = (this.config.get('discordRefreshToken') || '').trim();

    if (!accessToken && !refreshTokenStr) {
      return;
    }

    this.authFlowRunning = true;
    try {
      if (accessToken) {
        const auth = await this.rpcCommand('AUTHENTICATE', { access_token: accessToken });
        if (auth.ok) {
          this.authenticated = true;
          const username = (auth.data as { user?: { username?: string } } | undefined)?.user?.username;
          this.username = username || '';
          appendLog('DISCORD', `Automatycznie uwierzytelniono sesję OAuth${username ? ` jako @${username}` : ''} ✓`);
          this.emit('authenticated');
          return;
        }
        appendLog('DISCORD', 'Zapisany token dostępu wygasł — próba automatycznego odświeżenia (refresh_token)...');
      }

      if (refreshTokenStr) {
        const refreshed = await this.refreshToken(refreshTokenStr);
        if (refreshed?.access_token) {
          this.saveTokens(refreshed.access_token, refreshed.refresh_token);
          const auth = await this.rpcCommand('AUTHENTICATE', { access_token: refreshed.access_token });
          if (auth.ok) {
            this.authenticated = true;
            const username = (auth.data as { user?: { username?: string } } | undefined)?.user?.username;
            this.username = username || '';
            appendLog('DISCORD', `Pomyślnie odświeżono token OAuth i uwierzytelniono sesję${username ? ` (@${username})` : ''} ✓`);
            this.emit('authenticated');
            return;
          }
        }
        this.clearTokens();
        appendLog('DISCORD', 'Tokeny wygasły — wymagana ponowna jednorazowa autoryzacja (kliknij "Autoryzuj Discord").');
      }
    } catch (e) {
      console.warn('[discord] Błąd auto-uwierzytelniania:', (e as Error).message);
    } finally {
      this.authFlowRunning = false;
    }
  }

  /** Ręczne uruchomienie autoryzacji (tray/UI) — resetuje backoff i odpala flow. */
  authorizeManually(): void {
    this.authFailures = 0;
    this.lastAuthAttemptAt = 0;
    void this.authorizeFlow();
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
      // Zestaw uprawnień wymaganych do sterowania wejściem i profilami głosu w Discordzie.
      // Uwaga: scope 'rpc' NIE istnieje w liście scopes na Developer Portalu — to scope
      // lokalny IPC; dodanie go w kodzie jest poprawne i wymagane.
      const scopeSets: string[][] = [
        ['identify', 'rpc', 'rpc.voice.read', 'rpc.voice.write'],
        ['identify', 'rpc', 'rpc.voice.read', 'rpc.voice.write', 'rpc.notifications.read', 'rpc.activities.write']
      ];
      let authResp: { ok: boolean; data?: unknown } = { ok: false, data: undefined };
      for (const scopes of scopeSets) {
        // AUTHORIZE otwiera MODAL zgody w kliencie Discord — użytkownik klika ręką,
        // więc timeout musi być długi (rpcCommand domyślnie ma 3 s — ZA KRÓTKO).
        authResp = await this.rpcCommand(
          'AUTHORIZE',
          { client_id: this.config.get('discordClientId'), scopes },
          120000
        );
        const c = (authResp.data as { code?: string } | undefined)?.code;
        if (authResp.ok && c) break;
        // 4002 "Already authing" = w kliencie trwa już inny flow autoryzacji
        // (zawieszony popup albo inny program RPC jak Deckboard). Czekamy i ponawiamy
        // tę samą próbę — nowy popup pojawi się po zwolnieniu slotu.
        const errCode = (authResp.data as { code?: number } | undefined)?.code;
        if (errCode === 4002) {
          console.warn(
            '[discord] 4002 Already authing — w Discordzie trwa inna autoryzacja. ' +
              'Zamknij zawieszony popup zgody lub wyłącz inny program RPC (np. Deckboard), ' +
              'potem kliknij ponownie „Autoryzuj Discord".'
          );
          break;
        }
        console.warn(
          `[discord] AUTHORIZE odrzucone (scopes: ${scopes.join(',')}):`,
          JSON.stringify(authResp.data ?? null).slice(0, 300)
        );
      }
      const code = (authResp.data as { code?: string } | undefined)?.code;
      if (!authResp.ok || !code) {
        this.authFailures++;
        console.error(
          '[discord] AUTHORIZE bezskuteczny. Sprawdź, czy w Developer Portal → OAuth2 → Redirects ' +
            'jest zarejestrowany adres z discordRedirectUri oraz czy popup zgody w kliencie Discord ' +
            'został zatwierdzony. Szczegóły w logach AUTHORIZE raw powyżej.'
        );
        return;
      }
      this.authFailures = 0;
      const tokenData = await this.exchangeToken(code);
      if (!tokenData?.access_token) return;

      this.saveTokens(tokenData.access_token, tokenData.refresh_token);

      const auth = await this.rpcCommand('AUTHENTICATE', { access_token: tokenData.access_token });
      if (auth.ok) {
        this.authenticated = true;
        const username = (auth.data as { user?: { username?: string } } | undefined)?.user?.username;
        this.username = username || '';
        appendLog('DISCORD', `Pomyślnie uwierzytelniono OAuth${username ? ` jako @${username}` : ''} — presety głosu i sterowanie wejściem aktywne ✓`);
        this.emit('authenticated');
      } else {
        appendLog('DISCORD', `Błąd AUTHENTICATE: ${JSON.stringify(auth.data ?? null)}`);
        console.warn('[discord] AUTHENTICATE odrzucone:', JSON.stringify(auth.data ?? null).slice(0, 300));
      }
    } catch (e) {
      appendLog('DISCORD', `Błąd flow autoryzacji: ${(e as Error).message}`);
      console.warn('[discord] Błąd flow autoryzacji:', (e as Error).message);
    } finally {
      this.authFlowRunning = false;
    }
  }

  /** Wymiana kodu autoryzacji na access token i refresh token (POST /api/oauth2/token). */
  private exchangeToken(code: string): Promise<{ access_token: string; refresh_token?: string } | null> {
    return new Promise((resolve) => {
      const body = new URLSearchParams({
        client_id: this.config.get('discordClientId'),
        client_secret: (this.config.get('discordClientSecret') || '').trim(),
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.get('discordRedirectUri') || 'https://discord.com'
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
              const json = JSON.parse(data) as { access_token?: string; refresh_token?: string; error?: string };
              if (json.access_token) {
                resolve({ access_token: json.access_token, refresh_token: json.refresh_token });
              } else {
                appendLog('DISCORD', `Token exchange odrzucony przez Discord: ${JSON.stringify(json)}`);
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
        appendLog('DISCORD', `Błąd połączenia z serwerem OAuth Discord: ${e.message}`);
        console.warn('[discord] Token exchange error:', e.message);
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  }

  /** Odświeżanie tokenu za pomocą refresh_token (POST /api/oauth2/token). */
  private refreshToken(refreshToken: string): Promise<{ access_token: string; refresh_token?: string } | null> {
    return new Promise((resolve) => {
      const body = new URLSearchParams({
        client_id: this.config.get('discordClientId'),
        client_secret: (this.config.get('discordClientSecret') || '').trim(),
        grant_type: 'refresh_token',
        refresh_token: refreshToken
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
              const json = JSON.parse(data) as { access_token?: string; refresh_token?: string; error?: string };
              if (json.access_token) {
                resolve({ access_token: json.access_token, refresh_token: json.refresh_token });
              } else {
                appendLog('DISCORD', `Odświeżenie tokenu odrzucone przez Discord: ${JSON.stringify(json)}`);
                console.warn('[discord] Refresh token błąd:', JSON.stringify(json).slice(0, 300));
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('error', (e) => {
        appendLog('DISCORD', `Błąd połączenia podczas odświeżania tokenu: ${e.message}`);
        console.warn('[discord] Refresh token error:', e.message);
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  }

  getStatus(): { connected: boolean; ready: boolean; authenticated: boolean; user?: string } {
    return {
      connected: this.connected,
      ready: this.ready,
      authenticated: this.authenticated,
      user: this.username || undefined
    };
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
        appendLog('DISCORD', `Wysłano żądanie przełączenia wejścia audio Discord -> "${deviceName || 'Domyślny systemowy'}"`);
      } catch (err) {
        console.warn('[discord] Błąd wysyłania komendy:', (err as Error).message);
      }
    }
  }

  /** Wspólny wysyłacz komendy RPC z weryfikacją odpowiedzi po nonce. */
  private rpcCommand(cmd: string, args: Record<string, unknown>, timeoutMs = 3000): Promise<{ ok: boolean; data?: unknown }> {
    if (!this.connected || !this.ready || !this.socket || this.socket.destroyed) {
      return Promise.resolve({ ok: false });
    }
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify({ cmd, args, nonce });
    return new Promise<{ ok: boolean; data?: unknown }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        resolve({ ok: false });
      }, timeoutMs);
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
    if (!this.connected || !this.ready || !this.authenticated) {
      appendLog('DISCORD', `Pominięto profil głosu (bramka ${opts.gateDb ?? '--'} dB) — brak autoryzacji OAuth Discorda`);
      return false;
    }
    try {
      const args: Record<string, unknown> = {};
      if (typeof opts.gateDb === 'number') {
        const clamped = Math.max(-100, Math.min(0, Math.round(opts.gateDb)));
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
      appendLog(
        'DISCORD',
        `Aplikowano profil głosu w Discordzie: VAD=${opts.gateDb ?? '--'} dB, Krisp=${opts.krisp ?? '--'}, AGC=${opts.agc ?? '--'}, Echo=${opts.echo ?? '--'} -> ${reply.ok ? 'SUKCES ✓' : 'BŁĄD ✗'}`
      );
      console.log(
        `[discord] SET_VOICE_SETTINGS ${JSON.stringify(opts)} -> ok=${reply.ok} data=${JSON.stringify(reply.data ?? null).slice(0, 300)}`
      );
      return reply.ok;
    } catch (err) {
      appendLog('DISCORD', `Błąd ustawiania profilu głosu: ${(err as Error).message}`);
      console.warn('[discord] Błąd ustawiania profilu głosowego:', (err as Error).message);
      return false;
    }
  }

  async setVoiceGate(thresholdDb: number): Promise<boolean> {
    return this.applyMicSettings({ gateDb: thresholdDb });
  }

  /**
   * Głośność wejścia przez Discorda (pipeline WebRTC). Działa nawet dla urządzeń
   * BT, które nie wystawiają IAudioEndpointVolume w OS (E_NOINTERFACE).
   * Zakres Discorda: 0-200 (100 = 100%). Fallback dla daemona audio.
   */
  async applyInputVolume(percent: number): Promise<boolean> {
    if (!this.config.get('discordIntegration') || !this.authenticated) return false;
    const vol = Math.max(0, Math.min(200, Math.round(percent)));
    const reply = await this.rpcCommand('SET_VOICE_SETTINGS', {
      input: { volume: vol }
    });
    console.log(
      `[discord] SET_VOICE_SETTINGS input.volume=${vol} -> ok=${reply.ok}`
    );
    return reply.ok;
  }

  /** Mute wejścia przez Discorda — fallback dla urządzeń BT bez IAudioEndpointVolume. */
  async setInputMute(muted: boolean): Promise<boolean> {
    if (!this.config.get('discordIntegration') || !this.authenticated) return false;
    const reply = await this.rpcCommand('SET_VOICE_SETTINGS', { mute: muted });
    console.log(`[discord] SET_VOICE_SETTINGS mute=${muted} -> ok=${reply.ok}`);
    return reply.ok;
  }

  /** Aktualny stan mute wejścia z Discorda (do toggle przy urządzeniach BT). */
  async getInputMute(): Promise<boolean | null> {
    if (!this.config.get('discordIntegration') || !this.authenticated) return null;
    const reply = await this.rpcCommand('GET_VOICE_SETTINGS', {});
    if (!reply.ok) return null;
    const d = reply.data as { mute?: boolean };
    return typeof d.mute === 'boolean' ? d.mute : null;
  }

  /**
   * Pobiera aktualne ustawienia głosu bezpośrednio z Discorda (próg bramki dB, Krisp, AGC, Echo).
   */
  async getVoiceSettings(): Promise<{
    thresholdDb?: number;
    autoThreshold?: boolean;
    krisp?: boolean;
    agc?: boolean;
    echo?: boolean;
  } | null> {
    if (!this.config.get('discordIntegration') || !this.authenticated) return null;
    const reply = await this.rpcCommand('GET_VOICE_SETTINGS', {});
    if (!reply.ok || !reply.data || typeof reply.data !== 'object') return null;
    const d = reply.data as {
      mode?: { type?: string; auto_threshold?: boolean; threshold?: number };
      automatic_gain_control?: boolean;
      noise_suppression?: boolean;
      echo_cancellation?: boolean;
    };
    return {
      thresholdDb: typeof d.mode?.threshold === 'number' ? Math.round(d.mode.threshold) : undefined,
      autoThreshold: typeof d.mode?.auto_threshold === 'boolean' ? d.mode.auto_threshold : undefined,
      krisp: typeof d.noise_suppression === 'boolean' ? d.noise_suppression : undefined,
      agc: typeof d.automatic_gain_control === 'boolean' ? d.automatic_gain_control : undefined,
      echo: typeof d.echo_cancellation === 'boolean' ? d.echo_cancellation : undefined
    };
  }
}
