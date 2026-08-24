import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import https from 'node:https';

const GITHUB_REPO = 'Monratis/MicrophoneTool';

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
    this._downloadAbort = null;
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
   * Sprawdza dostępność nowej wersji na GitHub Releases.
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
            name: targetAsset.name,
            size: targetAsset.size,
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
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': `AutoAudioSwitch/${this.currentVersion}`,
        'Accept': 'application/vnd.github.v3+json'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GitHub API HTTP ${res.status}`);
    }

    return await res.json();
  }

  /**
   * Pobiera plik aktualizacji z raportowaniem postępu na żywo.
   */
  async downloadUpdate() {
    if (!this.updateInfo || !this.updateInfo.asset || !this.updateInfo.asset.downloadUrl) {
      throw new Error('Brak pliku aktualizacji do pobrania');
    }

    this.status = 'downloading';
    this.emit('status', this.getStatus());

    const asset = this.updateInfo.asset;
    const tempDir = path.join(os.tmpdir(), 'AutoAudioSwitch-Update');
    fs.mkdirSync(tempDir, { recursive: true });

    const targetFile = path.join(tempDir, asset.name);
    this.downloadedFilePath = targetFile;

    const fileStream = fs.createWriteStream(targetFile);

    return new Promise((resolve, reject) => {
      let downloadedBytes = 0;
      const totalBytes = asset.size || 0;
      let startTime = Date.now();

      const downloadUrl = asset.downloadUrl;

      const fetchWithRedirects = (currentUrl) => {
        const req = https.get(currentUrl, {
          headers: {
            'User-Agent': `AutoAudioSwitch/${this.currentVersion}`
          }
        }, (res) => {
          // Obsługa przekierowań (301, 302, 307)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            fetchWithRedirects(res.headers.location);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
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

      fetchWithRedirects(downloadUrl);
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
