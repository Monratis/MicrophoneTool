import { BrowserWindow, app } from 'electron';
import path from 'node:path';
import type { AppContext } from './appContext';
import { resolveWindowIcon } from './appContext';

let settingsWindow: BrowserWindow | null = null;

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}

export function createSettingsWindow(ctx: AppContext): void {
  const winIcon = resolveWindowIcon();

  settingsWindow = new BrowserWindow({
    width: 780,
    height: 860,
    minWidth: 640,
    minHeight: 680,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#0d0f14',
    icon: winIcon ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void settingsWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void settingsWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  settingsWindow.on('close', (e) => {
    const appWithQuitFlag = app as Electron.App & { isQuitting?: boolean };
    if (!appWithQuitFlag.isQuitting) {
      e.preventDefault();
      settingsWindow?.hide();
    }
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    ctx.settingsWindow = null;
  });
  // Ikona na taskbarze TYLKO gdy okno faktycznie widać; schowane do tray
  // znika z paska. Zdarzenia show/hide obejmują wszystkie ścieżki
  // (klik w tray, przycisk ✕, druga instancja).
  settingsWindow.on('show', () => {
    settingsWindow?.setSkipTaskbar(false);
  });
  settingsWindow.on('hide', () => {
    settingsWindow?.setSkipTaskbar(true);
  });

  ctx.settingsWindow = settingsWindow;
}

export function showSettings(ctx: AppContext): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow(ctx);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('push:event', { type: 'snapshot', snapshot: ctx.buildSnapshot() });
    settingsWindow.show();
    settingsWindow.focus();
  }
}

