const { app, BrowserWindow, globalShortcut, ipcMain } = require("electron");
const path = require("node:path");
const { createBubbleServer } = require("./server");
const { getOrCreateToken, regenerateToken } = require("./token");

// Named explicitly so userData lands in a folder called "claude-bubble"
// instead of "desktop" (Electron's default is the package.json "name",
// which is just the folder name of this app). That's where the pairing
// token and conversations.json live — see the paths logged below on start.
app.setName("claude-bubble");

let win = null;
let server = null;
let token = null;

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

  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log("[bubble-ui-console]", level, `${sourceId}:${line}`, message);
  });

  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  const userDataDir = app.getPath("userData");
  token = getOrCreateToken(userDataDir);
  console.log("[bubble-server] userData dir:", userDataDir);
  console.log("[bubble-server] pairing token:", token);

  server = createBubbleServer({
    userDataDir,
    getToken: () => token,
    onEvent: (event) => {
      if (win) win.webContents.send("server-event", event);
    },
  });

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

ipcMain.on("bubble:prompt", (_event, { promptId, text }) => {
  if (server) server.sendPrompt(promptId, text);
});

ipcMain.on("bubble:history-request", (_event, { conversationId, beforeIndex }) => {
  if (server) server.sendHistoryRequest(conversationId, beforeIndex);
});

ipcMain.handle("bubble:get-token", () => token);

ipcMain.handle("bubble:regenerate-token", () => {
  token = regenerateToken(app.getPath("userData"));
  console.log("[bubble-server] pairing token regenerated:", token);
  return token;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (server) server.close();
});

app.on("window-all-closed", () => {
  app.quit();
});
