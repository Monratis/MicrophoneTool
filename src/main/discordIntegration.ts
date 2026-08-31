import net from 'node:net';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import type Config from './config';
import { appendLog } from './logger';

// Fallback gdy config nie zawiera discordClientId / secret — domyślne dane aplikacji
const DISCORD_CLIENT_ID = '1238447097859145859';
const DISCORD_CLIENT_SECRET = 'xwmeOcXQP496dX5EYgXBFFcNyEUo30Z3';
const DISCORD_REDIRECT_URI = 'https://discord.com';

const OPCODES = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
} as const;

/** Wynik synchronizacji wejścia audio Discorda (notifyDeviceChanged). */
export interface DiscordSyncResult {
  ok: boolean;
  reason?: 'disabled' | 'not_connected' | 'not_ready' | 'rejected';
}

export default class DiscordIntegration extends EventEmitter {
  private readonly config: Config;
  private socket: net.Socket | null = null;
  private connected = false;
  private ready = false;
  private authenticated = false;
  private authFlowRunning = false;
  private authFlowPromise: Promise<{ ok: boolean; user?: string; error?: string }> | null = null;
  private authFailures = 0;
  private lastAuthAttemptAt = 0;
  private username = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Cykliczny proaktywny refresh tokenu OAuth (przed wygaśnięciem). */
  private refreshTimer: NodeJS.Timeout | null = null;
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

  private getClientId(): string {
    return (this.config.get('discordClientId') || DISCORD_CLIENT_ID).trim();
  }

  private getClientSecret(): string {
    return (this.config.get('discordClientSecret') || DISCORD_CLIENT_SECRET).trim();
  }

  private getRedirectUri(): string {
    return (this.config.get('discordRedirectUri') || DISCORD_REDIRECT_URI).trim();
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }

  start(): void {
    this.running = true;
    if (this.config.get('discordIntegration') !== false) {
      this.tryConnect();
      // Access token Discorda żyje 7 dni — kontrola co 6 h wymienia go
      // z 24 h zapasem, więc sesja auth nigdy nie przerywa działania.
      this.refreshTimer = setInterval(() => void this.proactiveTokenRefresh(), 6 * 3600 * 1000);
      if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
    }
    this.emitStatus();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
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
    this.emitStatus();
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
        this.emitStatus();
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
      this.emitStatus();
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
      this.emitStatus();
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
      this.emitStatus();
      return;
    }
    if (op !== 1 || !payload || typeof payload !== 'object') return;

