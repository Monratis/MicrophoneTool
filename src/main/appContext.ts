import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, Notification, nativeImage } from 'electron';
import type { BrowserWindow } from 'electron';
import type Config from './config';
import type AppController from './appController';
import type RadarListener from './radarListener';
import type AudioController from './audioController';
import type AppUpdater from './updater';
import type SensorFlasher from './sensorFlasher';
import type SignalRGBIntegration from './signalrgbIntegration';
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
  updater: AppUpdater;
  sensorFlasher: SensorFlasher;
  signalrgb: SignalRGBIntegration | null;

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
 * Sprzątanie staroć po sobie: pobrane instalatory aktualizacji i skrypty restartu
 * zostawiane wcześniej w %TEMP% nigdy nie były usuwane (setki MB śmieci).
 */
export function cleanupStaleUpdateFiles(): void {
  const targets = [
    path.join(os.tmpdir(), 'AutoAudioSwitch-Update'),
    path.join(os.tmpdir(), 'update_restart.bat'),
    path.join(os.tmpdir(), 'AutoAudioSwitch-Firmware')
  ];
  for (const t of targets) {
    try {
      fs.rmSync(t, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* ignore */
    }
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
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    path: process.execPath
  });
}

export function getAutoStart(config: Config): boolean {
  if (app.isPackaged) {
    return app.getLoginItemSettings().openAtLogin;
  }
  return Boolean(config.get('autoStart'));
}

export function createNotification(title: string, body: string, notificationsEnabled: boolean): void {
  if (Notification.isSupported() && notificationsEnabled) {
    try {
      const iconPath = resolveAppIcon();
      new Notification({
        title,
        body,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        silent: true
      }).show();
    } catch {
      /* ignore */
    }
  }
}
