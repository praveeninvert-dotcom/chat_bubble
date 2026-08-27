// The WebSocket server described in SPEC.md §4 and §5.
//
// Binds 127.0.0.1 only. Rejects any WebSocket upgrade whose Origin header
// isn't exactly https://claude.ai or chrome-extension://* — that check happens
// on the raw HTTP upgrade, before a WebSocket connection ever exists, so a
// hostile page gets nothing back. A connection that passes the origin check
// still needs the correct pairing token or it's sent a BAD_TOKEN error and
// closed. Only one extension connection is allowed at a time; a second is
// told ROLE_TAKEN.
//
// The extension is the only WebSocket client (see SPEC.md §4's note on the
// bubble using contextBridge IPC instead). Everything the server would "send
// to the bubble" is instead handed to the onEvent callback, which main.js
// forwards to the renderer over IPC.
const http = require("node:http");
const { URL } = require("node:url");
const { WebSocketServer } = require("ws");
const { loadStore, saveStore } = require("./store");

const HOST = "127.0.0.1";
const PORT = 8787;

// Generous enough for a long turn.snapshot backfill of a big conversation,
// small enough to bound how much memory one message can force us to hold.
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

function isAllowedOrigin(origin) {
  return origin === "https://claude.ai" || origin.startsWith("chrome-extension://");
}

