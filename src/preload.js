'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('launcher', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  refreshManifest: (options) => ipcRenderer.invoke('manifest:refresh', options),
  getVersionInfo: (versionId) => ipcRenderer.invoke('version:info', versionId),
  localVersions: () => ipcRenderer.invoke('versions:local'),
  play: (payload) => ipcRenderer.invoke('game:play', payload),
  cancel: () => ipcRenderer.invoke('game:cancel'),
  stop: () => ipcRenderer.invoke('game:stop'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  pickGameDir: () => ipcRenderer.invoke('dialog:game-dir'),
  pickJava: () => ipcRenderer.invoke('dialog:java'),
  detectJava: (value) => ipcRenderer.invoke('java:detect', value),
  listJava: (options) => ipcRenderer.invoke('java:list', options),
  openFolder: (payload) => ipcRenderer.invoke('shell:open', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  loaderVersions: (payload) => ipcRenderer.invoke('loader:versions', payload),
  installLoader: (payload) => ipcRenderer.invoke('loader:install', payload),
  cancelLoader: () => ipcRenderer.invoke('loader:cancel'),
  pickOptifine: () => ipcRenderer.invoke('dialog:optifine'),
  onLoaderState: (callback) => subscribe('loader:state', callback),
  catalogSearch: (payload) => ipcRenderer.invoke('catalog:search', payload),
  catalogInstall: (payload) => ipcRenderer.invoke('catalog:install', payload),
  catalogPack: (payload) => ipcRenderer.invoke('catalog:pack', payload),
  catalogCancel: () => ipcRenderer.invoke('catalog:cancel'),
  onCatalogState: (callback) => subscribe('catalog:state', callback),
  getSkin: () => ipcRenderer.invoke('skin:get'),
  saveSkin: (payload) => ipcRenderer.invoke('skin:save', payload),
  resetSkin: () => ipcRenderer.invoke('skin:reset'),
  exportSkin: (payload) => ipcRenderer.invoke('skin:export', payload),
  skinGallery: (payload) => ipcRenderer.invoke('skin:gallery', payload),
  skinApplyGallery: (payload) => ipcRenderer.invoke('skin:apply-gallery', payload),
  onProgress: (callback) => subscribe('game:progress', callback),
  onLog: (callback) => subscribe('game:log', callback),
  onState: (callback) => subscribe('game:state', callback),
});
