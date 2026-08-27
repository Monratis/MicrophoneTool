import { EventEmitter } from 'node:events';
import { powerMonitor } from 'electron';
import { appendLog } from './logger';
import type Config from './config';

/**
 * Watcher aktywności wejściowej użytkownika (klawiatura / mysz / touchpad).
 * Wykorzystuje systemowe Win32 GetLastInputInfo (przez Electron powerMonitor).
 * Eliminuje fałszywe wygaszanie obecności, gdy użytkownik siedzi i pisze/klika.
 */
export default class ActivityWatcher extends EventEmitter {
  private readonly config: Config;
  private intervalTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastIdleSeconds = 0;
  public lastInputTime = Date.now();

  constructor(config: Config) {
    super();
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastInputTime = Date.now();
    this.lastIdleSeconds = 0;
    this.intervalTimer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    this.running = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private tick(): void {
    if (!this.running) return;
    if (this.config.get('userInputPresenceEnabled') === false) return;

    try {
      const idleSec = powerMonitor.getSystemIdleTime();
      if (idleSec <= 1 || idleSec < this.lastIdleSeconds) {
        const wasIdle = this.lastIdleSeconds > 3;
        this.lastInputTime = Date.now();
        if (wasIdle) {
          appendLog('ACTIVITY', 'Wykryto aktywność wejściową użytkownika (klawiatura / mysz)');
        }
        this.emit('activity', { idleSec, freshInput: wasIdle });
      }
      this.lastIdleSeconds = idleSec;
    } catch {
      /* ignore powerMonitor errors */
    }
  }

  isUserActiveRecently(maxSeconds = 15): boolean {
    if (this.config.get('userInputPresenceEnabled') === false) return false;
    return Date.now() - this.lastInputTime <= maxSeconds * 1000;
  }
}
