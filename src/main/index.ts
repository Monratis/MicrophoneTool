import { app, BrowserWindow, dialog, globalShortcut } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import Config from './config';
import RadarListener from './radarListener';
import AudioController from './audioController';
import AppController from './appController';
import AppUpdater from './updater';
import SensorFlasher from './sensorFlasher';
import DiscordIntegration from './discordIntegration';
import SignalRGBIntegration from './signalrgbIntegration';
import type { AppContext } from './appContext';
import type { DeviceState } from '../shared/types';
import {
  getAppDataDir,
  cleanupStaleUpdateFiles,
  ensureToastShortcut,
  resolveConfigPath,
  resolveBinDir,
  resolveAppIcon,
  applyAutoStart,
  createNotification
} from './appContext';
import { interceptConsole, setLogSink, appendLog } from './logger';
import { createTray, refreshTray } from './tray';
import { createSettingsWindow, showSettings, getSettingsWindow } from './settingsWindow';
import { registerIpc } from './ipc';

// Performance App Flags
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

// Single instance lock
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
  process.exit(0);
}

interceptConsole();

// Siatka bezpieczeństwa dla apki żyjącej w tray tygodniami: przyszły
// nieobsłużony rejection logujemy zamiast ryzykować śmierć procesu.
process.on('unhandledRejection', (reason) => {
  console.warn('[main] unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});

let ctx: AppContext | null = null;
let tray: Electron.Tray | null = null;
let radarIssueToastShown = false;
let lastRadarIssueToastAt = 0;
let lastSnapshotPush = 0;
let snapshotPushTimer: ReturnType<typeof setTimeout> | null = null;

// ---------- snapshot / events ----------

function buildSnapshot() {
  if (!ctx) throw new Error('ctx not ready');
  const radarConnected = Boolean(ctx.radar.port && ctx.radar.port.isOpen);
  return {
    version: app.getVersion(),
    mode: ctx.controller.mode,
    state: ctx.controller.currentDevice,
    deviceName:
      ctx.controller.currentDevice === 'desk'
        ? ctx.config.get('micDeskName')
        : ctx.controller.currentDevice === 'headset'
          ? ctx.config.get('micHeadsetName')
          : null,
    radar: {
      connected: radarConnected,
      presence: ctx.radar.presence,
      pendingState:
        ctx.radar.state ?? (ctx.radar.presence ? ('desk' as const) : ('away' as const)),
      port: ctx.config.get('port')
    },
    telemetry: ctx.radar.telemetry,
    config: { ...ctx.config.data }
  };
}

function pushEvent(type: string, payload: Record<string, unknown> = {}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // Apka w tray: ukryte okno dostaje WYŁĄCZNIE 'switch' (chime gra w rendererze).
    // Toasty/telemetria/updater bez widocznego okna to czysty odpad IPC.
    if (!win.isDestroyed() && (win.isVisible() || type === 'switch')) {
      win.webContents.send('push:event', { type, ...payload });
    }
  }
}

function showWindowsNotification(title: string, body: string): void {
  if (ctx) {
    createNotification(title, body, ctx.config.get('notifications'));
  }
}

async function restartRadar(): Promise<void> {
  if (!ctx) return;
  await ctx.radar.stop();
  await ctx.radar.start();
  refreshSnapshot();
}

function refreshSnapshot(): void {
  if (!ctx || !tray) return;
  // Throttle: radarStatus potrafi leć co ~2 s przy niestabilnym połączeniu;
  // bez limitu każdy event = rebuild menu tray + broadcast do okien.
  const now = Date.now();
  if (now - lastSnapshotPush < 400) {
    if (!snapshotPushTimer) {
      snapshotPushTimer = setTimeout(() => {
        snapshotPushTimer = null;
        refreshSnapshot();
      }, 400);
    }
    return;
  }
  lastSnapshotPush = now;
  pushEvent('snapshot', { snapshot: buildSnapshot() });
  refreshTray(ctx, tray);
}

// ---------- lifecycle ----------

app.setAppUserModelId('com.monratis.desksense');

app.whenReady().then(() => {
  cleanupStaleUpdateFiles();
  ensureToastShortcut();

  const appDataDir = getAppDataDir();
  try {
    fs.mkdirSync(appDataDir, { recursive: true });
    app.setPath('userData', appDataDir);
  } catch (err) {
    console.warn('[main] setup appDataDir warning:', (err as Error).message);
  }

  setLogSink((entry) => {
    const win = getSettingsWindow();
    // Logi przez IPC tylko gdy okno (z modalem logów) faktycznie widać —
    // inaczej każdy console.log to bezużyteczny IPC w tle.
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.webContents.send('push:event', { type: 'log:entry', entry });
    }
  });

  const config = new Config(resolveConfigPath(appDataDir));
  const radar = new RadarListener(config);
  const audio = new AudioController({
    binDir: resolveBinDir(),
    toolsDir: path.join(appDataDir, 'tools'),
    config
  });
  const discord = new DiscordIntegration(config);
  const signalrgb = new SignalRGBIntegration({ config });

  const controller = new AppController(radar, audio, config, discord, signalrgb);
  const updater = new AppUpdater({ onEvent: (ev) => pushEvent(ev.type, ev), config });
  const sensorFlasher = new SensorFlasher({ config, radar, onEvent: (ev) => pushEvent(ev.type, ev) });

  audio.on('toolStatus', (msg: string) => pushEvent('toast', { message: msg }));
  radar.on('telemetry', (tel) => pushEvent('telemetry', tel));
  applyAutoStart(config.get('autoStart'));

  ctx = {
    config,
    radar,
    audio,
    controller,
    updater,
    sensorFlasher,
    signalrgb,
    appDataDir,
    settingsWindow: null,
    buildSnapshot,
    pushEvent,
    refreshSnapshot,
    restartRadar,
    showSettings: () => showSettings(ctx!),
    showWindowsNotification,
    applyAutoStart
  };

  controller.on('switch', ({ state, device, unconfigured }) => {
    if (unconfigured) {
      console.log('[main] switch: mikrofony nie zostały jeszcze skonfigurowane przez użytkownika');
      return;
    }
    // Sam sygnał zmiany — chime gra od razu; toasty/powiadomienia dopiero
    // po POTWIERDZONYM wyniku w handlerze 'switched' (wcześniej user
    // dostawał sprzeczne "Przełączono" + "Nie udało się" naraz).
    pushEvent('switch', { state, device });
    refreshSnapshot();
  });
  controller.on('displayState', (disp: string) => {
    pushEvent('toast', {
      message: disp === 'sleep' ? '🖥️ Ekrany uśpione (brak obecności)' : '🖥️ Ekrany wybudzone'
    });
  });
  controller.on('switched', (p: { state: DeviceState; device?: string | null; ok: boolean; switched?: boolean }) => {
    appendLog('APP', `switched state=${p.state} device=${p.device} ok=${p.ok} switched=${p.switched}`);
    if (p.ok && p.switched && p.device) {
      pushEvent('toast', { message: `Przełączono mikrofon: ${p.device}` });
      const chimeWillPlay =
        ctx!.config.get('audioChime') &&
        (p.state === 'desk'
          ? ctx!.config.get('audioChimeOnDesk') !== false
          : ctx!.config.get('audioChimeOnAway') !== false);
      if (!chimeWillPlay) {
        showWindowsNotification('DeskSense', `Aktywny mikrofon: ${p.device}`);
      }
    } else if (!p.ok && p.device) {
      pushEvent('toast', { error: true, message: `Nie udało się aktywować mikrofonu: ${p.device} — ponawiam w tle` });
    }
    refreshSnapshot();
  });
  controller.on('radarStatus', (s: { connected?: boolean; error?: string }) => {
    if (s && s.connected === true) {
      radarIssueToastShown = false;
    } else if (s && s.error && !radarIssueToastShown) {
      // Cooldown czasowy: flaky kabel/sensor nie może spamować toastem co epizod
      const now = Date.now();
      if (now - lastRadarIssueToastAt > 10 * 60 * 1000) {
        radarIssueToastShown = true;
        lastRadarIssueToastAt = now;
        pushEvent('toast', { error: true, message: 'Radar niedostępny — ponawiam połączenie…' });
      }
    }
    refreshSnapshot();
  });
  controller.on('error', (err: Error) => {
    console.error('[main] error:', err.message);
    pushEvent('toast', { error: true, message: `Błąd: ${err.message}` });
    refreshSnapshot();
  });
  controller.on('mode', () => refreshSnapshot());

  tray = createTray(ctx);

  registerIpc(ctx);
  createSettingsWindow(ctx);
  refreshSnapshot();
  void controller.start();

  // Wygrzanie daemona audio w tle — pierwsze przełączenie mikrofonu
  // bez cold-startu procesu.
  void audio.warmup();

  // Global hotkey: Ctrl+Shift+M -> szybkie wyciszenie/odciszenie
  try {
    const registered = globalShortcut.register(config.get('globalShortcut'), async () => {
      const res = await ctx!.audio.toggleMute();
      const isMuted = res?.isMuted;
      pushEvent('toast', { message: isMuted ? 'Mikrofon wyciszony 🔇' : 'Mikrofon aktywny 🎙️' });
      showWindowsNotification(
        'DeskSense',
        isMuted ? 'Mikrofon został wyciszony 🔇' : 'Wyciszenie mikrofonu wyłączone 🎙️'
      );
      refreshSnapshot();
    });
    // register() zwraca false gdy skrót zajęty przez inną apkę — bez tego
    // awaria przechodzi zupełnie po cichu.
    if (!registered) {
      console.warn(`[main] globalShortcut '${config.get('globalShortcut')}' zajęty — skrót wyłączony`);
      pushEvent('toast', { error: true, message: 'Skrót Ctrl+Shift+M zajęty przez inną aplikację' });
    }
  } catch (err) {
    console.warn('[main] globalShortcut register error:', (err as Error).message);
  }

  // Ciche sprawdzenie aktualizacji w tle po 5 sekundach od uruchomienia
  setTimeout(() => {
    void updater.checkForUpdates().catch(() => {});
  }, 5000);

  // Powiadomienie startowe: apka siedzi w tray i mówi krótko, że działa
  // oraz jaki mikrofon jest teraz aktywny. Po 1,5 s — żeby nie kolidować
  // z logowaniem Windows przy autostarcie.
  setTimeout(() => {
    if (!ctx) return;
    void ctx.audio
      .getCurrentDefault()
      .then((current) => {
        const name =
          current?.name ||
          ctx!.config.get('micDeskName') ||
          ctx!.config.get('micHeadsetName') ||
          'nie wykryto';
        createNotification(
          'DeskSense',
          `Wystartowała w tle. Aktywny mikrofon: ${name}`,
          ctx!.config.get('notifications')
        );
      })
      .catch(() => {});
  }, 1500);
});

app.on('second-instance', () => {
  if (ctx) showSettings(ctx);
});

let forceQuitAfterWarn = false;

app.on('before-quit', (e) => {
  // Twarda zasada: nigdy nie ubijamy esptool w połowie zapisu flash.
  // Furtka: świadome "Zamknij mimo to" — użytkownik musi potwierdzić ryzyko,
  // inaczej zawieszony flash zamieniłby apkę w niezanikalną.
  if (ctx?.sensorFlasher.isFlashing && !forceQuitAfterWarn) {
    e.preventDefault();
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'DeskSense',
      message: 'Trwa wgrywanie firmware sensora.',
      detail: 'Przerwanie w połowie zapisu może wymagać awaryjnego wgrywania przez tryb ratunkowy.',
      buttons: ['Czekaj na zakończenie', 'Zamknij mimo to'],
      defaultId: 0,
      cancelId: 0
    });
    if (choice === 1) {
      forceQuitAfterWarn = true;
      app.quit();
    }
    return;
  }
  (app as Electron.App & { isQuitting?: boolean }).isQuitting = true;
  globalShortcut.unregisterAll();
  // Sprzątanie: zatrzymaj radar i ubij rezydentny daemon AudioSwitcher.exe,
  // inaczej proces dziecka zostaje jako sierota po zamknięciu aplikacji.
  if (ctx) {
    void ctx.controller.stop();
    ctx.audio.shutdown();
  }
  cleanupStaleUpdateFiles();
});

// Aplikacja działa w tray — zamknięcie okien nie kończy procesu.
app.on('window-all-closed', () => {
  // keep running in tray
});

export { resolveAppIcon };
