import { EventEmitter } from 'node:events';
import { powerMonitor } from 'electron';
import { appendLog } from './logger';
import type Config from './config';

/**
 * Watcher aktywności wejściowej i stanu sesji użytkownika Windows.
 * - Wykorzystuje systemowe Win32 GetLastInputInfo (przez Electron powerMonitor, próbkowanie co 250 ms).
 * - Nasłuchuje natywnych zdarzeń blokady ekranu (Win + L / PIN / Hasło) oraz wygaszenia/uśpienia.
 * - Błyskawicznie (0 ms) przełącza profil przy blokadzie / odblokowaniu komputera.
 */
export default class ActivityWatcher extends EventEmitter {
  private readonly config: Config;
  private intervalTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastIdleSeconds = 0;
  public lastInputTime = Date.now();
  public isLocked = false;
  public isSuspended = false;

  private onLockScreenBound = (): void => this.handleLockScreen();
  private onUnlockScreenBound = (): void => this.handleUnlockScreen();
  private onSuspendBound = (): void => this.handleSuspend();
  private onResumeBound = (): void => this.handleResume();

  constructor(config: Config) {
    super();
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastInputTime = Date.now();
    this.lastIdleSeconds = 0;
    this.isLocked = false;
    this.isSuspended = false;

    // Próbkowanie wejścia co 250 ms dla sub-sekundowej responsywności na dotyk myszy/klawiatury
    this.intervalTimer = setInterval(() => this.tick(), 250);

    // Podpięcie zdarzeń sesji i zasilania Windows
    try {
      powerMonitor.on('lock-screen', this.onLockScreenBound);
      powerMonitor.on('unlock-screen', this.onUnlockScreenBound);
      powerMonitor.on('suspend', this.onSuspendBound);
      powerMonitor.on('resume', this.onResumeBound);
    } catch (err: unknown) {
      appendLog('ACTIVITY', `Błąd rejestracji zdarzeń powerMonitor: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stop(): void {
    this.running = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    try {
      powerMonitor.removeListener('lock-screen', this.onLockScreenBound);
      powerMonitor.removeListener('unlock-screen', this.onUnlockScreenBound);
      powerMonitor.removeListener('suspend', this.onSuspendBound);
      powerMonitor.removeListener('resume', this.onResumeBound);
    } catch {
      /* ignore powerMonitor cleanup errors */
    }
  }

  private handleLockScreen(): void {
    if (!this.running) return;
    this.isLocked = true;
    appendLog('ACTIVITY', '🔒 Wykryto zablokowanie ekranu Windows (Win + L / hasło) — natychmiastowe odejście (AWAY)');
    this.emit('lock');
  }

  private handleUnlockScreen(): void {
    if (!this.running) return;
    this.isLocked = false;
    this.lastInputTime = Date.now();
    this.lastIdleSeconds = 0;
    appendLog('ACTIVITY', '🔓 Wykryto odblokowanie ekranu Windows — natychmiastowy powrót do biurka (DESK)');
    this.emit('unlock');
    this.emit('activity', { idleSec: 0, freshInput: true });
  }

  private handleSuspend(): void {
    if (!this.running) return;
    this.isSuspended = true;
    appendLog('ACTIVITY', '💤 System Windows przechodzi w stan uśpienia (suspend)');
    this.emit('suspend');
  }

  private handleResume(): void {
    if (!this.running) return;
    this.isSuspended = false;
    this.lastInputTime = Date.now();
    this.lastIdleSeconds = 0;
    appendLog('ACTIVITY', '⚡ Wybudzono system Windows ze stanu uśpienia (resume)');
    this.emit('resume');
  }

  private tick(): void {
    if (!this.running || this.isLocked || this.isSuspended) return;
    if (this.config.get('userInputPresenceEnabled') === false) return;

    try {
      const idleSec = powerMonitor.getSystemIdleTime();
      if (typeof idleSec === 'number' && Number.isFinite(idleSec)) {
        if (idleSec <= 1 || idleSec < this.lastIdleSeconds) {
          const wasIdle = this.lastIdleSeconds > 2;
          this.lastInputTime = Date.now();
          if (wasIdle) {
            appendLog('ACTIVITY', 'Wykryto aktywność wejściową użytkownika (klawiatura / mysz)');
          }
          this.emit('activity', { idleSec, freshInput: wasIdle });
        }
        this.lastIdleSeconds = idleSec;
      }
    } catch {
      /* ignore powerMonitor errors */
    }
  }

  isUserActiveRecently(maxSeconds = 15): boolean {
    if (this.config.get('userInputPresenceEnabled') === false) return false;
    if (this.isLocked || this.isSuspended) return false;
    return Date.now() - this.lastInputTime <= maxSeconds * 1000;
  }
}
