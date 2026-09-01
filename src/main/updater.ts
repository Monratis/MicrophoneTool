import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import https from 'node:https';
import type Config from './config';
import type { UpdateInfo, UpdaterStatus } from '../shared/types';

const GITHUB_REPO = 'Monratis/MicrophoneTool';

function compareSemver(v1: string, v2: string): number {
  const clean1 = (v1 || '').replace(/^v/i, '').split('-')[0].trim();
  const clean2 = (v2 || '').replace(/^v/i, '').split('-')[0].trim();

  const parts1 = clean1.split('.').map((p) => parseInt(p, 10) || 0);
  const parts2 = clean2.split('.').map((p) => parseInt(p, 10) || 0);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

interface GitHubReleaseAsset {
  id: number;
  name: string;
  size: number;
  url: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  assets?: GitHubReleaseAsset[];
}

export default class AppUpdater {
  private readonly onEvent: ((ev: { type: string; [key: string]: unknown }) => void) | null;
  private readonly config: Config;

  currentVersion: string;
  status: UpdaterStatus['status'] = 'idle';
  updateInfo: UpdateInfo | null = null;
  downloadedFilePath: string | null = null;

  constructor({ onEvent, config }: { onEvent?: (ev: { type: string; [key: string]: unknown }) => void; config: Config }) {
    this.onEvent = onEvent ?? null;
    this.config = config;
    this.currentVersion = app.getVersion();
  }

  emit(type: string, payload: Record<string, unknown> | object = {}): void {
    if (this.onEvent) {
      this.onEvent({ type: `updater:${type}`, ...(payload as Record<string, unknown>) });
    }
  }

  getStatus(): UpdaterStatus {
    return {
      status: this.status,
      currentVersion: this.currentVersion,
      updateInfo: this.updateInfo,
      downloadedFilePath: this.downloadedFilePath
    };
  }

  /**
   * Sprawdza dostępność nowej wersji na GitHub Releases.
   * Deduplikacja: nakładające się wywołania (tray + timer + przycisk)
   * dzielą jeden request zamiast wyścigu o stan.
   */
  async checkForUpdates(): Promise<{ available: boolean; updateInfo?: UpdateInfo; currentVersion: string; remoteVersion?: string; error?: string }> {
    if (!this.checkInflight) {
      this.checkInflight = this.doCheckForUpdates().finally(() => {
        this.checkInflight = null;
      });
    }
    return this.checkInflight;
  }

  private checkInflight: Promise<{ available: boolean; updateInfo?: UpdateInfo; currentVersion: string; remoteVersion?: string; error?: string }> | null = null;

  private async doCheckForUpdates(): Promise<{ available: boolean; updateInfo?: UpdateInfo; currentVersion: string; remoteVersion?: string; error?: string }> {
    this.status = 'checking';
    this.emit('status', this.getStatus());

    try {
      const release = await this.fetchLatestRelease();
      if (!release || !release.tag_name) {
        this.status = 'not-available';
        this.emit('status', this.getStatus());
        return { available: false, currentVersion: this.currentVersion };
      }

      const remoteTag = release.tag_name.replace(/^v/i, '');
      const isNewer = compareSemver(remoteTag, this.currentVersion) > 0;

      if (isNewer) {
        // Dopasuj odpowiedni asset (installer / portable / zip)
        const assets = release.assets || [];
        // Portable EXE w Windows (NSIS) ustawia zmienną PORTABLE_EXECUTABLE_FILE
        const execLower = (process.env.PORTABLE_EXECUTABLE_FILE || process.execPath).toLowerCase();
        const isInstaller =
          app.isPackaged && !execLower.includes('portable') && !execLower.includes('win-unpacked');

        let targetAsset = assets.find(
          (a) =>
            a.name.toLowerCase().endsWith('.exe') &&
            (isInstaller
              ? a.name.toLowerCase().includes('setup')
              : a.name.toLowerCase().includes('portable') || !a.name.toLowerCase().includes('setup'))
        );

        if (!targetAsset && assets.length > 0) {
          targetAsset = assets.find(
            (a) => a.name.toLowerCase().endsWith('.exe') || a.name.toLowerCase().endsWith('.zip')
          );
        }

        this.updateInfo = {
          version: remoteTag,
          tag: release.tag_name,
          name: release.name || release.tag_name,
          notes: release.body || '',
          publishedAt: release.published_at || '',
          url: release.html_url || '',
          asset: targetAsset
            ? {
                id: targetAsset.id,
                name: targetAsset.name,
                size: targetAsset.size,
                apiUrl: targetAsset.url,
                downloadUrl: targetAsset.browser_download_url
              }
            : null
        };

        this.status = 'available';
        this.emit('status', this.getStatus());
        return { available: true, updateInfo: this.updateInfo, currentVersion: this.currentVersion };
      } else {
        this.status = 'not-available';
        this.emit('status', this.getStatus());
        return { available: false, currentVersion: this.currentVersion, remoteVersion: remoteTag };
      }
    } catch (err) {
      console.error('[updater] check error:', (err as Error).message);
      this.status = 'error';
      this.emit('status', { ...this.getStatus(), error: (err as Error).message });
      return { available: false, error: (err as Error).message, currentVersion: this.currentVersion };
    }
  }

  private async fetchLatestRelease(): Promise<GitHubRelease | null> {
    const repo = (this.config && this.config.get('githubRepo')) || GITHUB_REPO;
    const token = this.config.get('githubToken');
    const url = `https://api.github.com/repos/${repo}/releases/latest`;

    const headers: Record<string, string> = {
      'User-Agent': `DeskSense/${this.currentVersion}`,
      Accept: 'application/vnd.github.v3+json'
    };
    if (token && token.trim()) {
      headers['Authorization'] = `Bearer ${token.trim()}`;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000)
    });

    if (res.status === 404) {
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GitHub API HTTP ${res.status}: Wymagany poprawny token PAT do prywatnego repozytorium`);
    }
    if (!res.ok) {
      throw new Error(`GitHub API HTTP ${res.status}`);
    }

    return (await res.json()) as GitHubRelease;
  }

  /**
   * Pobiera plik aktualizacji z raportowaniem postępu na żywo.
   */
  async downloadUpdate(): Promise<{ ok: boolean; file: string }> {
    if (!this.updateInfo || !this.updateInfo.asset) {
      throw new Error('Brak pliku aktualizacji do pobrania');
    }
    // Dwa równoległe pobrania pisałyby do tego samego pliku jednocześnie.
    if (this.status === 'downloading') {
      throw new Error('Pobieranie aktualizacji już trwa');
    }

    this.status = 'downloading';
    this.emit('status', this.getStatus());

    const asset = this.updateInfo.asset;
    const token = this.config.get('githubToken');
    const tempDir = path.join(os.tmpdir(), 'DeskSense-Update');
    fs.mkdirSync(tempDir, { recursive: true });

    const targetFile = path.join(tempDir, asset.name);
    this.downloadedFilePath = targetFile;

    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(targetFile);
      // Bez tego dysk pełny / zablokowany przez AV = nieobsłużony 'error'
      // na strumieniu = crash całego procesu Electrona.
      fileStream.on('error', (err: Error) => {
        this.status = 'error';
        this.emit('status', { ...this.getStatus(), error: err.message });
        reject(err);
      });
      let downloadedBytes = 0;
      const totalBytes = asset.size || 0;
      const startTime = Date.now();
      let failed = false;

      // Dla prywatnych repo użyj API Asset URL z nagłówkiem application/octet-stream
      const isPrivate = Boolean(token && token.trim());
      const initialUrl =
        isPrivate && asset.apiUrl ? asset.apiUrl : asset.downloadUrl!;

      const fetchWithRedirects = (currentUrl: string, isRedirect = false, depth = 0): void => {
        if (depth > 5) {
          fileStream.close();
          this.status = 'error';
          const errMsg = 'Zbyt wiele przekierowań podczas pobierania aktualizacji';
          this.emit('status', { ...this.getStatus(), error: errMsg });
          reject(new Error(errMsg));
          return;
        }

        const headers: Record<string, string> = {
          'User-Agent': `DeskSense/${this.currentVersion}`
        };

        // Autoryzacja tylko do api.github.com (nigdy do S3 po redirectzie)
        if (isPrivate && !isRedirect) {
          headers['Authorization'] = `Bearer ${(token || '').trim()}`;
          headers['Accept'] = 'application/octet-stream';
        }

        const req = https.get(currentUrl, { headers }, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.destroy();
            fetchWithRedirects(res.headers.location, true, depth + 1);
            return;
          }

          if (res.statusCode !== 200) {
            fileStream.close();
            this.status = 'error';
            const errMsg = `Błąd pobierania HTTP ${res.statusCode}${
              res.statusCode === 401 || res.statusCode === 404 ? ' (sprawdź uprawnienia GitHub Token)' : ''
            }`;
            this.emit('status', { ...this.getStatus(), error: errMsg });
            reject(new Error(errMsg));
            return;
          }

          res.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            // Backpressure: bez pauzy przy pełnym buforze write() całe ~100 MB
            // ląduje w pamięci procesu przy wolnym dysku.
            if (!fileStream.write(chunk)) {
              res.pause();
              fileStream.once('drain', () => res.resume());
            }

            const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
            const elapsedSec = (Date.now() - startTime) / 1000;
            const speedKB = elapsedSec > 0 ? Math.round(downloadedBytes / 1024 / elapsedSec) : 0;

            this.emit('progress', {
              percent,
              transferred: downloadedBytes,
              total: totalBytes,
              speed: `${speedKB} KB/s`
            });
          });

          res.on('error', (err: Error) => {
            failed = true;
            fileStream.destroy();
            this.status = 'error';
            this.emit('status', { ...this.getStatus(), error: err.message });
            reject(err);
          });

          // Rozwiązuj dopiero gdy plik jest w pełni spłukany na dysk
          // ('end' oznacza koniec odczytu z sieci, nie zapisu do pliku).
          res.on('end', () => {
            fileStream.end();
          });
          fileStream.on('finish', () => {
            if (failed) return;
            if (downloadedBytes === 0 || (totalBytes > 0 && downloadedBytes < totalBytes)) {
              this.status = 'error';
              const errMsg = `Pobieranie niekompletne (${downloadedBytes} z ${totalBytes} bajtów)`;
              this.emit('status', { ...this.getStatus(), error: errMsg });
              try {
                fs.unlinkSync(targetFile);
              } catch {}
              reject(new Error(errMsg));
              return;
            }
            this.status = 'downloaded';
            this.emit('status', this.getStatus());
            resolve({ ok: true, file: targetFile });
          });
        });

        req.on('error', (err: Error) => {
          failed = true;
          fileStream.close();
          this.status = 'error';
          this.emit('status', { ...this.getStatus(), error: err.message });
          reject(err);
        });
      };

      fetchWithRedirects(initialUrl);
    });
  }

  /**
   * Instaluje pobraną aktualizację i restartuje aplikację.
   */
  quitAndInstall(): void {
    if (!this.downloadedFilePath || !fs.existsSync(this.downloadedFilePath)) {
      throw new Error('Plik instalatora nie istnieje');
    }
    // Bez tego guard da się zainstalować PLIK CZĘŚCIOWY po nieudanym
    // pobieraniu (plik istnieje, ale jest obcięty).
    if (this.status !== 'downloaded') {
      throw new Error('Aktualizacja nie została w pełni pobrana');
    }

    const installerPath = this.downloadedFilePath;
    const currentExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

    if (installerPath.toLowerCase().endsWith('.exe')) {
      if (installerPath.toLowerCase().includes('setup')) {
        // Uruchomienie instalatora NSIS dopiero PO wyjściu aplikacji —
        // start przed quit() koliduje z zablokowanymi plikami EXE.
        const delayedRun = [
          '@echo off',
          'timeout /t 2 /nobreak > nul',
          `start "" "${installerPath}" /S`,
          'del "%~f0"'
        ].join('\r\n');
        const runScript = path.join(os.tmpdir(), 'desksense_update_run_installer.bat');
        fs.writeFileSync(runScript, delayedRun, 'utf8');
        spawn('cmd.exe', ['/c', runScript], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        }).unref();
      } else {
        // Aktualizacja wersji portable: skrypt wsadowy podmieniający .exe.
        // EXE potrafi być zablokowany dłużej niż sekundę — ponawiamy kopię zanim odpalimy nową binarkę.
        const batScript = path.join(os.tmpdir(), 'desksense_update_restart.bat');
        const batContent = `@echo off
timeout /t 2 /nobreak > nul
copy /y "${installerPath}" "${currentExe}" > nul 2>&1
if errorlevel 1 (
  timeout /t 3 /nobreak > nul
  copy /y "${installerPath}" "${currentExe}" > nul 2>&1
)
start "" "${currentExe}"
del "%~f0"
`;
        fs.writeFileSync(batScript, batContent, 'utf8');
        spawn('cmd.exe', ['/c', batScript], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        }).unref();
      }

      app.quit();
    }
  }
}
