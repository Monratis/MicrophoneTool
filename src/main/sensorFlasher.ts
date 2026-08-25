import { SerialPort } from 'serialport';
import { ESPLoader } from 'esptool-js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import type RadarListener from './radarListener';
import type Config from './config';

const GITHUB_REPO = 'Monratis/MicrophoneTool';

interface GitHubAsset {
  name: string;
  size: number;
  url: string;
  browser_download_url: string;
}

interface FirmwareCheck {
  available: boolean;
  version?: string;
  name?: string;
  size?: number;
  downloadUrl?: string;
  apiUrl?: string;
  releaseNotes?: string;
  error?: string;
  message?: string;
}

/**
 * Adapter SerialPort (Node.js) do interfejsu Transport (esptool-js).
 */
class NodeSerialTransport {
  private readonly port: SerialPort;
  baudrate: number;
  slipReaderEnabled = false;
  dtrState = false;
  rtsState = false;
  private buffer = new Uint8Array(0);
  private readResolvers: Array<{ minBytes: number; resolve: (data: Uint8Array) => void }> = [];

  constructor(port: SerialPort) {
    this.port = port;
    this.baudrate = port.baudRate || 115200;

    port.on('data', (chunk: Buffer) => {
      const u8 = new Uint8Array(chunk);
      const combined = new Uint8Array(this.buffer.length + u8.length);
      combined.set(this.buffer);
      combined.set(u8, this.buffer.length);
      this.buffer = combined;

      while (this.readResolvers.length > 0 && this.buffer.length > 0) {
        const entry = this.readResolvers[0];
        if (this.buffer.length >= entry.minBytes) {
          this.readResolvers.shift();
          const out = this.buffer.slice(0, entry.minBytes);
          this.buffer = this.buffer.slice(entry.minBytes);
          entry.resolve(out);
        } else {
          break;
        }
      }
    });
  }

  getInfo(): string {
    return `NodeSerialPort ${this.port.path}`;
  }

  getPid(): number {
    return 0x1001;
  }

  async read(timeout = 3000, minBytes = 1): Promise<Uint8Array> {
    if (this.buffer.length >= minBytes) {
      const out = this.buffer.slice(0, minBytes);
      this.buffer = this.buffer.slice(minBytes);
      return out;
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.readResolvers.findIndex((r) => r.resolve === wrappedResolve);
        if (idx >= 0) this.readResolvers.splice(idx, 1);
        if (this.buffer.length > 0) {
          const out = this.buffer;
          this.buffer = new Uint8Array(0);
          resolve(out);
        } else {
          resolve(new Uint8Array(0));
        }
      }, timeout);

      const wrappedResolve = (data: Uint8Array): void => {
        clearTimeout(timer);
        resolve(data);
      };

