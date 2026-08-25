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
  testDevice: (name: string) => ipcRenderer.invoke('audio:testDevice', name),
  sleepDisplay: () => ipcRenderer.invoke('display:sleep'),
  wakeDisplay: () => ipcRenderer.invoke('display:wake'),
  openConfigDir: () => ipcRenderer.invoke('config:openDir'),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  closeWindow: () => ipcRenderer.send('window:close'),
  // Radar Auto-Tuning
  resetAutoTuning: () => ipcRenderer.invoke('radar:resetAutoTuning'),

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

  // Sensor USB Firmware Flasher & Recovery
  checkSensorFirmware: () => ipcRenderer.invoke('sensor:checkFirmware'),
  flashSensorFromGitHub: () => ipcRenderer.invoke('sensor:flashFromGitHub'),
  flashSensorFromFile: () => ipcRenderer.invoke('sensor:flashFromFile'),

  // Diagnostic Logs
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),

  onEvent: (cb: (e: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on('push:event', listener);
    return (): void => {
      ipcRenderer.removeListener('push:event', listener);
    };
  }
};

contextBridge.exposeInMainWorld('api', api);