    // READY = handshake zaakceptowany.
    // Jeśli mamy zapisany token w configu, uwierzytelniamy automatycznie w tle.
    if (payload.evt === 'READY') {
      this.handshakeFailures = 0;
      this.ready = true;
      const rUser = payload.data?.user?.global_name || payload.data?.user?.username;
      if (rUser && !this.username) {
        this.username = rUser;
      }
      console.log(`[discord] Sesja RPC gotowa (READY)${this.username ? ` (@${this.username})` : ''}`);
      this.emitStatus();
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

  /** Zapisuje tokeny OAuth2 do pliku konfiguracyjnego — jeden atomowy zapis na końcu.
   *  Jeśli Discord nie zwrócił nowego refresh_token (rotacja nie zawsze następuje),
   *  zachowuje poprzedni zapisany. */
  private saveTokens(accessToken: string, refreshToken?: string, expiresIn?: number): void {
    this.config.data.discordAccessToken = accessToken;
    // Zachowaj stary refresh_token jeśli Discord nie zwrócił nowego —
    // rotacja refresh tokenu nie jest gwarantowana przy każdym odświeżeniu.
    if (refreshToken) {
      this.config.data.discordRefreshToken = refreshToken;
    }
    if (typeof expiresIn === 'number' && expiresIn > 0) {
      const expiresAt = Date.now() + expiresIn * 1000;
      this.config.data.discordTokenExpiresAt = expiresAt;
      const expiresDate = new Date(expiresAt).toLocaleString('pl-PL');
      appendLog('DISCORD', `Access token ważny do: ${expiresDate} (za ${Math.round(expiresIn / 3600)} h)`);
    }
    // Jeden atomowy zapis — chroni przed utratą danych przy crashu między set()-ami.
    this.config.save();
  }

  /** Czyści zapisane tokeny w konfiguracji — jeden atomowy zapis. */
  private clearTokens(): void {
    this.config.data.discordAccessToken = '';
    this.config.data.discordRefreshToken = '';
    this.config.data.discordTokenExpiresAt = 0;
    this.config.save();
  }

  /**
   * Cicha próba automatycznego uwierzytelnienia sesji RPC zapisanym tokenem.
   * Access token Discorda żyje 7 dni — gdy wygasa w ciągu 24 h, jest proaktywnie
   * odświeżany w tle, ale sesja RPC natychmiast loguje się istniejącym tokenem.
   * Wszelkie błędy sieci/serwera zachowują tokeny bez ich usuwania.
   */
  private async tryAutoAuthenticate(): Promise<void> {
    if (!this.ready || this.authenticated || !this.socket || this.socket.destroyed) {
      return;
    }
    if (this.authFlowRunning) {
      if (this.authFlowPromise) {
        try {
          await this.authFlowPromise;
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const accessToken = (this.config.get('discordAccessToken') || '').trim();
    const refreshTokenStr = (this.config.get('discordRefreshToken') || '').trim();

    if (!accessToken && !refreshTokenStr) {
      return;
    }

    this.authFlowRunning = true;
    try {
      const expiresAt = Number(this.config.get('discordTokenExpiresAt')) || 0;
      const isExpired = expiresAt > 0 && Date.now() >= expiresAt;
      const expiresSoon = expiresAt > 0 && Date.now() > expiresAt - 24 * 3600 * 1000;

      if (expiresAt > 0) {
        const remainH = Math.round((expiresAt - Date.now()) / 3600000);
        appendLog('DISCORD', `Auto-auth: access token ${isExpired ? 'WYGASŁ' : `ważny jeszcze ~${remainH} h`}`);
      } else {
        appendLog('DISCORD', 'Auto-auth: brak zapisanego czasu wygaśnięcia tokenu — próba AUTHENTICATE');
      }

      // 1. Jeśli token dostępu istnieje i nie wygasł definitywnie, spróbuj najpierw uwierzytelnić sesję RPC
      if (accessToken && !isExpired) {
        const auth = await this.rpcCommand('AUTHENTICATE', { access_token: accessToken }, 10000);
        if (auth.ok) {
          this.authenticated = true;
          const u = (auth.data as { user?: { username?: string; global_name?: string } } | undefined)?.user;
          this.username = u?.global_name || u?.username || this.username || '';
          appendLog('DISCORD', `Automatycznie uwierzytelniono sesję OAuth${this.username ? ` jako @${this.username}` : ''} ✓`);
          this.emit('authenticated');
          this.emitStatus();

          // Jeśli token wygasa wkrótce (<24h), w tle odśwież go proaktywnie (nie blokując sesji)
          if (expiresSoon && refreshTokenStr) {
            void this.proactiveTokenRefresh();
          }
          return;
        }
        appendLog('DISCORD', 'Zapisany access token nie został przyjęty przez sesję RPC — próbuję odświeżyć token (refresh_token)...');
      }

      // 2. Jeśli brak access tokenu lub nie został przyjęty / wygasł, użyj refresh_token do pobrania nowego
      if (refreshTokenStr) {
        const refreshed = await this.refreshToken(refreshTokenStr);
        if (refreshed.ok && refreshed.accessToken) {
          this.saveTokens(refreshed.accessToken, refreshed.refreshToken, refreshed.expiresIn);
          const auth = await this.rpcCommand('AUTHENTICATE', { access_token: refreshed.accessToken }, 10000);
          if (auth.ok) {
            this.authenticated = true;
            const u = (auth.data as { user?: { username?: string; global_name?: string } } | undefined)?.user;
            this.username = u?.global_name || u?.username || this.username || '';
            appendLog('DISCORD', `Pomyślnie odświeżono token OAuth i uwierzytelniono sesję${this.username ? ` (@${this.username})` : ''} ✓`);
            this.emit('authenticated');
            this.emitStatus();
            return;
          }
          appendLog('DISCORD', 'Nowy token nie został przyjęty przez sesję RPC — tokeny zachowane, ponowię przy kolejnym połączeniu.');
          return;
        }

        // 3. Sprawdź przyczynę błędu odświeżania
        if (refreshed.rejected) {
          // Jednoznaczna odmowa (invalid_grant) — np. użytkownik odpiął aplikację w ustawieniach Discorda
          this.clearTokens();
          this.emitStatus();
          appendLog('DISCORD', 'Refresh token został unieważniony przez Discord (invalid_grant) — wymagana ponowna autoryzacja (kliknij "Autoryzuj Discord").');
        } else {
          // Błąd sieci/serwera Discord (np. brak połączenia z internetem przy starcie/wybudzeniu PC)
          // Jeśli stary accessToken istnieje, spróbuj go jako ostatnią deskę ratunku:
          if (accessToken) {
            const fallbackAuth = await this.rpcCommand('AUTHENTICATE', { access_token: accessToken }, 10000);
            if (fallbackAuth.ok) {
              this.authenticated = true;
              const u = (fallbackAuth.data as { user?: { username?: string; global_name?: string } } | undefined)?.user;
              this.username = u?.global_name || u?.username || this.username || '';
              appendLog('DISCORD', `Uwierzytelniono sesję RPC istniejącym tokenem w trybie offline/fallback${this.username ? ` (@${this.username})` : ''} ✓`);
              this.emit('authenticated');
              this.emitStatus();
              return;
            }
          }
          appendLog('DISCORD', 'Odświeżanie tokenu nie powiodło się (błąd sieci/serwera Discord) — tokeny zachowane, ponowię próbę.');
        }
      }
    } catch (e) {
      console.warn('[discord] Błąd auto-uwierzytelniania:', (e as Error).message);
    } finally {
      this.authFlowRunning = false;
      this.emitStatus();
    }
  }

  /**
   * Zapewnia, że sesja RPC jest uwierzytelniona jeśli w konfiguracji istnieją tokeny.
   * Czeka na zakończenie trwającego auto-uwierzytelniania.
   */
  async ensureAuthenticated(): Promise<boolean> {
    if (this.authenticated) return true;
    if (!this.connected || !this.ready || !this.socket || this.socket.destroyed) return false;
    const hasTokens = Boolean(this.config.get('discordAccessToken') || this.config.get('discordRefreshToken'));
    if (!hasTokens) return false;
    if (this.authFlowRunning && this.authFlowPromise) {
      try {
        const res = await this.authFlowPromise;
        return res.ok;
      } catch {
        return this.authenticated;
      }
    }
    await this.tryAutoAuthenticate();
    return this.authenticated;
  }

  /**
   * Proaktywna wymiana access tokenu przed wygaśnięciem (licznik co 6 h,
   * próba gdy zostało < 24 h). Dzięki temu sesja auth nigdy nie przerywa
   * działania w trakcie pracy.
   */
  private async proactiveTokenRefresh(): Promise<void> {
    if (!this.running || this.authFlowRunning) return;
    const refreshTokenStr = (this.config.get('discordRefreshToken') || '').trim();
    if (!refreshTokenStr) return;

    const expiresAt = Number(this.config.get('discordTokenExpiresAt')) || 0;
    if (expiresAt > 0 && Date.now() < expiresAt - 24 * 3600 * 1000) return;

    this.authFlowRunning = true;
    try {
      const refreshed = await this.refreshToken(refreshTokenStr);
      if (refreshed.ok && refreshed.accessToken) {
        this.saveTokens(refreshed.accessToken, refreshed.refreshToken, refreshed.expiresIn);
        appendLog('DISCORD', 'Access token OAuth odświeżony proaktywnie (przed wygaśnięciem) ✓');
        if (!this.authenticated && this.ready) {
          const auth = await this.rpcCommand('AUTHENTICATE', { access_token: refreshed.accessToken }, 10000);
          if (auth.ok) {
            this.authenticated = true;
            const u = (auth.data as { user?: { username?: string; global_name?: string } } | undefined)?.user;
            this.username = u?.global_name || u?.username || this.username || '';
            this.emit('authenticated');
            this.emitStatus();
          }
        }
      } else if (refreshed.rejected) {
        this.clearTokens();
        this.emitStatus();
        appendLog('DISCORD', 'Refresh token odrzucony przez Discord — wymagana ponowna jednorazowa autoryzacja.');
      }
      // Błąd sieci: cisza — kolejny cykl timera spróbuje ponownie.
    } finally {
      this.authFlowRunning = false;
      this.emitStatus();
    }
  }

  /** Ręczne uruchomienie autoryzacji (tray/UI) — resetuje backoff i odpala flow. */
  authorizeManually(): Promise<{ ok: boolean; user?: string; error?: string }> {
    this.authFailures = 0;
    this.lastAuthAttemptAt = 0;
    return this.authorizeFlow();
  }

  /**
   * Pełny OAuth flow dla komend głosowych (4006 bez tego):
   * AUTHORIZE (popup zgody w kliencie) → code → wymiana na token
   * (wymaga discordClientSecret z config.json) → AUTHENTICATE.
   */
  private async authorizeFlow(): Promise<{ ok: boolean; user?: string; error?: string }> {
    if (this.authenticated) {
      return { ok: true, user: this.username };
    }
    if (this.authFlowRunning && this.authFlowPromise) {
      return this.authFlowPromise;
    }
    if (!this.connected || !this.ready) {
      return { ok: false, error: 'Brak aktywnego połączenia z Discordem (upewnij się, że aplikacja Discord jest włączona).' };
    }
    // Odmowa autoryzacji nie może pchać popupa co 10 s: po 2 odmowach
    // kolejne próby najwcześniej po 5 minutach (chyba że zresetowano licznik).
    if (this.authFailures >= 2 && Date.now() - this.lastAuthAttemptAt < 5 * 60 * 1000) {
      return { ok: false, error: 'Zbyt wiele nieudanych prób autoryzacji. Spróbuj ponownie za kilka minut.' };
    }
    this.authFlowRunning = true;
    this.lastAuthAttemptAt = Date.now();
    this.emitStatus();

    this.authFlowPromise = (async () => {
      try {
        const clientId = this.getClientId();
        const clientSecret = this.getClientSecret();
        if (!clientSecret) {
          console.error(
            '[discord] Brak discordClientSecret w config.json — presety głosowe wymagają autoryzacji OAuth (scope rpc.voice.write).'
          );
          return { ok: false, error: 'Brak klucza discordClientSecret w konfiguracji aplikacji.' };
        }
        // Zestaw uprawnień wymaganych do sterowania wejściem i profilami głosu w Discordzie.
        const scopeSets: string[][] = [
          ['identify', 'rpc', 'rpc.voice.read', 'rpc.voice.write'],
          ['identify', 'rpc', 'rpc.voice.read', 'rpc.voice.write', 'rpc.notifications.read', 'rpc.activities.write']
        ];
        let authResp: { ok: boolean; data?: unknown } = { ok: false, data: undefined };
        for (const scopes of scopeSets) {
          // AUTHORIZE otwiera MODAL zgody w kliencie Discord — użytkownik klika ręką
          authResp = await this.rpcCommand(
            'AUTHORIZE',
            { client_id: clientId, scopes },
            120000
          );
          const c = (authResp.data as { code?: string } | undefined)?.code;
          if (authResp.ok && c) break;
          const errCode = (authResp.data as { code?: number } | undefined)?.code;
          if (errCode === 4002) {
            console.warn(
              '[discord] 4002 Already authing — w Discordzie trwa inna autoryzacja.'
            );
            return { ok: false, error: 'W Discordzie trwa już inne okno autoryzacji. Zamknij otwarty popup w Discordzie i spróbuj ponownie.' };
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
              'został zatwierdzony.'
          );
          return { ok: false, error: 'Autoryzacja nie została zatwierdzona w oknie aplikacji Discord.' };
        }
        this.authFailures = 0;
        const tokenData = await this.exchangeToken(code);
        if (!tokenData.ok || !tokenData.accessToken) {
          const err = tokenData.rejected
            ? 'Wymiana kodu na token odrzucona przez Discord (sprawdź discordClientSecret i discordRedirectUri).'
            : 'Wymiana kodu na token nieudana (błąd sieci/połączenia z Discord).'
          appendLog('DISCORD', err);
          return { ok: false, error: err };
        }

        this.saveTokens(tokenData.accessToken, tokenData.refreshToken, tokenData.expiresIn);

        const auth = await this.rpcCommand('AUTHENTICATE', { access_token: tokenData.accessToken }, 10000);
        if (auth.ok) {
          this.authenticated = true;
          const u = (auth.data as { user?: { username?: string; global_name?: string } } | undefined)?.user;
          this.username = u?.global_name || u?.username || this.username || '';
          appendLog('DISCORD', `Pomyślnie uwierzytelniono OAuth${this.username ? ` jako @${this.username}` : ''} — presety głosu i sterowanie wejściem aktywne ✓`);
          this.emit('authenticated');
          this.emitStatus();
          return { ok: true, user: this.username };
        } else {
          appendLog('DISCORD', `Błąd AUTHENTICATE: ${JSON.stringify(auth.data ?? null)}`);
          return { ok: false, error: 'AUTHENTICATE odrzucone przez Discord.' };
        }
      } catch (e) {
        appendLog('DISCORD', `Błąd flow autoryzacji: ${(e as Error).message}`);
        return { ok: false, error: (e as Error).message };
      } finally {
        this.authFlowRunning = false;
        this.authFlowPromise = null;
        this.emitStatus();
      }
    })();

    return this.authFlowPromise;
  }

  /** Wynik wymiany/odświeżania tokenu: `rejected` = Discord jednoznacznie odmówił
   *  (invalid_grant), inna porażka = sieć/serwer — tokeny należy zachować. */
  private tokenRequest(
    body: URLSearchParams,
    successLog?: (json: { access_token?: string; refresh_token?: string; expires_in?: number }) => void
  ): Promise<{ ok: boolean; rejected: boolean; accessToken?: string; refreshToken?: string; expiresIn?: number }> {
    return new Promise((resolve) => {
      const finish = (r: { ok: boolean; rejected: boolean; accessToken?: string; refreshToken?: string; expiresIn?: number }) => resolve(r);
      const postData = body.toString();
      const req = https.request(
        {
          hostname: 'discord.com',
          path: '/api/oauth2/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'User-Agent': 'DeskSense/1.0 (Windows NT 10.0; Win64; x64)'
          }
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(data) as {
                access_token?: string;
                refresh_token?: string;
                expires_in?: number;
                error?: string;
                error_description?: string;
                message?: string;
              };
              if (json.access_token) {
                if (successLog) successLog(json);
                finish({
                  ok: true,
                  rejected: false,
                  accessToken: json.access_token,
                  refreshToken: json.refresh_token,
                  expiresIn: json.expires_in
                });
              } else {
                // Tylko jednoznaczna odmowa invalid_grant na kodzie HTTP 400 oznacza unieważnienie tokenu
                const isExplicitlyRevoked = res.statusCode === 400 && json.error === 'invalid_grant';
                appendLog(
                  'DISCORD',
                  `Token endpoint zwrócił błąd (HTTP ${res.statusCode}): ${json.error || json.message || JSON.stringify(json).slice(0, 200)}`
                );
                finish({ ok: false, rejected: isExplicitlyRevoked });
              }
            } catch {
              // Odpowiedź nie-JSON (HTML bramki, timeout proxy) — traktuj jak błąd sieci
              appendLog('DISCORD', `Serwer Discord zwrócił odpowiedź nie-JSON (HTTP ${res.statusCode})`);
              finish({ ok: false, rejected: false });
            }
          });
        }
      );
      req.setTimeout(15000, () => req.destroy(new Error('timeout połączenia HTTPS do discord.com')));
      req.on('error', (e) => {
        appendLog('DISCORD', `Błąd połączenia z serwerem OAuth Discord: ${e.message}`);
        finish({ ok: false, rejected: false });
      });
      req.write(postData);
      req.end();
    });
  }

