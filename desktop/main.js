const { app, BrowserWindow, globalShortcut, ipcMain } = require("electron");
const path = require("node:path");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 560,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Plain alwaysOnTop isn't enough to survive another app going fullscreen —
  // 'floating' is the window level that does, and visibleOnFullScreen keeps
  // it from vanishing when that happens. Both are required together.
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  globalShortcut.register("Cmd+Shift+C", () => {
    if (!win) return;
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
    }
  });
});

ipcMain.on("bubble:hide", () => {
  if (win) win.hide();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  app.quit();
});
