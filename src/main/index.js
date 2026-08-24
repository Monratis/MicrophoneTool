import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, Notification, globalShortcut, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import Config, { DEFAULTS } from './config';
import RadarListener from './radarListener';
import AudioController from './audioController';
import AppController from './appController';
import AppUpdater from './updater';

// Performance App Flags
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

// Single instance lock
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
  process.exit(0);
}

let tray = null;
let settingsWindow = null;
let controller = null;
let updater = null;
let snapshot = null;
let radarIssueToastShown = false;

const STATE_LABEL = { desk: 'Przy biurku (Stacjonarny)', away: 'Poza biurkiem (Mobilny)' };
const MODE_LABEL = { auto: 'Auto (radar)', desk: 'Stacjonarny', headset: 'Mobilny' };

// ---------- paths & appdata ----------

const APP_DATA_FOLDER = 'Audio Switcher';

function getAppDataDir() {
  const base = process.env.APPDATA || (app.isReady() ? app.getPath('appData') : null) || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, APP_DATA_FOLDER);
}

const appDataDir = getAppDataDir();
try {
  fs.mkdirSync(appDataDir, { recursive: true });
  app.setPath('userData', appDataDir);
} catch (err) {
  console.warn('[main] setup appDataDir warning:', err.message);
}

function resolveConfigPath() {
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
        console.error('[config] failed to copy default config to %appdata%:', err.message);
      }
    }
  }

  return appDataConfig;
}

function resolveBinDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin');
  return path.join(__dirname, '..', '..', 'bin');
}

function createAudioController() {
  return new AudioController({
    binDir: resolveBinDir(),
    toolsDir: path.join(appDataDir, 'tools'),
    config: controller ? controller.config : null
  });
}

// ---------- snapshot / events ----------

function buildSnapshot() {
  const radarConnected = Boolean(controller.radar.port && controller.radar.port.isOpen);
  return {
    mode: controller.mode,
    state: controller.currentDevice,
    deviceName: controller.currentDevice
      ? (controller.currentDevice === 'desk' ? controller.config.get('micDeskName') : controller.config.get('micHeadsetName'))
      : null,
    radar: {
      connected: radarConnected,
      presence: controller.radar.presence,
      pendingState: controller.radar.state === null
        ? (controller.radar.presence ? 'desk' : 'away')
        : controller.radar.state,
      port: controller.config.get('port')
    },
    config: { ...controller.config.data }
  };
}

function refreshSnapshot() {
  snapshot = buildSnapshot();
  pushEvent('snapshot', snapshot);
  if (tray) refreshTray();
}

function pushEvent(type, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && (type.startsWith('toast') || type.startsWith('updater') || win.isVisible())) {
      win.webContents.send('push:event', { type, ...payload });
    }
  }
}

function showWindowsNotification(title, body) {
  if (Notification.isSupported() && controller && controller.config.get('notifications')) {
    try {
      const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
      new Notification({
        title,
        body,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        silent: true
      }).show();
    } catch (_) {}
  }
}

// ---------- autostart ----------

function applyAutoStart(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    path: process.execPath
  });
}

function getAutoStart() {
  if (app.isPackaged) {
    return app.getLoginItemSettings().openAtLogin;
  }
  return Boolean(controller && controller.config.get('autoStart'));
}

// ---------- tray icons (crisp 32x32 PNG bitmaps) ----------

const TRAY_PNG_DESK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAXUlEQVR4nO3SQQoAIAgEwJ7Ql3tWr6trWBpCKtUueFN2DqaEkORamuWElosIr3IWAYDmmAsAAJgDdhl3AAAgBEAx7wEkkPYWgDsB4U8YDjg5AEwAT8Sy3Ashln+ZDoqHy6bNXpYkAAAAAElFTkSuQmCC';
const TRAY_PNG_AWAY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAg0lEQVR4nO3TMQ6AMAwDwO78f+WXzCA2hCCNncaAiKVuNL5WtLXKKcs8rZnr0XIToSq/RbCD9kgBnqQAmAwDRBIGoCfzfu8CIMXoXhjAvhAaEDm9Z0Y6oPcvFMAE9DazgOMc+Q3IX0EBhgOspAAQDHo73wNkrAK8D6BEXJarEGb5L7MBuujMYhVrKjAAAAAASUVORK5CYII=';
const TRAY_PNG_DEF  = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAXUlEQVR4nO3SQQoAIAgEwB7bE/pFj65rWBpCKtUueFN2DqaEkORSm+WElosIr3IWAYDmmAsAAJgDdhl3AAAgBEAx7wEkkPYWgDsB4U8YDjg5AEwAT8Sy3Ashln+ZDs1pCdFUvqKZAAAAAElFTkSuQmCC';

function makePngIcon(dataUrl) {
  const img = nativeImage.createFromDataURL(dataUrl);
  return img;
}

