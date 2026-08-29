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
  resizeWindow: (width, height) => ipcRenderer.send("bubble:resize", { width, height }),
  resizeBounds: (x, y, width, height) =>
    ipcRenderer.send("bubble:resize-bounds", { x, y, width, height }),
  getSizeLimits: () => ipcRenderer.invoke("bubble:get-size-limits"),
  sendPrompt: (promptId, text) => ipcRenderer.send("bubble:prompt", { promptId, text }),
  requestHistory: (conversationId, beforeIndex) =>
    ipcRenderer.send("bubble:history-request", { conversationId, beforeIndex }),
  retryTurn: (conversationId, index) => ipcRenderer.send("bubble:retry", { conversationId, index }),
  getToken: () => ipcRenderer.invoke("bubble:get-token"),
  regenerateToken: () => ipcRenderer.invoke("bubble:regenerate-token"),
  onServerEvent: (callback) => {
    ipcRenderer.on("server-event", (_event, data) => callback(data));
  },
  onDragState: (callback) => {
    ipcRenderer.on("ui-drag-state", (_event, dragging) => callback(dragging));
  },
  onRequestHide: (callback) => {
    ipcRenderer.on("bubble:request-hide", () => callback());
  },
  onRequestShow: (callback) => {
    ipcRenderer.on("bubble:request-show", () => callback());
  },
});
