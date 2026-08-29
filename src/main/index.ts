import { app, BrowserWindow, globalShortcut, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import Config from './config';
import RadarListener from './radarListener';
import AudioController from './audioController';
import AppController from './appController';
import AppUpdater from './updater';
import DiscordIntegration from './discordIntegration';
import SignalRGBIntegration from './signalrgbIntegration';
import HomeAssistantIntegration from './haIntegration';
import DeviceWatcher from './deviceWatcher';
import ActivityWatcher from './activityWatcher';
import ScreenManager from './screenManager';
import type { AppContext } from './appContext';
import type { DeviceState } from '../shared/types';
import {
  getAppDataDir,
  cleanupStaleUpdateFiles,
  ensureToastShortcut,
  resolveConfigPath,
  resolveBinDir,
  applyAutoStart,
  createNotification,
  toggleMuteWithFeedback
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

// Jw. dla wyjątków: domyślnie Electron rzuca modalny dialog "JavaScript error
// in the main process" i zabija aplikację. Wyścigi zamknięcia portu COM
// (GetOverlappedResult: Operation aborted) są niegroźne — logujemy i żyjemy.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err.stack || err.message);
});

let ctx: AppContext | null = null;
let tray: Electron.Tray | null = null;
let deviceWatcher: DeviceWatcher | null = null;
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
    ha: ctx.ha.getStatus(),
    telemetry: ctx.radar.telemetry,
    config: { ...ctx.config.data },
    snoozeUntil: ctx.controller.getSnoozeUntil()
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
    createNotification(title, body, ctx.config.get('notifications'), () => {
      if (ctx) showSettings(ctx);
    });
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
  const activityWatcher = new ActivityWatcher(config);
  const radar = new RadarListener(config);
  radar.setActivityWatcher(activityWatcher);
  const audio = new AudioController({
    binDir: resolveBinDir(),
    toolsDir: path.join(appDataDir, 'tools'),
    config
  });
  const discord = new DiscordIntegration(config);
  const signalrgb = new SignalRGBIntegration({ config });
  const ha = new HomeAssistantIntegration({ config, radar });
  const screen = new ScreenManager(config, audio);

  const controller = new AppController(radar, audio, config, screen, discord, signalrgb);
  const updater = new AppUpdater({ onEvent: (ev) => pushEvent(ev.type, ev), config });

  audio.on('toolStatus', (msg: string) => pushEvent('toast', { message: msg }));
  radar.on('telemetry', (tel) => pushEvent('telemetry', tel));
  ha.on('status', () => refreshSnapshot());

  controller.on('switch', (ev) => {
    if (ev.device) {
      appendLog('AUDIO', `Przełączanie mikrofonu: "${ev.device}" (${ev.state === 'desk' ? 'Stacjonarny' : 'Mobilny'}) | zmiana: ${ev.switched ? 'TAK' : 'NIE'}`);
    }
  });

  controller.on('switched', (ev) => {
    appendLog('AUDIO', `Potwierdzono stan domyślnego mikrofonu: "${ev.device}" (${ev.state}) ✓`);
  });

  controller.on('mode', (mode) => {
    appendLog('MODE', `Zmiana trybu pracy aplikacji: ${mode.toUpperCase()}`);
  });

  radar.on('status', (s) => {
    if (s.state) {
      appendLog('RADAR', `Stan obecności: ${s.presence ? 'OBECNY' : 'BRAK'} | Tryb: ${s.state} | Dystans: ${s.telemetry?.distanceCm ?? '--'} cm`);
    }
  });

  applyAutoStart(config.get('autoStart'));

  ctx = {
    config,
    radar,
    audio,
    controller,
    screen,
    activityWatcher,
    updater,
    signalrgb,
    ha,
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
  // Synchronizacja mikrofonu z Discordem nie powiodła się — błąd MUSI być
  // widoczny w UI. Cooldown chroni przed spamem przy każdej zmianie stanu,
  // gdy Discord jest np. wyłączony na dłużej.
  let lastDiscordSyncToastAt = 0;
  controller.on('discordSyncError', (p: { reason?: string; device: string | null }) => {
    appendLog('DISCORD', `Synchronizacja wejścia z Discordem nieudana (${p.reason ?? 'nieznany powód'}) — "${p.device || 'default'}"`);
    const now = Date.now();
    if (now - lastDiscordSyncToastAt < 10 * 60 * 1000) return;
    lastDiscordSyncToastAt = now;
    const powod =
      p.reason === 'not_connected'
        ? 'Discord nie uruchomiony'
        : p.reason === 'not_ready'
          ? 'Discord nie odpowiedział na handshake'
          : p.reason === 'rejected'
            ? 'Discord odrzucił zmianę'
            : 'nieznany powód';
    pushEvent('toast', { error: true, message: `Discord: nie zsynchronizowano mikrofonu (${powod})` });
    refreshSnapshot();
  });
  controller.on('mode', () => refreshSnapshot());

  tray = createTray(ctx);

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') return callback(true);
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'media') return true;
    return false;
  });

  registerIpc(ctx);
  createSettingsWindow(ctx);
  refreshSnapshot();
  activityWatcher.start();
  void controller.start();
  void ha.start();

  // Watchdog urządzeń: wykrywa podłączanie/odłączanie mikrofonów i portów COM
  // w tle (niezależnie od widoczności okna) i wypycha zmiany do UI.
  deviceWatcher = new DeviceWatcher(audio, {
    devicesChanged: (devices, added, removed) => {
      ctx!.pushEvent('devices:changed', { devices, added, removed });
      if (added.length > 0) {
        pushEvent('toast', { message: `Wykryto nowy mikrofon: ${added.join(', ')}` });
      }
      refreshSnapshot();
    },
    portsChanged: (ports, added, removed) => {
      ctx!.pushEvent('ports:changed', { ports, added, removed });
      if (added.length > 0) {
        // Nowy port COM może być radarem — przyspiesz przekierowanie połączenia,
        // ale tylko gdy radar faktycznie nie jest podłączony (nie rozłączaj aktywnego).
        const radarConnected = Boolean(ctx!.radar.port && ctx!.radar.port.isOpen);
        if (!radarConnected) ctx!.restartRadar();
      }
      refreshSnapshot();
    }
  });
  deviceWatcher.start();

  // Wygrzanie daemona audio w tle — pierwsze przełączenie mikrofonu
  // bez cold-startu procesu.
  void audio.warmup();

  // Global hotkey: Ctrl+Shift+M -> szybkie wyciszenie/odciszenie
  try {
    const registered = globalShortcut.register(config.get('globalShortcut'), () => {
      // Wspólny helper (dioda + toast + powiadomienie + snapshot) — ten sam,
      // którego używa menu tray i IPC audio:toggleMute.
      void toggleMuteWithFeedback(ctx!);
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
          ctx!.config.get('notifications'),
          () => {
            if (ctx) showSettings(ctx);
          }
        );
      })
      .catch(() => {});
  }, 1500);
});

