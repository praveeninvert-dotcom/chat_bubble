const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage } = require("electron");
const path = require("node:path");
const { createBubbleServer } = require("./server");
const { getOrCreateToken, regenerateToken } = require("./token");

// Last-resort safety net: log and keep running rather than let an
// unanticipated error silently kill the whole app (and the bubble window
// with it). Everything that can be validated up front already is; this is
// only meant to catch what that validation missed.
process.on("uncaughtException", (err) => {
  console.error("[bubble-server] uncaught exception, continuing:", err && err.stack ? err.stack : err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[bubble-server] unhandled promise rejection, continuing:", reason);
});

// Named explicitly so userData lands in a folder called "claude-bubble"
// instead of "desktop" (Electron's default is the package.json "name",
// which is just the folder name of this app). That's where the pairing
// token and conversations.json live — see the paths logged below on start.
app.setName("claude-bubble");

// A second launch (e.g. an accidental double-click) would otherwise open a
// second window whose server can't bind the port the first one is already
// using, with nothing telling the operator why it's not working. Refuse the
// second copy outright and just surface the existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  return;
}

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

let win = null;
let server = null;
let token = null;
let tray = null;

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

// Menu-bar icon, so the bubble can always be shown again even if the global
// shortcut below is unavailable (another app already holds it, or the
// window somehow got hidden with no other way to reach it — see audit
// finding #4: skipTaskbar plus no tray icon meant a stuck bubble had no
// recovery route short of Activity Monitor).
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Claude Bubble");
  tray.setTitle("💬"); // macOS-only: renders next to an empty tray image.
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show/Hide Bubble",
        click: () => {
          if (!win) return;
          if (win.isVisible()) {
            win.hide();
          } else {
            win.show();
            win.focus();
          }
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
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

  try {
    createTray();
  } catch (err) {
    console.error("[bubble-server] failed to create the menu bar icon:", err && err.message);
  }

  const shortcutRegistered = globalShortcut.register("Cmd+Shift+C", () => {
    if (!win) return;
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
    }
  });
  if (!shortcutRegistered) {
    console.error(
      "[bubble-server] could not register Cmd+Shift+C — another app may already be using it. Use the menu bar icon to show or hide the bubble instead."
    );
  }
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
  if (tray) tray.destroy();
  if (server) server.close();
});

app.on("window-all-closed", () => {
  app.quit();
});
