const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: (cb) => ipcRenderer.on('picker:sources', (_event, sources) => cb(sources)),
  choose: (id, audio) => ipcRenderer.send('picker:choose', { id, audio }),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
