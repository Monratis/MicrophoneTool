'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  getPorts: () => ipcRenderer.invoke('ports:list'),
  setMode: (mode) => ipcRenderer.invoke('state:mode', mode),
  setPort: (port) => ipcRenderer.invoke('ports:set', port),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  detectDevices: () => ipcRenderer.invoke('devices:detect'),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  closeWindow: () => ipcRenderer.send('window:close'),
  onEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('push:event', listener);
    return () => ipcRenderer.removeListener('push:event', listener);
  }
});