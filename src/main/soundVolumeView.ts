import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { appendLog } from './logger';
import type Config from './config';
import type { AudioDeviceItem } from '../shared/types';

const CSC_PATHS = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
];

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface ToolInfo {
  path: string;
  isNative: boolean;
}

interface DaemonQueueItem {
  resolve: (val: ExecResult) => void;
  /** Po timeoutcie odpowiedź (gdy w końcu przyjdzie) jest DISKARDOWANA, ale pozycja zostaje w kolejce — zachowuje to dopasowanie 1:1 z protokołem daemona. */
  timedOut?: boolean;
}

interface CachedDevices {
  list: AudioDeviceItem[];
  timestamp: number;
}

interface NativeDevice {
  name?: string;
  id?: string;
  isDefault?: boolean;
  isDefaultComm?: boolean;
  isMuted?: boolean;
  volume?: number;
  volumeDb?: number | null;
}

/**
 * Moduł kontrolera audio Windows (Zero-Latency Resident Daemon & Direct COM).
 * Wykorzystuje natywny AudioSwitcher.exe oparty o Windows CoreAudio API.
 */
export default class SoundVolumeView {
  private readonly binDir: string;
  private readonly toolsDir: string;
  private statusCb: ((msg: string) => void) | null = null;
  private cachedTool: ToolInfo | null = null;
  private devicesCache: CachedDevices | null = null;
  private readonly nameToIdMap = new Map<string, string>();
  private currentDefaultDevice: string | null = null;
  private lastEnumSig = '';

  private daemonProc: ReturnType<typeof spawn> | null = null;
  private readonly daemonQueue: DaemonQueueItem[] = [];
  private readonly daemonCmdQueue: Array<{ cmd: string; resolve: (val: ExecResult | null) => void }> = [];
  private daemonBusy = false;
  private daemonStarting: Promise<ReturnType<typeof spawn> | null> | null = null;

  constructor({ binDir, toolsDir }: { binDir: string; toolsDir: string; config?: Config }) {
    this.binDir = binDir;
    this.toolsDir = toolsDir;
  }

  onStatus(cb: (msg: string) => void): void {
    this.statusCb = cb;
  }

  private emitStatus(msg: string): void {
    if (this.statusCb) this.statusCb(msg);
  }

  get nativeExePath(): string {
    return path.join(this.binDir, 'AudioSwitcher.exe');
  }

  private get sourceCsPath(): string | null {
    const devPath = path.join(__dirname, '..', '..', 'src', 'native', 'AudioSwitcher.cs');
    if (fs.existsSync(devPath)) return devPath;
    const resPath = path.join(this.binDir, 'AudioSwitcher.cs');
    if (fs.existsSync(resPath)) return resPath;
    return null;
  }

  async ensure(): Promise<ToolInfo | null> {
    if (this.cachedTool && fs.existsSync(this.cachedTool.path)) {
      return this.cachedTool;
    }

    if (fs.existsSync(this.nativeExePath)) {
      this.cachedTool = { path: this.nativeExePath, isNative: true };
      return this.cachedTool;
    }

    const csFile = this.sourceCsPath;
    if (csFile) {
      this.emitStatus('Kompiluję wbudowany moduł audio Windows…');
      const compiled = await this.compileNative(csFile);
      if (compiled && fs.existsSync(compiled)) {
        this.cachedTool = { path: compiled, isNative: true };
        this.emitStatus('Wbudowany moduł audio gotowy');
        return this.cachedTool;
      }
    }
    return null;
  }

