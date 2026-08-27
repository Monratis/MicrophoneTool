import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

const api = {
  getState: () => ipcRenderer.invoke('state:get'),
  getPorts: () => ipcRenderer.invoke('ports:list'),
  setMode: (mode: string) => ipcRenderer.invoke('state:mode', mode),
  setPort: (port: string) => ipcRenderer.invoke('ports:set', port),
  updateConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('config:update', patch),
  detectDevices: () => ipcRenderer.invoke('devices:detect'),
  listDevices: () => ipcRenderer.invoke('devices:list'),
  toggleMute: (target?: string) => ipcRenderer.invoke('audio:toggleMute', target),
  setMute: (target: string, mute: boolean) => ipcRenderer.invoke('audio:setMute', { target, mute }),
  setVolume: (target: string, percent: number) => ipcRenderer.invoke('audio:setVolume', { target, percent }),
  getVolume: (target?: string) => ipcRenderer.invoke('audio:getVolume', target),
  discordApplyVoice: (args: { gateDb?: number; krisp?: boolean; agc?: boolean; echo?: boolean }) =>
    ipcRenderer.invoke('discord:applyVoice', args),
  discordGetStatus: () => ipcRenderer.invoke('discord:getStatus'),
  discordGetVoiceSettings: () => ipcRenderer.invoke('discord:getVoiceSettings'),
  discordAuthorize: () => ipcRenderer.invoke('discord:authorize'),
  testDevice: (name: string) => ipcRenderer.invoke('audio:testDevice', name),
  sleepDisplay: () => ipcRenderer.invoke('display:sleep'),
  wakeDisplay: () => ipcRenderer.invoke('display:wake'),
  openConfigDir: () => ipcRenderer.invoke('config:openDir'),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  toggleDevTools: () => ipcRenderer.send('window:toggleDevTools'),
  // Radar Auto-Tuning
  resetAutoTuning: () => ipcRenderer.invoke('radar:resetAutoTuning'),

  // Home Assistant (HAOS) Integration
  haTestConnection: (opts?: { url?: string; token?: string }) =>
    ipcRenderer.invoke('ha:testConnection', opts),
  haFetchEntities: (opts?: { url?: string; token?: string }) =>
    ipcRenderer.invoke('ha:fetchEntities', opts),

  // SignalRGB Integration
  signalrgbProbe: () => ipcRenderer.invoke('signalrgb:probe'),
  signalrgbTestAway: () => ipcRenderer.invoke('signalrgb:testAway'),
  signalrgbTestDesk: () => ipcRenderer.invoke('signalrgb:testDesk'),

  // GitHub Auto Updater & Token
  openGitHubTokenPage: () => ipcRenderer.invoke('github:openTokenPage'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdaterStatus: () => ipcRenderer.invoke('updater:status'),

  // External URL opener & Native Clipboard
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  copyToClipboard: (text: string) => ipcRenderer.invoke('app:copyToClipboard', text),

  // Diagnostic Logs
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openLogsInNotepad: () => ipcRenderer.invoke('logs:openInNotepad'),

  onEvent: (cb: (e: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('push:event', listener);
    return (): void => {
      ipcRenderer.removeListener('push:event', listener);
    };
  }
};

contextBridge.exposeInMainWorld('api', api);
