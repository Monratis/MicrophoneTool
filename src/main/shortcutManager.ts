import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { globalShortcut } from 'electron';
import type { AppContext } from './appContext';
import { toggleMuteWithFeedback, resolveBinDir } from './appContext';
import { appendLog } from './logger';
import { showVoiceOsd } from './voiceOsd';

/**
 * Obsługuje wyzwolenie nasłuchu komendy głosowej przez globalny skrót klawiszowy lub przycisk myszy.
 */
export function handleVoiceHotkey(ctx: AppContext): void {
  const enabled = ctx.config.get('voiceEnabled');
  if (!enabled) {
    appendLog('VOICE-HOTKEY', 'Wciśnięto skrót wywołania mowy, ale sterowanie głosem jest wyłączone');
    ctx.pushEvent('toast', {
      message: '🎙️ Sterowanie głosem jest wyłączone. Włącz je w zakładce Komendy Głosowe.',
      error: true
    });
    showVoiceOsd('Sterowanie głosem jest wyłączone', 'blocked', 3000);
    return;
  }

  if (!ctx.voice) {
    return;
  }

  // Jeśli silnik jeszcze nie działa, sprawdź czy model jest gotowy i wystartuj
  if (!ctx.voice.isRunning()) {
    if (!ctx.voice.isModelReady()) {
      appendLog('VOICE-HOTKEY', 'Wciśnięto skrót wywołania mowy, ale model mowy nie jest jeszcze pobrany');
      ctx.pushEvent('toast', {
        message: '🎙️ Model mowy nie jest jeszcze pobrany. Pobierz go w zakładce Komendy Głosowe.',
        error: true
      });
      showVoiceOsd('Model mowy nie jest pobrany', 'blocked', 3000);
      return;
    }

    appendLog('VOICE-HOTKEY', 'Wciśnięto skrót wywołania mowy — uruchamiam silnik w tle…');
    void ctx.voice.start().then((started) => {
      if (started) {
        ctx.voice?.triggerWakeState('hotkey');
      }
    });
    return;
  }

  // Silnik już działa — natychmiastowe otwarcie okna nasłuchu komendy
  appendLog('VOICE-HOTKEY', '🎙️ Wciśnięto skrót wywołania mowy — aktywuję nasłuch komendy');
  ctx.voice.triggerWakeState('hotkey');
}

/**
 * Zarządza rejestracją i cyklem życia globalnych skrótów klawiszowych i przycisków myszy w aplikacji.
 */
export class ShortcutManager {
  private registeredMuteShortcut: string | null = null;
  private registeredVoiceShortcut: string | null = null;
  private hookProc: ChildProcess | null = null;
  private ctx: AppContext | null = null;
  private isIntentionalQuit = false;

  private get hookExePath(): string {
    const binExe = path.join(resolveBinDir(), 'GlobalInputHook.exe');
    if (fs.existsSync(binExe)) return binExe;
    return path.join(process.cwd(), 'bin', 'GlobalInputHook.exe');
  }

  private lastTriggerTimes: Record<string, number> = { voice: 0, mute: 0 };
  private readonly TRIGGER_COOLDOWN_MS = 350;

  private triggerTarget(target: 'voice' | 'mute'): void {
    const now = Date.now();
    const last = this.lastTriggerTimes[target] || 0;
    if (now - last < this.TRIGGER_COOLDOWN_MS) {
      return;
    }
    this.lastTriggerTimes[target] = now;

    if (!this.ctx) return;
    if (target === 'voice') {
      handleVoiceHotkey(this.ctx);
    } else if (target === 'mute') {
      void toggleMuteWithFeedback(this.ctx);
    }
  }

