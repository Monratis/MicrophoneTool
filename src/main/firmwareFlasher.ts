import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { dialog } from 'electron';
import type { AppContext } from './appContext';
import { appendLog } from './logger';

export interface FlasherDependencies {
  python: boolean;
  pythonCmd: string;
  esptool: boolean;
  arduinoCli: boolean;
  arduinoCliPath?: string;
  stockFiles: Array<{ name: string; path: string; type: 'bin' | 'ino'; description: string }>;
}

export interface FlashedFileInfo {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  extension: string;
}

export class FirmwareFlasher {
  private activeProcess: ReturnType<typeof spawn> | null = null;
  private isFlashing = false;

  constructor(private ctx: AppContext) {}

  /**
   * Sprawdza dostępność narzędzi deweloperskich w systemie (Python, esptool, arduino-cli).
   */
  async checkDependencies(): Promise<FlasherDependencies> {
    const result: FlasherDependencies = {
      python: false,
      pythonCmd: 'python',
      esptool: false,
      arduinoCli: false,
      stockFiles: []
    };

    // 1. Sprawdzenie Pythona i esptool
    for (const cmd of ['python', 'python3', 'py']) {
      const pyVer = await this.testExec(cmd, ['--version']);
      if (pyVer.ok) {
        result.python = true;
        result.pythonCmd = cmd;
        const espVer = await this.testExec(cmd, ['-m', 'esptool', 'version']);
        if (espVer.ok) {
          result.esptool = true;
        }
        break;
      }
    }

    // 2. Sprawdzenie Arduino CLI
    const localArduinoCli = path.join(
      process.env.LOCALAPPDATA || '',
      'Programs',
      'Arduino IDE',
      'resources',
      'app',
      'lib',
      'backend',
      'resources',
      'arduino-cli.exe'
    );

    if (fs.existsSync(localArduinoCli)) {
      result.arduinoCli = true;
      result.arduinoCliPath = localArduinoCli;
    } else {
      const cliVer = await this.testExec('arduino-cli', ['version']);
      if (cliVer.ok) {
        result.arduinoCli = true;
        result.arduinoCliPath = 'arduino-cli';
      }
    }

    // 3. Wyszukiwanie dołączonych stockowych plików wsadowych
    const candidates = [
      path.join(process.cwd(), 'firmware'),
      path.join(__dirname, '../../firmware'),
      path.join(process.resourcesPath || '', 'firmware')
    ];

    for (const baseDir of candidates) {
      if (fs.existsSync(baseDir)) {
        const bin60 = path.join(baseDir, 'seeedstudio-mr60bha2-kit-esp32c6.factory.bin');
        if (fs.existsSync(bin60)) {
          result.stockFiles.push({
            name: 'Stock Factory ESPHome (60GHz MR60BHA2)',
            path: bin60,
            type: 'bin',
            description: 'Oryginalny binarny wsad Seeed Studio ESPHome dla zestawu 60GHz.'
          });
        }

        const ino24 = path.join(baseDir, 'DeskSense_24GHz_XIAO', 'DeskSense_24GHz_XIAO.ino');
        if (fs.existsSync(ino24)) {
          result.stockFiles.push({
            name: 'DeskSense Native OS v1.5 (24GHz Shield 101010001)',
            path: ino24,
            type: 'ino',
            description: 'Natywny, błyskawiczny firmware C++ ze strefami ruchu i statyki (256000 baud).'
          });
        }

        const ino60 = path.join(baseDir, 'DeskSense_XIAO_ESP32C6', 'DeskSense_XIAO_ESP32C6.ino');
        if (fs.existsSync(ino60)) {
          result.stockFiles.push({
            name: 'DeskSense Native OS v1.5 (60GHz Kit MR60BHA2)',
            path: ino60,
            type: 'ino',
            description: 'Natywny wsad C++ z obsługą oddechu, tętna, światła BH1750 i diody WS2812.'
          });
        }
        break;
      }
    }

    return result;
  }

  /**
   * Otwiera okno dialogowe wyboru pliku wsadu (.bin lub .ino).
   */
  async selectFirmwareFile(): Promise<FlashedFileInfo | null> {
    const parentWin = this.ctx.settingsWindow || undefined;
    const res = await dialog.showOpenDialog(parentWin as any, {
      title: 'Wybierz plik wsadu firmware dla XIAO ESP32-C6',
      filters: [
        { name: 'Wszystkie obsługiwane (*.bin, *.ino)', extensions: ['bin', 'ino'] },
        { name: 'Skompilowany Binary (*.bin)', extensions: ['bin'] },
        { name: 'Kod źródłowy Arduino (*.ino)', extensions: ['ino'] }
      ],
      properties: ['openFile']
    });

    if (res.canceled || !res.filePaths[0]) {
      return null;
    }

    const filePath = res.filePaths[0];
    const stat = fs.statSync(filePath);
    return {
      filePath,
      fileName: path.basename(filePath),
      sizeBytes: stat.size,
      extension: path.extname(filePath).toLowerCase().replace('.', '')
    };
  }

