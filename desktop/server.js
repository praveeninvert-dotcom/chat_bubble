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

// Generous enough for a big harvested turn.window batch, small enough to
// bound how much memory one message can force us to hold.
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

// How often an in-progress streaming reply gets written to disk, so a crash
// or dropped connection mid-reply doesn't lose everything received so far.
const PARTIAL_FLUSH_MS = 500;

function isAllowedOrigin(origin) {
  return origin === "https://claude.ai" || origin.startsWith("chrome-extension://");
}

// port defaults to the real app's PORT; overridable so a throwaway server
// can run for testing (see test-conversation-guard.js) without touching the
// real one on 8787 or the real conversations.json — main.js never passes
// this, so the running app's behavior is unchanged.
function createBubbleServer({ userDataDir, getToken, onEvent, port = PORT }) {
  const store = loadStore(userDataDir);

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  let extensionSocket = null;
  let currentConversationId = null;
  const pendingTurns = new Map(); // turnId -> { role, origin, promptId, ts, buffer, index, flushTimer }

  function emit(event) {
    if (onEvent) onEvent(event);
  }

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendError(ws, code, message) {
    send(ws, { type: "error", code, message });
  }

  // turns is a sparse map of index -> {role, text}. The transcript is
  // virtualized (SPEC.md §4.1) so what's loaded can have gaps until the
  // operator scrolls up far enough to harvest them.
  function getConversation(conversationId) {
    if (!store.conversations[conversationId]) {
      store.conversations[conversationId] = { title: "", updatedAt: Date.now(), total: 0, turns: {} };
    }
    return store.conversations[conversationId];
  }

  function persist() {
    saveStore(userDataDir, store);
  }

  // Writes the buffer accumulated so far for an in-progress turn to disk,
  // marked `partial`. Called on a debounce during streaming (not on every
  // delta) so a crash or dropped connection mid-reply still leaves most of
  // it recoverable. turn.end overwrites the same index with the finished
  // text; if that never comes, the next turn.window merge for that index
  // (SPEC.md §4.1) overwrites it just like any other stored turn.
  function flushPartialTurn(turnId) {
    const pending = pendingTurns.get(turnId);
    if (!pending) return;
    pending.flushTimer = null;
    if (!currentConversationId) return;
    const convo = getConversation(currentConversationId);
    if (pending.index == null) {
      pending.index = convo.total || 0;
      convo.total = pending.index + 1;
    }
    convo.turns[pending.index] = { role: pending.role || "assistant", text: pending.buffer, partial: true };
    convo.updatedAt = Date.now();
    persist();
  }

  function sendHistory(conversationId) {
    const convo = conversationId ? store.conversations[conversationId] : null;
    emit({
      type: "history",
      conversationId,
      total: convo ? convo.total : 0,
      turns: convo ? convo.turns : {},
    });
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
    // Attached before any of the guard checks below (bad token, wrong role,
    // ROLE_TAKEN) so every connection this server ever accepts — rejected or
    // not — gets one uniform close log, not just the ones that made it to
    // being "the" extension connection. Diagnosing an unexplained 1006 means
    // seeing all of them.
    const connectedAt = Date.now();
    let closedByServer = false;

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf && reasonBuf.length ? reasonBuf.toString() : "";
      const openMs = Date.now() - connectedAt;
      console.log(
        `[bubble-server] socket closed: code=${code} reason=${JSON.stringify(reason)} ` +
          `initiatedByServer=${closedByServer} openMs=${openMs}`
      );
      if (extensionSocket === ws) {
        extensionSocket = null;
        // pendingTurns is deliberately left alone here. It used to be
        // cleared unconditionally on every disconnect, which orphaned any
        // turn still streaming through a benign reconnect (see the 2026-08-29
        // finding below case "turn.end") — the turnId → index mapping was
        // gone by the time turn.end arrived on the new connection, and the
        // guess-based fallback that used to run instead is what corrupted a
        // conversation's history. pendingTurns is a single Map shared across
        // the server's whole lifetime (declared once, above, not per
        // connection), so it already survives a reconnect intact without
        // needing anything special here — a turn.end that arrives on the new
        // connection can still find its entry. It's only cleared now in case
        // "conversation", and only when the id actually changes.
        // flushPartialTurn's timers are unaffected either way: they write to
        // disk on their own schedule, independent of any socket.
        console.log("[bubble-server] extension disconnected");
        emit({ type: "peers", extension: false });
      }
    });

    // The `ws` library enforces MAX_MESSAGE_BYTES itself, one level below
    // handleMessage — an oversized frame never reaches the "message"
    // listener at all. It surfaces here instead, as a RangeError tagged
    // WS_ERR_UNSUPPORTED_MESSAGE_LENGTH, right before the library closes the
    // connection on its own. Logged distinctly so this is never confused
    // with an unexplained disconnect.
    ws.on("error", (err) => {
      if (err && err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
        console.log(
          `[bubble-server] REJECTED message: exceeds ${MAX_MESSAGE_BYTES}-byte limit — ${err.message}`
        );
      } else {
        console.log("[bubble-server] socket error:", err.message);
      }
    });

    let url;
    try {
      url = new URL(req.url, `http://${HOST}`);
    } catch {
      closedByServer = true;
      ws.close(1008, "bad request");
      return;
    }
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token");

    if (token !== getToken()) {
      console.log("[bubble-server] rejected connection: bad token");
      sendError(ws, "BAD_TOKEN", "Pairing token missing or incorrect.");
      closedByServer = true;
      ws.close();
      return;
    }
    if (role !== "extension") {
      console.log("[bubble-server] rejected connection: role was", JSON.stringify(role));
      sendError(ws, "MALFORMED", "Only role=extension may connect over WebSocket.");
      closedByServer = true;
      ws.close();
      return;
    }
    if (extensionSocket) {
      console.log("[bubble-server] rejected connection: role already taken");
      sendError(ws, "ROLE_TAKEN", "An extension connection is already active.");
      closedByServer = true;
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
      // A malformed-but-well-typed message (e.g. a bad shape nested inside
      // an otherwise valid envelope) should be logged and dropped, not take
      // the whole app down with it.
      try {
        handleMessage(ws, msg);
      } catch (err) {
        console.error("[bubble-server] error handling message, dropped:", msg.type, err && err.message);
      }
    });
  });

  function handleMessage(ws, msg) {
    switch (msg.type) {
      case "hello": {
        console.log("[bubble-server] hello from clientId", msg.clientId);
        break;
      }

      case "conversation": {
        const newConversationId = msg.conversationId || null;
        const idChanged = newConversationId !== currentConversationId;
        console.log(
          `[bubble-server] conversation received: id=${newConversationId || "null"} ` +
            `title=${JSON.stringify(msg.title)} (previous currentConversationId=${currentConversationId}) ` +
            `idChanged=${idChanged}`
        );
        currentConversationId = newConversationId;
        if (idChanged) {
          // Only clear when the conversation actually changed. This used to
          // run unconditionally, including on a same-id reannounce — the
          // extension resends "conversation" on every reconnect (even a
          // benign one) and on a title-only update, neither of which means
          // any in-flight turn stopped belonging to this conversation.
          // Clearing anyway orphaned it, and turn.end's old guess-based
          // fallback is what then misfiled it into the wrong conversation's
          // history (2026-08-29, see case "turn.end").
          for (const pending of pendingTurns.values()) {
            if (pending.flushTimer) clearTimeout(pending.flushTimer);
          }
          pendingTurns.clear();
        }
        if (currentConversationId) {
          const convo = getConversation(currentConversationId);
          if (typeof msg.title === "string") convo.title = msg.title;
        }
        emit({ type: "conversation", conversationId: currentConversationId, title: msg.title || "" });
        sendHistory(currentConversationId);
        break;
      }

      case "turn.window": {
        const conversationId = msg.conversationId;
        if (!conversationId || !Array.isArray(msg.turns)) {
          sendError(ws, "MALFORMED", "turn.window needs a conversationId and a turns array.");
          return;
        }
        currentConversationId = conversationId;
        const convo = getConversation(conversationId);
        // Merge by index — never replace. The window is a partial view of a
        // virtualized transcript; replacing would discard everything outside
        // whatever happens to be rendered right now. An index already stored
        // is updated in place, a new one is added. See SPEC.md §4.1.
        for (const t of msg.turns) {
          if (!t || typeof t !== "object" || typeof t.index !== "number") continue;
          convo.turns[t.index] = { role: t.role, text: t.text };
        }
        if (typeof msg.total === "number") {
          convo.total = Math.max(convo.total || 0, msg.total);
        }
        convo.updatedAt = Date.now();
        persist();
        // Forward the raw window, not the merged store, so the renderer does
        // its own index merge into what it has on screen — the same rule
        // applies on both ends.
        emit({ type: "turn.window", conversationId, total: convo.total, turns: msg.turns });
        break;
      }

      case "turn.start": {
        if (!msg.turnId) {
          sendError(ws, "MALFORMED", "turn.start needs a turnId.");
          return;
        }
        // conversationId (SPEC.md §4, 2026-08-29) is what lets this be
        // checked against currentConversationId instead of trusted blindly —
        // the extension always knows which conversation a turn belongs to;
        // the server otherwise has no way to recover that once pendingTurns
        // loses the mapping (see case "turn.end").
        if (msg.conversationId !== currentConversationId) {
          console.log(
            `[bubble-server] dropped turn.start: conversationId=${msg.conversationId} does not match ` +
              `current=${currentConversationId} (turnId=${msg.turnId})`
          );
          return;
        }
        // msg.index (added for retry, SPEC.md §4) is the row's real page
        // index — the same value turn.window uses as its storage key. Using
        // it here too, instead of only falling back to convo.total the way
        // this used to, keeps a live turn's storage index consistent with
        // that same page-index space rather than a separately-incremented
        // counter that could in principle drift from it.
        const index = typeof msg.index === "number" ? msg.index : null;
        pendingTurns.set(msg.turnId, {
          role: msg.role,
          origin: msg.origin,
          promptId: msg.promptId || null,
          ts: msg.ts || Date.now(),
          buffer: "",
          index,
          flushTimer: null,
        });
        emit({
          type: "turn.start",
          turnId: msg.turnId,
          role: msg.role,
          origin: msg.origin,
          promptId: msg.promptId || null,
          ts: msg.ts,
          index,
        });
        break;
      }

      case "turn.delta": {
        if (!msg.turnId) {
          sendError(ws, "MALFORMED", "turn.delta needs a turnId.");
          return;
        }
        if (msg.conversationId !== currentConversationId) {
          console.log(
            `[bubble-server] dropped turn.delta: conversationId=${msg.conversationId} does not match ` +
              `current=${currentConversationId} (turnId=${msg.turnId})`
          );
          return;
        }
        const pending = pendingTurns.get(msg.turnId);
        if (pending) {
          pending.buffer += msg.text || "";
          if (!pending.flushTimer) {
            pending.flushTimer = setTimeout(() => flushPartialTurn(msg.turnId), PARTIAL_FLUSH_MS);
          }
        }
        emit({ type: "turn.delta", turnId: msg.turnId, text: msg.text });
        break;
      }

      // Appending isn't always valid mid-stream — the extension's own text
      // extraction can reshape text already sent as deltas (e.g. code-fence
      // rebuilding activating once a <pre> and its language label are both
      // present). turn.replace carries the current full text for a turnId;
      // unlike turn.delta this OVERWRITES pending.buffer rather than
      // appending to it. See SPEC.md §4.
      case "turn.replace": {
        if (!msg.turnId) {
          sendError(ws, "MALFORMED", "turn.replace needs a turnId.");
          return;
        }
        if (msg.conversationId !== currentConversationId) {
          console.log(
            `[bubble-server] dropped turn.replace: conversationId=${msg.conversationId} does not match ` +
              `current=${currentConversationId} (turnId=${msg.turnId})`
          );
          return;
        }
        const pending = pendingTurns.get(msg.turnId);
        if (pending) {
          pending.buffer = msg.text || "";
          if (!pending.flushTimer) {
            pending.flushTimer = setTimeout(() => flushPartialTurn(msg.turnId), PARTIAL_FLUSH_MS);
          }
        }
        emit({ type: "turn.replace", turnId: msg.turnId, text: msg.text });
        break;
      }

      case "turn.end": {
        if (!msg.turnId) {
          sendError(ws, "MALFORMED", "turn.end needs a turnId.");
          return;
        }
        if (msg.conversationId !== currentConversationId) {
          // Dropped, not just unpersisted — forwarding it to the bubble
          // would show text for a conversation the operator isn't even
          // looking at anymore as if it belonged here.
          console.log(
            `[bubble-server] dropped turn.end: conversationId=${msg.conversationId} does not match ` +
              `current=${currentConversationId} (turnId=${msg.turnId}) — not persisted, not forwarded.`
          );
          pendingTurns.delete(msg.turnId);
          return;
        }
        const pending = pendingTurns.get(msg.turnId);
        // No fallback index. This used to be
        // `pending && pending.index != null ? pending.index : convo.total || 0`
        // — guessing convo.total when the mapping was gone. That guess is
        // exactly what wrote one conversation's replies into a different
        // conversation's history (2026-08-29): pendingTurns had been cleared
        // by a benign reconnect (see case "conversation" and the socket
        // "close" handler above) or by the operator genuinely switching
        // conversations mid-reply, and convo.total pointed at whatever
        // conversation happened to be current when this orphaned turn.end
        // finally arrived — not the conversation the reply actually
        // belonged to. Dropping instead is safe: the next turn.window
        // resync fills the right index in correctly, straight from the
        // page, once the row settles (SPEC.md §4.1).
        if (!pending || pending.index == null) {
          console.log(
            `[bubble-server] dropped turn.end: no usable index for turnId=${msg.turnId} ` +
              `(${pending ? "pendingTurns entry has no index" : "no pendingTurns entry"}) — not persisted, not forwarded.`
          );
          pendingTurns.delete(msg.turnId);
          return;
        }
        if (pending.flushTimer) {
          clearTimeout(pending.flushTimer);
          pending.flushTimer = null;
        }
        if (currentConversationId) {
          const convo = getConversation(currentConversationId);
          convo.turns[pending.index] = { role: pending.role || "assistant", text: msg.text };
          convo.total = Math.max(convo.total || 0, pending.index + 1);
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

      // The extension sends this itself when it can't carry out something
      // the bubble asked for (currently just a retry whose row couldn't be
      // found — RETRY_FAILED, SPEC.md §4) — distinct from sendError() above,
      // which is the server rejecting a connection. Relayed as-is so the
      // bubble can show it instead of the failure being silent.
      case "error": {
        emit({ type: "error", code: msg.code || "UNKNOWN", message: msg.message || "" });
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

  // The bubble asks for older messages over IPC (it never touches the
  // socket); this is the relay half described in SPEC.md §4's history.request.
  function sendHistoryRequest(conversationId, beforeIndex) {
    if (!extensionSocket) return false;
    send(extensionSocket, { type: "history.request", conversationId, beforeIndex });
    return true;
  }

  // Relay half of SPEC.md §4's retry message — same shape, no server-side
  // state to track beyond forwarding it.
  function sendRetry(conversationId, index) {
    if (!extensionSocket) return false;
    send(extensionSocket, { type: "retry", conversationId, index });
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

  httpServer.listen(port, HOST, () => {
    console.log(`[bubble-server] listening on ${HOST}:${port}`);
  });

  return { sendPrompt, sendHistoryRequest, sendRetry, isExtensionConnected, close };
}

module.exports = { createBubbleServer, HOST, PORT, MAX_MESSAGE_BYTES };
