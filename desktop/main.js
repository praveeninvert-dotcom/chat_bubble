const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, screen } = require("electron");
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
  showBubble();
});

let win = null;
let server = null;
let token = null;
let tray = null;

// Below 320x400 the composer and header break. Above 700 wide there's no
// reason for a small floating bubble to get that big. Shared module-level
// constants (rather than literals inline in two places) so the BrowserWindow
// constructor below and the bubble:get-size-limits handler near the bottom
// of this file can't drift out of sync with each other.
const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;
const MAX_WIDTH = 700;

// .panel's box-shadow in the renderer spans the whole window; recomputing
// that blur on every recomposited frame of a live drag is expensive on a
// transparent window (see renderer/style.css), and was the cause of the
// resize stutter. 'resize' and 'move' fire continuously for the
// duration of *any* drag — native OS hit-testing (the header, and the
// bottom-left corner, which never needed a custom JS grip the way the
// other three corners did) as well as our own setSize/setBounds IPC calls
// below — so debouncing on those two events here covers every drag source
// uniformly, rather than needing each source to separately report its own
// start/end. 150ms of no further resize/move activity is treated as "the
// drag ended"; one gotcha: pausing mid-drag for longer than that (mouse
// still down, not moving) will make the shadow briefly pop back before
// disappearing again on the next move — harmless since nothing is being
// recomposited while stationary anyway, but worth knowing about.
let dragSettleTimer = null;
function onWindowDragActivity() {
  if (dragSettleTimer === null) {
    if (win) win.webContents.send("ui-drag-state", true);
  } else {
    clearTimeout(dragSettleTimer);
  }
  dragSettleTimer = setTimeout(() => {
    dragSettleTimer = null;
    if (win) win.webContents.send("ui-drag-state", false);
  }, 150);
}

// Shared show/hide/toggle entry points — used by the tray menu, the
// Cmd+Shift+C shortcut, and a second launch attempt (see the
// second-instance handler above), so the fade animation (see
// renderer/app.js's beginHideAnimation and the bubble:request-hide/-show
// listeners) plays no matter which of those triggered it, not just the
// in-window hide button.
//
// Hiding is a handshake: this only asks the renderer to animate out —
// ipcMain's "bubble:hide" handler below is what actually calls win.hide(),
// once the renderer says the animation (or its reduced-motion skip) is
// done. Showing doesn't need the reverse handshake: the window is made
// visible immediately, in whatever hidden-looking CSS state it was left
// in, and then told to animate back to normal — so the fade-in itself is
// what's on screen instead of happening invisibly before the window appears.
function showBubble() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send("bubble:request-show");
}

function hideBubble() {
  if (!win) return;
  win.webContents.send("bubble:request-hide");
}

function toggleBubbleVisibility() {
  if (!win) return;
  if (win.isVisible()) {
    hideBubble();
  } else {
    showBubble();
  }
}

function createWindow() {
  // Height of the display the window will open on, so the max size below
  // can't exceed the screen. Evaluated once at creation time against the
  // primary display (where a window with no explicit x/y opens) — this
  // does not follow the window if it's later dragged to a different-sized
  // display in a multi-monitor setup.
  const displayHeight = screen.getPrimaryDisplay().workAreaSize.height;

  win = new BrowserWindow({
    width: 380,
    height: 560,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: MAX_WIDTH,
    maxHeight: displayHeight,
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

  win.on("resize", onWindowDragActivity);
  win.on("move", onWindowDragActivity);

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
        click: () => toggleBubbleVisibility(),
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
    toggleBubbleVisibility();
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

// Drives the bottom-right resize grip (see renderer/app.js). Needed because
// native OS edge/corner hit-testing is unreliable for a transparent,
// frameless BrowserWindow on macOS — this bypasses that entirely by
// resizing directly. setSize keeps the window's current x/y (top-left)
// fixed and clamps to the min/maxWidth/Height set on the window above, so
// no manual bounds-checking is needed here.
ipcMain.on("bubble:resize", (_event, { width, height }) => {
  if (!win) return;
  win.setSize(Math.round(width), Math.round(height));
});

// Drives the top-left/top-right resize grips (see renderer/app.js). Those
// corners anchor the *opposite* corner in place, so the window's origin
// moves as it resizes — setSize's "keep x/y fixed" behavior doesn't cover
// that, but setBounds moves and resizes in one call. The renderer clamps
// width/height to bubble:get-size-limits below before computing x/y from
// them, so this should already be in range; Electron's own min/max
// constraints on the window are just the backstop.
ipcMain.on("bubble:resize-bounds", (_event, { x, y, width, height }) => {
  if (!win) return;
  win.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
});

ipcMain.on("bubble:prompt", (_event, { promptId, text }) => {
  if (server) server.sendPrompt(promptId, text);
});

ipcMain.on("bubble:history-request", (_event, { conversationId, beforeIndex }) => {
  if (server) server.sendHistoryRequest(conversationId, beforeIndex);
});

ipcMain.on("bubble:retry", (_event, { conversationId, index }) => {
  if (server) server.sendRetry(conversationId, index);
});

// Lets the renderer clamp the top-corner grips' width/height itself (see
// app.js) before computing x/y from them — if it clamped only through
// Electron's own constraints, an over-large size sent via setBounds could
// get shrunk by Electron while the position we calculated (from the
// un-clamped size) stayed wrong, and the anchored corner would drift.
ipcMain.handle("bubble:get-size-limits", () => ({
  minWidth: MIN_WIDTH,
  minHeight: MIN_HEIGHT,
  maxWidth: MAX_WIDTH,
  maxHeight: screen.getPrimaryDisplay().workAreaSize.height,
}));

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
