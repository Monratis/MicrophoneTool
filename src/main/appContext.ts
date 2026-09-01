import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, nativeImage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type Config from './config';
import type AppController from './appController';
import type RadarListener from './radarListener';
import type AudioController from './audioController';
import type AppUpdater from './updater';
import type SignalRGBIntegration from './signalrgbIntegration';
import type HomeAssistantIntegration from './haIntegration';
import type ActivityWatcher from './activityWatcher';
import type ScreenManager from './screenManager';
import type { VoiceManager } from './voiceManager';
import type { FirmwareFlasher } from './firmwareFlasher';
import type { PushEvent, Snapshot } from '../shared/types';
import { showVoiceOsd } from './voiceOsd';
import { appendLog } from './logger';

/**
 * Wspólny kontekst aplikacji przekazywany modułom (tray / okno / IPC).
 * Unika cyklicznych importów i globalnego stanu rozproszonego po plikach.
 */
export interface AppContext {
  config: Config;
  radar: RadarListener;
  audio: AudioController;
  controller: AppController;
  screen: ScreenManager;
  activityWatcher: ActivityWatcher;
  updater: AppUpdater;
  signalrgb: SignalRGBIntegration | null;
  ha: HomeAssistantIntegration;
  voice?: VoiceManager;
  flasher: FirmwareFlasher;

  appDataDir: string;
  settingsWindow: BrowserWindow | null;

  buildSnapshot(): Snapshot;
  pushEvent(type: string, payload?: Partial<PushEvent>): void;
  refreshSnapshot(): void;
  restartRadar(): Promise<void>;
  showSettings(): void;
  applyAutoStart(enabled: boolean): void;
}

// ---------- paths ----------

const APP_DATA_FOLDER = 'DeskSense';

export function getAppDataDir(): string {
  const base =
    process.env.APPDATA ||
    (app.isReady() ? app.getPath('appData') : null) ||
    path.join(os.homedir(), 'AppData', 'Roaming');
  const targetDir = path.join(base, APP_DATA_FOLDER);

  // Automatyczna migracja z poprzedniej nazwy folderu (Audio Switcher -> DeskSense)
  try {
    const legacyDir = path.join(base, 'Audio Switcher');
    if (fs.existsSync(legacyDir) && !fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      for (const file of fs.readdirSync(legacyDir)) {
        const srcFile = path.join(legacyDir, file);
        const destFile = path.join(targetDir, file);
        if (fs.statSync(srcFile).isFile() && !fs.existsSync(destFile)) {
          fs.copyFileSync(srcFile, destFile);
        }
      }
    }
  } catch (err) {
    console.warn('[appData] migration warning:', (err as Error).message);
  }

  return targetDir;
}

/**
 * Sprzątanie staroci i plików tymczasowych po sobie: pobrane instalatory
 * aktualizacji, firmware, skrypty restartu, osierocone foldery electron-download,
 * rozpakowane wcześniej wersje portable (ns*.tmp) i tymczasowe raporty CSV
 * zostawiane w %TEMP% są usuwane przy starcie i zamknięciu aplikacji.
 */
