import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

const api = {
  getState: () => ipcRenderer.invoke('state:get'),
  getPorts: () => ipcRenderer.invoke('ports:list'),
  setMode: (mode: string) => ipcRenderer.invoke('state:mode', mode),
  updateConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke('config:update', patch),
  detectDevices: () => ipcRenderer.invoke('devices:detect'),
  listDevices: () => ipcRenderer.invoke('devices:list'),
  toggleMute: () => ipcRenderer.invoke('audio:toggleMute'),
  discordApplyVoice: (args: { gateDb?: number; krisp?: boolean; agc?: boolean; echo?: boolean }) =>
    ipcRenderer.invoke('discord:applyVoice', args),
  discordGetStatus: () => ipcRenderer.invoke('discord:getStatus'),
  discordGetVoiceSettings: () => ipcRenderer.invoke('discord:getVoiceSettings'),
  discordAuthorize: () => ipcRenderer.invoke('discord:authorize'),
  testDevice: (name: string) => ipcRenderer.invoke('audio:testDevice', name),
  screensaverStart: () => ipcRenderer.invoke('screensaver:start'),
  // Ewakuacja z nakładki wygaszacza: dowolne wejście użytkownika natychmiast
  // ją zdejmuje (screensaver.ts używa tego samego preloadu co okno główne).
  screensaverDismiss: () => ipcRenderer.send('screensaver:dismiss'),
  openConfigDir: () => ipcRenderer.invoke('config:openDir'),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  toggleDevTools: () => ipcRenderer.send('window:toggleDevTools'),
  // Radar Auto-Tuning
  resetAutoTuning: () => ipcRenderer.invoke('radar:resetAutoTuning'),

  // Rejestrator surowego strumienia radaru (kalibracja progów fuzji)
  diagRecord: () => ipcRenderer.invoke('diag:record'),

  // Home Assistant (HAOS) Integration
  haTestConnection: (opts?: { url?: string; token?: string }) =>
    ipcRenderer.invoke('ha:testConnection', opts),
  haFetchEntities: (opts?: { url?: string; token?: string }) =>
    ipcRenderer.invoke('ha:fetchEntities', opts),
  haCallService: (entityId: string) => ipcRenderer.invoke('ha:callService', entityId),

  // SignalRGB Integration
  signalrgbTestAway: () => ipcRenderer.invoke('signalrgb:testAway'),
  signalrgbTestDesk: () => ipcRenderer.invoke('signalrgb:testDesk'),
  signalrgbGetStatus: () => ipcRenderer.invoke('signalrgb:getStatus'),
  signalrgbListEffects: () => ipcRenderer.invoke('signalrgb:listEffects'),

  // GitHub Auto Updater & Token
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdaterStatus: () => ipcRenderer.invoke('updater:status'),

  // External URL opener & Native Clipboard
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  copyToClipboard: (text: string) => ipcRenderer.invoke('app:copyToClipboard', text),
  pickAudioFile: () => ipcRenderer.invoke('app:pickAudioFile'),
  refreshLed: () => ipcRenderer.invoke('led:refresh'),

  // Diagnostic Logs
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  openLogsInNotepad: () => ipcRenderer.invoke('logs:openInNotepad'),

  // Sesja diagnostyczna "Wyjście z pokoju"
  diagStart: () => ipcRenderer.invoke('diag:start'),
  diagStatus: () => ipcRenderer.invoke('diag:status'),
  diagStop: () => ipcRenderer.invoke('diag:stop'),
  openTextInNotepad: (text: string) => ipcRenderer.invoke('app:openTextInNotepad', text),

  onEvent: (cb: (e: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('push:event', listener);
    return (): void => {
      ipcRenderer.removeListener('push:event', listener);
    };
  }
};

contextBridge.exposeInMainWorld('api', api);
