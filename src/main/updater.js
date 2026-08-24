import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import https from 'node:https';

const GITHUB_REPO = 'Monratis/MicrophoneTool';
const DEFAULT_GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

function compareSemver(v1, v2) {
  const clean1 = (v1 || '').replace(/^v/i, '').trim();
  const clean2 = (v2 || '').replace(/^v/i, '').trim();

  const parts1 = clean1.split('.').map(Number);
  const parts2 = clean2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

export default class AppUpdater {
  constructor({ onEvent, config }) {
    this.onEvent = onEvent;
    this.config = config;
    this.currentVersion = app.getVersion();
    this.status = 'idle'; // 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
    this.updateInfo = null;
    this.downloadedFilePath = null;
  }

  emit(type, payload = {}) {
    if (this.onEvent) {
      this.onEvent({ type: `updater:${type}`, ...payload });
    }
  }

  getStatus() {
    return {
      status: this.status,
      currentVersion: this.currentVersion,
      updateInfo: this.updateInfo,
      downloadedFilePath: this.downloadedFilePath
    };
  }

  /**
   * Sprawdza dostępność nowej wersji na GitHub Releases (obsługuje repozytoria publiczne i prywatne).
   */
  async checkForUpdates() {
    this.status = 'checking';
    this.emit('status', this.getStatus());

    try {
      const release = await this._fetchLatestRelease();
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
        const isInstaller = app.isPackaged && !process.execPath.includes('win-unpacked');

        let targetAsset = assets.find((a) => a.name.toLowerCase().endsWith('.exe') && (
          isInstaller ? a.name.toLowerCase().includes('setup') : (a.name.toLowerCase().includes('portable') || !a.name.toLowerCase().includes('setup'))
        ));

        if (!targetAsset && assets.length > 0) {
          targetAsset = assets.find((a) => a.name.toLowerCase().endsWith('.exe') || a.name.toLowerCase().endsWith('.zip'));
        }

        this.updateInfo = {
          version: remoteTag,
          tag: release.tag_name,
          name: release.name || release.tag_name,
          notes: release.body || '',
          publishedAt: release.published_at,
          url: release.html_url,
          asset: targetAsset ? {
            id: targetAsset.id,
            name: targetAsset.name,
            size: targetAsset.size,
            apiUrl: targetAsset.url,
            downloadUrl: targetAsset.browser_download_url
          } : null
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
      console.error('[updater] check error:', err.message);
      this.status = 'error';
      this.emit('status', { ...this.getStatus(), error: err.message });
      return { available: false, error: err.message, currentVersion: this.currentVersion };
    }
  }

  async _fetchLatestRelease() {
    const repo = (this.config && this.config.get('githubRepo')) || GITHUB_REPO;
    const token = (this.config && this.config.get('githubToken')) || DEFAULT_GITHUB_TOKEN;
    const url = `https://api.github.com/repos/${repo}/releases/latest`;

    const headers = {
      'User-Agent': `AutoAudioSwitch/${this.currentVersion}`,
      'Accept': 'application/vnd.github.v3+json'
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

    return await res.json();
  }

  /**
   * Pobiera plik aktualizacji z raportowaniem postępu na żywo (działa dla publicznych i prywatnych repo).
   */
  async downloadUpdate() {
    if (!this.updateInfo || !this.updateInfo.asset) {
      throw new Error('Brak pliku aktualizacji do pobrania');
    }

    this.status = 'downloading';
    this.emit('status', this.getStatus());

    const asset = this.updateInfo.asset;
    const token = (this.config && this.config.get('githubToken')) || DEFAULT_GITHUB_TOKEN;
    const tempDir = path.join(os.tmpdir(), 'AutoAudioSwitch-Update');
    fs.mkdirSync(tempDir, { recursive: true });

    const targetFile = path.join(tempDir, asset.name);
    this.downloadedFilePath = targetFile;

    const fileStream = fs.createWriteStream(targetFile);

    return new Promise((resolve, reject) => {
      let downloadedBytes = 0;
      const totalBytes = asset.size || 0;
      let startTime = Date.now();

      // Dla prywatnych repo użyj API Asset URL z nagłówkiem application/octet-stream
      const isPrivate = Boolean(token && token.trim());
      const initialUrl = (isPrivate && asset.apiUrl) ? asset.apiUrl : asset.downloadUrl;

      const fetchWithRedirects = (currentUrl, isRedirect = false) => {
        const headers = {
          'User-Agent': `AutoAudioSwitch/${this.currentVersion}`
        };

        // Dołącz autoryzację tylko do domeny api.github.com (nigdy do AWS S3 po redirectzie)
        if (isPrivate && !isRedirect) {
          headers['Authorization'] = `Bearer ${token.trim()}`;
          headers['Accept'] = 'application/octet-stream';
        }

        const req = https.get(currentUrl, { headers }, (res) => {
          // Obsługa przekierowań (301, 302, 307) np. z GitHub API do AWS S3
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            fetchWithRedirects(res.headers.location, true);
            return;
          }

          if (res.statusCode !== 200) {
            fileStream.close();
            this.status = 'error';
            const errMsg = `Błąd pobierania HTTP ${res.statusCode}${res.statusCode === 401 || res.statusCode === 404 ? ' (sprawdź uprawnienia GitHub Token)' : ''}`;
            this.emit('status', { ...this.getStatus(), error: errMsg });
            reject(new Error(errMsg));
            return;
          }

          res.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            fileStream.write(chunk);

            const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
            const elapsedSec = (Date.now() - startTime) / 1000;
            const speedKB = elapsedSec > 0 ? Math.round((downloadedBytes / 1024) / elapsedSec) : 0;

            this.emit('progress', {
              percent,
              transferred: downloadedBytes,
              total: totalBytes,
              speed: `${speedKB} KB/s`
            });
          });

          res.on('end', () => {
            fileStream.end();
            this.status = 'downloaded';
            this.emit('status', this.getStatus());
            resolve({ ok: true, file: targetFile });
          });

          res.on('error', (err) => {
            fileStream.close();
            this.status = 'error';
            this.emit('status', { ...this.getStatus(), error: err.message });
            reject(err);
          });
        });

        req.on('error', (err) => {
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
  quitAndInstall() {
    if (!this.downloadedFilePath || !fs.existsSync(this.downloadedFilePath)) {
      throw new Error('Plik instalatora nie istnieje');
    }

    const installerPath = this.downloadedFilePath;
    const currentExe = process.execPath;

    if (installerPath.toLowerCase().endsWith('.exe')) {
      if (installerPath.toLowerCase().includes('setup')) {
        // Uruchomienie instalatora NSIS
        spawn(installerPath, ['/S'], {
          detached: true,
          stdio: 'ignore'
        }).unref();
      } else {
        // Aktualizacja wersji portable: skrypt wsadowy podmieniający .exe
        const batScript = path.join(os.tmpdir(), 'update_restart.bat');
        const batContent = `@echo off
timeout /t 1 /nobreak > nul
copy /y "${installerPath}" "${currentExe}"
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
