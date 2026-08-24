import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import Config, { DEFAULTS } from './config';
import RadarListener from './radarListener';
import AudioController from './audioController';
import AppController from './appController';

let tray = null;
let settingsWindow = null;
let controller = null;
let snapshot = null;
let radarIssueToastShown = false;

const STATE_LABEL = { desk: 'Przy biurku', away: 'Poza biurkiem' };
const MODE_LABEL = { auto: 'Auto (radar)', desk: 'QuadCast 2', headset: 'Słuchawki' };

// ---------- paths ----------

function resolveConfigPath() {
  if (!app.isPackaged) {
    const dev = path.join(__dirname, '..', '..', 'config.json');
    if (fs.existsSync(dev)) return dev;
  }
  // portable: konfiguracja trwała obok exe (przenośność między uruchomieniami)
  const exeDir = path.join(path.dirname(process.execPath), 'config.json');
  if (app.isPackaged && fs.existsSync(exeDir)) return exeDir;
  // wbudowana kopia startowa (szablon)
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'config.json') : null;
  if (bundled && fs.existsSync(bundled)) return bundled;
  return path.join(app.getPath('userData'), 'config.json');
}

function resolveBinDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin');
  return path.join(__dirname, '..', '..', 'bin');
}

function createAudioController() {
  return new AudioController({
    binDir: resolveBinDir(),
    toolsDir: path.join(app.getPath('userData'), 'tools'),
    config: controller ? controller.config : null
  });
}

// ---------- samoleczenie ----------

/**
 * Po nieudanym przełączeniu próbuje wykryć prawidłową nazwę urządzenia
 * i ponawia przełączenie. Zwraca poprawioną nazwę albo null.
 */
async function autoHealDeviceName(state) {
  if (!controller.config.get('autoDetectDevices')) return null;
  const devices = await controller.audio.listRecordingDevices();
  if (!devices.length) return null;
  const rec = controller.audio.resolveNames(devices);
  const key = state === 'desk' ? 'micDeskName' : 'micHeadsetName';
  const desired = state === 'desk' ? rec.micDeskName : rec.micHeadsetName;
  const current = controller.config.get(key);
  if (desired && desired !== current && devices.some((d) => d.name === desired)) {
    controller.config.set(key, desired);
    const res = await controller.audio.setDefaultRecordingDevice(desired);
    if (res.ok) return desired;
  }
  return null;
}

/**
 * Przy starcie sprawdza, czy nazwy z konfiguracji istnieją na liście
 * urządzeń; jeśli nie — automatycznie je poprawia.
 */
async function autoDetectOnStartup() {
  if (!controller.config.get('autoDetectDevices')) return;
  const devices = await controller.audio.listRecordingDevices();
  if (!devices.length) return;
  const rec = controller.audio.resolveNames(devices);
  let changed = false;
  if (rec.micDeskName && !devices.some((d) => d.name === controller.config.get('micDeskName')) && devices.some((d) => d.name === rec.micDeskName)) {
    controller.config.set('micDeskName', rec.micDeskName);
    changed = true;
  }
  if (rec.micHeadsetName && !devices.some((d) => d.name === controller.config.get('micHeadsetName')) && devices.some((d) => d.name === rec.micHeadsetName)) {
    controller.config.set('micHeadsetName', rec.micHeadsetName);
    changed = true;
  }
  if (changed) {
    pushEvent('toast', { message: 'Automatycznie poprawiono nazwy urządzeń audio' });
    refreshSnapshot();
  }
}

// ---------- snapshot / events ----------

function buildSnapshot() {
  const radarConnected = controller.config.get('mockMode')
    ? true
    : Boolean(controller.radar.port && controller.radar.port.isOpen);
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
    if (!win.isDestroyed()) {
      win.webContents.send('push:event', { type, ...payload });
    }
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
  // w dev tylko zapis w configu
  return Boolean(controller && controller.config.get('autoStart'));
}

