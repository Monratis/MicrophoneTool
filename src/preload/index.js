'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  getPorts: () => ipcRenderer.invoke('ports:list'),
  setMode: (mode) => ipcRenderer.invoke('state:mode', mode),
  setPort: (port) => ipcRenderer.invoke('ports:set', port),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  detectDevices: () => ipcRenderer.invoke('devices:detect'),
  listDevices: () => ipcRenderer.invoke('devices:list'),
  toggleMute: (target) => ipcRenderer.invoke('audio:toggleMute', target),
  setMute: (target, mute) => ipcRenderer.invoke('audio:setMute', { target, mute }),
  testDevice: (name) => ipcRenderer.invoke('audio:testDevice', name),
  sleepDisplay: () => ipcRenderer.invoke('display:sleep'),
  wakeDisplay: () => ipcRenderer.invoke('display:wake'),
  openConfigDir: () => ipcRenderer.invoke('config:openDir'),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // GitHub Auto Updater
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getUpdaterStatus: () => ipcRenderer.invoke('updater:status'),

  onEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('push:event', listener);
    return () => ipcRenderer.removeListener('push:event', listener);
  }
});