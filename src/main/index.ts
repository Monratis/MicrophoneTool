import { app, BrowserWindow, session } from 'electron';
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
import { VoiceManager } from './voiceManager';
import { initVoiceOsd, showVoiceOsd, closeVoiceOsd } from './voiceOsd';
import { shortcutManager } from './shortcutManager';
import DeviceWatcher from './deviceWatcher';
import ActivityWatcher from './activityWatcher';
import ScreenManager from './screenManager';
import { FirmwareFlasher } from './firmwareFlasher';
import type { AppContext } from './appContext';
import type { DeviceState } from '../shared/types';
import {
  getAppDataDir,
  cleanupStaleUpdateFiles,
  ensureToastShortcut,
  resolveConfigPath,
  resolveBinDir,
  applyAutoStart,
  toggleMuteWithFeedback
} from './appContext';
import { interceptConsole, setLogSink, appendLog } from './logger';
import { createTray, refreshTray } from './tray';
import { createSettingsWindow, showSettings, getSettingsWindow } from './settingsWindow';
import { registerIpc } from './ipc';

// Performance App Flags
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch(
  'disable-features',
  'HardwareMediaKeyHandling,SpareRendererForSitePerProcess'
);

// Konfiguracja katalogu danych użytkownika PRZED requestSingleInstanceLock i whenReady
const appDataDir = getAppDataDir();
try {
  fs.mkdirSync(appDataDir, { recursive: true });
  app.setPath('userData', appDataDir);
} catch (err) {
  console.warn('[main] setup appDataDir warning:', (err as Error).message);
}

app.setAppUserModelId('com.monratis.desksense');

// Single instance lock
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (ctx) showSettings(ctx);
});

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
  // Tokeny OAuth Discorda nie trafiają do renderera — zarządza nimi wyłącznie
  // discordIntegration.ts, a ich obecność w formularzu powodowała nadpisywanie
  // świeżo odświeżonych tokenów starymi kopiami przy zapisie ustawień.
  const { discordAccessToken: _a, discordRefreshToken: _r, discordTokenExpiresAt: _e, ...safeConfig } = ctx.config.data;
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
    discord: ctx.controller.discord ? ctx.controller.discord.getStatus() : undefined,
    voice: ctx.voice ? ctx.voice.getStatus() : undefined,
    telemetry: ctx.radar.telemetry,
    config: safeConfig as typeof ctx.config.data,
    snoozeUntil: ctx.controller.getSnoozeUntil()
  };
}

