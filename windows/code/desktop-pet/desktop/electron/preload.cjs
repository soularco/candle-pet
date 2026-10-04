const { contextBridge, ipcRenderer } = require('electron');
const channels = new Set(['desktop', 'shell', 'diagnostic']);
// Delivery allowlist. A method missing here is dropped silently, which is why
// localSpeech never reached the renderer and the offline voice stayed mute.
const methods = new Set(['receive', 'connectionChanged', 'hotkeyConfig', 'hotkeyEvent', 'displayConfig', 'managementResult', 'localSpeech', 'systemState', 'foregroundState', 'ambientConfig', 'autoStart', 'trayCommand', 'remoteChat', 'remoteChatStatus']);
contextBridge.exposeInMainWorld('desktopHost', {
  postMessage(name, value) { if (channels.has(name)) ipcRenderer.send('pet:' + name, value); },
  subscribe(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('pet:delivery', (_event, method, ...args) => { if (methods.has(method)) callback(method, ...args); });
  }
});