  private async compileNative(csFilePath: string): Promise<string | null> {
    try {
      let cscExe: string | null = null;
      for (const p of CSC_PATHS) {
        if (fs.existsSync(p)) {
          cscExe = p;
          break;
        }
      }
      if (!cscExe) {
        // .NET Framework 4 csc.exe nie siedzi w PATH — czysty Windows bez
        // Frameworka po prostu nie skompiluje źródła, trzeba to zgłosić.
        this.emitStatus('Nie znaleziono kompilatora .NET (csc.exe) — moduł audio niedostępny');
        return null;
      }

      fs.mkdirSync(this.toolsDir, { recursive: true });
      const targetExe = path.join(this.toolsDir, 'AudioSwitcher.exe');
      const args = ['/nologo', '/optimize', `/out:${targetExe}`, csFilePath];
      const res = await this.run(cscExe, args);
      if (res.ok && fs.existsSync(targetExe)) {
        return targetExe;
      }
    } catch (err) {
      console.error('[audioBackend] compileNative error:', (err as Error).message);
    }
    return null;
  }

  /**
   * Zapewnia uruchomienie daemona audio (długożyjący proces stdin/stdout).
   */
  private async ensureDaemon(): Promise<ReturnType<typeof spawn> | null> {
    if (this.daemonProc && !this.daemonProc.killed && this.daemonProc.exitCode === null) {
      return this.daemonProc;
    }

    if (this.daemonStarting) {
      return this.daemonStarting;
    }

    this.daemonStarting = (async () => {
      const tool = await this.ensure();
      if (!tool || !tool.isNative) {
        return null;
      }

      try {
        const proc = spawn(tool.path, ['daemon'], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        if (!proc || !proc.stdout || !proc.stdin) {
          return null;
        }

        const rl = readline.createInterface({
          input: proc.stdout,
          crlfDelay: Infinity
        });

        const errRl = readline.createInterface({
          input: proc.stderr!,
          crlfDelay: Infinity
        });

        // Daemon odpowiada DOKŁADNIE jedną linijką JSON na komendę — sukcesy na
        // stdout, błędy na stderr. Obie ścieżki konsumują głowę kolejki, inaczej
        // odpowiedzi tracą parowanie z komendami (desync FIFO).
        const dequeue = (val: ExecResult): void => {
          if (this.daemonQueue.length === 0) return;
          const head = this.daemonQueue.shift();
          if (head && !head.timedOut) {
            head.resolve(val);
          }
        };

        // Czekamy na baner startowy {"ready":true,"version":"..."} zanim zaczniemy przyjmować komendy
        await new Promise<void>((resolveReady) => {
          let readyDone = false;
          const onLineInit = (line: string): void => {
            const trimmed = line.trim();
            if (trimmed.includes('"ready":true')) {
              if (!readyDone) {
                readyDone = true;
                rl.off('line', onLineInit);
                resolveReady();
              }
            }
          };
          rl.on('line', onLineInit);
          setTimeout(() => {
            if (!readyDone) {
              readyDone = true;
              rl.off('line', onLineInit);
              resolveReady();
            }
          }, 1500);
        });

        rl.on('line', (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (trimmed.includes('"ready":true')) {
            // Ignoruj powtórzony lub spóźniony baner powitalny daemona
            return;
          }
          dequeue({ ok: true, stdout: trimmed, stderr: '' });
        });

        errRl.on('line', (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          console.warn('[AudioSwitcher daemon stderr]:', trimmed);
          try {
            const parsed = JSON.parse(trimmed) as { ok?: boolean };
            if (parsed && parsed.ok === false) {
              dequeue({ ok: false, stdout: '', stderr: trimmed });
            }
          } catch {
            /* stderr bez JSON-a to zwykły log diagnostyczny daemona */
          }
        });

        proc.on('exit', (code, signal) => {
          this.daemonProc = null;
          this.daemonBusy = false;
          while (this.daemonQueue.length > 0) {
            const item = this.daemonQueue.shift();
            if (item) {
              item.resolve({ ok: false, stdout: '', stderr: `Daemon exited (code: ${code}, signal: ${signal})` });
            }
          }
          while (this.daemonCmdQueue.length > 0) {
            const item = this.daemonCmdQueue.shift();
            if (item) {
              item.resolve({ ok: false, stdout: '', stderr: `Daemon exited (code: ${code}, signal: ${signal})` });
            }
          }
        });

        proc.on('error', (err) => {
          console.error('[AudioSwitcher daemon error]:', err.message);
        });

        this.daemonProc = proc;
        return proc;
      } catch (err) {
        console.error('[AudioSwitcher daemon spawn error]:', (err as Error).message);
        return null;
      } finally {
        this.daemonStarting = null;
      }
    })();

    return this.daemonStarting;
  }

  /**
   * Wysyła komendę do rezydentnego daemona w zserializowanej kolejce.
   */
  private async sendDaemonCommand(cmd: string): Promise<ExecResult | null> {
    const proc = await this.ensureDaemon();
    if (!proc || !proc.stdin || proc.killed || proc.exitCode !== null) {
      return null;
    }

    return new Promise<ExecResult | null>((resolve) => {
      this.daemonCmdQueue.push({ cmd, resolve });
      void this.processDaemonQueue();
    });
  }

  private async processDaemonQueue(): Promise<void> {
    if (this.daemonBusy || this.daemonCmdQueue.length === 0) return;
    this.daemonBusy = true;

    const item = this.daemonCmdQueue.shift();
    if (!item) {
      this.daemonBusy = false;
      return;
    }

    const proc = this.daemonProc;
    if (!proc || !proc.stdin || proc.killed || proc.exitCode !== null) {
      item.resolve({ ok: false, stdout: '', stderr: 'Daemon not available' });
      this.daemonBusy = false;
      void this.processDaemonQueue();
      return;
    }

    try {
      const res = await new Promise<ExecResult>((resolveCmd) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          const idx = this.daemonQueue.findIndex((q) => q.resolve === wrappedResolve);
          if (idx !== -1) this.daemonQueue[idx].timedOut = true;
          resolveCmd({ ok: false, stdout: '', stderr: 'Daemon request timeout' });
        }, 2000);

        const wrappedResolve = (val: ExecResult): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolveCmd(val);
        };

        this.daemonQueue.push({ resolve: wrappedResolve });
        try {
          proc.stdin!.write(item.cmd + '\n');
        } catch (err) {
          wrappedResolve({ ok: false, stdout: '', stderr: (err as Error).message });
        }
      });

      item.resolve(res);
    } catch (err) {
      item.resolve({ ok: false, stdout: '', stderr: (err as Error).message });
    } finally {
      this.daemonBusy = false;
      if (this.daemonCmdQueue.length > 0) {
        void this.processDaemonQueue();
      }
    }
  }

  private run(exe: string, args: string[]): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        exe,
        args,
        { windowsHide: true, timeout: 5000 },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            stdout: (stdout || '').trim(),
            stderr: (stderr || '').trim()
          });
        }
      );
    });
  }

  async setDefault(deviceName: string): Promise<ExecResult> {
    if (!deviceName) {
      return { ok: false, stdout: '', stderr: 'Pusta nazwa urządzenia' };
    }

    if (this.currentDefaultDevice === deviceName) {
      appendLog('AUDIO-SET', `Domyślny mikrofon jest już aktywny: "${deviceName}" (pomijam redundantny switch)`);
      return { ok: true, stdout: '{"ok":true,"cached":true}', stderr: '' };
    }

    const t0 = Date.now();
    const idOrName = this.nameToIdMap.get(deviceName) || deviceName;

    let res = await this.sendDaemonCommand(`set ${idOrName}`);
    if (res && res.ok) {
      this.currentDefaultDevice = deviceName;
      this.devicesCache = null;
      const elapsed = Date.now() - t0;
      appendLog('AUDIO-SWITCH', `Aktywowano mikrofon: "${deviceName}" (${elapsed} ms) ✓`);
      return res;
    }

    const tool = await this.ensure();
    if (tool && tool.isNative) {
      res = await this.run(tool.path, ['set', idOrName]);
      if (res.ok) {
        this.currentDefaultDevice = deviceName;
        this.devicesCache = null;
        const elapsed = Date.now() - t0;
        appendLog('AUDIO-SWITCH', `Aktywowano mikrofon (CLI): "${deviceName}" (${elapsed} ms) ✓`);
        return res;
      }
    }

    appendLog('AUDIO-ERR', `Nie udało się aktywować mikrofonu: "${deviceName}"`);
    return res || { ok: false, stdout: '', stderr: 'Brak modułu audio' };
  }

  async setMute(target = '', mute = true): Promise<{ ok: boolean; isMuted?: boolean }> {
    const idOrName = this.nameToIdMap.get(target) || target;
    const cmd = mute ? `mute ${idOrName}` : `unmute ${idOrName}`;
    let res = await this.sendDaemonCommand(cmd.trim());
    if (res && res.ok) {
      appendLog('AUDIO-MUTE', `${mute ? 'WYCISZONO' : 'ODCISZONO'} mikrofon "${target || 'default'}" ✓`);
      return { ok: true, isMuted: mute };
    }

    const tool = await this.ensure();
    if (tool && tool.isNative) {
      res = await this.run(tool.path, [mute ? 'mute' : 'unmute', idOrName]);
      if (res && res.ok) {
        appendLog('AUDIO-MUTE', `${mute ? 'WYCISZONO' : 'ODCISZONO'} mikrofon (CLI) "${target || idOrName}" ✓`);
        return { ok: true, isMuted: mute };
      }
    }

    this.devicesCache = null;
    appendLog('AUDIO-ERR', `Błąd ustawiania mute=${mute} dla "${target || 'default'}"`);
    return res || { ok: false };
  }

  async setVolume(target = '', percent: number): Promise<{ ok: boolean; volume?: number }> {
    const vol = Math.max(0, Math.min(100, Math.round(percent)));
    const idOrName = this.nameToIdMap.get(target) || target;
    let res = await this.sendDaemonCommand(`set-volume ${vol} ${idOrName}`);
    if (res && res.ok) {
      appendLog('AUDIO-VOL', `Ustawiono głośność "${target || 'default'}" -> ${vol}% ✓`);
      return this.parseVolumeResponse(res);
    }

    const tool = await this.ensure();
    if (tool && tool.isNative) {
      res = await this.run(tool.path, ['set-volume', idOrName, String(vol)]);
      if (res && res.ok) return this.parseVolumeResponse(res);
    }

    return this.parseVolumeResponse(res);
  }

  async getVolume(target = ''): Promise<{ ok: boolean; volume?: number }> {
    const idOrName = this.nameToIdMap.get(target) || target;
    let res = await this.sendDaemonCommand(`get-volume ${idOrName}`.trim());
    if (res && res.ok) {
      const parsed = this.parseVolumeResponse(res);
      if (parsed.volume !== undefined) return parsed;
    }

    const tool = await this.ensure();
    if (tool && tool.isNative) {
      res = await this.run(tool.path, ['get-volume', idOrName]);
      if (res && res.ok) return this.parseVolumeResponse(res);
    }

    return this.parseVolumeResponse(res);
  }

  private parseVolumeResponse(res: ExecResult | null): { ok: boolean; volume?: number } {
    if (!res || !res.ok) return { ok: false };
    try {
      const parsed = JSON.parse(res.stdout) as { volume?: number };
      return { ok: true, volume: typeof parsed.volume === 'number' ? parsed.volume : undefined };
    } catch {
      return { ok: false };
    }
  }

  async getCurrentDefault(): Promise<{ name?: string; id?: string; isDefaultComm?: boolean } | null> {
    let res = await this.sendDaemonCommand('get');
    if (res && res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout);
        if (parsed && parsed.name) {
          this.currentDefaultDevice = parsed.name;
          return parsed;
        }
      } catch {}
    }

    const tool = await this.ensure();
    if (tool && tool.isNative) {
      res = await this.run(tool.path, ['get']);
      if (res.ok && res.stdout) {
        try {
          const parsed = JSON.parse(res.stdout);
          if (parsed && parsed.name) {
            this.currentDefaultDevice = parsed.name;
            return parsed;
          }
        } catch {}
      }
    }
    return null;
  }

  async sleepDisplay(): Promise<ExecResult | { ok: boolean }> {
    let res = await this.sendDaemonCommand('sleep-display');
    if (res && res.ok) return res;

    const tool = await this.ensure();
    if (tool && tool.isNative) {
      return this.run(tool.path, ['sleep-display']);
    }
    return { ok: false };
  }

  async wakeDisplay(): Promise<ExecResult | { ok: boolean }> {
    let res = await this.sendDaemonCommand('wake-display');
    if (res && res.ok) return res;

    const tool = await this.ensure();
    if (tool && tool.isNative) {
      return this.run(tool.path, ['wake-display']);
    }
    return { ok: false };
  }

  async listRecordingDevices(forceFresh = false): Promise<AudioDeviceItem[]> {
    const now = Date.now();
    if (!forceFresh && this.devicesCache && now - this.devicesCache.timestamp < 1000) {
      return this.devicesCache.list;
    }

    let res = await this.sendDaemonCommand('list');
    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        res = await this.run(tool.path, ['list']);
      }
    }

    if (res && res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout.trim()) as NativeDevice[];
        if (Array.isArray(parsed)) {
          const list: AudioDeviceItem[] = parsed
            .map((d) => {
              if (d.name && d.id) this.nameToIdMap.set(d.name, d.id);
              if (d.isDefault) this.currentDefaultDevice = d.name!;
              return {
                name: d.name!,
                isDefault: Boolean(d.isDefault),
                isDefaultComm: Boolean(d.isDefaultComm),
                isMuted: typeof d.isMuted === 'boolean' ? d.isMuted : undefined,
                volume: typeof d.volume === 'number' ? d.volume : undefined,
                volumeDb: typeof d.volumeDb === 'number' ? d.volumeDb : undefined,
                id: d.id
              };
            })
            .filter((d) => d.name);

          this.devicesCache = { list, timestamp: now };
          const sig = list.map((d) => `${d.name}:${d.isDefault ? '1' : '0'}:${d.isMuted ? 'M' : 'U'}`).join('|');
          if (sig !== this.lastEnumSig) {
            this.lastEnumSig = sig;
            appendLog('AUDIO-ENUM', `Lista mikrofonów (${list.length}): ${list.map((d) => `"${d.name}"${d.isDefault ? ' [DOMYŚLNY]' : ''}`).join(', ')}`);
          }
          return list;
        }
      } catch (err) {
        appendLog('AUDIO-ERR', `Błąd parsowania listy urządzeń: ${(err as Error).message}`);
        console.error('[audioBackend] parse error:', (err as Error).message);
      }
    }
    return [];
  }

  resolveNames(devices: AudioDeviceItem[]): { micDeskName: string; micHeadsetName: string } {
    const names = devices.map((d) => d.name);
    const noisy = /headset|headphone|słuchawk|microphone array|stereo mix|line in|what u hear|listen|monitor/i;
    const desk =
      names.find((n) => /quadcast|yet|blue\b|nano|rode|shure|hyperx|mic(rophone)?$/i.test(n)) ||
      names.find((n) => !noisy.test(n));
    const headset =
      names.find((n) => /headset|headphone|słuchawk/i.test(n)) ||
      names.find((n) => n !== desk && !/microphone array|stereo mix|line in|what u hear/i.test(n));
    return {
      micDeskName: desk || names[0] || '',
      micHeadsetName: headset || desk || names[0] || ''
    };
  }

  shutdown(): void {
    if (this.daemonProc) {
      try {
        if (this.daemonProc.stdin && !this.daemonProc.stdin.destroyed) {
          this.daemonProc.stdin.write('exit\n');
        }
      } catch {}
      try {
        this.daemonProc.kill();
      } catch {}
      this.daemonProc = null;
    }
  }

  async warmup(): Promise<void> {
    try {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        await this.sendDaemonCommand('ping');
        await this.listRecordingDevices(true);
      }
    } catch {
      /* warmup best-effort */
    }
  }
}
