import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { ipcMain, shell, clipboard, app } from 'electron';
import RadarListener from './radarListener';
import type { AppContext } from './appContext';
import { applyAutoStart } from './appContext';
import { getSettingsWindow } from './settingsWindow';
import { DEFAULTS } from './config';
import { toggleMuteWithFeedback } from './appContext';
import { getLogs, clearLogs } from './logger';
import { startDiagSession, stopDiagSession, isDiagSessionActive, diagSessionStartedAt } from './diagSession';
import { toggleRecording } from './diagRecorder';

export function registerIpc(ctx: AppContext): void {
  ipcMain.handle('state:get', () => ctx.buildSnapshot());
  ipcMain.handle('ports:list', () => RadarListener.listPorts());
  ipcMain.handle('state:mode', (_e, mode: 'auto' | 'desk' | 'headset') => {
    ctx.controller.setMode(mode);
    return ctx.buildSnapshot();
  });
  // Pauza automatyki (snooze): 0 = wznowienie. Main jest źródłem prawdy —
  // renderer dostaje świeży snapshot z snoozeUntil.
  ipcMain.handle('snooze:set', (_e, minutes: number) => {
    ctx.controller.setSnooze(Number(minutes) || 0);
    ctx.refreshSnapshot();
    return ctx.buildSnapshot();
  });
  ipcMain.handle('config:update', (_e, patch: Record<string, unknown>) => {
    const prevBaud = ctx.config.get('baudRate');
    const prevPort = ctx.config.get('port');
    const prevHaEnabled = ctx.config.get('haEnabled');
    const prevHaUrl = ctx.config.get('haUrl');
    const prevHaToken = ctx.config.get('haToken');
    const prevHaPresence = ctx.config.get('haPresenceEntity');
    const prevHaDistance = ctx.config.get('haDistanceEntity');
    const prevHaHeart = ctx.config.get('haHeartRateEntity');
    const prevHaBreath = ctx.config.get('haBreathRateEntity');
    const prevHaAutoAway = ctx.config.get('haAutomationOnAway');
    const prevHaAutoDesk = ctx.config.get('haAutomationOnDesk');
    const prevHaBtnSnooze = ctx.config.get('haButtonSnoozeEntity');
    const prevHaBtnMute = ctx.config.get('haButtonMuteEntity');

    for (const [key, value] of Object.entries(patch || {})) {
      if (key in ctx.config.data) {
        (ctx.config.data as unknown as Record<string, unknown>)[key] = value;
      }
    }
    if (typeof patch?.autoStart === 'boolean') applyAutoStart(patch.autoStart);
    ctx.config.save();

    // Restart radaru przy zmianie portu LUB baudrate — inaczej radar
    // słuchałby starego portu do końca sesji.
    const radarNeedsRestart =
      Boolean(patch && 'baudRate' in patch && patch.baudRate !== prevBaud) ||
      Boolean(patch && 'port' in patch && patch.port !== prevPort);

    // Przeładowanie Home Assistant przy zmianie parametrów integracji
    const haNeedsReload =
      Boolean(patch && 'haEnabled' in patch && patch.haEnabled !== prevHaEnabled) ||
      Boolean(patch && 'haUrl' in patch && patch.haUrl !== prevHaUrl) ||
      Boolean(patch && 'haToken' in patch && patch.haToken !== prevHaToken) ||
      Boolean(patch && 'haPresenceEntity' in patch && patch.haPresenceEntity !== prevHaPresence) ||
      Boolean(patch && 'haDistanceEntity' in patch && patch.haDistanceEntity !== prevHaDistance) ||
      Boolean(patch && 'haHeartRateEntity' in patch && patch.haHeartRateEntity !== prevHaHeart) ||
      Boolean(patch && 'haBreathRateEntity' in patch && patch.haBreathRateEntity !== prevHaBreath) ||
      Boolean(patch && 'haAutomationOnAway' in patch && patch.haAutomationOnAway !== prevHaAutoAway) ||
      Boolean(patch && 'haAutomationOnDesk' in patch && patch.haAutomationOnDesk !== prevHaAutoDesk) ||
      Boolean(patch && 'haButtonSnoozeEntity' in patch && patch.haButtonSnoozeEntity !== prevHaBtnSnooze) ||
      Boolean(patch && 'haButtonMuteEntity' in patch && patch.haButtonMuteEntity !== prevHaBtnMute);

    const discordVoiceNeedsUpdate =
      Boolean(patch) &&
      ('micDeskGateDb' in patch ||
        'micDeskKrisp' in patch ||
        'micDeskAgc' in patch ||
        'micDeskEcho' in patch ||
        'micHeadsetGateDb' in patch ||
        'micHeadsetKrisp' in patch ||
        'micHeadsetAgc' in patch ||
        'micHeadsetEcho' in patch ||
        'discordGateFollowMic' in patch ||
        'discordIntegration' in patch);

    const ledNeedsUpdate =
      Boolean(patch) &&
      ('sensorLedEnabled' in patch ||
        'sensorLedBrightness' in patch ||
        'sensorLedDeskColor' in patch ||
        'sensorLedAwayColor' in patch ||
        'sensorLedMuteColor' in patch);

    if (radarNeedsRestart) {
      void ctx.restartRadar();
    }
    if (haNeedsReload) {
      void ctx.ha.reload();
    }
    if (discordVoiceNeedsUpdate && ctx.controller.currentDevice) {
      ctx.controller.applyDiscordGate(ctx.controller.currentDevice);
    }
    if (ledNeedsUpdate && !radarNeedsRestart) {
      ctx.radar.updateLed();
    }
    if (!radarNeedsRestart) {
      ctx.refreshSnapshot();
    }
    return ctx.buildSnapshot();
  });
  ipcMain.handle('devices:list', async () => {
    // Cache 1 s — renderer woła to przy KAŻDYM snapshocie (radar status,
    // mute, przełączenie); bez cache każde zdarzenie = rund trip do daemona.
    return await ctx.audio.listRecordingDevices(false);
  });
  ipcMain.handle('devices:detect', async () => {
    const devices = await ctx.audio.listRecordingDevices(true);
    const recommended = ctx.audio.resolveNames(devices);
    return { devices, recommended };
  });
  ipcMain.handle('audio:toggleMute', async () => {
    // Wspólny helper z pełnym feedbackiem (LED + toast + powiadomienie)
    return await toggleMuteWithFeedback(ctx);
  });
  ipcMain.handle(
    'discord:applyVoice',
    async (_e, args: { gateDb?: number; krisp?: boolean; agc?: boolean; echo?: boolean }) =>
      ctx.controller.discord ? ctx.controller.discord.applyMicSettings(args || {}) : false
  );
  ipcMain.handle('discord:getStatus', async () =>
    ctx.controller.discord ? ctx.controller.discord.getStatus() : { connected: false, ready: false, authenticated: false }
  );
  ipcMain.handle('discord:getVoiceSettings', async () =>
    ctx.controller.discord ? ctx.controller.discord.getVoiceSettings() : null
  );
  ipcMain.handle('discord:authorize', async () => {
    if (ctx.controller.discord) {
      ctx.controller.discord.authorizeManually();
      return true;
    }
    return false;
  });
  ipcMain.handle('config:reset', () => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      (ctx.config.data as unknown as Record<string, unknown>)[key] = value;
    }
    ctx.config.save();
    applyAutoStart(ctx.config.get('autoStart'));
    void ctx.restartRadar();
    ctx.refreshSnapshot();
    return ctx.buildSnapshot();
  });

  ipcMain.handle('config:openDir', () => {
    void shell.openPath(ctx.appDataDir);
    return true;
  });
  ipcMain.handle('audio:testDevice', async (_e, name: string) => {
    await ctx.audio.setDefaultRecordingDevice(name);
    // Test = mini-przełączenie: aplikuj też profil (głośność + Discord)
    ctx.controller.applyProfileForDevice(name);
    ctx.refreshSnapshot();
    return ctx.buildSnapshot();
  });
  ipcMain.handle('screensaver:start', async () => {
    ctx.screen.showScreensaver();
    return true;
  });
  // Ewakuacja z nakładki: dowolne wejście użytkownika na wygaszaczu (preload
  // screensaver.ts) zdejmuje go natychmiast, z pominięciem polla idle.
  ipcMain.on('screensaver:dismiss', () => {
    ctx.screen.notifyUserInput();
  });

  // Home Assistant (HAOS) IPC
  ipcMain.handle('ha:testConnection', async (_e, opts?: { url?: string; token?: string }) =>
    ctx.ha.testConnection(opts)
  );
  ipcMain.handle('ha:fetchEntities', async (_e, opts?: { url?: string; token?: string }) =>
    ctx.ha.fetchEntities(opts)
  );
  // Test wywołania usługi HAOS z panelu (automation/script/button/scene/...)
  ipcMain.handle('ha:callService', async (_e, entityId: string) => ctx.ha.callService(String(entityId || '')));

  // SignalRGB IPC — zwracają realny wynik akcji (rest/deeplink/none + powód)
  ipcMain.handle('signalrgb:testAway', async () =>
    ctx.signalrgb ? ctx.signalrgb.onAway() : { ok: false, reason: 'Integracja niezainicjalizowana' }
  );
  ipcMain.handle('signalrgb:testDesk', async () =>
    ctx.signalrgb ? ctx.signalrgb.onDesk() : { ok: false, reason: 'Integracja niezainicjalizowana' }
  );
  ipcMain.handle('signalrgb:getStatus', async () =>
    ctx.signalrgb
      ? ctx.signalrgb.inspect()
      : { restAvailable: false, proRequired: false, detail: 'Integracja niezainicjalizowana' }
  );
  // Lista zainstalowanych efektów z dysku (bez Pro) — podpowiedzi do pickerów
  ipcMain.handle('signalrgb:listEffects', () =>
    ctx.signalrgb ? ctx.signalrgb.listLocalEffects() : []
  );

  // Updater IPC
  ipcMain.handle('updater:check', async () => await ctx.updater.checkForUpdates());
  ipcMain.handle('updater:download', async () =>
    ctx.updater ? await ctx.updater.downloadUpdate() : null
  );
  ipcMain.handle('updater:install', async () => {
    ctx.updater.quitAndInstall();
    return null;
  });
  ipcMain.handle('updater:status', () => ctx.updater.getStatus());

  // Radar Auto-Tuning IPC
  ipcMain.handle('radar:resetAutoTuning', () => {
    const status = ctx.radar.resetAutoTuning();
    ctx.refreshSnapshot();
    return status;
  });

  // Rejestrator surowego strumienia radaru (toggle: start / stop + raport)
  ipcMain.handle('diag:record', () => toggleRecording(300));

  // General External URL Opener IPC
  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      void shell.openExternal(url);
    }
    return true;
  });

  // Native Clipboard IPC (unrestricted OS-level clipboard access)
  ipcMain.handle('app:copyToClipboard', (_e, text: string) => {
    if (typeof text === 'string') {
      clipboard.writeText(text);
      return true;
    }
    return false;
  });

  // Diagnostic Logs IPC
  ipcMain.handle('logs:get', () => getLogs());
  ipcMain.handle('logs:clear', () => {
    clearLogs();
    return true;
  });
  ipcMain.handle('logs:openInNotepad', () => {
    try {
      const logs = getLogs();
      const tmpPath = path.join(os.tmpdir(), `DeskSense-Logs-${Date.now()}.txt`);
      fs.writeFileSync(tmpPath, logs.join('\r\n'), 'utf8');
      exec(`notepad.exe "${tmpPath}"`);
      return true;
    } catch {
      return false;
    }
  });

  // Sesja diagnostyczna "Wyjście z pokoju" — patrz src/main/diagSession.ts
  ipcMain.handle('diag:start', () => {
    startDiagSession();
    return true;
  });
  ipcMain.handle('diag:status', () => ({
    active: isDiagSessionActive(),
    startedAt: diagSessionStartedAt()
  }));
  ipcMain.handle('diag:stop', () => {
    const res = stopDiagSession();
    if (!res) return null;
    const durationMin = ((res.endedAt - res.startedAt) / 60000).toFixed(1);
    const header = [
      `# DeskSense — sesja diagnostyczna "Wyjście z pokoju"`,
      `Start: ${new Date(res.startedAt).toLocaleString('pl-PL')} | Koniec: ${new Date(res.endedAt).toLocaleString('pl-PL')} | Czas trwania: ${durationMin} min`,
      `Wersja: v${app.getVersion()} | Tryb: ${ctx.controller.mode} | Obecność: ${ctx.radar.presence ? 'OBECNY' : 'BRAK'}`,
      `Logów w sesji: ${res.logs.length}`,
      ``
    ].join('\n');
    return {
      startedAt: res.startedAt,
      endedAt: res.endedAt,
      count: res.logs.length,
      text: header + res.logs.join('\n')
    };
  });

  // Notatnik z dowolnym tekstem (używane przez modal sesji diagnostycznej)
  ipcMain.handle('app:openTextInNotepad', (_e, text: string) => {
    try {
      const tmpPath = path.join(os.tmpdir(), `DeskSense-Diag-${Date.now()}.txt`);
      fs.writeFileSync(tmpPath, String(text ?? ''), 'utf8');
      exec(`notepad.exe "${tmpPath}"`);
      return true;
    } catch {
      return false;
    }
  });

  // Systemowy dialog wyboru pliku audio (własny dźwięk przełączenia)
  ipcMain.handle('app:pickAudioFile', async () => {
    const { dialog } = await import('electron');
    const win = getSettingsWindow() ?? undefined;
    const result = await dialog.showOpenDialog(win as Electron.BaseWindow, {
      title: 'Wybierz plik audio (mp3, wav, ogg)',
      filters: [
        { name: 'Audio (mp3, wav, ogg)', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] },
        { name: 'Wszystkie pliki', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Natychmiastowe odświeżenie koloru diody po zmianie w color pickerze
  ipcMain.handle('led:refresh', () => {
    ctx.radar.updateLed();
    return true;
  });

  ipcMain.on('window:close', () => {
    const win = getSettingsWindow();
    if (win) win.hide();
  });

  ipcMain.on('window:minimize', () => {
    const win = getSettingsWindow();
    if (win) win.minimize();
  });

  ipcMain.on('window:maximize', () => {
    const win = getSettingsWindow();
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle('window:isMaximized', () => {
    const win = getSettingsWindow();
    return win ? win.isMaximized() : false;
  });

  ipcMain.on('window:toggleDevTools', () => {
    const win = getSettingsWindow();
    if (win) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });
}