  private ensureHookProcess(ctx: AppContext): void {
    this.ctx = ctx;
    if (this.hookProc && !this.hookProc.killed) return;

    const exe = this.hookExePath;
    if (!fs.existsSync(exe)) {
      appendLog('HOTKEY-WARN', `Brak pliku GlobalInputHook.exe pod: ${exe} — używam awaryjnego globalShortcut Electrona`);
      return;
    }

    try {
      this.isIntentionalQuit = false;
      this.hookProc = spawn(exe, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const rl = readline.createInterface({ input: this.hookProc.stdout! });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.event === 'hotkey') {
            if (parsed.target === 'voice' || parsed.target === 'mute') {
              this.triggerTarget(parsed.target);
            }
          }
        } catch {
          // Ignoruj nie-JSON
        }
      });

      this.hookProc.on('error', (err) => {
        appendLog('HOTKEY-ERR', `Błąd procesu GlobalInputHook: ${err.message}`);
        this.hookProc = null;
      });

      this.hookProc.on('exit', () => {
        this.hookProc = null;
        if (!this.isIntentionalQuit && this.ctx) {
          setTimeout(() => {
            if (!this.isIntentionalQuit && this.ctx) {
              this.ensureHookProcess(this.ctx);
              this.sendTargetsToHook();
            }
          }, 1500);
        }
      });
    } catch (err) {
      appendLog('HOTKEY-ERR', `Nie udało się uruchomić GlobalInputHook.exe: ${(err as Error).message}`);
    }
  }

  private sendTargetsToHook(): void {
    if (!this.hookProc || !this.hookProc.stdin || this.hookProc.stdin.destroyed) return;
    try {
      const v = this.registeredVoiceShortcut || '';
      const m = this.registeredMuteShortcut || '';
      this.hookProc.stdin.write(`voice ${v}\n`);
      this.hookProc.stdin.write(`mute ${m}\n`);
    } catch {}
  }

  registerAll(ctx: AppContext): void {
    this.ctx = ctx;
    this.ensureHookProcess(ctx);

    const voiceSc = (ctx.config.get('voiceShortcut') || '').trim();
    const muteSc = (ctx.config.get('globalShortcut') || '').trim();

    this.registeredVoiceShortcut = voiceSc || null;
    this.registeredMuteShortcut = muteSc || null;

    // Przekaż skróty/przyciski do natywnego GlobalInputHook (obsługa myszy Mouse1-5 + klawiszy)
    this.sendTargetsToHook();

    // Rejestruj awaryjnie w Electron globalShortcut z debouncem
    this.unregisterElectronShortcuts();
    if (muteSc && !muteSc.toLowerCase().includes('mouse')) {
      try {
        globalShortcut.register(muteSc, () => {
          this.triggerTarget('mute');
        });
      } catch {}
    }
    if (voiceSc && !voiceSc.toLowerCase().includes('mouse')) {
      try {
        globalShortcut.register(voiceSc, () => {
          this.triggerTarget('voice');
        });
      } catch {}
    }

    if (voiceSc) appendLog('HOTKEY', `Aktywny skrót wywołania mowy: ${voiceSc}`);
    if (muteSc) appendLog('HOTKEY', `Aktywny skrót wyciszenia: ${muteSc}`);
  }

  private unregisterElectronShortcuts(): void {
    try {
      globalShortcut.unregisterAll();
    } catch {}
  }

  unregisterAll(): void {
    this.isIntentionalQuit = true;
    this.unregisterElectronShortcuts();
    if (this.hookProc) {
      try {
        if (this.hookProc.stdin && !this.hookProc.stdin.destroyed) {
          this.hookProc.stdin.write('quit\n');
        }
        this.hookProc.kill('SIGTERM');
      } catch {}
      this.hookProc = null;
    }
    this.registeredMuteShortcut = null;
    this.registeredVoiceShortcut = null;
  }

  getRegisteredMuteShortcut(): string | null {
    return this.registeredMuteShortcut;
  }

  getRegisteredVoiceShortcut(): string | null {
    return this.registeredVoiceShortcut;
  }
}

export const shortcutManager = new ShortcutManager();
