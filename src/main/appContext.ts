import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, Notification, nativeImage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type Config from './config';
import type AppController from './appController';
import type RadarListener from './radarListener';
import type AudioController from './audioController';
import type AppUpdater from './updater';
import type SignalRGBIntegration from './signalrgbIntegration';
import type HomeAssistantIntegration from './haIntegration';
import type ActivityWatcher from './activityWatcher';
import type { PushEvent, Snapshot } from '../shared/types';

/**
 * Wspólny kontekst aplikacji przekazywany modułom (tray / okno / IPC).
 * Unika cyklicznych importów i globalnego stanu rozproszonego po plikach.
 */
export interface AppContext {
  config: Config;
  radar: RadarListener;
  audio: AudioController;
  controller: AppController;
  activityWatcher: ActivityWatcher;
  updater: AppUpdater;
  signalrgb: SignalRGBIntegration | null;
  ha: HomeAssistantIntegration;

  appDataDir: string;
  settingsWindow: BrowserWindow | null;

  buildSnapshot(): Snapshot;
  pushEvent(type: string, payload?: Partial<PushEvent>): void;
  refreshSnapshot(): void;
  restartRadar(): Promise<void>;
  showSettings(): void;
  showWindowsNotification(title: string, body: string): void;
  applyAutoStart(enabled: boolean): void;
}

// ---------- paths ----------

const APP_DATA_FOLDER = 'Audio Switcher';

export function getAppDataDir(): string {
  const base =
    process.env.APPDATA ||
    (app.isReady() ? app.getPath('appData') : null) ||
    path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, APP_DATA_FOLDER);
}

/**
 * Sprzątanie staroci i plików tymczasowych po sobie: pobrane instalatory
 * aktualizacji, firmware, skrypty restartu, osierocone foldery electron-download,
 * rozpakowane wcześniej wersje portable (ns*.tmp) i tymczasowe raporty CSV
 * zostawiane w %TEMP% są usuwane przy starcie i zamknięciu aplikacji.
 */
export function cleanupStaleUpdateFiles(): void {
  const tmp = os.tmpdir();
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
        lower.startsWith('desksense-') ||
        lower.startsWith('autoaudioswitch-') ||
        lower.startsWith('electron-download-') ||
        (lower.startsWith('ns') && lower.endsWith('.tmp'));

      if (isTarget) {
        try {
          const fullPath = path.join(tmp, f);
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

  // W wersji portable / produkcyjnej zawsze dbamy o obecność configu w %APPDATA%/Audio Switcher
  if (!fs.existsSync(appDataConfig)) {
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

/** Ikona aplikacji: w dev z build/, w paczce z resources/ (extraResources). */
export function resolveAppIcon(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'icon.png');
  }
  return path.join(__dirname, '..', '..', 'build', 'icon.png');
}

export function resolveWindowIcon(): Electron.NativeImage | null {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'icon.png')
    : path.join(__dirname, '..', '..', 'build', 'icon.ico');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return null;
}

// ---------- autostart ----------

export function applyAutoStart(enabled: boolean): void {
  // openAsHidden pominięte: _macOS only_ i deprecated w Electron — na Windows
  // aplikacja i tak startuje schowana (okno show:false, tray).
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath
  });
}

export function getAutoStart(config: Config): boolean {
  if (app.isPackaged) {
    return app.getLoginItemSettings().openAtLogin;
  }
  return Boolean(config.get('autoStart'));
}

export function createNotification(
  title: string,
  body: string,
  notificationsEnabled: boolean,
  onClick?: () => void
): void {
  if (Notification.isSupported() && notificationsEnabled) {
    try {
      const iconPath = resolveAppIcon();
      const notif = new Notification({
        title,
        body,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        silent: true
      });
      if (onClick) {
        notif.on('click', () => {
          try {
            onClick();
          } catch (_) {}
        });
      }
      notif.show();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Windows bierze ikonę toasta ze skrótu Start Menu powiązanego z App User
 * Model ID. Portable nie ma takiego skrótu → powiadomienia pokazują generyczną
 * ikonę. Tworzymy/odświeżamy go przy każdym starcie (target = aktualna lokalizacja EXE).
 */
export function ensureToastShortcut(): void {
  try {
    if (!app.isPackaged) return; // w dev toast i tak dziedziczy ikonę Electrona
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

    shell.writeShortcutLink(path.join(programsDir, 'DeskSense.lnk'), 'replace', {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      appUserModelId: 'com.monratis.desksense',
      description: 'DeskSense'
    });
  } catch (err) {
    console.warn('[main] toast shortcut warning:', (err as Error).message);
  }
}
