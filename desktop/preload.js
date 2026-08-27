const { contextBridge, ipcRenderer } = require("electron");

// Deliberately tiny for now — this is the wiring, not the feature. It exists
// so the renderer never gets direct Node/Electron access (contextIsolation),
// and it's visible in the placeholder panel so a broken bridge shows up
// immediately instead of failing silently later.
contextBridge.exposeInMainWorld("bubble", {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  hide: () => ipcRenderer.send("bubble:hide"),
  sendPrompt: (promptId, text) => ipcRenderer.send("bubble:prompt", { promptId, text }),
  onServerEvent: (callback) => {
    ipcRenderer.on("server-event", (_event, data) => callback(data));
  },
});
