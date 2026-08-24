'use strict';

import { SerialPort } from 'serialport';
import { ESPLoader } from 'esptool-js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';

const DEFAULT_GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'Monratis/MicrophoneTool';

/**
 * Adapter SerialPort (Node.js) do interfejsu Transport (esptool-js).
 */
class NodeSerialTransport {
  constructor(port) {
    this.port = port;
    this.baudrate = port.baudRate || 115200;
    this.slipReaderEnabled = false;
    this._DTR_state = false;
    this._RTS_state = false;
    this.buffer = new Uint8Array(0);
    this._readResolvers = [];

    this.port.on('data', (chunk) => {
      const u8 = new Uint8Array(chunk);
      const combined = new Uint8Array(this.buffer.length + u8.length);
      combined.set(this.buffer);
      combined.set(u8, this.buffer.length);
      this.buffer = combined;

      while (this._readResolvers.length > 0 && this.buffer.length > 0) {
        const { resolve, minBytes } = this._readResolvers[0];
        if (this.buffer.length >= minBytes) {
          this._readResolvers.shift();
          const out = this.buffer.slice(0, minBytes);
          this.buffer = this.buffer.slice(minBytes);
          resolve(out);
        } else {
          break;
        }
      }
    });
  }

  getInfo() {
    return `NodeSerialPort ${this.port.path}`;
  }

  getPid() {
    return 0x1001; // XIAO ESP32-C6 USB-JTAG
  }

  async read(timeout = 3000, minBytes = 1) {
    if (this.buffer.length >= minBytes) {
      const out = this.buffer.slice(0, minBytes);
      this.buffer = this.buffer.slice(minBytes);
      return out;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this._readResolvers.findIndex((r) => r.resolve === resolve);
        if (idx >= 0) this._readResolvers.splice(idx, 1);
        if (this.buffer.length > 0) {
          const out = this.buffer;
          this.buffer = new Uint8Array(0);
          resolve(out);
        } else {
          resolve(new Uint8Array(0));
        }
      }, timeout);

