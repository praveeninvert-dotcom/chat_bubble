// Vanilla JS bubble UI. No framework, no build step. Talks to the main
// process only through window.bubble (contextBridge, see preload.js) — this
// file never touches a WebSocket. See SPEC.md §4 and §4.1.
(() => {
  "use strict";

  // Placeholder delimiter for markdown extraction (code blocks/spans).
  // NUL can't occur in typed chat text, so it can't collide with real
  // content — a padded-spaces scheme was tried first and rejected: it broke
  // on real prose like "section B2", and a later trim() bug meant the
  // block-level placeholder check never matched at all.
  const PH = String.fromCharCode(0);

  // ---------- DOM refs ----------

  const els = {
    healthDot: document.getElementById("health-dot"),
    healthDetail: document.getElementById("health-detail"),
    historyBadge: document.getElementById("history-badge"),
    titleText: document.getElementById("title-text"),
    messageList: document.getElementById("message-list"),
    loadingOlder: document.getElementById("loading-older"),
    indexedTurns: document.getElementById("indexed-turns"),
    liveTurns: document.getElementById("live-turns"),
    emptyState: document.getElementById("empty-state"),
    input: document.getElementById("composer-input"),
    sendBtn: document.getElementById("send-btn"),
    hideBtn: document.getElementById("hide-btn"),
    settingsBtn: document.getElementById("settings-btn"),
    settingsOverlay: document.getElementById("settings-overlay"),
    settingsClose: document.getElementById("settings-close"),
    tokenValue: document.getElementById("token-value"),
    tokenCopy: document.getElementById("token-copy"),
    tokenRegenerate: document.getElementById("token-regenerate"),
    versions: document.getElementById("versions"),
  };

  // ---------- state ----------

  const state = {
    // undefined (not null) so the very first "conversation" event — which
    // legitimately carries conversationId: null on claude.ai/new — still
    // differs from this and triggers the initial reset/title paint.
    conversationId: undefined,
    total: 0,
    turnsByIndex: new Map(), // index -> {role, text}
    minLoadedIndex: null,
    liveTurns: new Map(), // turnId -> {el, buffer}
    pendingOptimistic: new Map(), // promptId -> element
    hasLoadedOnce: false,
    userScrolledUp: false,
    historyRequestInFlight: false,
    extensionConnected: false,
    captureStatus: null, // 'ok' | 'no-container' | 'no-composer' | null (unknown)
  };

  const NEAR_BOTTOM_PX = 60;
  const NEAR_TOP_PX = 30;

  // ---------- markdown (subset: headings, bold, italic, inline code, ----------
  // ---------- fenced code blocks, unordered/ordered lists)             ----------

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderInline(text) {
    const codeSpans = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codeSpans.push(code);
      return PH + "K" + (codeSpans.length - 1) + PH;
    });

    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    text = text.replace(/_([^_]+)_/g, "<em>$1</em>");

    const codeRestoreRe = new RegExp(PH + "K(\\d+)" + PH, "g");
    text = text.replace(codeRestoreRe, (_, i) => `<code>${codeSpans[Number(i)]}</code>`);
    return text;
  }

  function renderMarkdown(rawText) {
    const blocks = [];
    let text = String(rawText || "").replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push({ lang, code });
      return PH + "B" + (blocks.length - 1) + PH;
    });

    text = escapeHtml(text);

    const blockLineRe = new RegExp("^" + PH + "B\\d+" + PH + "$");
    const lines = text.split("\n");
    let html = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (blockLineRe.test(line.trim())) {
        html += line.trim();
        i++;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
        i++;
        continue;
      }

      if (/^[-*]\s+/.test(line)) {
        let items = "";
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          items += `<li>${renderInline(lines[i].replace(/^[-*]\s+/, ""))}</li>`;
          i++;
        }
        html += `<ul>${items}</ul>`;
        continue;
      }

      if (/^\d+\.\s+/.test(line)) {
        let items = "";
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items += `<li>${renderInline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`;
          i++;
        }
        html += `<ol>${items}</ol>`;
        continue;
      }

      if (line.trim() === "") {
        i++;
        continue;
      }

      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !blockLineRe.test(lines[i].trim()) &&
        !/^(#{1,6})\s+/.test(lines[i]) &&
        !/^[-*]\s+/.test(lines[i]) &&
        !/^\d+\.\s+/.test(lines[i])
      ) {
        paraLines.push(renderInline(lines[i]));
        i++;
      }
      html += `<p>${paraLines.join("<br>")}</p>`;
    }

    const blockRestoreRe = new RegExp(PH + "B(\\d+)" + PH, "g");
    html = html.replace(blockRestoreRe, (_, idxStr) => {
      const b = blocks[Number(idxStr)];
      const code = b.code.replace(/\n$/, "");
      const escapedCode = escapeHtml(code);
      const langLabel = b.lang ? escapeHtml(b.lang) : "";
      return (
        `<div class="code-block">` +
        `<div class="code-block-header"><span class="code-lang">${langLabel}</span>` +
        `<button class="copy-btn" type="button">Copy</button></div>` +
        `<pre><code>${escapedCode}</code></pre>` +
        `</div>`
      );
    });

    return html;
  }

  // ---------- rendering ----------

  function updateEmptyState() {
    els.emptyState.classList.toggle("hidden", loadedCount() !== 0);
  }

  function loadedCount() {
    // Includes pendingOptimistic — a message the operator just sent is
    // rendered on screen before its echo reconciles into liveTurns, and
    // should count as loaded from the moment it appears.
    return state.turnsByIndex.size + state.liveTurns.size + state.pendingOptimistic.size;
  }

  function updateHistoryBadge() {
    const loaded = loadedCount();
    els.historyBadge.textContent = `${loaded} of ${Math.max(loaded, state.total)} loaded`;
  }

  function isNearBottom() {
    const el = els.messageList;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  function scrollToBottom() {
    els.messageList.scrollTop = els.messageList.scrollHeight;
  }

  function createTurnElement(role) {
    const el = document.createElement("div");
    el.className = "turn turn-" + (role === "user" ? "user" : "assistant");
    const content = document.createElement("div");
    content.className = "turn-content";
    el.appendChild(content);
    return el;
  }

  function paintTurn(el, role, text) {
    el.className = "turn turn-" + (role === "user" ? "user" : "assistant");
    el.querySelector(".turn-content").innerHTML = renderMarkdown(text);
  }

  function upsertIndexedTurn(index, role, text) {
    state.turnsByIndex.set(index, { role, text });
    if (state.minLoadedIndex === null || index < state.minLoadedIndex) {
      state.minLoadedIndex = index;
    }

    let el = els.indexedTurns.querySelector(`[data-index="${index}"]`);
    if (el) {
      paintTurn(el, role, text);
      return;
    }
    el = createTurnElement(role);
    el.dataset.index = String(index);
    paintTurn(el, role, text);

    const children = els.indexedTurns.children;
    let inserted = false;
    for (let i = 0; i < children.length; i++) {
      if (Number(children[i].dataset.index) > index) {
        els.indexedTurns.insertBefore(el, children[i]);
        inserted = true;
        break;
      }
    }
    if (!inserted) els.indexedTurns.appendChild(el);
  }

  // Merges a turn.window (or a history snapshot shaped the same way) by
  // index. Never replaces what's already loaded — an index already stored
  // is repainted in place, a new one is inserted in sorted order. The very
  // first merge for a conversation snaps to the bottom (most recent
  // messages); every merge after that preserves the operator's scroll
  // position, which matters when harvesting older messages above the
  // current viewport (SPEC.md §4.1).
  function mergeTurnWindow(turns, total) {
    const listEl = els.messageList;
    const isFirstMerge = !state.hasLoadedOnce;
    const prevScrollTop = listEl.scrollTop;
    const prevScrollHeight = listEl.scrollHeight;

    for (const t of turns) {
      if (typeof t.index !== "number") continue;
      upsertIndexedTurn(t.index, t.role, t.text);
    }
    if (typeof total === "number" && total > state.total) state.total = total;

    if (isFirstMerge) {
      state.hasLoadedOnce = true;
      scrollToBottom();
    } else {
      const newScrollHeight = listEl.scrollHeight;
      listEl.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    }

    updateHistoryBadge();
    updateEmptyState();
    setLoadingOlder(false);
  }

  function setLoadingOlder(loading) {
    state.historyRequestInFlight = loading;
    els.loadingOlder.hidden = !loading;
  }

  function maybeRequestHistory() {
    if (state.historyRequestInFlight) return;
    if (!state.extensionConnected) return;
    if (!state.conversationId) return;
    if (state.minLoadedIndex === null || state.minLoadedIndex <= 0) return;
    if (els.messageList.scrollTop > NEAR_TOP_PX) return;

    setLoadingOlder(true);
    window.bubble.requestHistory(state.conversationId, state.minLoadedIndex);
  }

  // ---------- live turns (post-attach streaming, and optimistic sends) ----------

  function renderOptimisticUserTurn(promptId, text) {
    const el = createTurnElement("user");
    el.dataset.promptId = promptId;
    paintTurn(el, "user", text);
    els.liveTurns.appendChild(el);
    state.pendingOptimistic.set(promptId, el);
    state.userScrolledUp = false;
    updateEmptyState();
    updateHistoryBadge();
    scrollToBottom();
  }

  function handleTurnStart(msg) {
    let el = null;

    if (msg.origin === "bubble" && msg.promptId && state.pendingOptimistic.has(msg.promptId)) {
      // Reconcile: this is the echo of a message the bubble already rendered
      // optimistically. Reuse that element rather than adding a duplicate.
      el = state.pendingOptimistic.get(msg.promptId);
      state.pendingOptimistic.delete(msg.promptId);
      delete el.dataset.promptId;
    } else {
      el = createTurnElement(msg.role);
      els.liveTurns.appendChild(el);
    }

    el.dataset.turnId = msg.turnId;
    state.liveTurns.set(msg.turnId, { el, buffer: "" });
    updateEmptyState();
    updateHistoryBadge();
    if (!state.userScrolledUp) scrollToBottom();
  }

  function handleTurnDelta(msg) {
    let live = state.liveTurns.get(msg.turnId);
    if (!live) {
      // No matching turn.start (e.g. app restarted mid-stream) — start one
      // now so the text isn't silently lost.
      const el = createTurnElement("assistant");
      els.liveTurns.appendChild(el);
      live = { el, buffer: "" };
      state.liveTurns.set(msg.turnId, live);
      updateEmptyState();
      updateHistoryBadge();
    }
    live.buffer += msg.text || "";
    paintTurn(live.el, live.el.className.includes("turn-user") ? "user" : "assistant", live.buffer);
    if (!state.userScrolledUp) scrollToBottom();
  }

  function handleTurnEnd(msg) {
    let live = state.liveTurns.get(msg.turnId);
    if (!live) {
      const el = createTurnElement("assistant");
      els.liveTurns.appendChild(el);
      live = { el, buffer: "" };
      state.liveTurns.set(msg.turnId, live);
    }
    // The final text is authoritative and replaces whatever the deltas produced.
    paintTurn(live.el, live.el.className.includes("turn-user") ? "user" : "assistant", msg.text);
    state.total += 1;
    updateHistoryBadge();
    updateEmptyState();
    if (!state.userScrolledUp) scrollToBottom();
  }

  // ---------- health ----------

  const CAPTURE_LABELS = {
    "no-container": "can't find the conversation on the page",
    "no-composer": "can't find the message box",
  };

  function renderHealth() {
    if (!state.extensionConnected) {
      els.healthDot.className = "health-dot off";
      els.healthDetail.textContent = "Extension offline — the claude.ai tab isn't connected.";
      return;
    }
    if (state.captureStatus && state.captureStatus !== "ok") {
      const detail = CAPTURE_LABELS[state.captureStatus] || state.captureStatus;
      els.healthDot.className = "health-dot warn";
      els.healthDetail.textContent = `Connected, but capture is broken (${detail}).`;
      return;
    }
    els.healthDot.className = "health-dot ok";
    els.healthDetail.textContent = "Connected and capturing.";
  }

  // ---------- composer ----------

  function autoResizeInput() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 140) + "px";
  }

  function updateSendButton() {
    els.sendBtn.disabled = els.input.value.trim().length === 0;
  }

  function genPromptId() {
    return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function send() {
    const text = els.input.value.trim();
    if (!text) return;
    const promptId = genPromptId();
    renderOptimisticUserTurn(promptId, text);
    window.bubble.sendPrompt(promptId, text);
    els.input.value = "";
    autoResizeInput();
    updateSendButton();
  }

  els.input.addEventListener("input", () => {
    autoResizeInput();
    updateSendButton();
  });

  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  els.sendBtn.addEventListener("click", send);

  // ---------- scrolling ----------

  els.messageList.addEventListener("scroll", () => {
    state.userScrolledUp = !isNearBottom();
    maybeRequestHistory();
  });

  // ---------- copy buttons (event delegation, works for dynamically added code blocks) ----------

  els.messageList.addEventListener("click", (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const codeEl = btn.closest(".code-block").querySelector("code");
    const text = codeEl.textContent;
    navigator.clipboard
      .writeText(text)
      .then(() => flashButton(btn, "Copied!"))
      .catch(() => flashButton(btn, "Failed"));
  });

  function flashButton(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  }

  // ---------- header buttons ----------

  els.hideBtn.addEventListener("click", () => window.bubble.hide());

  els.settingsBtn.addEventListener("click", openSettings);
  els.settingsClose.addEventListener("click", closeSettings);

  function openSettings() {
    els.settingsOverlay.hidden = false;
    els.tokenValue.value = "loading…";
    window.bubble.getToken().then((token) => {
      els.tokenValue.value = token || "";
    });
  }

  function closeSettings() {
    els.settingsOverlay.hidden = true;
  }

  els.tokenCopy.addEventListener("click", () => {
    navigator.clipboard
      .writeText(els.tokenValue.value)
      .then(() => flashButton(els.tokenCopy, "Copied!"))
      .catch(() => flashButton(els.tokenCopy, "Failed"));
  });

  els.tokenRegenerate.addEventListener("click", () => {
    const sure = window.confirm(
      "Regenerate the pairing token?\n\nThe current token stops working immediately. " +
        "You'll need to paste the new one into the extension's options page before it " +
        "can reconnect."
    );
    if (!sure) return;
    window.bubble.regenerateToken().then((token) => {
      els.tokenValue.value = token || "";
    });
  });

  // ---------- conversation reset ----------

  function resetConversationState(conversationId, title) {
    state.conversationId = conversationId;
    state.total = 0;
    state.turnsByIndex.clear();
    state.minLoadedIndex = null;
    state.liveTurns.clear();
    state.pendingOptimistic.clear();
    state.hasLoadedOnce = false;
    state.userScrolledUp = false;
    setLoadingOlder(false);

    els.indexedTurns.innerHTML = "";
    els.liveTurns.innerHTML = "";
    els.titleText.textContent = title || (conversationId ? "Untitled conversation" : "New conversation");
    updateHistoryBadge();
    updateEmptyState();
  }

  // ---------- server events ----------

  window.bubble.onServerEvent((event) => {
    switch (event.type) {
      case "peers":
        state.extensionConnected = !!event.extension;
        if (!state.extensionConnected) state.captureStatus = null;
        renderHealth();
        break;

      case "status":
        state.captureStatus = event.capture || null;
        renderHealth();
        break;

      case "conversation":
        if (event.conversationId !== state.conversationId) {
          resetConversationState(event.conversationId, event.title);
        }
        break;

      case "history":
        if (event.conversationId !== state.conversationId) break;
        mergeTurnWindow(indexedMapToArray(event.turns), event.total);
        break;

      case "turn.window":
        if (event.conversationId !== state.conversationId) break;
        mergeTurnWindow(event.turns, event.total);
        break;

      case "turn.start":
        handleTurnStart(event);
        break;

      case "turn.delta":
        handleTurnDelta(event);
        break;

      case "turn.end":
        handleTurnEnd(event);
        break;

      default:
        break;
    }
  });

  // history sends turns as an object keyed by index (JSON object keys are
  // strings); turn.window sends an array. Normalise to the array shape
  // mergeTurnWindow expects.
  function indexedMapToArray(turnsObj) {
    if (!turnsObj) return [];
    return Object.keys(turnsObj).map((k) => ({
      index: Number(k),
      role: turnsObj[k].role,
      text: turnsObj[k].text,
    }));
  }

  // ---------- init ----------

  const v = window.bubble.versions;
  els.versions.textContent = `electron ${v.electron} · chrome ${v.chrome} · node ${v.node}`;

  updateSendButton();
  updateHistoryBadge();
  updateEmptyState();
  renderHealth();
})();
