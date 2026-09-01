import { BrowserWindow, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { AppContext } from './appContext';
import { resolveWindowIcon, resolveAppIconPath } from './appContext';
import { appendLog } from './logger';

let settingsWindow: BrowserWindow | null = null;

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}

export function createSettingsWindow(ctx: AppContext): void {
  const winIcon = resolveWindowIcon();
  const iconPath = resolveAppIconPath();
  const iconExists = fs.existsSync(iconPath);

  appendLog('ICON', `createSettingsWindow: iconPath="${iconPath}" (exists=${iconExists}), nativeImageIsEmpty=${!winIcon || winIcon.isEmpty()}, execPath="${process.execPath}"`);

  settingsWindow = new BrowserWindow({
    width: 1140,
    height: 760,
    minWidth: 880,
    minHeight: 580,
    show: false,
    frame: false,
    resizable: true,
    backgroundColor: '#1b2028',
    icon: winIcon ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // contextIsolation + własny preload zapewniają izolację procesu.
      // sandbox: true jest zbędne przy contextIsolation i łamie startupData na Electron 43.
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });

  if (process.platform === 'win32' && iconExists) {
    try {
      settingsWindow.setAppDetails({
        appId: 'com.monratis.desksense',
        appIconPath: iconPath,
        appIconIndex: 0,
        relaunchCommand: `"${process.execPath}"`,
        relaunchDisplayName: 'DeskSense'
      });
      appendLog('ICON', `createSettingsWindow: setAppDetails zaaplikowane pomyślnie z appIconPath="${iconPath}"`);
    } catch (err) {
      appendLog('ICON', `createSettingsWindow: błąd setAppDetails: ${(err as Error).message}`);
    }
  }

  settingsWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error(`[settingsWindow] did-fail-load: code=${errorCode} desc="${errorDescription}" url="${validatedURL}"`);
  });

  settingsWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[settingsWindow] render-process-gone:', details);
  });

  settingsWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      console.warn(`[renderer console] [lvl ${level}] ${message} (${sourceId}:${line})`);
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
  // Ikona na taskbarze przy otwarciu okna
  settingsWindow.on('show', () => {
    const currentIcon = resolveWindowIcon();
    if (currentIcon && !currentIcon.isEmpty() && settingsWindow && !settingsWindow.isDestroyed()) {
      try {
        settingsWindow.setIcon(currentIcon);
        appendLog('ICON', `settingsWindow on(show): zaaplikowano setIcon (NativeImage ${currentIcon.getSize().width}x${currentIcon.getSize().height})`);
      } catch (err) {
        appendLog('ICON', `Błąd setIcon w on(show): ${(err as Error).message}`);
      }
    }
    if (process.platform === 'win32' && fs.existsSync(iconPath) && settingsWindow && !settingsWindow.isDestroyed()) {
      try {
        settingsWindow.setAppDetails({
          appId: 'com.monratis.desksense',
          appIconPath: iconPath,
          appIconIndex: 0,
          relaunchCommand: `"${process.execPath}"`,
          relaunchDisplayName: 'DeskSense'
        });
      } catch (err) {
        appendLog('ICON', `Błąd setAppDetails w on(show): ${(err as Error).message}`);
      }
    }
    settingsWindow?.webContents.send('push:event', { type: 'window:visibility', visible: true });
  });
  settingsWindow.on('hide', () => {
    settingsWindow?.webContents.send('push:event', { type: 'window:visibility', visible: false });
  });
  settingsWindow.on('maximize', () => {
    settingsWindow?.webContents.send('push:event', { type: 'window:state', isMaximized: true });
  });
  settingsWindow.on('unmaximize', () => {
    settingsWindow?.webContents.send('push:event', { type: 'window:state', isMaximized: false });
  });

  ctx.settingsWindow = settingsWindow;
}

export function showSettings(ctx: AppContext, atCursor = false, initialTab?: string): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow(ctx);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    const { screen } = require('electron');
    const winBounds = settingsWindow.getBounds();

    if (atCursor) {
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursor);
      const wa = display.workArea;
      let x = Math.round(cursor.x - winBounds.width / 2);
      let y = Math.round(cursor.y - winBounds.height / 2);
      // Ogranicz do obszaru roboczego aktywnego monitora
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width - winBounds.width));
      y = Math.max(wa.y, Math.min(y, wa.y + wa.height - winBounds.height));
      settingsWindow.setPosition(x, y);
    } else {
      const isVisibleOnAnyDisplay = screen.getAllDisplays().some((d: Electron.Display) => {
        const db = d.bounds;
        return (
          winBounds.x + winBounds.width > db.x &&
          winBounds.x < db.x + db.width &&
          winBounds.y + winBounds.height > db.y &&
          winBounds.y < db.y + db.height
        );
      });
      if (!isVisibleOnAnyDisplay) {
        settingsWindow.center();
      }
    }

    const currentIcon = resolveWindowIcon();
    if (currentIcon && !currentIcon.isEmpty() && !settingsWindow.isDestroyed()) {
      try { settingsWindow.setIcon(currentIcon); } catch (_) {}
    }

    settingsWindow.webContents.send('push:event', { type: 'snapshot', snapshot: ctx.buildSnapshot() });
    if (initialTab) {
      settingsWindow.webContents.send('push:event', { type: 'navigate:tab', tab: initialTab });
    }
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore();
    }
    settingsWindow.show();
    settingsWindow.setAlwaysOnTop(true);
    settingsWindow.focus();
    settingsWindow.moveTop();
    setTimeout(() => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.setAlwaysOnTop(false);
      }
    }, 200);
  }
}