      this._readResolvers.push({
        minBytes,
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        }
      });
    });
  }

  async write(data) {
    return new Promise((resolve, reject) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data);
      this.port.write(buf, (err) => {
        if (err) reject(err);
        else this.port.drain(() => resolve());
      });
    });
  }

  async setSignals(signals) {
    return new Promise((resolve) => {
      const options = {};
      if (typeof signals.dataTerminalReady !== 'undefined') {
        options.dtr = signals.dataTerminalReady;
        this._DTR_state = signals.dataTerminalReady;
      }
      if (typeof signals.requestToSend !== 'undefined') {
        options.rts = signals.requestToSend;
        this._RTS_state = signals.requestToSend;
      }
      this.port.set(options, () => resolve());
    });
  }

  async setBaudrate(baud) {
    return new Promise((resolve, reject) => {
      this.baudrate = baud;
      this.port.update({ baudRate: baud }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async disconnect() {
    return new Promise((resolve) => {
      if (this.port && this.port.isOpen) {
        this.port.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

export default class SensorFlasher {
  constructor({ config, radar, onEvent }) {
    this.config = config;
    this.radar = radar;
    this.onEvent = onEvent;
    this.isFlashing = false;
    this.cancelRequested = false;
  }

  emit(type, payload = {}) {
    if (this.onEvent) {
      this.onEvent({ type: `sensor:${type}`, ...payload });
    }
  }

  /**
   * Sprawdza dostępność skompilowanego firmware'u (.bin) na GitHubie.
   */
  async checkGitHubFirmware() {
    const repo = (this.config && this.config.get('githubRepo')) || GITHUB_REPO;
    const token = (this.config && this.config.get('githubToken')) || DEFAULT_GITHUB_TOKEN;
    const url = `https://api.github.com/repos/${repo}/releases/latest`;

    const headers = {
      'User-Agent': 'AutoAudioSwitch-SensorFlasher',
      'Accept': 'application/vnd.github.v3+json'
    };
    if (token && token.trim()) {
      headers['Authorization'] = `Bearer ${token.trim()}`;
    }

    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { available: false, error: `HTTP ${res.status}` };

      const release = await res.json();
      const assets = release.assets || [];

      // Szukaj pliku .bin firmware'u
      const binAsset = assets.find((a) => a.name.toLowerCase().endsWith('.bin'));

      if (!binAsset) {
        return {
          available: false,
          version: release.tag_name,
          message: 'Brak pliku .bin w najnowszym wydaniu GitHub'
        };
      }

      return {
        available: true,
        version: release.tag_name,
        name: binAsset.name,
        size: binAsset.size,
        downloadUrl: binAsset.browser_download_url,
        apiUrl: binAsset.url,
        releaseNotes: release.body || ''
      };
    } catch (err) {
      return { available: false, error: err.message };
    }
  }

  /**
   * Pobiera plik firmware .bin do folderu tymczasowego.
   */
  async downloadFirmware(asset) {
    const token = (this.config && this.config.get('githubToken')) || DEFAULT_GITHUB_TOKEN;
    const tempDir = path.join(os.tmpdir(), 'AutoAudioSwitch-Firmware');
    fs.mkdirSync(tempDir, { recursive: true });

    const targetFile = path.join(tempDir, asset.name);
    const fileStream = fs.createWriteStream(targetFile);

    const isPrivate = Boolean(token && token.trim());
    const initialUrl = isPrivate && asset.apiUrl ? asset.apiUrl : asset.downloadUrl;

    return new Promise((resolve, reject) => {
      const fetchWithRedirects = (curUrl, isRedirect = false) => {
        const headers = { 'User-Agent': 'AutoAudioSwitch-SensorFlasher' };
        if (isPrivate && !isRedirect) {
          headers['Authorization'] = `Bearer ${token.trim()}`;
          headers['Accept'] = 'application/octet-stream';
        }

        https.get(curUrl, { headers }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            fetchWithRedirects(res.headers.location, true);
            return;
          }
          if (res.statusCode !== 200) {
            fileStream.close();
            reject(new Error(`Błąd pobierania firmware HTTP ${res.statusCode}`));
            return;
          }

          let downloaded = 0;
          const total = asset.size || 0;

          res.on('data', (c) => {
            downloaded += c.length;
            if (total > 0) {
              this.emit('flash-progress', {
                stage: 'downloading',
                percent: Math.round((downloaded / total) * 100),
                message: `Pobieranie firmware: ${Math.round((downloaded / 1024))} kB / ${Math.round(total / 1024)} kB`
              });
            }
          });

          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            resolve(targetFile);
          });
        }).on('error', (err) => {
          fileStream.close();
          reject(err);
        });
      };

      fetchWithRedirects(initialUrl);
    });
  }

  /**
   * Wgrywa firmware .bin bezpośrednio do XIAO ESP32-C6 po kablu USB (Serial COM).
   */
  async flashFirmware(binPathOrBuffer, customPort = null) {
    if (this.isFlashing) throw new Error('Wgrywanie firmware jest już w toku');
    this.isFlashing = true;
    this.cancelRequested = false;

    let targetPort = customPort || (this.radar && this.radar.portName);
    if (!targetPort || targetPort === 'auto') {
      const list = await SerialPort.list();
      const espPort = list.find((p) => {
        const vid = (p.vendorId || '').toLowerCase();
        const pid = (p.productId || '').toLowerCase();
        const mfg = (p.manufacturer || '').toLowerCase();
        return vid === '303a' || vid === '2886' || mfg.includes('espressif') || mfg.includes('seeed');
      });
      if (espPort) targetPort = espPort.path;
      else if (list.length > 0) targetPort = list[0].path;
    }

    if (!targetPort) {
      this.isFlashing = false;
      throw new Error('Nie wykryto podłączonego sensora XIAO ESP32-C6 na żadnym porcie COM');
    }

    // 1. Zatrzymanie nasłuchu radaru (zwolnienie portu COM)
    this.emit('flash-progress', { stage: 'connecting', percent: 5, message: `Łączenie z ${targetPort}…` });
    if (this.radar) {
      await this.radar.stop();
      await new Promise((r) => setTimeout(r, 600));
    }

    let serialPort = null;

    try {
      // 2. Otwarcie portu na 115200 baud
      serialPort = new SerialPort({
        path: targetPort,
        baudRate: 115200,
        autoOpen: false
      });

      await new Promise((resolve, reject) => {
        serialPort.open((err) => (err ? reject(err) : resolve()));
      });

      const transport = new NodeSerialTransport(serialPort);

      // 3. Inicjalizacja ESPLoader
      const terminal = {
        clean: () => {},
        writeLine: (data) => console.log(`[esptool] ${data}`),
        write: (data) => process.stdout.write(String(data))
      };

      const loader = new ESPLoader({
        transport,
        baudrate: 115200,
        terminal,
        romBaudrate: 115200,
        enableFlashSizes: true
      });

      this.emit('flash-progress', { stage: 'syncing', percent: 15, message: 'Synchronizacja z bootloaderem ESP32-C6…' });
      const chipName = await loader.main();
      console.log(`[esptool] Wykryto układ: ${chipName}`);

      // 4. Załadowanie zawartości pliku binarnego
      let binBuffer;
      if (Buffer.isBuffer(binPathOrBuffer)) {
        binBuffer = binPathOrBuffer;
      } else {
        binBuffer = fs.readFileSync(binPathOrBuffer);
      }

      // 5. Konwersja na ciąg binarny dla esptool-js
      let binString = '';
      for (let i = 0; i < binBuffer.length; i++) {
        binString += String.fromCharCode(binBuffer[i]);
      }

      this.emit('flash-progress', { stage: 'erasing', percent: 25, message: 'Przygotowywanie pamięci flash…' });

      // 6. Zapisywanie pamięci Flash z raportowaniem postępu na żywo
      const flashOptions = {
        fileArray: [{ data: binString, address: 0x0 }],
        flashSize: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex, written, total) => {
          const pct = Math.round(25 + (written / total) * 70);
          this.emit('flash-progress', {
            stage: 'flashing',
            percent: Math.min(95, pct),
            message: `Zapisywanie pamięci Flash: ${Math.round((written / total) * 100)}% (${Math.round(written / 1024)} kB)`
          });
        },
        calculateMD5Hash: (image) => ''
      };

      await loader.writeFlash(flashOptions);

      // 7. Restart ESP32-C6
      this.emit('flash-progress', { stage: 'rebooting', percent: 98, message: 'Restartowanie układu ESP32-C6…' });
      await loader.hardReset();
      await transport.disconnect();

      this.emit('flash-progress', { stage: 'done', percent: 100, message: 'Firmware wgrany pomyślnie! ✓' });
      this.emit('flash-complete', { ok: true, port: targetPort });

      return { ok: true, port: targetPort };
    } catch (err) {
      console.error('[esptool] Błąd podczas wgrywania firmware:', err);
      this.emit('flash-progress', { stage: 'error', percent: 0, message: `Błąd wgrywania: ${err.message}` });
      throw err;
    } finally {
      this.isFlashing = false;
      // Wznów nasłuch radaru
      if (this.radar) {
        setTimeout(async () => {
          try {
            await this.radar.start();
          } catch (_) {}
        }, 1200);
      }
    }
  }
}