function pushEvent(type: string, payload: Record<string, unknown> = {}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // Apka w tray: ukryte okno dostaje dźwięki 'switch' oraz 'voice:playChime' (chime gra w rendererze przez Web Audio).
    // Toasty/telemetria/updater bez widocznego okna to czysty odpad IPC.
    if (!win.isDestroyed() && (win.isVisible() || type === 'switch' || type === 'voice:playChime')) {
      win.webContents.send('push:event', { type, ...payload });
    }
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

app.whenReady().then(() => {
  appendLog('SYSTEM', `DeskSense start: version=${app.getVersion()}, isPackaged=${app.isPackaged}, execPath="${process.execPath}", resourcesPath="${process.resourcesPath}", appDataDir="${appDataDir}"`);
  cleanupStaleUpdateFiles();
  ensureToastShortcut();
  initVoiceOsd();

  setLogSink((entry) => {
    const win = getSettingsWindow();
    // Logi przez IPC tylko gdy okno (z modalem logów) faktycznie widać —
    // inaczej każdy console.log to bezużyteczny IPC w tle.
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.webContents.send('push:event', { type: 'log:entry', entry });
    }
  });

  const config = new Config(resolveConfigPath(appDataDir));
  config.upgradeEncryption();
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

  const controller = new AppController(radar, audio, config, screen, discord, signalrgb, ha);
  const updater = new AppUpdater({ onEvent: (ev) => pushEvent(ev.type, ev), config });

  // Przyciski HAOS sterujące apką: snooze = pauza/wznowienie automatyki (15 min),
  // mute = ten sam pełny feedback co skrót globalny (dioda + toast + powiadomienie).
  ha.setCommandHandlers({
    snoozeToggle: () => {
      if (!ctx) return;
      ctx.controller.setSnooze(ctx.controller.isSnoozed() ? 0 : 15);
      refreshSnapshot();
    },
    muteToggle: () => {
      if (!ctx) return;
      void toggleMuteWithFeedback(ctx);
    }
  });

  audio.on('toolStatus', (msg: string) => pushEvent('toast', { message: msg }));
  radar.on('telemetry', (tel) => pushEvent('telemetry', tel));
  ha.on('status', () => refreshSnapshot());
  discord.on('status', () => refreshSnapshot());
  discord.on('authenticated', () => refreshSnapshot());

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
    voice: undefined,
    flasher: undefined as any,
    appDataDir,
    settingsWindow: null,
    buildSnapshot,
    pushEvent,
    refreshSnapshot,
    restartRadar,
    showSettings: () => showSettings(ctx!),
    applyAutoStart
  };

  const flasher = new FirmwareFlasher(ctx);
  ctx.flasher = flasher;

  // VoiceManager potrzebuje pełnego kontekstu DI — budujemy go po utworzeniu ctx
  const voice = new VoiceManager(ctx);
  ctx.voice = voice;
  void voice.init();

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
    voice.onDeviceSwitched(p.state);
    if (p.ok && p.switched && p.device) {
      pushEvent('toast', { message: `Przełączono mikrofon: ${p.device}` });
      showVoiceOsd(
        `Aktywny: ${p.device}`,
        'ok',
        2400,
        p.state === 'desk' ? 'DeskSense · Mikrofon Biurkowy' : 'DeskSense · Mikrofon Mobilny'
      );
      const chimeWillPlay =
        ctx!.config.get('audioChime') &&
        (p.state === 'desk'
          ? ctx!.config.get('audioChimeOnDesk') !== false
          : ctx!.config.get('audioChimeOnAway') !== false);
      if (!chimeWillPlay) {
        pushEvent('toast', { message: `Aktywny mikrofon: ${p.device}` });
      }
    } else if (!p.ok && p.device) {
      pushEvent('toast', { error: true, message: `Nie udało się aktywować mikrofonu: ${p.device} — ponawiam w tle` });
      showVoiceOsd(`Błąd przełączania: ${p.device}`, 'blocked', 3000);
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

  // Błąd autoryzacji tokena Home Assistant — użytkownik musi zostać powiadomiony,
  // a token pozostaje nienaruszony w konfiguracji.
  let lastHaAuthErrorToastAt = 0;
  ha.on('authError', (p: { message: string }) => {
    appendLog('HAOS', `Błąd autoryzacji HAOS: ${p.message}`);
    const now = Date.now();
    if (now - lastHaAuthErrorToastAt < 5 * 60 * 1000) return;
    lastHaAuthErrorToastAt = now;
    pushEvent('toast', { error: true, message: `🏠 HAOS: ${p.message}` });
    refreshSnapshot();
  });

  controller.on('mode', () => refreshSnapshot());
  controller.on('snooze', () => refreshSnapshot());

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
      controller.onDevicesChanged(devices, added);
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

  // Rejestracja globalnych skrótów klawiszowych (Mute + Wywołanie Mowy)
  shortcutManager.registerAll(ctx);

  // Ciche sprawdzenie aktualizacji w tle po 5 sekundach od uruchomienia
  setTimeout(() => {
    void updater.checkForUpdates().catch(() => {});
  }, 5000);

  // Otwórz okno jeśli jawnie zażądano tego w argumentach CLI (np. po buildzie przez build.mjs)
  if (process.argv.includes('--show') || process.argv.includes('--open')) {
    showSettings(ctx);
  }
});

let isCleanedUp = false;

app.on('before-quit', (e) => {
  if (isCleanedUp) return;
  e.preventDefault();
  (app as Electron.App & { isQuitting?: boolean }).isQuitting = true;
  shortcutManager.unregisterAll();

  // Asynchroniczne sprzątanie: zwalnia port COM, zatrzymuje kontrolery i ubija daemony
  const cleanupTasks: Promise<unknown>[] = [];
  if (ctx) {
    ctx.activityWatcher.stop();
    ctx.voice?.stop();
    cleanupTasks.push(
      ctx.controller.stop().catch(() => {}),
      ctx.ha.stop().catch(() => {})
    );
    ctx.audio.shutdown();
  }
  deviceWatcher?.stop();
  cleanupStaleUpdateFiles();
  closeVoiceOsd();

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
      ctx.voice?.stop();
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
