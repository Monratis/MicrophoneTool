import { ipcMain, shell, dialog } from 'electron';
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
    for (const [key, value] of Object.entries(patch || {})) {
      if (key in ctx.config.data) {
        (ctx.config.data as unknown as Record<string, unknown>)[key] = value;
      }
    }
    if (typeof patch?.autoStart === 'boolean') applyAutoStart(patch.autoStart);
    ctx.config.save();
    const radarNeedsRestart = Boolean(patch && 'baudRate' in patch && patch.baudRate !== prevBaud);
    if (radarNeedsRestart) {
      void ctx.restartRadar();
    } else {
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
    const res = await ctx.audio.setMute(args.target, args.mute);
    ctx.refreshSnapshot();
    return res;
  });
  ipcMain.handle(
    'audio:setVolume',
    async (_e, args: { target: string; percent: number }) => ctx.audio.setVolume(args.target, args.percent)
  );
  ipcMain.handle('audio:getVolume', async (_e, target?: string) => ctx.audio.getVolume(target ?? ''));
  ipcMain.handle(
    'discord:applyVoice',
    async (_e, args: { gateDb?: number; krisp?: boolean; agc?: boolean; echo?: boolean }) =>
      ctx.controller.discord ? ctx.controller.discord.applyMicSettings(args || {}) : false
  );
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
    ctx.refreshSnapshot();
    return ctx.buildSnapshot();
  });
  ipcMain.handle('display:sleep', async () => {
    return await ctx.audio.sleepDisplay();
  });
  ipcMain.handle('display:wake', async () => {
    return await ctx.audio.wakeDisplay();
  });

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

  // Sensor USB Firmware Flasher & Emergency Recovery IPC
  ipcMain.handle('sensor:checkFirmware', async () => ctx.sensorFlasher.checkGitHubFirmware());
  ipcMain.handle('sensor:flashFromGitHub', async (_e, opts?: { eraseAll?: boolean }) => {
    const check = await ctx.sensorFlasher.checkGitHubFirmware();
    if (!check.available || !check.name) {
      throw new Error(check.message || check.error || 'Brak pliku firmware .bin na GitHubie');
    }
    const binPath = await ctx.sensorFlasher.downloadFirmware({
      name: check.name,
      size: check.size,
      apiUrl: check.apiUrl,
      downloadUrl: check.downloadUrl
    });
    // eraseAll wyłącznie dla jawnie żądanego trybu ratunkowego (unbrick) —
    // normalna aktualizacja nie dotyka fabrycznej kalibracji radaru.
    return await ctx.sensorFlasher.flashFirmware(binPath, null, { eraseAll: Boolean(opts?.eraseAll) });
  });
  ipcMain.handle('sensor:flashFromFile', async () => {
    const parent = getSettingsWindow();
    const dialogOpts = {
      title: 'Wybierz skompilowany plik firmware ESP32-C6 (.bin)',
      filters: [{ name: 'Firmware Binary (*.bin)', extensions: ['bin'] }],
      properties: ['openFile' as const]
    };
    const { canceled, filePaths } = parent
      ? await dialog.showOpenDialog(parent, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (canceled || !filePaths || filePaths.length === 0) return { canceled: true };
    return await ctx.sensorFlasher.flashFirmware(filePaths[0]);
  });

  // Diagnostic Logs IPC
  ipcMain.handle('logs:get', () => getLogs());
  ipcMain.handle('logs:clear', () => {
    clearLogs();
    return true;
  });

  ipcMain.on('window:close', () => {
    const win = getSettingsWindow();
    if (win) win.hide();
  });
}
