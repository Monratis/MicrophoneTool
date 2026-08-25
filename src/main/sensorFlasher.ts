import { SerialPort } from 'serialport';
import { ESPLoader } from 'esptool-js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { createHash } from 'node:crypto';
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
 * Implementuje PEŁNĄ powierzchnię wymaganą przez ESPLoader 0.6.x:
 * connect / disconnect / readLoop / flushInput / peek / read / write /
 * setBaudrate / setSignals / setDTR / setRTS / getPid / getInfo /
 * hexify / hexConvert / trace.
 */
class NodeSerialTransport {
  private readonly port: SerialPort;
  baudrate: number;
  slipReaderEnabled = false;
  dtrState = false;
  rtsState = false;
  tracing = false;
  private readonly detectedPid?: number;
  private buffer = new Uint8Array(0);
  private readResolvers: Array<{ minBytes: number; resolve: (data: Uint8Array) => void }> = [];

  constructor(port: SerialPort, detectedPid?: number) {
    this.port = port;
    this.baudrate = port.baudRate || 115200;
    // Realny PID pozwala esptool dobrać właściwą strategię resetu
    // (USB-JTAG-Serial dla PID 0x1001, klasyczny DTR/RTS dla mostków UART).
    this.detectedPid = detectedPid;

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

  /** esptool woła przed każdą próbą połączenia; port otwieramy sami wcześniej. */
  async connect(baudrate?: number): Promise<void> {
    const target = typeof baudrate === 'number' && baudrate > 0 ? baudrate : this.baudrate;
    this.baudrate = target;
    if (this.port.isOpen && this.port.baudRate !== target) {
      await this.setBaudrate(target);
    }
    this.flushInput();
  }

  getInfo(): string {
    return `NodeSerialPort ${this.port.path}`;
  }

  getPid(): number {
    return this.detectedPid ?? 0x1001;
  }

  /** Dane napływają przez event 'data' — brak potrzeby aktywnego pollingu. */
  readLoop(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Czyści bufor wejściowy. Mirror zachowania webserial: NIE rozwiązuje
   * oczekujących odczytów pustą ramką — pusta ramka mogłaby zostać
   * zinterpretowana przez esptool jako odpowiedź urządzenia. Oczekujące
   * read() wygasają własnym timeoutem i sięgają po świeże dane.
   */
  flushInput(): void {
    this.buffer = new Uint8Array(0);
  }

  /** Podgląd bufora bez konsumpcji (mirror zachowania webserial Transport). */
  peek(): Uint8Array {
    return this.buffer;
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

  // Strategie resetu esptool (ClassicReset / HardReset / UsbJtagSerialReset)
  // wołają wprost setDTR / setRTS.
  async setDTR(val: boolean): Promise<void> {
    await this.setSignals({ dataTerminalReady: val });
  }

  async setRTS(val: boolean): Promise<void> {
    await this.setSignals({ requestToSend: val });
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

  hexify(u8: Uint8Array): string {
    return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  hexConvert(u8: Uint8Array): string {
    return this.hexify(u8);
  }

  trace(_message: string): void {
    /* tracing wyłączony w produkcji */
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

      // Priorytet: pliki wskazujące na ESP32-C6 / merged image; dopiero potem
      // pierwszy lepszy .bin — redukuje ryzyko pobrania obrazu dla innego sprzętu.
      const binAsset =
        assets.find((a) => a.name.toLowerCase().endsWith('.bin') && /c6|merged|factory/i.test(a.name)) ||
        assets.find((a) => a.name.toLowerCase().endsWith('.bin'));

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
    const tempDir = path.join(os.tmpdir(), 'DeskSense-Firmware');
    fs.mkdirSync(tempDir, { recursive: true });

    const targetFile = path.join(tempDir, asset.name);

    const isPrivate = Boolean(token && token.trim());
    const initialUrl =
      isPrivate && asset.apiUrl ? asset.apiUrl : (asset.downloadUrl as string);

    return new Promise((resolve, reject) => {
      const fileStream = fs.createWriteStream(targetFile);
      // Nieobsłużony 'error' na WriteStream (dysk pełny, AV) = crash procesu.
      fileStream.on('error', (err: Error) => reject(err));
      const fetchWithRedirects = (curUrl: string, isRedirect = false, depth = 0): void => {
        if (depth > 5) {
          fileStream.close();
          reject(new Error('Zbyt wiele przekierowań podczas pobierania firmware'));
          return;
        }
        const headers: Record<string, string> = { 'User-Agent': 'DeskSense-SensorFlasher' };
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
              res.destroy();
              fetchWithRedirects(res.headers.location, true, depth + 1);
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
              if (total > 0 && downloaded > total) {
                fileStream.destroy();
                reject(new Error('Pobrany plik jest większy niż deklarowany — możliwa manipulacja lub błąd serwera'));
                return;
              }
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
              // Weryfikacja kompletności pobrania względem metadanych GitHub
              if (total > 0 && downloaded !== total) {
                fs.rmSync(targetFile, { force: true });
                reject(
                  new Error(`Pobieranie niekompletne: ${downloaded} z ${total} bajtów. Spróbuj ponownie.`)
                );
                return;
              }
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

  async flashFirmware(
    binPathOrBuffer: string | Buffer,
    customPort: string | null = null,
    opts: { eraseAll?: boolean } = {}
  ): Promise<{ ok: boolean; port: string }> {
    if (this.isFlashing) throw new Error('Wgrywanie firmware jest już w toku');
    this.isFlashing = true;
    this.cancelRequested = false;

    // Wczytaj i ZWALIDUJ plik PRZED jakimkolwiek kontaktem z urządzeniem.
    // Nigdy nie dopuszczamy do wgrania śmieci w pamięć flash sensora.
    const binBuffer = typeof binPathOrBuffer === 'string' ? fs.readFileSync(binPathOrBuffer) : binPathOrBuffer;
    this.validateFirmwareImage(binBuffer);

    const eraseAll = Boolean(opts.eraseAll);

    let targetPort: string | null = customPort || null;
    let detectedPid: number | undefined;
    if (!targetPort) {
      const list = await SerialPort.list();
      const espPort = list.find((p) => {
        const vid = (p.vendorId || '').toLowerCase();
        const pid = (p.productId || '').toLowerCase();
        const mfg = (p.manufacturer || '').toLowerCase();
        return vid === '303a' || vid === '2886' || pid === '1001' || mfg.includes('espressif') || mfg.includes('seeed');
      });
      if (espPort) {
        targetPort = espPort.path;
        const pidNum = parseInt(espPort.productId || '', 16);
        if (Number.isFinite(pidNum)) detectedPid = pidNum;
      }
      // Brak fallbacku na pierwszy lepszy port — nie wolno wgrywać firmware
      // do przypadkowego urządzenia szeregowego podłączonego do komputera.
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
    let transport: NodeSerialTransport | null = null;

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

      transport = new NodeSerialTransport(serialPort, detectedPid);

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
        terminal: terminal as never
      } as never);

      this.emit('flash-progress', { stage: 'syncing', percent: 15, message: 'Synchronizacja z bootloaderem ESP32-C6…' });
      const chipName = await loader.main();
      console.log(`[esptool] Wykryto układ: ${chipName}`);

      // 4. BEZWZGLĘDNA weryfikacja układu — obraz ESP32-C6 nie może trafić
      //    na inny chip. Przerywamy PRZED kasowaniem i zapisem.
      if (!/ESP32[-_ ]?C6/i.test(chipName)) {
        throw new Error(
          `Nieprawidłowy układ na porcie (${chipName}). Wgrywanie dozwolone wyłącznie na ESP32-C6.`
        );
      }

      if (eraseAll) {
        this.emit('flash-progress', { stage: 'erasing', percent: 25, message: 'Kasowanie całej pamięci flash (tryb ratunkowy)…' });
      } else {
        this.emit('flash-progress', { stage: 'erasing', percent: 25, message: 'Przygotowywanie pamięci flash…' });
      }

      // 5. Zapis pamięci Flash z raportowaniem postępu i weryfikacją MD5.
      //    esptool-js 0.6.x wymaga data jako Uint8Array — binary string
      //    byłby zinterpretowany przez pako deflate jako tekst UTF-8
      //    i USZKODZIŁ obraz podczas kompresji.
      await loader.writeFlash({
        fileArray: [{ data: new Uint8Array(binBuffer), address: 0x0 }],
        flashMode: 'keep',
        flashFreq: 'keep',
        flashSize: 'keep',
        eraseAll,
        compress: true,
        reportProgress: (_fileIndex: number, written: number, total: number) => {
          const pct = Math.round(25 + (written / total) * 70);
          this.emit('flash-progress', {
            stage: 'flashing',
            percent: Math.min(95, pct),
            message: `Zapisywanie pamięci Flash: ${Math.round((written / total) * 100)}% (${Math.round(written / 1024)} kB)`
          });
        },
        // Prawdziwy MD5 — esptool porówna hash z urządzeniem po zapisie.
        // Puste '' wyłączałoby weryfikację (uszkodzony flash przeszedłby niezauważony).
        calculateMD5Hash: (image: string | Uint8Array): string =>
          createHash('md5')
            .update(typeof image === 'string' ? Buffer.from(image, 'latin1') : Buffer.from(image))
            .digest('hex')
      } as never);

      // 6. Reset układu by the book (publiczne API esptool-js)
      this.emit('flash-progress', { stage: 'rebooting', percent: 98, message: 'Restartowanie układu ESP32-C6…' });
      await loader.after('hard_reset');

      this.emit('flash-progress', { stage: 'done', percent: 100, message: 'Firmware wgrany pomyślnie! ✓' });
      this.emit('flash-complete', { ok: true, port: targetPort });

      return { ok: true, port: targetPort };
    } catch (err) {
      console.error('[esptool] Błąd podczas wgrywania firmware:', err);
      this.emit('flash-progress', { stage: 'error', percent: 0, message: `Błąd wgrywania: ${(err as Error).message}` });
      throw err;
    } finally {
      this.isFlashing = false;
      // ZAWSZE zwalniaj port COM — także przy błędzie, inaczej radar
      // nie będzie w stanie ponownie otworzyć portu.
      try {
        await transport?.disconnect();
      } catch {
        /* ignore */
      }
      // Wznów nasłuch radaru
      const radar = this.radar;
      if (radar) {
        setTimeout(() => {
          void radar.start().catch(() => {});
        }, 1200);
      }
    }
  }

  /**
   * Walidacja strukturalna obrazu ESP wg esp_image_header_t (IDFv4+):
   * - magiczny bajt 0xE9,
   * - chip_id == 13 (ESP32-C6) — obraz innego układu = twardy reject,
   * - tablica partycji (0xAA 0x50) na offsecie 0x8000 — dowód że plik jest
   *   pełnym obrazem merged/factory (goły app.bin wgrany na 0x0 uszkodziłby
   *   bootloader; app-only wymaga offsetu 0x10000 i innego procesu).
   */
  private validateFirmwareImage(buf: Buffer): void {
    if (buf.length === 0) {
      throw new Error('Plik firmware jest pusty');
    }
    if (buf[0] !== 0xe9) {
      throw new Error(
        `Plik nie jest poprawnym obrazem firmware ESP (nagłówek 0x${buf[0]
          .toString(16)
          .padStart(2, '0')} zamiast 0xE9). Wgrywanie przerwane.`
      );
    }

    // Nagłówek obrazu: [1]=liczba segmentów, [4..7]=entry point, [12..13]=chip_id
    const segmentCount = buf[1];
    if (segmentCount < 1 || segmentCount > 16) {
      throw new Error(`Nieprawidłowa liczba segmentów obrazu (${segmentCount}). Plik nie wygląda na firmware ESP.`);
    }
    const entryAddr = buf.readUInt32LE(4);
    if (entryAddr === 0) {
      throw new Error('Nieprawidłowy entry point (0x00000000) w nagłówku obrazu.');
    }
    const chipId = buf.readUInt16LE(12);
    const CHIP_ID_ESP32_C6 = 13;
    if (chipId !== CHIP_ID_ESP32_C6) {
      throw new Error(
        `Obraz przeznaczony dla innego układu (chip_id=${chipId}, oczekiwany ${CHIP_ID_ESP32_C6} = ESP32-C6). Wgrywanie przerwane.`
      );
    }

    // Pełny obraz merged/factory zawiera tablicę partycji dokładnie na 0x8000
    const PARTITION_TABLE_OFFSET = 0x8000;
    if (buf.length < PARTITION_TABLE_OFFSET + 3) {
      throw new Error(
        'Plik jest zbyt mały, aby zawierać tablicę partycji (offset 0x8000). ' +
          'Wymagany jest PEŁNY obraz merged/factory — pojedynczy app.bin uszkodziłby bootloader sensora.'
      );
    }
    if (!(buf[PARTITION_TABLE_OFFSET] === 0xaa && buf[PARTITION_TABLE_OFFSET + 1] === 0x50)) {
      throw new Error(
        'Brak tablicy partycji na offsecie 0x8000 — plik nie jest pełnym obrazem merged/factory. ' +
          'Pobieranie właściwego firmware z GitHuba lub wgranie ręczne esptool są jedynymi wspieranymi opcjami.'
      );
    }

    const MAX_FW_BYTES = 16 * 1024 * 1024;
    if (buf.length > MAX_FW_BYTES) {
      throw new Error(
        `Plik firmware przekracza rozmiar pamięci flash sensora (${Math.round(buf.length / 1024 / 1024)} MB > 16 MB).`
      );
    }
  }
}