app.on('second-instance', () => {
  if (ctx) showSettings(ctx);
});

let isCleanedUp = false;

app.on('before-quit', (e) => {
  if (isCleanedUp) return;
  e.preventDefault();
  (app as Electron.App & { isQuitting?: boolean }).isQuitting = true;
  globalShortcut.unregisterAll();

  // Asynchroniczne sprzątanie: zwalnia port COM, zatrzymuje kontrolery i ubija daemony
  const cleanupTasks: Promise<unknown>[] = [];
  if (ctx) {
    ctx.activityWatcher.stop();
    cleanupTasks.push(
      ctx.controller.stop().catch(() => {}),
      ctx.ha.stop().catch(() => {})
    );
    ctx.audio.shutdown();
  }
  deviceWatcher?.stop();
  cleanupStaleUpdateFiles();

  void Promise.all(cleanupTasks).finally(() => {
    isCleanedUp = true;
    app.quit();
  });
});

const forceCleanup = () => {
  if (ctx) {
    try {
      ctx.screen.stop();
      ctx.audio.shutdown();
      if (ctx.radar.port) {
        ctx.radar.port.removeAllListeners();
        // Odbiorca dla porzuconych zapisów — bez tego abort portu przy wyjściu
        // kończy się nieprzechwyconym wyjątkiem i modalem "JavaScript error".
        ctx.radar.port.on('error', () => {});
        if (ctx.radar.port.isOpen) ctx.radar.port.close(() => {});
        ctx.radar.port.destroy();
      }
    } catch {}
  }
};

process.on('exit', forceCleanup);
process.on('SIGINT', () => {
  forceCleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  forceCleanup();
  process.exit(0);
});

// Aplikacja działa w tray — zamknięcie okien nie kończy procesu (czytanie radaru w tle).
app.on('window-all-closed', () => {
  // keep running in tray
});
