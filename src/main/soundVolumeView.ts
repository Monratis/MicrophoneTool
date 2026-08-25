import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import type Config from './config';
import type { AudioDeviceItem } from '../shared/types';

const DOWNLOAD_URL = 'https://www.nirsoft.net/utils/soundvolumeview-x64.zip';
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
}

interface CachedDevices {
  list: AudioDeviceItem[];
  timestamp: number;
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
  }
  return rows;
}

/**
 * Moduł kontrolera audio Windows (Zero-Latency Resident Daemon & Direct COM).
 */
export default class SoundVolumeView {
  private readonly binDir: string;
  private readonly toolsDir: string;
  private readonly config: Config;
  private statusCb: ((msg: string) => void) | null = null;
  private cachedTool: ToolInfo | null = null;
  private devicesCache: CachedDevices | null = null;
  private readonly nameToIdMap = new Map<string, string>();
  private currentDefaultDevice: string | null = null;

  private daemonProc: ReturnType<typeof spawn> | null = null;
  private daemonRl: readline.Interface | null = null;
  private daemonErrRl: readline.Interface | null = null;
  private readonly daemonQueue: DaemonQueueItem[] = [];
  private daemonStarting: Promise<ReturnType<typeof spawn> | null> | null = null;

  constructor({ binDir, toolsDir, config }: { binDir: string; toolsDir: string; config: Config }) {
    this.binDir = binDir;
    this.toolsDir = toolsDir;
    this.config = config;
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

  private get svvExePath(): string {
    return path.join(this.binDir, 'SoundVolumeView.exe');
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

    const nativeCandidates = [this.nativeExePath, path.join(this.toolsDir, 'AudioSwitcher.exe')];
    for (const c of nativeCandidates) {
      if (fs.existsSync(c)) {
        this.cachedTool = { path: c, isNative: true };
        return this.cachedTool;
      }
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

    const svvCandidates = [this.svvExePath, path.join(this.toolsDir, 'SoundVolumeView.exe')];
    for (const c of svvCandidates) {
      if (fs.existsSync(c)) {
        this.cachedTool = { path: c, isNative: false };
        return this.cachedTool;
      }
    }

    if (this.config && this.config.get('autoDownloadTools')) {
      this.emitStatus('Pobieram SoundVolumeView z nirsoft.net…');
      try {
        const out = await this.downloadSvv();
        this.cachedTool = { path: out, isNative: false };
        this.emitStatus('Narzędzie audio gotowe');
        return this.cachedTool;
      } catch (err) {
        console.error('[audioBackend] download fallback failed:', (err as Error).message);
        this.emitStatus('Brak modułu audio — sprawdź konfigurację');
        return null;
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
      if (!cscExe) cscExe = 'csc.exe';

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

  private async downloadSvv(): Promise<string> {
    fs.mkdirSync(this.toolsDir, { recursive: true });
    const res = await fetch(DOWNLOAD_URL, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => /soundvolumeview\.exe$/i.test(e.entryName));
    if (!entry) throw new Error('Brak SoundVolumeView.exe w archiwum');
    const out = path.join(this.toolsDir, 'SoundVolumeView.exe');
    fs.writeFileSync(out, entry.getData());
    return out;
  }

  // ---------- Zero-Latency Resident Daemon Manager ----------

  private async ensureDaemon(): Promise<ReturnType<typeof spawn> | null> {
    if (this.daemonProc && !this.daemonProc.killed) {
      return this.daemonProc;
    }

    if (this.daemonStarting) {
      return this.daemonStarting;
    }

    this.daemonStarting = (async () => {
      const tool = await this.ensure();
      if (!tool || !tool.isNative) return null;

      try {
        const proc = spawn(tool.path, ['daemon'], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        const rl = readline.createInterface({ input: proc.stdout!, terminal: false });

        rl.on('line', (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;

          if (trimmed.includes('"ready":true')) return;

          if (this.daemonQueue.length > 0) {
            const item = this.daemonQueue.shift();
            item?.resolve({ ok: true, stdout: trimmed, stderr: '' });
          }
        });

        // AudioSwitcher.cs pisze błędy na Console.Error — bez konsumenta stderr
        // odpowiedź {"ok":false} nigdy nie trafia do kolejki (5 s timeout na
        // każdą nieudaną komendę), a bufor potoku może się zapełnić.
        const errRl = readline.createInterface({ input: proc.stderr!, terminal: false });
        errRl.on('line', (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          console.warn('[audioBackend] daemon stderr:', trimmed);
          if (trimmed.startsWith('{') && this.daemonQueue.length > 0) {
            const item = this.daemonQueue.shift();
            item?.resolve({ ok: false, stdout: '', stderr: trimmed });
          }
        });

        proc.on('error', (err: Error) => {
          console.warn('[audioBackend] daemon process error:', err.message);
          this.killDaemon();
        });

        proc.on('exit', () => {
          this.killDaemon();
        });

        this.daemonProc = proc;
        this.daemonRl = rl;
        this.daemonErrRl = errRl;
        return proc;
      } catch (err) {
        console.error('[audioBackend] daemon start failed:', (err as Error).message);
        return null;
      } finally {
        this.daemonStarting = null;
      }
    })();

    return this.daemonStarting;
  }

  private killDaemon(): void {
    if (this.daemonProc) {
      try {
        this.daemonProc.stdin?.write('exit\n');
        this.daemonProc.kill();
      } catch {
        /* ignore */
      }
      this.daemonProc = null;
    }
    if (this.daemonRl) {
      this.daemonRl.close();
      this.daemonRl = null;
    }
    if (this.daemonErrRl) {
      this.daemonErrRl.close();
      this.daemonErrRl = null;
    }
    while (this.daemonQueue.length > 0) {
      const item = this.daemonQueue.shift();
      item?.resolve({ ok: false, stdout: '', stderr: 'Daemon exited' });
    }
  }

  /** Publiczne zamknięcie daemona (przy wyjściu z aplikacji). */
  shutdown(): void {
    this.killDaemon();
  }

  /**
   * Wygrzanie przy starcie: kompilacja/pobranie toola + spawn daemon
   * + ping. Bez tego pierwsze przełączenie mikrofonu płaci cold-start
   * (~200-300 ms na spawn procesu).
   */
  async warmup(): Promise<void> {
    try {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        await this.sendDaemonCommand('ping');
      }
    } catch {
      /* warmup best-effort */
    }
  }

  private async sendDaemonCommand(cmd: string): Promise<ExecResult | null> {
    const daemon = await this.ensureDaemon();
    if (!daemon) return null;

    return new Promise<ExecResult>((resolve) => {
      const timeout = setTimeout(() => {
        const idx = this.daemonQueue.findIndex((item) => item.resolve === wrappedResolve);
        if (idx >= 0) this.daemonQueue.splice(idx, 1);
        resolve({ ok: false, stdout: '', stderr: 'Daemon timeout' });
      }, 5000);

      const wrappedResolve = (val: ExecResult): void => {
        clearTimeout(timeout);
        resolve(val);
      };

      this.daemonQueue.push({ resolve: wrappedResolve });

      try {
        daemon.stdin!.write(cmd + '\n');
      } catch (err) {
        clearTimeout(timeout);
        this.killDaemon();
        resolve({ ok: false, stdout: '', stderr: (err as Error).message });
      }
    });
  }

  private run(exe: string, args: string[]): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        exe,
        args,
        { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '' });
        }
      );
    });
  }

  async setDefault(deviceName: string): Promise<ExecResult> {
    if (!deviceName) return { ok: false, stdout: '', stderr: 'Brak nazwy urządzenia' };

    if (this.currentDefaultDevice === deviceName) {
      return { ok: true, stdout: '{"ok":true,"cached":true}', stderr: '' };
    }

    const target = this.nameToIdMap.get(deviceName) || deviceName;

    let res = await this.sendDaemonCommand(`set ${target}`);

    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (!tool) return { ok: false, stdout: '', stderr: 'Brak modułu audio' };

      if (tool.isNative) {
        res = await this.run(tool.path, ['set', target]);
      } else {
        res = await this.run(tool.path, ['/SetDefault', deviceName, 'all']);
      }
    }

    if (res && res.ok) {
      this.currentDefaultDevice = deviceName;
      this.devicesCache = null;
      console.log(`[audio] Default recording device -> "${deviceName}" (<1ms)`);
    } else {
      console.error(`[audio] SetDefault failed for "${deviceName}":`, res?.stderr || res?.stdout);
    }

    return res || { ok: false, stdout: '', stderr: 'Błąd wykonania' };
  }

  async toggleMute(target = ''): Promise<{ ok: boolean; isMuted?: boolean }> {
    const idOrName = this.nameToIdMap.get(target) || target;
    let res = await this.sendDaemonCommand(`toggle-mute ${idOrName}`.trim());
    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        res = await this.run(tool.path, ['toggle-mute', idOrName]);
      }
    }
    if (res && res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout);
        this.devicesCache = null;
        return parsed;
      } catch {
        /* ignore */
      }
    }
    return res || { ok: false };
  }

  async setMute(target = '', mute = true): Promise<{ ok: boolean; isMuted?: boolean }> {
    const idOrName = this.nameToIdMap.get(target) || target;
    const cmd = mute ? `mute ${idOrName}` : `unmute ${idOrName}`;
    let res = await this.sendDaemonCommand(cmd.trim());
    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        res = await this.run(tool.path, [mute ? 'mute' : 'unmute', idOrName]);
      }
    }
    this.devicesCache = null;
    return res || { ok: false };
  }

  /** Ustawia głośność endpointu (0-100). Daemon: IAudioEndpointVolume scalar. */
  async setVolume(target = '', percent: number): Promise<{ ok: boolean; volume?: number }> {
    const vol = Math.max(0, Math.min(100, Math.round(percent)));
    const idOrName = this.nameToIdMap.get(target) || target;
    // Procent PIERWSZY w formacie daemonowym — nazwy urządzeń potrafią
    // kończyć się cyfrą, co łamało parsowanie "ostatni token".
    let res = await this.sendDaemonCommand(`set-volume ${vol} ${idOrName}`);
    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        res = await this.run(tool.path, ['set-volume', idOrName, String(vol)]);
      }
    }
    return this.parseVolumeResponse(res);
  }

  async getVolume(target = ''): Promise<{ ok: boolean; volume?: number }> {
    const idOrName = this.nameToIdMap.get(target) || target;
    let res = await this.sendDaemonCommand(`get-volume ${idOrName}`.trim());
    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        res = await this.run(tool.path, ['get-volume', idOrName]);
      }
    }
    return this.parseVolumeResponse(res);
  }

  private parseVolumeResponse(res: ExecResult | null): { ok: boolean; volume?: number } {
    if (!res || !res.ok) return { ok: false };
    try {
      const parsed = JSON.parse(res.stdout) as { volume?: number };
      return { ok: true, volume: typeof parsed.volume === 'number' ? parsed.volume : undefined };
    } catch {
      return { ok: true };
    }
  }

  /** Aktualny domyślny mikrofon Windows (null gdy brak urządzeń). */
  async getCurrentDefault(): Promise<{ name?: string; id?: string; isDefaultComm?: boolean } | null> {
    let res = await this.sendDaemonCommand('get');
    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        res = await this.run(tool.path, ['get']);
      }
    }
    if (!res || !res.ok || !res.stdout) return null;
    try {
      const parsed = JSON.parse(res.stdout.trim()) as { name?: string; id?: string; isDefaultComm?: boolean } | null;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async sleepDisplay(): Promise<ExecResult | { ok: boolean }> {
    let res = await this.sendDaemonCommand('sleep-display');
    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        res = await this.run(tool.path, ['sleep-display']);
      }
    }
    return res || { ok: false };
  }

  async wakeDisplay(): Promise<ExecResult | { ok: boolean }> {
    let res = await this.sendDaemonCommand('wake-display');
    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (tool && tool.isNative) {
        res = await this.run(tool.path, ['wake-display']);
      }
    }
    return res || { ok: false };
  }

  async listRecordingDevices(forceFresh = false): Promise<AudioDeviceItem[]> {
    const now = Date.now();
    if (!forceFresh && this.devicesCache && now - this.devicesCache.timestamp < 3000) {
      return this.devicesCache.list;
    }

    let res = await this.sendDaemonCommand('list');

    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (!tool) return [];
      if (tool.isNative) {
        res = await this.run(tool.path, ['list']);
      }
    }

    interface NativeDevice {
      name?: string;
      id?: string;
      isDefault?: boolean | number;
      isMuted?: boolean;
      volume?: number;
    }
    if (res && res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout.trim()) as NativeDevice[];
        if (Array.isArray(parsed)) {
          const list = parsed
            .map((d) => {
              if (d.name && d.id) {
                this.nameToIdMap.set(d.name, d.id);
              }
              if (d.isDefault) {
                this.currentDefaultDevice = d.name!;
              }
              return {
                name: d.name!,
                isDefault: Boolean(d.isDefault),
                // Daemon zwraca isMuted — renderer inicjalizuje z niego
                // stan pill "Wyciszony/Aktywny".
                isMuted: typeof d.isMuted === 'boolean' ? d.isMuted : undefined,
                // Daemon wysyła volume już jako procent (0-100)
                volume: typeof d.volume === 'number' ? d.volume : undefined,
                id: d.id
              };
            })
            .filter((d) => d.name);

          this.devicesCache = { list, timestamp: now };
          return list;
        }
      } catch (err) {
        console.error('[audioBackend] parse error:', (err as Error).message);
      }
    }

    // Fallback dla SVV CSV
    const tool = await this.ensure();
    if (!tool || tool.isNative) return [];

    const tmp = path.join(os.tmpdir(), `svv-${Date.now()}-${process.pid}.csv`);
    try {
      const csvRes = await this.run(tool.path, ['/scomma', tmp]);
      if (!csvRes.ok || !fs.existsSync(tmp)) return [];
      const raw = fs.readFileSync(tmp);
      let text: string;
      try {
        text = iconv.decode(raw, 'cp1250');
      } catch {
        text = raw.toString('latin1');
      }
      const rows = parseCsv(text);
      if (rows.length < 2) return [];
      const h = rows[0];
      const iName = h.indexOf('Name');
      const iType = h.indexOf('Type');
      const iDefault = h.indexOf('Default');
      const recs: AudioDeviceItem[] = [];
      for (const r of rows.slice(1)) {
        const type = (iType >= 0 ? r[iType] : '').trim().toLowerCase();
        if (type === 'recording') {
          recs.push({
            name: (iName >= 0 ? r[iName] : '').trim(),
            isDefault: iDefault >= 0 && (r[iDefault] || '').trim() !== ''
          });
        }
      }
      const list = recs.filter((d) => d.name);
      this.devicesCache = { list, timestamp: now };
      return list;
    } catch (err) {
      console.error('[audioBackend] svv error:', (err as Error).message);
      return [];
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
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
}
