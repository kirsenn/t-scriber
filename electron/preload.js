'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tscriber', {
  listSessions:  () => ipcRenderer.invoke('list-sessions'),
  getSession:    id => ipcRenderer.invoke('get-session', id),
  deleteSession: id => ipcRenderer.invoke('delete-session', id),
  onEvent: callback => ipcRenderer.on('event', (_, e) => callback(e)),

  getConfig:  ()    => ipcRenderer.invoke('get-config'),
  saveConfig: cfg   => ipcRenderer.invoke('save-config', cfg),
  chooseFile: opts  => ipcRenderer.invoke('choose-file', opts),
});
