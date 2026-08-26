import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import AdmZip from 'adm-zip';
import iconv from 'iconv-lite';
import { appendLog } from './logger';
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

interface SubunitInfo {
  cmdName: string;
  itemId: string;
  volume?: number;
  isMuted?: boolean;
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
  private readonly subunitMap = new Map<string, SubunitInfo>();
  private subunitMapTimestamp = 0;
  private currentDefaultDevice: string | null = null;
  private lastEnumSig = '';

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

  async ensureSvv(): Promise<string | null> {
    const svvCandidates = [this.svvExePath, path.join(this.toolsDir, 'SoundVolumeView.exe')];
    for (const c of svvCandidates) {
      if (fs.existsSync(c)) return c;
    }
    if (this.config && this.config.get('autoDownloadTools')) {
      try {
        const out = await this.downloadSvv();
        if (fs.existsSync(out)) return out;
      } catch (err) {
        console.error('[audioBackend] SVV download failed:', (err as Error).message);
      }
    }
    return null;
  }

  /**
   * Szybka synchronizacja drzewa podwęzłów Kernel Streaming (Subunits) z SoundVolumeView.
   * Umożliwia sprzętową regulację głośności/wyciszenia urządzeń bez IAudioEndpointVolume.
   */
  async refreshSubunits(forceFresh = false): Promise<void> {
    const now = Date.now();
    if (!forceFresh && this.subunitMap.size > 0 && now - this.subunitMapTimestamp < 10000) {
      return;
    }
    const svvExe = await this.ensureSvv();
    if (!svvExe) return;

    const tmp = path.join(os.tmpdir(), `svv-subunits-${now}-${process.pid}.csv`);
    try {
      const csvRes = await this.run(svvExe, ['/scomma', tmp]);
      if (!csvRes.ok || !fs.existsSync(tmp)) return;
      const raw = fs.readFileSync(tmp);
      let text: string;
      try {
        text = iconv.decode(raw, 'cp1250');
      } catch {
        text = raw.toString('latin1');
      }
      const rows = parseCsv(text);
      if (rows.length < 2) return;
      const h = rows[0];
      const iType = h.indexOf('Type');
      const iDirection = h.indexOf('Direction');
      const iDevName = h.indexOf('Device Name');
      const iMuted = h.indexOf('Muted');
      const iVolPct = h.indexOf('Volume Percent');
      const iItemId = h.indexOf('Item ID');
      const iCmdName = h.indexOf('Command-Line Friendly ID');

      this.subunitMap.clear();
      this.subunitMapTimestamp = now;

      for (const r of rows.slice(1)) {
        const type = (iType >= 0 ? r[iType] : '').trim().toLowerCase();
        const direction = (iDirection >= 0 ? r[iDirection] : '').trim().toLowerCase();
        if (type !== 'subunit' || direction !== 'capture') continue;

        const devName = (iDevName >= 0 ? r[iDevName] : '').trim();
        const cmdName = (iCmdName >= 0 ? r[iCmdName] : '').trim();
        const itemId = (iItemId >= 0 ? r[iItemId] : '').trim();
        const mutedStr = (iMuted >= 0 ? r[iMuted] : '').trim().toLowerCase();
        const volStr = (iVolPct >= 0 ? r[iVolPct] : '').trim().replace('%', '');

        const isMuted = mutedStr === 'yes' ? true : mutedStr === 'no' ? false : undefined;
        const volNum = parseFloat(volStr);
        const volume = !isNaN(volNum) ? Math.round(volNum) : undefined;

        const info: SubunitInfo = {
          cmdName: cmdName || itemId,
          itemId,
          volume,
          isMuted
        };

        if (devName) {
          this.subunitMap.set(devName.toLowerCase(), info);
          this.subunitMap.set(`mikrofon (${devName})`.toLowerCase(), info);
          this.subunitMap.set(`microphone (${devName})`.toLowerCase(), info);
        }
        if (cmdName) {
          this.subunitMap.set(cmdName.toLowerCase(), info);
        }
        if (itemId) {
          this.subunitMap.set(itemId.toLowerCase(), info);
        }
      }
    } catch (err) {
      console.error('[audioBackend] refreshSubunits error:', (err as Error).message);
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  private async resolveSubunitTarget(target: string): Promise<string | null> {
    if (!target) return null;
    const directTarget = target.trim();
    const idMapped = this.nameToIdMap.get(directTarget) || directTarget;

    await this.refreshSubunits();

    const lookup = (key: string): string | null => {
      const k = key.toLowerCase().trim();
      const direct = this.subunitMap.get(k);
      if (direct) return direct.cmdName;

      for (const [mapKey, info] of this.subunitMap.entries()) {
        if (k.includes(mapKey) || mapKey.includes(k)) {
          return info.cmdName;
        }
      }
      return null;
    };

    let resolved = lookup(directTarget) || lookup(idMapped);
    if (resolved) return resolved;

    const stripped = directTarget
      .replace(/^mikrofon\s*\((.+)\)$/i, '$1')
      .replace(/^microphone\s*\((.+)\)$/i, '$1')
      .trim();

    resolved = lookup(stripped);
    if (resolved) return resolved;

    const candidates = [
      `${stripped}\\Subunit\\Przechwyt.`,
      `${stripped}\\Subunit\\Capture`,
      `${stripped}\\Subunit\\Mikrofon`,
      `${stripped}\\Subunit\\Microphone`,
      `${directTarget}\\Subunit\\Przechwyt.`,
      `${directTarget}\\Subunit\\Capture`
    ];
    return candidates[0];
  }

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
          // E_NOINTERFACE jest oczekiwanym stanem dla urządzeń wirtualnych/chat —
          // jest płynnie obsługiwany przez fallback KS Subunit bez błędu.
          if (!trimmed.includes('E_NOINTERFACE')) {
            console.warn('[audioBackend] daemon stderr:', trimmed);
          }
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
      appendLog('AUDIO-SET', `Domyślny mikrofon jest już aktywny: "${deviceName}" (pomijam redundantny switch)`);
      return { ok: true, stdout: '{"ok":true,"cached":true}', stderr: '' };
    }

    const target = this.nameToIdMap.get(deviceName) || deviceName;
    appendLog('AUDIO-SET', `Żądanie zmiany domyślnego mikrofonu Windows -> "${deviceName}" [target: ${target}]`);

    let res = await this.sendDaemonCommand(`set ${target}`);

    if (!res || !res.ok) {
      const tool = await this.ensure();
      if (!tool) {
        appendLog('AUDIO-ERR', `Brak modułu audio do przełączenia na "${deviceName}"`);
        return { ok: false, stdout: '', stderr: 'Brak modułu audio' };
      }

      if (tool.isNative) {
        res = await this.run(tool.path, ['set', target]);
      } else {
        res = await this.run(tool.path, ['/SetDefault', deviceName, 'all']);
      }
    }

    if (res && res.ok) {
      this.currentDefaultDevice = deviceName;
      this.devicesCache = null;
      appendLog('AUDIO-SET', `SUKCES: Domyślny mikrofon Windows zmieniony na "${deviceName}" ✓`);
      console.log(`[audio] Default recording device -> "${deviceName}" (<1ms)`);
    } else {
      appendLog('AUDIO-ERR', `BŁĄD przełączania na "${deviceName}": ${res?.stderr || res?.stdout || 'Nieznany błąd'}`);
      console.error(`[audio] SetDefault failed for "${deviceName}":`, res?.stderr || res?.stdout);
    }

    return res || { ok: false, stdout: '', stderr: 'Błąd wykonania' };
  }