const TRAY_ICONS = {
  desk: makePngIcon(TRAY_PNG_DESK),
  away: makePngIcon(TRAY_PNG_AWAY),
  default: makePngIcon(TRAY_PNG_DEF)
};

function trayIcon(state) {
  return TRAY_ICONS[state] || TRAY_ICONS.default;
}

function refreshTray() {
  const s = snapshot;
  const stateText = s.state ? STATE_LABEL[s.state] : '—';
  const menu = Menu.buildFromTemplate([
    { label: `Stan: ${stateText}`, enabled: false },
    { label: `Tryb: ${MODE_LABEL[s.mode]}`, enabled: false },
    { label: `Port: ${s.config.port || 'auto'}`, enabled: false },
    { type: 'separator' },
    { label: 'Ustawienia…', click: () => showSettings() },
    {
      label: 'Wycisz / Odcisz mikrofon (Ctrl+Shift+M)',
      click: async () => {
        const res = await controller.audio.toggleMute();
        const isMuted = res?.isMuted;
        pushEvent('toast', { message: isMuted ? 'Mikrofon wyciszony 🔇' : 'Mikrofon aktywny 🎙️' });
        showWindowsNotification('Auto Audio Switch', isMuted ? 'Mikrofon został wyciszony 🔇' : 'Wyciszenie wyłączone 🎙️');
        refreshSnapshot();
      }
    },
    { type: 'separator' },
    {
      label: 'Tryb automatyczny (radar)',
      type: 'radio',
      checked: s.mode === 'auto',
      click: () => controller.setMode('auto')
    },
    {
      label: '🎙️ Wymuś mikrofon stacjonarny',
      type: 'radio',
      checked: s.mode === 'desk',
      click: () => controller.setMode('desk')
    },
    {
      label: '🎧 Wymuś mikrofon mobilny',
      type: 'radio',
      checked: s.mode === 'headset',
      click: () => controller.setMode('headset')
    },
    { type: 'separator' },
    { label: 'Sprawdź aktualizacje…', click: () => { showSettings(); if (updater) updater.checkForUpdates(); } },
    { label: 'Odśwież / wykryj port COM', click: () => restartRadar() },
    { label: 'Wyjdź', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Auto Audio Switch · ${stateText} · ${MODE_LABEL[s.mode]}`);
  tray.setImage(trayIcon(s.state));
}

// ---------- settings window ----------

function showSettings() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow();
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('push:event', { type: 'snapshot', snapshot: buildSnapshot() });
    settingsWindow.show();
    settingsWindow.focus();
  }
}

function createSettingsWindow() {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
  const winIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : trayIcon('away');

  settingsWindow = new BrowserWindow({
    width: 490,
    height: 780,
    minWidth: 480,
    minHeight: 640,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#0d0f14',
    icon: winIcon,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    settingsWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    settingsWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  settingsWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      settingsWindow.hide();
    }
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('state:get', () => buildSnapshot());
  ipcMain.handle('ports:list', () => RadarListener.listPorts());
  ipcMain.handle('state:mode', (_e, mode) => controller.setMode(mode));
  ipcMain.handle('ports:set', async (_e, port) => {
    controller.config.set('port', port);
    await restartRadar();
    return buildSnapshot();
  });
  ipcMain.handle('config:update', (_e, patch) => {
    const prev = {
      baudRate: controller.config.get('baudRate')
    };
    for (const [key, value] of Object.entries(patch || {})) {
      if (key in controller.config.data) controller.config.set(key, value);
    }
    if (typeof patch?.autoStart === 'boolean') applyAutoStart(patch.autoStart);
    applyConfig();
    const radarNeedsRestart = patch && (
      ('baudRate' in patch && patch.baudRate !== prev.baudRate)
    );
    if (radarNeedsRestart) {
      restartRadar();
    } else {
      refreshSnapshot();
    }
    return buildSnapshot();
  });
  ipcMain.handle('devices:list', async () => {
    return await controller.audio.listRecordingDevices(true);
  });
  ipcMain.handle('devices:detect', async () => {
    const devices = await controller.audio.listRecordingDevices(true);
    const recommended = controller.audio.resolveNames(devices);
    return { devices, recommended };
  });
  ipcMain.handle('audio:toggleMute', async (_e, target) => {
    const res = await controller.audio.toggleMute(target);
    refreshSnapshot();
    return res;
  });
  ipcMain.handle('audio:setMute', async (_e, { target, mute }) => {
    const res = await controller.audio.setMute(target, mute);
    refreshSnapshot();
    return res;
  });
  ipcMain.handle('config:reset', () => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      controller.config.set(key, value);
    }
    applyConfig();
    applyAutoStart(controller.config.get('autoStart'));
    restartRadar();
    refreshSnapshot();
    return buildSnapshot();
  });

  ipcMain.handle('config:openDir', () => {
    shell.openPath(appDataDir);
    return true;
  });
  ipcMain.handle('audio:testDevice', async (_e, name) => {
    await controller.audio.setDefaultRecordingDevice(name);
    refreshSnapshot();
    return buildSnapshot();
  });
  ipcMain.handle('display:sleep', async () => {
    return await controller.audio.sleepDisplay();
  });
  ipcMain.handle('display:wake', async () => {
    return await controller.audio.wakeDisplay();
  });

  // Updater IPC
  ipcMain.handle('updater:check', async () => updater ? updater.checkForUpdates() : { available: false });
  ipcMain.handle('updater:download', async () => updater ? updater.downloadUpdate() : null);
  ipcMain.handle('updater:install', async () => updater ? updater.quitAndInstall() : null);
  ipcMain.handle('updater:status', () => updater ? updater.getStatus() : null);

  ipcMain.on('window:close', () => { if (settingsWindow) settingsWindow.hide(); });
}

// ---------- lifecycle ----------

async function restartRadar() {
  await controller.radar.stop();
  await controller.radar.start();
  refreshSnapshot();
}

function applyConfig() {
  controller.radar.config = controller.config;
  controller.audio = createAudioController();
  controller.audio.on('toolStatus', (msg) => pushEvent('toast', { message: msg }));
}

app.setAppUserModelId('com.monratis.autoaudio');

app.whenReady().then(() => {
  const config = new Config(resolveConfigPath());
  const radar = new RadarListener(config);
  const audio = new AudioController({
    binDir: resolveBinDir(),
    toolsDir: path.join(appDataDir, 'tools'),
    config
  });

  controller = new AppController(radar, audio, config);
  updater = new AppUpdater({ onEvent: (ev) => pushEvent(ev.type, ev), config });

  audio.on('toolStatus', (msg) => pushEvent('toast', { message: msg }));
  applyAutoStart(config.get('autoStart'));

  controller.on('switch', ({ state, device, unconfigured }) => {
    if (unconfigured) {
      console.log('[main] switch: mikrofony nie zostały jeszcze skonfigurowane przez użytkownika');
      return;
    }
    console.log(`[main] switch -> ${state}: ${device}`);
    pushEvent('switch', { state, device });
    pushEvent('toast', { message: `Przełączono mikrofon: ${device}` });
    showWindowsNotification('Auto Audio Switch', `Aktywny mikrofon: ${device}`);
    refreshSnapshot();
  });
  controller.on('displayState', (disp) => {
    pushEvent('toast', {
      message: disp === 'sleep' ? '🖥️ Ekrany uśpione (brak obecności)' : '🖥️ Ekrany wybudzone'
    });
  });
  controller.on('switched', async ({ state, device, ok }) => {
    if (!ok && device) {
      pushEvent('toast', { error: true, message: `Nie udało się aktywować mikrofonu: ${device}` });
    }
    refreshSnapshot();
  });
  controller.on('radarStatus', (s) => {
    if (s && s.connected === true) {
      radarIssueToastShown = false;
    } else if (s && s.error && !radarIssueToastShown) {
      radarIssueToastShown = true;
      pushEvent('toast', { error: true, message: 'Radar niedostępny — ponawiam połączenie…' });
    }
    refreshSnapshot();
  });
  controller.on('error', (err) => {
    console.error('[main] error:', err.message);
    pushEvent('toast', { error: true, message: `Błąd: ${err.message}` });
    refreshSnapshot();
  });
  controller.on('mode', () => refreshSnapshot());

  tray = new Tray(trayIcon('away'));
  tray.on('click', () => showSettings());
  tray.on('double-click', () => showSettings());

  registerIpc();
  createSettingsWindow();
  refreshSnapshot();
  controller.start();

  // Global hotkey: Ctrl+Shift+M (lub Cmd+Shift+M) -> szybkie wyciszenie/odciszenie
  try {
    globalShortcut.register('CommandOrControl+Shift+M', async () => {
      const res = await controller.audio.toggleMute();
      const isMuted = res?.isMuted;
      pushEvent('toast', { message: isMuted ? 'Mikrofon wyciszony 🔇' : 'Mikrofon aktywny 🎙️' });
      showWindowsNotification('Auto Audio Switch', isMuted ? 'Mikrofon został wyciszony 🔇' : 'Wyciszenie mikrofonu wyłączone 🎙️');
      refreshSnapshot();
    });
  } catch (err) {
    console.warn('[main] globalShortcut register error:', err.message);
  }

  // Ciche sprawdzenie aktualizacji w tle po 5 sekundach od uruchomienia
  setTimeout(() => {
    if (updater) {
      updater.checkForUpdates().catch(() => {});
    }
  }, 5000);
});

app.on('second-instance', () => {
  showSettings();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
});

// Aplikacja działa w tray — zamknięcie okien nie kończy procesu.
app.on('window-all-closed', () => {
  // keep running in tray
});