export function cleanupStaleUpdateFiles(): void {
  const tmp = os.tmpdir();
  const currentExecDir = path.dirname(process.execPath).toLowerCase();
  const currentResourcesDir = (process.resourcesPath || '').toLowerCase();
  const portableDir = (process.env.PORTABLE_EXECUTABLE_DIR || '').toLowerCase();

  const isSafeToDelete = (targetPath: string): boolean => {
    try {
      const resolved = path.resolve(targetPath).toLowerCase();
      // Nigdy nie usuwaj katalogu roboczego aplikacji, zasobów ani katalogu z plikiem portable exe
      if (
        currentExecDir === resolved ||
        currentExecDir.startsWith(resolved + path.sep) ||
        resolved.startsWith(currentExecDir + path.sep) ||
        currentResourcesDir === resolved ||
        currentResourcesDir.startsWith(resolved + path.sep) ||
        resolved.startsWith(currentResourcesDir + path.sep) ||
        (portableDir && (portableDir === resolved || portableDir.startsWith(resolved + path.sep) || resolved.startsWith(portableDir + path.sep)))
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const directTargets = [
    path.join(tmp, 'AutoAudioSwitch-Update'),
    path.join(tmp, 'DeskSense-Update'),
    path.join(tmp, 'AutoAudioSwitch-Firmware'),
    path.join(tmp, 'DeskSense-Firmware'),
    path.join(tmp, 'update_restart.bat'),
    path.join(tmp, 'update_run_installer.bat'),
    path.join(tmp, 'desksense_update_restart.bat'),
    path.join(tmp, 'desksense_update_run_installer.bat'),
    path.join(tmp, 'svv.zip'),
    path.join(tmp, 'svv_out.txt')
  ];

  for (const t of directTargets) {
    if (!isSafeToDelete(t)) continue;
    try {
      fs.rmSync(t, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* ignore */
    }
  }

  // Wyczyść osierocone pliki tymczasowe z poprzednich sesji, update'ów i kompilacji
  try {
    const files = fs.readdirSync(tmp);
    for (const f of files) {
      const lower = f.toLowerCase();
      const isTarget =
        (lower.startsWith('svv-') && lower.endsWith('.csv')) ||
        lower.startsWith('desksense-update') ||
        lower.startsWith('desksense-firmware') ||
        lower.startsWith('desksense-logs-') ||
        lower.startsWith('autoaudioswitch-update') ||
        lower.startsWith('autoaudioswitch-firmware') ||
        lower.startsWith('electron-download-');

      if (isTarget) {
        const fullPath = path.join(tmp, f);
        if (!isSafeToDelete(fullPath)) continue;
        try {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } catch {
          /* ignore zablokowane pliki aktualnie działających procesów */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

export function resolveConfigPath(appDataDir: string): string {
  const appDataConfig = path.join(appDataDir, 'config.json');

  if (!app.isPackaged) {
    const dev = path.join(__dirname, '..', '..', 'config.json');
    if (fs.existsSync(dev)) return dev;
  }

  // W wersji portable / produkcyjnej zawsze dbamy o obecność configu w %APPDATA%/DeskSense
  if (!fs.existsSync(appDataConfig)) {
    const base = path.dirname(appDataDir);
    const legacyConfig = path.join(base, 'Audio Switcher', 'config.json');
    if (fs.existsSync(legacyConfig)) {
      try {
        fs.copyFileSync(legacyConfig, appDataConfig);
        return appDataConfig;
      } catch (_) {}
    }

    const bundled = app.isPackaged ? path.join(process.resourcesPath, 'config.json') : null;
    if (bundled && fs.existsSync(bundled)) {
      try {
        fs.copyFileSync(bundled, appDataConfig);
      } catch (err) {
        console.error('[config] failed to copy default config to %appdata%:', (err as Error).message);
      }
    }
  }

  return appDataConfig;
}

export function resolveBinDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin');
  return path.join(__dirname, '..', '..', 'bin');
}

/** Ścieżka do pliku ikony (.ico lub .png): w dev z build/ lub resources/, w paczce z resources/. */
export function resolveAppIconPath(): string {
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  const candidates = [
    // W paczce (extraResources: resources/ -> resources/icon.ico)
    path.join(process.resourcesPath, 'icon.ico'),
    path.join(process.resourcesPath, 'resources', 'icon.ico'),
    path.join(process.resourcesPath, 'icon.png'),
    path.join(process.resourcesPath, 'resources', 'icon.png'),
    // W trybie deweloperskim
    path.join(appPath, 'build', 'icon.ico'),
    path.join(appPath, 'resources', 'icon.ico'),
    path.join(appPath, 'build', 'icon.png'),
    path.join(appPath, 'resources', 'icon.png'),
    path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    path.join(__dirname, '..', '..', 'resources', 'icon.ico'),
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(__dirname, '..', '..', 'resources', 'icon.png')
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return path.join(appPath, 'build', 'icon.ico');
}

/** Ikona aplikacji PNG: w dev z build/, w paczce z resources/ (extraResources). */
export function resolveAppIcon(): string {
  const appPath = typeof app?.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  if (app.isPackaged) {
    const directPng = path.join(process.resourcesPath, 'icon.png');
    if (fs.existsSync(directPng)) return directPng;
    const resPng = path.join(process.resourcesPath, 'resources', 'icon.png');
    if (fs.existsSync(resPng)) return resPng;
    return path.join(process.resourcesPath, 'icon.png');
  }
  const buildPng = path.join(appPath, 'build', 'icon.png');
  if (fs.existsSync(buildPng)) return buildPng;
  const resPng = path.join(appPath, 'resources', 'icon.png');
  if (fs.existsSync(resPng)) return resPng;
  return path.join(__dirname, '..', '..', 'build', 'icon.png');
}

export function resolveWindowIcon(): Electron.NativeImage | string | undefined {
  const iconPath = resolveAppIconPath();
  const exists = fs.existsSync(iconPath);
  if (exists) {
    if (process.platform === 'win32' && iconPath.endsWith('.ico')) {
      return iconPath;
    }
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) return img;
    } catch (err) {
      console.warn('[main] resolveWindowIcon error:', (err as Error).message);
    }
    return iconPath;
  }
  return undefined;
}

// ---------- shortcuts & autostart ----------

/**
 * Bezpieczne tworzenie lub aktualizacja skrótu Windows .lnk.
 * Electron shell.writeShortcutLink z 'replace' wyrzuca błąd gdy plik nie istnieje,
 * a 'create' wyrzuca błąd gdy plik już istnieje. Usuwamy stary i tworzymy świeży.
 */
export function writeOrUpdateShortcut(shortcutPath: string, details: Electron.ShortcutDetails): boolean {
  try {
    if (fs.existsSync(shortcutPath)) {
      try {
        fs.unlinkSync(shortcutPath);
      } catch (_) {
        return shell.writeShortcutLink(shortcutPath, 'replace', details);
      }
    }
    return shell.writeShortcutLink(shortcutPath, 'create', details);
  } catch (err) {
    console.warn(`[shortcut] Nie udało się zapisać skrótu "${shortcutPath}":`, (err as Error).message);
    return false;
  }
}

export function applyAutoStart(enabled: boolean): void {
  try {
    const startupDir = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup'
    );
    const startupLnk = path.join(startupDir, 'DeskSense.lnk');
    const oldStartupLnk = path.join(startupDir, 'Auto Audio Switch.lnk');

    // Usuń stary skrót z poprzedniej nazwy jeśli istnieje
    if (fs.existsSync(oldStartupLnk)) {
      try { fs.unlinkSync(oldStartupLnk); } catch (_) {}
    }

    const targetExe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const targetDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(targetExe);
    const iconPath = resolveAppIconPath();

    if (enabled) {
      fs.mkdirSync(startupDir, { recursive: true });

      // Tworzymy skrót .lnk w folderze Autostartu Windows z jawnym katalogiem roboczym (cwd).
      // To gwarantuje, że wersja Portable odpala się bezbłędnie niezależnie od ścieżki ze spacjami.
      writeOrUpdateShortcut(startupLnk, {
        target: targetExe,
        args: app.isPackaged ? undefined : `"${path.resolve('.')}"`,
        cwd: targetDir,
        appUserModelId: 'com.monratis.desksense',
        description: 'DeskSense',
        icon: iconPath,
        iconIndex: 0
      });

      // Usuwamy ewentualny stary wpis w rejestrze, aby Windows nie odpalał dwóch kopii
      try {
        app.setLoginItemSettings({
          openAtLogin: false,
          path: targetExe
        });
      } catch (_) {}
    } else {
      if (fs.existsSync(startupLnk)) {
        try { fs.unlinkSync(startupLnk); } catch (_) {}
      }
      try {
        app.setLoginItemSettings({
          openAtLogin: false,
          path: targetExe
        });
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[autostart] applyAutoStart warning:', (err as Error).message);
  }
}

/**
 * Wspólny toggle mute z pełnym feedbackiem (dioda sensora, toast, odświeżenie snapshotu).
 * Używany przez skrót globalny, menu tray i IPC — wcześniej logika była skopiowana
 * w trzech miejscach i tray nie aktualizował LED.
 */
export async function toggleMuteWithFeedback(ctx: AppContext): Promise<{ ok: boolean; isMuted?: boolean }> {
  const res = await ctx.controller.toggleDeviceMute();
  if (res.ok && typeof res.isMuted === 'boolean') {
    // Dioda sensora reaguje na mute z KAŻDEGO źródła (skrót / tray / UI)
    ctx.radar.updateLed(res.isMuted ? 'mute' : (ctx.controller.currentDevice || 'desk'));
    ctx.pushEvent('toast', { message: res.isMuted ? 'Mikrofon wyciszony 🔇' : 'Mikrofon aktywny 🎙️' });
    showVoiceOsd(res.isMuted ? 'Mikrofon wyciszony' : 'Mikrofon aktywny', res.isMuted ? 'mute' : 'unmute', 2000);
  } else if (!res.ok) {
    ctx.pushEvent('toast', { error: true, message: 'Nie udało się przełączyć wyciszenia mikrofonu' });
    showVoiceOsd('Nie udało się przełączyć wyciszenia', 'blocked', 2500);
  }
  ctx.refreshSnapshot();
  return res;
}

/**
 * Windows bierze ikonę paska zadań i toasta ze skrótu Start Menu powiązanego z App User
 * Model ID (AUMID: com.monratis.desksense). Tworzymy/odświeżamy go przy starcie
 * zarówno w trybie packaged jak i deweloperskim, aby pasek zadań zawsze wyświetlał
 * naszą dedykowaną ikonę DeskSense zamiast domyślnego logo Electrona.
 */
export function ensureToastShortcut(): void {
  try {
    const appData = getAppDataDir();
    const persistentIcon = path.join(appData, 'icon.ico');
    const sourceIcon = resolveAppIconPath();
    if (fs.existsSync(sourceIcon)) {
      try {
        fs.copyFileSync(sourceIcon, persistentIcon);
      } catch (err) {
        appendLog('ICON', `Błąd kopiowania ikony do AppData: ${(err as Error).message}`);
      }
    }

    const programsDir = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    );
    fs.mkdirSync(programsDir, { recursive: true });

    // Usuń stary skrót z poprzedniej nazwy jeśli istnieje
    const oldShortcut = path.join(programsDir, 'Auto Audio Switch.lnk');
    if (fs.existsSync(oldShortcut)) {
      try { fs.unlinkSync(oldShortcut); } catch (_) {}
    }

    const targetExe = process.execPath;
    const targetDir = path.dirname(process.execPath);
    const iconToUse = fs.existsSync(persistentIcon) ? persistentIcon : sourceIcon;

    const ok = writeOrUpdateShortcut(path.join(programsDir, 'DeskSense.lnk'), {
      target: targetExe,
      args: app.isPackaged ? '--show' : `"${path.resolve('.')}" --show`,
      cwd: targetDir,
      appUserModelId: 'com.monratis.desksense',
      description: 'DeskSense',
      icon: iconToUse,
      iconIndex: 0
    });

    appendLog('ICON', `Rejestracja skrótu AUMID: shortcut="${path.join(programsDir, 'DeskSense.lnk')}", targetExe="${targetExe}", icon="${iconToUse}" (exists: ${fs.existsSync(iconToUse)}), success=${ok}`);
  } catch (err) {
    appendLog('ICON', `Błąd w ensureToastShortcut: ${(err as Error).message}`);
  }
}