  async toggleMute(target = ''): Promise<{ ok: boolean; isMuted?: boolean }> {
    const idOrName = this.nameToIdMap.get(target) || target;
    let res = await this.sendDaemonCommand(`toggle-mute ${idOrName}`.trim());
    if (res && res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout);
        this.devicesCache = null;
        appendLog('AUDIO-MUTE', `Toggle mute "${target || 'default'}": ${parsed.isMuted ? 'WYCISZONY' : 'ODCISZONY'} ✓`);
        return parsed;
      } catch {
        /* ignore */
      }
    }

    // Fallback 1: Kernel Streaming Subunit (SoundVolumeView) dla urządzeń z E_NOINTERFACE (np. BlackShark Chat)
    const svvExe = await this.ensureSvv();
    if (svvExe) {
      const subunitTarget = await this.resolveSubunitTarget(target || idOrName);
      if (subunitTarget) {
        const svvRes = await this.run(svvExe, ['/Switch', subunitTarget]);
        if (svvRes.ok) {
          this.devicesCache = null;
          await this.refreshSubunits(true);
          const entry = this.subunitMap.get((target || idOrName).toLowerCase());
          appendLog('AUDIO-MUTE', `Toggle mute (KS Subunit) "${target || idOrName}": ${entry?.isMuted ? 'WYCISZONY' : 'ODCISZONY'} ✓`);
          console.log(`[audio] Hardware toggle mute via KS Subunit -> ${entry?.isMuted ? 'MUTED' : 'UNMUTED'} (${subunitTarget})`);
          return { ok: true, isMuted: entry?.isMuted };
        }
      }
    }

    // Fallback 2: Standalone CLI
    const tool = await this.ensure();
    if (tool && tool.isNative) {
      res = await this.run(tool.path, ['toggle-mute', idOrName]);
      if (res && res.ok && res.stdout) {
        try {
          const parsed = JSON.parse(res.stdout);
          appendLog('AUDIO-MUTE', `Toggle mute (CLI) "${target || idOrName}": ${parsed.isMuted ? 'WYCISZONY' : 'ODCISZONY'} ✓`);
          return parsed;
        } catch {
          /* ignore */
        }
      }
    }

    appendLog('AUDIO-ERR', `Błąd toggle mute dla "${target || 'default'}"`);
    return res || { ok: false };
  }

  async setMute(target = '', mute = true): Promise<{ ok: boolean; isMuted?: boolean }> {
    const idOrName = this.nameToIdMap.get(target) || target;
    const cmd = mute ? `mute ${idOrName}` : `unmute ${idOrName}`;
    let res = await this.sendDaemonCommand(cmd.trim());
    if (res && res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout);
        this.devicesCache = null;
        appendLog('AUDIO-MUTE', `${mute ? 'WYCISZONO' : 'ODCISZONO'} mikrofon "${target || 'default'}" ✓`);
        return parsed;
      } catch {
        appendLog('AUDIO-MUTE', `${mute ? 'WYCISZONO' : 'ODCISZONO'} mikrofon "${target || 'default'}" ✓`);
        return { ok: true, isMuted: mute };
      }
    }

    // Fallback 1: Kernel Streaming Subunit (SoundVolumeView) dla urządzeń z E_NOINTERFACE
    const svvExe = await this.ensureSvv();
    if (svvExe) {
      const subunitTarget = await this.resolveSubunitTarget(target || idOrName);
      if (subunitTarget) {
        const svvRes = await this.run(svvExe, [mute ? '/Mute' : '/Unmute', subunitTarget]);
        if (svvRes.ok) {
          this.devicesCache = null;
          const entry = this.subunitMap.get((target || idOrName).toLowerCase());
          if (entry) entry.isMuted = mute;
          appendLog('AUDIO-MUTE', `${mute ? 'WYCISZONO' : 'ODCISZONO'} mikrofon (KS Subunit) "${target || idOrName}" ✓`);
          console.log(`[audio] Hardware mute via KS Subunit -> ${mute ? 'MUTED' : 'UNMUTED'} (${subunitTarget})`);
          return { ok: true, isMuted: mute };
        }
      }
    }

    // Fallback 2: Standalone CLI
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

  /** Ustawia głośność endpointu (0-100). Daemon: IAudioEndpointVolume scalar. */
  async setVolume(target = '', percent: number): Promise<{ ok: boolean; volume?: number }> {
    const vol = Math.max(0, Math.min(100, Math.round(percent)));
    const idOrName = this.nameToIdMap.get(target) || target;
    // Procent PIERWSZY w formacie daemonowym — nazwy urządzeń potrafią
    // kończyć się cyfrą, co łamało parsowanie "ostatni token".
    let res = await this.sendDaemonCommand(`set-volume ${vol} ${idOrName}`);
    if (res && res.ok) {
      appendLog('AUDIO-VOL', `Ustawiono głośność "${target || 'default'}" -> ${vol}% ✓`);
      return this.parseVolumeResponse(res);
    }

    // Fallback 1: Kernel Streaming Subunit (SoundVolumeView) dla urządzeń z E_NOINTERFACE
    const svvExe = await this.ensureSvv();
    if (svvExe) {
      const subunitTarget = await this.resolveSubunitTarget(target || idOrName);
      if (subunitTarget) {
        const svvRes = await this.run(svvExe, ['/SetVolume', subunitTarget, String(vol)]);
        if (svvRes.ok) {
          this.devicesCache = null;
          const entry = this.subunitMap.get((target || idOrName).toLowerCase());
          if (entry) entry.volume = vol;
          console.log(`[audio] Hardware volume via KS Subunit -> ${vol}% (${subunitTarget})`);
          return { ok: true, volume: vol };
        }
      }
    }

    // Fallback 2: Standalone CLI
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

    // Fallback 1: Kernel Streaming Subunit (SoundVolumeView)
    await this.refreshSubunits();
    const entry = this.subunitMap.get((target || idOrName).toLowerCase());
    if (entry && typeof entry.volume === 'number') {
      return { ok: true, volume: entry.volume };
    }

    // Fallback 2: Standalone CLI
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
      isDefaultComm?: boolean | number;
      isMuted?: boolean;
      volume?: number;
    }
    if (res && res.ok && res.stdout) {
      try {
        const parsed = JSON.parse(res.stdout.trim()) as NativeDevice[];
        if (Array.isArray(parsed)) {
          const list: AudioDeviceItem[] = parsed
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
                isDefaultComm: Boolean(d.isDefaultComm),
                // Daemon zwraca isMuted — renderer inicjalizuje z niego stan pill
                isMuted: typeof d.isMuted === 'boolean' ? d.isMuted : undefined,
                // Daemon wysyła volume już jako procent (0-100)
                volume: typeof d.volume === 'number' ? d.volume : undefined,
                id: d.id
              };
            })
            .filter((d) => d.name);

          // Wzbogać listę o odczyt z podwęzłów (SVV) dla urządzeń bez IAudioEndpointVolume
          try {
            await this.refreshSubunits();
            for (const item of list) {
              const entry =
                this.subunitMap.get(item.name.toLowerCase()) ||
                (item.id ? this.subunitMap.get(item.id.toLowerCase()) : null);
              if (entry) {
                if (typeof entry.volume === 'number' && (item.volume === undefined || item.volume === 100)) {
                  item.volume = entry.volume;
                }
                if (typeof entry.isMuted === 'boolean' && item.isMuted === undefined) {
                  item.isMuted = entry.isMuted;
                }
              }
            }
          } catch {
            /* ignore enrichment failure */
          }

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
