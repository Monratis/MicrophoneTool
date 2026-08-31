import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { ipcMain, shell, clipboard } from 'electron';
import RadarListener from './radarListener';
import type { AppContext } from './appContext';
import { applyAutoStart } from './appContext';
import { getSettingsWindow } from './settingsWindow';
import { DEFAULTS } from './config';
import { toggleMuteWithFeedback } from './appContext';
import { getLogs, clearLogs } from './logger';
import { startDiagSession, stopDiagSession, isDiagSessionActive, diagSessionStartedAt } from './diagSession';
import { toggleRecording, startRecording, stopRecording } from './diagRecorder';

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
        // Tokeny OAuth Discorda zarządzane są WYŁĄCZNIE przez discordIntegration.ts
        // (proaktywny refresh co 6h). Renderer odsyła stary token z chwili otwarcia okna,
        // który może być już nieaktualny — nadpisanie spowodowałoby utratę sesji.
        if (key === 'discordAccessToken' || key === 'discordRefreshToken' || key === 'discordTokenExpiresAt') {
          continue;
        }
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
        'micDeskAutoThreshold' in patch ||
        'micDeskKrisp' in patch ||
        'micDeskAgc' in patch ||
        'micDeskEcho' in patch ||
        'micHeadsetGateDb' in patch ||
        'micHeadsetAutoThreshold' in patch ||
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

    const voiceNeedsUpdate =
      Boolean(patch) &&
      ('voiceEnabled' in patch ||
        'voiceEngine' in patch ||
        'voiceWhisperModel' in patch ||
        'voiceWhisperBackend' in patch ||
        'voiceModel' in patch ||
        'voiceCustomModelPath' in patch ||
        'voiceWakeWord' in patch ||
        'voiceRequireWakeWord' in patch ||
        'voiceIdleUnloadMin' in patch ||
        'voiceRules' in patch);

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
    if (voiceNeedsUpdate && ctx.voice && !ctx.voice.isDownloading()) {
      // Użytkownik jawnie wybrał backend GPU — wyczyść wymuszony fallback CPU,
      // żeby mógł ponownie spróbować CUDA (inaczej auto zostałby na CPU na stałe).
      const explicitBackend = (patch?.voiceWhisperBackend as string);
      if (explicitBackend === 'cuda12' || explicitBackend === 'cuda11') {
        ctx.voice.resetCpuFallback();
      }
      if (typeof patch?.voiceEnabled === 'boolean') {
        if (patch.voiceEnabled) {
          void ctx.voice.start();
        } else {
          ctx.voice.stop();
        }
      } else if (typeof patch?.voiceIdleUnloadMin === 'number') {
        ctx.voice.setVoiceIdleUnload(patch.voiceIdleUnloadMin);
      } else if ('voiceEngine' in (patch || {}) || 'voiceWhisperModel' in (patch || {}) || 'voiceWhisperBackend' in (patch || {}) || 'voiceModel' in (patch || {}) || 'voiceCustomModelPath' in (patch || {})) {
        const eng = (patch?.voiceEngine as string) || ctx.config.get('voiceEngine') || 'whisper';
        const mdl = eng === 'whisper'
          ? (patch?.voiceWhisperModel as string) || ctx.config.get('voiceWhisperModel') || 'whisper-base'
          : (patch?.voiceModel as string) || ctx.config.get('voiceModel') || 'pl-small';
        const bck = (patch?.voiceWhisperBackend as string) || ctx.config.get('voiceWhisperBackend') || 'auto';
        // Restart tylko gdy nowa konfiguracja jest gotowa — inaczej nie ubijamy działającego silnika
        if (ctx.voice.isModelReady(eng as never, mdl as never, bck as never)) {
          void ctx.voice.restart();
        }
      }
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
    async (_e, args: { gateDb?: number; autoThreshold?: boolean; krisp?: boolean; agc?: boolean; echo?: boolean }) =>
      ctx.controller.discord ? ctx.controller.discord.applyMicSettings(args || {}) : false
  );
  ipcMain.handle('discord:getStatus', async () =>
    ctx.controller.discord
      ? ctx.controller.discord.getStatus()
      : { enabled: false, connected: false, ready: false, authenticated: false }
  );
  ipcMain.handle('discord:getVoiceSettings', async () =>
    ctx.controller.discord
      ? await ctx.controller.discord.getVoiceSettings()
      : { ok: false, error: 'Discord nie jest zainicjalizowany' }
  );
  ipcMain.handle('discord:authorize', async () => {
    if (ctx.controller.discord) {
      return await ctx.controller.discord.authorizeManually();
    }
    return { ok: false, error: 'Integracja z Discordem jest niedostępna' };
  });
  ipcMain.handle('config:reset', () => {
    const savedAccessToken = ctx.config.get('discordAccessToken');
    const savedRefreshToken = ctx.config.get('discordRefreshToken');
    const savedTokenExpiresAt = ctx.config.get('discordTokenExpiresAt');
    for (const [key, value] of Object.entries(DEFAULTS)) {
      (ctx.config.data as unknown as Record<string, unknown>)[key] = value;
    }
    // Zachowaj aktywne tokeny Discorda przy resecie ustawień
    if (savedAccessToken) ctx.config.data.discordAccessToken = savedAccessToken;
    if (savedRefreshToken) ctx.config.data.discordRefreshToken = savedRefreshToken;
    if (savedTokenExpiresAt) ctx.config.data.discordTokenExpiresAt = savedTokenExpiresAt;
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
  // Test wywołania usługi HAOS z panelu (automation/script/button/scene/light/...)
  ipcMain.handle('ha:callService', async (_e, target: string | Record<string, unknown>) => ctx.ha.callService(target));

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
  // Ręczny/testowy podgląd wybranego efektu z opcjonalnym kolorem
  ipcMain.handle('signalrgb:applyEffect', async (_e, effectName: string, color?: string) =>
    ctx.signalrgb ? ctx.signalrgb.applyEffect(effectName, color) : { ok: false, reason: 'Integracja niezainicjalizowana' }
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

  // Radar Auto-Tuning & Calibration IPC
  ipcMain.handle('radar:resetAutoTuning', () => {
    ctx.refreshSnapshot();
    return { ok: true };
  });
  ipcMain.handle('radar:applyCalibration', () => {
    ctx.refreshSnapshot();
    return { ok: true, snapshot: ctx.buildSnapshot() };
  });

  // Rejestrator surowego strumienia radaru (toggle: start / stop + raport)
  ipcMain.handle('diag:record', (_e, durationSec?: number) => toggleRecording(durationSec ?? 300));
  ipcMain.handle('diag:recordStart', (_e, durationSec?: number) => startRecording(durationSec ?? 300));
  ipcMain.handle('diag:recordStop', () => stopRecording());

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
    const discordStatus = ctx.controller.discord ? ctx.controller.discord.getStatus() : null;
    startDiagSession({
      initialState: ctx.controller.currentDevice,
      initialPresence: ctx.radar.presence,
      portName: ctx.config.get('port') || 'COM3',
      firmwareVersion: ctx.radar.telemetry.deviceInfo?.fwVersion ? `v${ctx.radar.telemetry.deviceInfo.fwVersion}` : 'nieznana',
      timeoutAwayMs: ctx.config.get('timeoutAwayMs'),
      timeoutDeskMs: ctx.config.get('timeoutDeskMs'),
      userInputPresenceHoldSec: ctx.config.get('userInputPresenceHoldSec'),
      micDeskName: ctx.config.get('micDeskName'),
      micDeskVolume: ctx.config.get('micDeskVolume'),
      micHeadsetName: ctx.config.get('micHeadsetName'),
      micHeadsetVolume: ctx.config.get('micHeadsetVolume'),
      unmuteOnDesk: ctx.config.get('unmuteOnDesk'),
      muteBehaviorOnAway: ctx.config.get('muteBehaviorOnAway'),
      discordConnected: Boolean(discordStatus?.connected),
      discordAuth: Boolean(discordStatus?.authenticated),
      micDeskGateDb: ctx.config.get('micDeskGateDb'),
      micHeadsetGateDb: ctx.config.get('micHeadsetGateDb')
    });
    return true;
  });
  ipcMain.handle('diag:status', () => ({
    active: isDiagSessionActive(),
    startedAt: diagSessionStartedAt()
  }));
  ipcMain.handle('diag:stop', () => {
    const res = stopDiagSession();
    if (!res) return null;
    return {
      startedAt: res.startedAt,
      endedAt: res.endedAt,
      durationSec: res.durationSec,
      timeline: res.timeline,
      analysis: res.analysis,
      count: res.logs.length,
      text: res.text
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

  // Voice Control IPC
  ipcMain.handle('voice:getStatus', () => ctx.voice ? ctx.voice.getStatus() : null);
  ipcMain.handle('voice:startDownload', (_e, engine?: any, modelType?: any, backend?: any) => ctx.voice ? ctx.voice.startDownload(engine, modelType, backend) : { ok: false, message: 'Moduł mowy niedostępny' });
  ipcMain.handle('voice:cancelDownload', () => ctx.voice ? ctx.voice.cancelDownload() : false);
  ipcMain.handle('voice:deleteAsset', (_e, kind: any, key: any) => ctx.voice ? ctx.voice.deleteAsset(kind, key) : { ok: false, message: 'Moduł mowy niedostępny' });
  ipcMain.handle('voice:testAction', (_e, rule: any) => ctx.voice ? ctx.voice.executeAction(rule) : { ok: false, message: 'Moduł mowy niedostępny' });
  ipcMain.handle('voice:startLiveTest', () => {
    if (ctx.voice) {
      ctx.voice.setLiveTestMode(true);
      return true;
    }
    return false;
  });
  ipcMain.handle('voice:stopLiveTest', () => {
    if (ctx.voice) {
      ctx.voice.setLiveTestMode(false);
      return true;
    }
    return false;
  });
  ipcMain.handle('voice:pickCustomModel', async () => {
    const { dialog } = await import('electron');
    const win = getSettingsWindow() ?? undefined;
    const result = await dialog.showOpenDialog(win as Electron.BaseWindow, {
      title: 'Wybierz folder z modelem Vosk',
      properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.handle('voice:pickAppPath', async () => {
    const { dialog } = await import('electron');
    const win = getSettingsWindow() ?? undefined;
    const result = await dialog.showOpenDialog(win as Electron.BaseWindow, {
      title: 'Wybierz aplikację lub skrypt do uruchomienia',
      filters: [
        { name: 'Programy i skrypty (*.exe, *.bat, *.cmd, *.lnk, *.ps1)', extensions: ['exe', 'bat', 'cmd', 'lnk', 'ps1', 'vbs'] },
        { name: 'Wszystkie pliki (*.*)', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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
