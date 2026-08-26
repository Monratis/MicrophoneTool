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
import { getLogs, clearLogs } from './logger';

export function registerIpc(ctx: AppContext): void {
  ipcMain.handle('state:get', () => ctx.buildSnapshot());
  ipcMain.handle('ports:list', () => RadarListener.listPorts());
  ipcMain.handle('state:mode', (_e, mode: 'auto' | 'desk' | 'headset') => {
    ctx.controller.setMode(mode);
    return ctx.buildSnapshot();
  });
  ipcMain.handle('ports:set', async (_e, port: string) => {
    ctx.config.set('port', port);
    await ctx.restartRadar();
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
      Boolean(patch && 'haBreathRateEntity' in patch && patch.haBreathRateEntity !== prevHaBreath);

    if (radarNeedsRestart) {
      void ctx.restartRadar();
    }
    if (haNeedsReload) {
      void ctx.ha.reload();
    }
    if (!radarNeedsRestart) {
      ctx.refreshSnapshot();
    }
    return ctx.buildSnapshot();
  });
  ipcMain.handle('devices:list', async () => {
    // Cache 3 s — renderer woła to przy KAŻDYM snapshocie (radar status,
    // mute, przełączenie); bez cache każde zdarzenie = rund trip do daemona.
    return await ctx.audio.listRecordingDevices(false);
  });
  ipcMain.handle('devices:detect', async () => {
    const devices = await ctx.audio.listRecordingDevices(true);
    const recommended = ctx.audio.resolveNames(devices);
    return { devices, recommended };
  });
  ipcMain.handle('audio:toggleMute', async (_e, target?: string) => {
    const res = await ctx.audio.toggleMute(target);
    ctx.refreshSnapshot();
    return res;
  });
  ipcMain.handle('audio:setMute', async (_e, args: { target: string; mute: boolean }) => {
    const res = await ctx.controller.setDeviceMute(args.target, args.mute);
    ctx.refreshSnapshot();
    return res;
  });
  ipcMain.handle(
    'audio:setVolume',
    async (_e, args: { target: string; percent: number }) =>
      ctx.controller.setDeviceVolume(args.target, args.percent)
  );
  ipcMain.handle('audio:getVolume', async (_e, target?: string) => ctx.audio.getVolume(target ?? ''));
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
  ipcMain.handle('display:sleep', async () => {
    return await ctx.audio.sleepDisplay();
  });
  ipcMain.handle('display:wake', async () => {
    return await ctx.audio.wakeDisplay();
  });

  // Home Assistant (HAOS) IPC
  ipcMain.handle('ha:testConnection', async (_e, opts?: { url?: string; token?: string }) =>
    ctx.ha.testConnection(opts)
  );
  ipcMain.handle('ha:fetchEntities', async (_e, opts?: { url?: string; token?: string }) =>
    ctx.ha.fetchEntities(opts)
  );

  // SignalRGB IPC
  ipcMain.handle('signalrgb:probe', async () =>
    ctx.signalrgb ? ctx.signalrgb.probe() : { connected: false }
  );
  ipcMain.handle('signalrgb:testAway', async () => {
    if (ctx.signalrgb) await ctx.signalrgb.onAway();
    return true;
  });
  ipcMain.handle('signalrgb:testDesk', async () => {
    if (ctx.signalrgb) await ctx.signalrgb.onDesk();
    return true;
  });

  // GitHub Token Page & Updater IPC
  ipcMain.handle('github:openTokenPage', () => {
    void shell.openExternal(
      'https://github.com/settings/tokens/new?scopes=repo&description=AutoAudioSwitch-Updater'
    );
    return true;
  });
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
}