// ---------- tray ----------

function trayIcon(state) {
  const color = state === 'desk' ? '#34d399' : (state === 'away' ? '#f59e0b' : '#8b93a3');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">
    <rect width="24" height="24" rx="6" fill="${color}"/>
    <circle cx="12" cy="10" r="5" fill="#0d0f14"/>
    <circle cx="12" cy="10" r="2.6" fill="#fff"/>
    <rect x="5" y="17.5" width="14" height="2.6" rx="1.3" fill="#0d0f14"/>
  </svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  img.setTemplateImage(false);
  return img;
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
    { type: 'separator' },
    {
      label: 'Tryb automatyczny (radar)',
      type: 'radio',
      checked: s.mode === 'auto',
      click: () => controller.setMode('auto')
    },
    {
      label: 'Wymuś mikrofon: QuadCast 2',
      type: 'radio',
      checked: s.mode === 'desk',
      click: () => controller.setMode('desk')
    },
    {
      label: 'Wymuś mikrofon: Słuchawki',
      type: 'radio',
      checked: s.mode === 'headset',
      click: () => controller.setMode('headset')
    },
    { type: 'separator' },
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
  settingsWindow.show();
  settingsWindow.focus();
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 470,
    height: 740,
    minWidth: 470,
    minHeight: 640,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#0d0f14',
    icon: trayIcon(controller ? controller.currentDevice : 'away'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
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
      mockMode: controller.config.get('mockMode'),
      baudRate: controller.config.get('baudRate')
    };
    for (const [key, value] of Object.entries(patch || {})) {
      if (key in controller.config.data) controller.config.set(key, value);
    }
    if (typeof patch?.autoStart === 'boolean') applyAutoStart(patch.autoStart);
    applyConfig();
    const radarNeedsRestart = patch && (
      ('mockMode' in patch && patch.mockMode !== prev.mockMode) ||
      ('baudRate' in patch && patch.baudRate !== prev.baudRate)
    );
    if (radarNeedsRestart) {
      restartRadar();
    } else {
      refreshSnapshot();
    }
    return buildSnapshot();
  });
  ipcMain.handle('devices:detect', async () => {
    const devices = await controller.audio.listRecordingDevices();
    const recommended = controller.audio.resolveNames(devices);
    let applied = false;
    if (devices.length) {
      const fix = (key, want) => {
        if (want && !devices.some((d) => d.name === controller.config.get(key)) && devices.some((d) => d.name === want)) {
          controller.config.set(key, want);
          applied = true;
        }
      };
      fix('micDeskName', recommended.micDeskName);
      fix('micHeadsetName', recommended.micHeadsetName);
    }
    refreshSnapshot();
    return { devices, recommended, applied };
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
    toolsDir: path.join(app.getPath('userData'), 'tools'),
    config
  });

  controller = new AppController(radar, audio, config);
  audio.on('toolStatus', (msg) => pushEvent('toast', { message: msg }));
  applyAutoStart(config.get('autoStart'));

  controller.on('switch', ({ state, device }) => {
    console.log(`[main] switch -> ${state}: ${device}`);
    pushEvent('toast', { message: `Przełączono mikrofon: ${device}` });
    refreshSnapshot();
  });
  controller.on('switched', async ({ state, ok }) => {
    if (!ok) {
      const healed = await autoHealDeviceName(state);
      if (healed) {
        pushEvent('toast', { message: `Poprawiono nazwę urządzenia: ${healed}` });
      } else {
        pushEvent('toast', { error: true, message: 'Nie udało się ustawić mikrofonu' });
      }
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
  controller.start().then(() => autoDetectOnStartup());
});

app.on('before-quit', () => { app.isQuitting = true; });

// Aplikacja działa w tray — zamknięcie okien nie kończy procesu.
app.on('window-all-closed', () => {
  // keep running in tray
});