      this.readResolvers.push({ minBytes, resolve: wrappedResolve });
    });
  }

  async write(data: Buffer | Uint8Array | number[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as Uint8Array);
      this.port.write(buf, (err) => {
        if (err) reject(err);
        else this.port.drain(() => resolve());
      });
    });
  }

  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    return new Promise((resolve) => {
      const options: Record<string, boolean> = {};
      if (typeof signals.dataTerminalReady !== 'undefined') {
        options.dtr = signals.dataTerminalReady;
        this.dtrState = signals.dataTerminalReady;
      }
      if (typeof signals.requestToSend !== 'undefined') {
        options.rts = signals.requestToSend;
        this.rtsState = signals.requestToSend;
      }
      this.port.set(options, () => resolve());
    });
  }

  async setBaudrate(baud: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.baudrate = baud;
      this.port.update({ baudRate: baud }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
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
  private readonly config: Config;
  private readonly radar: RadarListener | null;
  private readonly onEvent: ((ev: { type: string; [key: string]: unknown }) => void) | null;

  isFlashing = false;
  cancelRequested = false;

  constructor({
    config,
    radar,
    onEvent
  }: {
    config: Config;
    radar: RadarListener;
    onEvent: (ev: { type: string; [key: string]: unknown }) => void;
  }) {
    this.config = config;
    this.radar = radar ?? null;
    this.onEvent = onEvent ?? null;
  }

  emit(type: string, payload: Record<string, unknown> = {}): void {
    if (this.onEvent) {
      this.onEvent({ type: `sensor:${type}`, ...payload });
    }
  }

  async checkGitHubFirmware(): Promise<FirmwareCheck> {
    const repo = (this.config && this.config.get('githubRepo')) || GITHUB_REPO;
    const token = this.config.get('githubToken');
    const url = `https://api.github.com/repos/${repo}/releases/latest`;

    const headers: Record<string, string> = {
      'User-Agent': 'AutoAudioSwitch-SensorFlasher',
      Accept: 'application/vnd.github.v3+json'
    };
    if (token && token.trim()) {
      headers['Authorization'] = `Bearer ${token.trim()}`;
    }

    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { available: false, error: `HTTP ${res.status}` };

      const release = (await res.json()) as { tag_name?: string; body?: string; assets?: GitHubAsset[] };
      const assets = release.assets || [];

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
      return { available: false, error: (err as Error).message };
    }
  }

  async downloadFirmware(asset: { name: string; size?: number; apiUrl?: string; downloadUrl?: string }): Promise<string> {
    const token = this.config.get('githubToken');
    const tempDir = path.join(os.tmpdir(), 'AutoAudioSwitch-Firmware');
    fs.mkdirSync(tempDir, { recursive: true });

    const targetFile = path.join(tempDir, asset.name);
    const fileStream = fs.createWriteStream(targetFile);

    const isPrivate = Boolean(token && token.trim());
    const initialUrl =
      isPrivate && asset.apiUrl ? asset.apiUrl : (asset.downloadUrl as string);

    return new Promise((resolve, reject) => {
      const fetchWithRedirects = (curUrl: string, isRedirect = false): void => {
        const headers: Record<string, string> = { 'User-Agent': 'AutoAudioSwitch-SensorFlasher' };
        if (isPrivate && !isRedirect) {
          headers['Authorization'] = `Bearer ${(token || '').trim()}`;
          headers['Accept'] = 'application/octet-stream';
        }

        https
          .get(curUrl, { headers }, (res) => {
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
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

            res.on('data', (c: Buffer) => {
              downloaded += c.length;
              if (total > 0) {
                this.emit('flash-progress', {
                  stage: 'downloading',
                  percent: Math.round((downloaded / total) * 100),
                  message: `Pobieranie firmware: ${Math.round(downloaded / 1024)} kB / ${Math.round(total / 1024)} kB`
                });
              }
            });

            res.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve(targetFile);
            });
          })
          .on('error', (err: Error) => {
            fileStream.close();
            reject(err);
          });
      };

      fetchWithRedirects(initialUrl);
    });
  }

  async flashFirmware(binPathOrBuffer: string | Buffer, customPort: string | null = null): Promise<{ ok: boolean; port: string }> {
    if (this.isFlashing) throw new Error('Wgrywanie firmware jest już w toku');
    this.isFlashing = true;
    this.cancelRequested = false;

    let targetPort: string | null = customPort || null;
    if (!targetPort) {
      const list = await SerialPort.list();
      const espPort = list.find((p) => {
        const vid = (p.vendorId || '').toLowerCase();
        const pid = (p.productId || '').toLowerCase();
        const mfg = (p.manufacturer || '').toLowerCase();
        return vid === '303a' || vid === '2886' || pid === '1001' || mfg.includes('espressif') || mfg.includes('seeed');
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
      await new Promise<void>((r) => setTimeout(r, 600));
    }

    let serialPort: SerialPort | null = null;

    try {
      // 2. Otwarcie portu na 115200 baud
      serialPort = new SerialPort({
        path: targetPort,
        baudRate: 115200,
        autoOpen: false
      });

      await new Promise<void>((resolve, reject) => {
        serialPort!.open((err) => (err ? reject(err) : resolve()));
      });

      const transport = new NodeSerialTransport(serialPort);

      // 3. Inicjalizacja ESPLoader
      const terminal = {
        clean: (): void => {},
        writeLine: (data: string): void => {
          console.log(`[esptool] ${data}`);
        },
        write: (data: string | Uint8Array): void => {
          process.stdout.write(String(data));
        }
      };

      const loader = new ESPLoader({
        transport: transport as never,
        baudrate: 115200,
        terminal: terminal as never,
        romBaudrate: 115200,
        enableFlashSizes: true
      } as never);

      this.emit('flash-progress', { stage: 'syncing', percent: 15, message: 'Synchronizacja z bootloaderem ESP32-C6…' });
      const chipName = await loader.main();
      console.log(`[esptool] Wykryto układ: ${chipName}`);

      // 4. Załadowanie zawartości pliku binarnego
      const binBuffer = typeof binPathOrBuffer === 'string' ? fs.readFileSync(binPathOrBuffer) : binPathOrBuffer;

      // 5. Konwersja na ciąg binarny dla esptool-js
      let binString = '';
      for (let i = 0; i < binBuffer.length; i++) {
        binString += String.fromCharCode(binBuffer[i]);
      }

      this.emit('flash-progress', { stage: 'erasing', percent: 25, message: 'Przygotowywanie pamięci flash…' });

      // 6. Zapisywanie pamięci Flash z raportowaniem postępu na żywo
      await loader.writeFlash({
        fileArray: [{ data: binString, address: 0x0 }],
        flashSize: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (_fileIndex: number, written: number, total: number) => {
          const pct = Math.round(25 + (written / total) * 70);
          this.emit('flash-progress', {
            stage: 'flashing',
            percent: Math.min(95, pct),
            message: `Zapisywanie pamięci Flash: ${Math.round((written / total) * 100)}% (${Math.round(written / 1024)} kB)`
          });
        },
        calculateMD5Hash: () => ''
      } as never);

      // 7. Restart ESP32-C6
      this.emit('flash-progress', { stage: 'rebooting', percent: 98, message: 'Restartowanie układu ESP32-C6…' });
      await (loader as unknown as { hardReset(): Promise<void> }).hardReset();
      await transport.disconnect();

      this.emit('flash-progress', { stage: 'done', percent: 100, message: 'Firmware wgrany pomyślnie! ✓' });
      this.emit('flash-complete', { ok: true, port: targetPort });

      return { ok: true, port: targetPort };
    } catch (err) {
      console.error('[esptool] Błąd podczas wgrywania firmware:', err);
      this.emit('flash-progress', { stage: 'error', percent: 0, message: `Błąd wgrywania: ${(err as Error).message}` });
      throw err;
    } finally {
      this.isFlashing = false;
      // Wznów nasłuch radaru
      const radar = this.radar;
      if (radar) {
        setTimeout(() => {
          void radar.start().catch(() => {});
        }, 1200);
      }
    }
  }
}