function createBubbleServer({ userDataDir, getToken, onEvent }) {
  const store = loadStore(userDataDir);

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  let extensionSocket = null;
  let currentConversationId = null;
  const pendingTurns = new Map(); // turnId -> { role, origin, promptId, ts }

  function emit(event) {
    if (onEvent) onEvent(event);
  }

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendError(ws, code, message) {
    send(ws, { type: "error", code, message });
  }

  function getConversation(conversationId) {
    if (!store.conversations[conversationId]) {
      store.conversations[conversationId] = { title: "", updatedAt: Date.now(), turns: [] };
    }
    return store.conversations[conversationId];
  }

  function persist() {
    saveStore(userDataDir, store);
  }

  function sendHistory(conversationId) {
    const convo = conversationId ? store.conversations[conversationId] : null;
    emit({ type: "history", conversationId, turns: convo ? convo.turns : [] });
  }

  httpServer.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin || "";
    if (!isAllowedOrigin(origin)) {
      console.log("[bubble-server] rejected upgrade, bad origin:", JSON.stringify(origin));
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}`);
    } catch {
      ws.close(1008, "bad request");
      return;
    }
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token");

    if (token !== getToken()) {
      console.log("[bubble-server] rejected connection: bad token");
      sendError(ws, "BAD_TOKEN", "Pairing token missing or incorrect.");
      ws.close();
      return;
    }
    if (role !== "extension") {
      console.log("[bubble-server] rejected connection: role was", JSON.stringify(role));
      sendError(ws, "MALFORMED", "Only role=extension may connect over WebSocket.");
      ws.close();
      return;
    }
    if (extensionSocket) {
      console.log("[bubble-server] rejected connection: role already taken");
      sendError(ws, "ROLE_TAKEN", "An extension connection is already active.");
      ws.close();
      return;
    }

    extensionSocket = ws;
    console.log("[bubble-server] extension connected");
    emit({ type: "peers", extension: true });
    if (currentConversationId) sendHistory(currentConversationId);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendError(ws, "MALFORMED", "Not valid JSON.");
        return;
      }
      if (!msg || typeof msg.type !== "string") {
        sendError(ws, "MALFORMED", "Message is missing a type field.");
        return;
      }
      handleMessage(ws, msg);
    });

    ws.on("close", () => {
      if (extensionSocket === ws) {
        extensionSocket = null;
        pendingTurns.clear();
        console.log("[bubble-server] extension disconnected");
        emit({ type: "peers", extension: false });
      }
    });

    ws.on("error", (err) => {
      console.log("[bubble-server] socket error:", err.message);
    });
  });

  function handleMessage(ws, msg) {
    switch (msg.type) {
      case "hello": {
        console.log("[bubble-server] hello from clientId", msg.clientId);
        break;
      }

      case "conversation": {
        currentConversationId = msg.conversationId || null;
        pendingTurns.clear();
        if (currentConversationId) {
          const convo = getConversation(currentConversationId);
          if (typeof msg.title === "string") convo.title = msg.title;
        }
        emit({ type: "conversation", conversationId: currentConversationId, title: msg.title || "" });
        sendHistory(currentConversationId);
        break;
      }

      case "turn.snapshot": {
        const conversationId = msg.conversationId;
        if (!conversationId || !Array.isArray(msg.turns)) {
          sendError(ws, "MALFORMED", "turn.snapshot needs a conversationId and a turns array.");
          return;
        }
        currentConversationId = conversationId;
        const convo = getConversation(conversationId);
        convo.turns = msg.turns.map((t, i) => ({
          seq: typeof t.seq === "number" ? t.seq : i,
          role: t.role,
          text: t.text,
          turnId: null,
          ts: null,
          origin: null,
          promptId: null,
        }));
        convo.updatedAt = Date.now();
        persist();
        sendHistory(conversationId);
        break;
      }

      case "turn.start": {
        if (!msg.turnId) {
          sendError(ws, "MALFORMED", "turn.start needs a turnId.");
          return;
        }
        pendingTurns.set(msg.turnId, {
          role: msg.role,
          origin: msg.origin,
          promptId: msg.promptId || null,
          ts: msg.ts || Date.now(),
        });
        emit({
          type: "turn.start",
          turnId: msg.turnId,
          role: msg.role,
          origin: msg.origin,
          promptId: msg.promptId || null,
          ts: msg.ts,
        });
        break;
      }

      case "turn.delta": {
        if (!msg.turnId) {
          sendError(ws, "MALFORMED", "turn.delta needs a turnId.");
          return;
        }
        emit({ type: "turn.delta", turnId: msg.turnId, text: msg.text });
        break;
      }

      case "turn.end": {
        if (!msg.turnId) {
          sendError(ws, "MALFORMED", "turn.end needs a turnId.");
          return;
        }
        const pending = pendingTurns.get(msg.turnId);
        if (!pending) {
          console.log("[bubble-server] turn.end with no matching turn.start:", msg.turnId);
        }
        if (currentConversationId) {
          const convo = getConversation(currentConversationId);
          convo.turns.push({
            seq: convo.turns.length,
            role: (pending && pending.role) || "assistant",
            text: msg.text,
            turnId: msg.turnId,
            ts: (pending && pending.ts) || Date.now(),
            origin: (pending && pending.origin) || "native",
            promptId: (pending && pending.promptId) || null,
          });
          convo.updatedAt = Date.now();
          persist();
        }
        pendingTurns.delete(msg.turnId);
        emit({ type: "turn.end", turnId: msg.turnId, text: msg.text });
        break;
      }

      case "status": {
        emit({
          type: "status",
          conversationId: msg.conversationId,
          streaming: !!msg.streaming,
          capture: msg.capture,
        });
        break;
      }

      default:
        console.log("[bubble-server] dropped unrecognised message type:", msg.type);
    }
  }

  function sendPrompt(promptId, text) {
    if (!extensionSocket) return false;
    send(extensionSocket, { type: "prompt", promptId, text });
    return true;
  }

  function isExtensionConnected() {
    return !!extensionSocket;
  }

  function close() {
    wss.close();
    httpServer.close();
  }

  httpServer.on("error", (err) => {
    console.error("[bubble-server] server error:", err.message);
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`[bubble-server] listening on ${HOST}:${PORT}`);
  });

  return { sendPrompt, isExtensionConnected, close };
}

module.exports = { createBubbleServer, HOST, PORT, MAX_MESSAGE_BYTES };