  /** Wymiana kodu autoryzacji na access token i refresh token (POST /api/oauth2/token). */
  private exchangeToken(code: string) {
    return this.tokenRequest(new URLSearchParams({
      client_id: this.getClientId(),
      client_secret: this.getClientSecret(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.getRedirectUri()
    }));
  }

  /** Odświeżanie tokenu za pomocą refresh_token (POST /api/oauth2/token). */
  private refreshToken(refreshToken: string) {
    return this.tokenRequest(new URLSearchParams({
      client_id: this.getClientId(),
      client_secret: this.getClientSecret(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }));
  }

  getStatus(): {
    enabled: boolean;
    connected: boolean;
    ready: boolean;
    authenticated: boolean;
    user?: string;
    error?: string;
  } {
    return {
      enabled: this.config.get('discordIntegration') !== false,
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
      client_id: this.getClientId()
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

  /**
   * Przełącza wejście audio Discorda na DOMYŚLNE urządzenie systemowe.
   * UWAGA: parametr deviceLabel jest wyłącznie informacyjny (logi, komunikaty
   * błędów) — Discord RPC dostaje zawsze device_id 'default', bo to apka
   * zmienia domyślny mikrofon w Windows i Discord ma za nim podążać.
   * W odróżnieniu od dawnego fire-and-forget odpowiedź Discorda jest
   * weryfikowana po nonce — porażka wraca z powodem, który kontroler
   * wyświetla użytkownikowi w UI.
   */
  async notifyDeviceChanged(deviceLabel: string | null): Promise<DiscordSyncResult> {
    const deviceName = deviceLabel;
    if (!this.config.get('discordIntegration')) {
      return { ok: true, reason: 'disabled' };
    }
    if (!this.connected || !this.socket || this.socket.destroyed) {
      appendLog(
        'DISCORD',
        `Nie zsynchronizowano wejścia Discorda ("${deviceName || 'Domyślny systemowy'}") — brak połączenia RPC (Discord nie uruchomiony?)`
      );
      return { ok: false, reason: 'not_connected' };
    }
    if (!this.ready) {
      appendLog('DISCORD', `Nie zsynchronizowano wejścia Discorda — sesja RPC bez handshake'u READY`);
      return { ok: false, reason: 'not_ready' };
    }
    await this.ensureAuthenticated();
    try {
      const reply = await this.rpcCommand('SET_VOICE_SETTINGS', {
        input: { device_id: 'default' }
      }, 10000);
      if (reply.ok) {
        appendLog('DISCORD', `Zsynchronizowano wejście audio Discord -> "${deviceName || 'Domyślny systemowy'}" ✓`);
        return { ok: true };
      }
      appendLog(
        'DISCORD',
        `Discord nie przyjął zmiany wejścia (${deviceName || 'default'}) — brak odpowiedzi lub odrzucenie: ${JSON.stringify(reply.data ?? null).slice(0, 200)}`
      );
      return { ok: false, reason: 'rejected' };
    } catch (err) {
      console.warn('[discord] Błąd wysyłania komendy:', (err as Error).message);
      appendLog('DISCORD', `Błąd wysyłania SET_VOICE_SETTINGS: ${(err as Error).message}`);
      return { ok: false, reason: 'rejected' };
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
  async applyMicSettings(opts: {
    gateDb?: number;
    autoThreshold?: boolean;
    krisp?: boolean;
    agc?: boolean;
    echo?: boolean;
  }): Promise<boolean> {
    if (!this.config.get('discordIntegration')) return false;
    if (!this.connected || !this.ready) {
      appendLog('DISCORD', `Pominięto profil głosu (bramka ${opts.autoThreshold ? 'AUTO' : opts.gateDb ?? '--'}) — brak aktywnego połączenia z Discordem`);
      return false;
    }
    if (!this.authenticated) {
      await this.ensureAuthenticated();
    }
    if (!this.authenticated) {
      appendLog('DISCORD', `Pominięto profil głosu — brak autoryzacji OAuth Discorda`);
      return false;
    }
    try {
      const args: Record<string, unknown> = {};
      if (opts.autoThreshold === true) {
        args.mode = {
          type: 'VOICE_ACTIVITY',
          auto_threshold: true
        };
      } else if (typeof opts.gateDb === 'number') {
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

      const reply = await this.rpcCommand('SET_VOICE_SETTINGS', args, 10000);
      appendLog(
        'DISCORD',
        `Aplikowano profil głosu w Discordzie: VAD=${opts.autoThreshold ? 'AUTO (Voice Isolation)' : `${opts.gateDb ?? '--'} dB`}, Krisp=${opts.krisp ?? '--'}, AGC=${opts.agc ?? '--'}, Echo=${opts.echo ?? '--'} -> ${reply.ok ? 'SUKCES ✓' : 'BŁĄD ✗'}`
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

  /**
   * Głośność wejścia przez Discorda (pipeline WebRTC). Działa nawet dla urządzeń   * BT, które nie wystawiają IAudioEndpointVolume w OS (E_NOINTERFACE).
   * Zakres Discorda: 0-200 (100 = 100%). Fallback dla daemona audio.
   */
  async applyInputVolume(percent: number): Promise<boolean> {
    if (!this.config.get('discordIntegration')) return false;
    if (!this.authenticated) await this.ensureAuthenticated();
    if (!this.authenticated) return false;
    const vol = Math.max(0, Math.min(200, Math.round(percent)));
    const reply = await this.rpcCommand('SET_VOICE_SETTINGS', {
      input: { volume: vol }
    }, 5000);
    console.log(
      `[discord] SET_VOICE_SETTINGS input.volume=${vol} -> ok=${reply.ok}`
    );
    return reply.ok;
  }

  /** Mute wejścia przez Discorda — fallback dla urządzeń BT bez IAudioEndpointVolume. */
  async setInputMute(muted: boolean): Promise<boolean> {
    if (!this.config.get('discordIntegration')) return false;
    if (!this.authenticated) await this.ensureAuthenticated();
    if (!this.authenticated) return false;
    const reply = await this.rpcCommand('SET_VOICE_SETTINGS', { mute: muted }, 5000);
    console.log(`[discord] SET_VOICE_SETTINGS mute=${muted} -> ok=${reply.ok}`);
    return reply.ok;
  }

  /** Aktualny stan mute wejścia z Discorda (do toggle przy urządzeniach BT). */
  async getInputMute(): Promise<boolean | null> {
    if (!this.config.get('discordIntegration')) return null;
    if (!this.authenticated) await this.ensureAuthenticated();
    if (!this.authenticated) return null;
    const reply = await this.rpcCommand('GET_VOICE_SETTINGS', {}, 5000);
    if (!reply.ok) return null;
    const d = reply.data as { mute?: boolean };
    return typeof d.mute === 'boolean' ? d.mute : null;
  }

  /**
   * Pobiera aktualne ustawienia głosu bezpośrednio z Discorda (próg bramki dB, Krisp, AGC, Echo).
   */
  async getVoiceSettings(): Promise<{
    ok: boolean;
    settings?: {
      thresholdDb?: number;
      autoThreshold?: boolean;
      krisp?: boolean;
      agc?: boolean;
      echo?: boolean;
    };
    user?: string;
    error?: string;
  }> {
    if (!this.config.get('discordIntegration')) {
      return { ok: false, error: 'Integracja z Discordem jest wyłączona w ustawieniach aplikacji.' };
    }
    if (!this.connected || !this.ready) {
      return { ok: false, error: 'Brak połączenia z Discordem (upewnij się, że aplikacja Discord jest włączona).' };
    }
    if (!this.authenticated) {
      await this.ensureAuthenticated();
      if (!this.authenticated) {
        const authRes = await this.authorizeFlow();
        if (!authRes.ok) {
          return { ok: false, error: authRes.error || 'Wymagana autoryzacja OAuth w Discordzie (kliknij "Autoryzuj Discord").' };
        }
      }
    }
    const reply = await this.rpcCommand('GET_VOICE_SETTINGS', {}, 10000);
    if (!reply.ok || !reply.data || typeof reply.data !== 'object') {
      return { ok: false, error: 'Discord nie zwrócił ustawień głosu.' };
    }
    const d = reply.data as {
      mode?: { type?: string; auto_threshold?: boolean; threshold?: number };
      automatic_gain_control?: boolean;
      noise_suppression?: boolean;
      echo_cancellation?: boolean;
    };
    return {
      ok: true,
      user: this.username || undefined,
      settings: {
        thresholdDb: typeof d.mode?.threshold === 'number' ? Math.round(d.mode.threshold) : undefined,
        autoThreshold: typeof d.mode?.auto_threshold === 'boolean' ? d.mode.auto_threshold : undefined,
        krisp: typeof d.noise_suppression === 'boolean' ? d.noise_suppression : undefined,
        agc: typeof d.automatic_gain_control === 'boolean' ? d.automatic_gain_control : undefined,
        echo: typeof d.echo_cancellation === 'boolean' ? d.echo_cancellation : undefined
      }
    };
  }
}