  /**
   * Główna procedura flashowania mikrokontrolera XIAO ESP32-C6.
   */
  async flash(options: {
    port: string;
    filePath: string;
    baudRate?: number;
  }): Promise<{ success: boolean; error?: string }> {
    if (this.isFlashing) {
      return { success: false, error: 'Proces wgrywania firmware już trwa.' };
    }

    if (!options.port || options.port === 'auto') {
      return { success: false, error: 'Wskaż konkretny port COM (np. COM3) przed rozpoczęciem flashowania.' };
    }

    if (!fs.existsSync(options.filePath)) {
      return { success: false, error: `Wskazany plik firmware nie istnieje: ${options.filePath}` };
    }

    this.isFlashing = true;
    appendLog('FLASHER', `Rozpoczynam wgrywanie ${path.basename(options.filePath)} na port ${options.port}`);
    this.sendEvent('flasher:start', { file: path.basename(options.filePath), port: options.port });

    // 1. Bezpieczeństwo: Zwolnienie portu COM (zatrzymanie radaru)
    this.sendEvent('flasher:log', { text: `[1/4] Zwalnianie portu ${options.port} i wstrzymywanie radaru...` });
    try {
      await this.ctx.radar.stop();
      await new Promise((r) => setTimeout(r, 600));
    } catch (e) {
      console.warn('[flasher] Błąd przy zwalnianiu portu:', e);
    }

    const ext = path.extname(options.filePath).toLowerCase();
    const deps = await this.checkDependencies();

    try {
      if (ext === '.bin') {
        // Flashowanie skompilowanego pliku .bin przez esptool
        if (!deps.esptool) {
          throw new Error(
            'Brak zainstalowanego narzędzia esptool. Zainstaluj je poleceniem: pip install esptool'
          );
        }

        const baud = options.baudRate || 460800;
        this.sendEvent('flasher:log', {
          text: `[2/4] Uruchamianie esptool (${deps.pythonCmd} -m esptool --chip esp32c6 --port ${options.port} --baud ${baud} write_flash 0x0)...`
        });

        const args = [
          '-m',
          'esptool',
          '--chip',
          'esp32c6',
          '--port',
          options.port,
          '--baud',
          String(baud),
          'write_flash',
          '0x0',
          options.filePath
        ];

        await this.runProcess(deps.pythonCmd, args);
      } else if (ext === '.ino') {
        // Kompilacja i upload przez arduino-cli
        if (!deps.arduinoCli || !deps.arduinoCliPath) {
          throw new Error(
            'Do kompilacji plików .ino wymagane jest narzędzie arduino-cli (zainstalowane np. z Arduino IDE).'
          );
        }

        const sketchDir = path.dirname(options.filePath);
        this.sendEvent('flasher:log', {
          text: `[2/4] Kompilacja szkicu Arduino (${deps.arduinoCliPath} compile --fqbn esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc)...`
        });

        await this.runProcess(deps.arduinoCliPath, [
          'compile',
          '--fqbn',
          'esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc',
          sketchDir
        ]);

        this.sendEvent('flasher:log', {
          text: `[3/4] Wgrywanie skompilowanego programu na port ${options.port}...`
        });

        await this.runProcess(deps.arduinoCliPath, [
          'upload',
          '-p',
          options.port,
          '--fqbn',
          'esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc',
          sketchDir
        ]);
      } else {
        throw new Error(`Nieobsługiwane rozszerzenie pliku: ${ext}. Wybierz plik .bin lub .ino.`);
      }

      this.sendEvent('flasher:log', { text: '✓ [4/4] Wgrywanie firmware zakończone pełnym sukcesem!' });
      this.sendEvent('flasher:done', { success: true });
      appendLog('FLASHER', `Sukces wgrywania wsadu na ${options.port}`);

      // Odczekanie na restart mikrokontrolera i ponowne podpięcie radaru
      setTimeout(async () => {
        try {
          await this.ctx.restartRadar();
        } catch {}
      }, 1500);

      return { success: true };
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      this.sendEvent('flasher:log', { text: `❌ BŁĄD FLASHOWANIA: ${errMsg}`, isError: true });
      this.sendEvent('flasher:done', { success: false, error: errMsg });
      appendLog('FLASHER', `Błąd: ${errMsg}`);

      // Próba wznowienia radaru mimo błędu
      setTimeout(async () => {
        try {
          await this.ctx.restartRadar();
        } catch {}
      }, 1000);

      return { success: false, error: errMsg };
    } finally {
      this.isFlashing = false;
      this.activeProcess = null;
    }
  }

  /**
   * Anuluje bieżący proces wgrywania.
   */
  cancel(): void {
    if (this.activeProcess) {
      try {
        this.activeProcess.kill('SIGTERM');
        this.sendEvent('flasher:log', { text: '⚠️ Przerwano proces na żądanie użytkownika.' });
      } catch (e) {
        console.error('[flasher] Błąd przy ubijaniu procesu:', e);
      }
    }
  }

  private runProcess(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, { shell: true });
      this.activeProcess = proc;

      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString('utf8');
        for (const line of text.split('\n')) {
          const clean = line.trim();
          if (clean) this.sendEvent('flasher:log', { text: clean });
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString('utf8');
        for (const line of text.split('\n')) {
          const clean = line.trim();
          if (clean) this.sendEvent('flasher:log', { text: clean, isError: clean.toLowerCase().includes('error') });
        }
      });

      proc.on('error', (err) => {
        this.activeProcess = null;
        reject(err);
      });

      proc.on('close', (code) => {
        this.activeProcess = null;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Proces zakończył się kodem błędu ${code}`));
        }
      });
    });
  }

  private testExec(cmd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: 3000 }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, output: (stdout || '').trim() });
        } else {
          resolve({ ok: false, output: (stderr || '').trim() });
        }
      });
    });
  }

  private sendEvent(type: string, payload: unknown): void {
    this.ctx.pushEvent(type, payload as any);
  }
}
