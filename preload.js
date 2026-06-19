const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  playSpotify: (type, term) => ipcRenderer.send('play-spotify', { type, term }),
  mediaControl: (cmd) => ipcRenderer.send('media-control', cmd),
  openApp: (appName) => ipcRenderer.send('open-app', appName),
  requestScreenshot: () => ipcRenderer.invoke('request-screenshot'),
  executeCommand: (payload) => ipcRenderer.invoke('execute-command', payload),
  nvidiaTtsConfig: (payload) => ipcRenderer.invoke('nvidia-tts-config', payload),
  nvidiaTtsSynthesize: (payload) => ipcRenderer.invoke('nvidia-tts-synthesize', payload)
});
