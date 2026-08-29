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

  // Checked once at load — this is a personal, single-session desktop app,
  // not a long-lived page where the OS setting might plausibly flip while
  // it's open. Gates the JS-side wait-for-animation logic below; the CSS
  // transitions/keyframes it pairs with are gated the same way via their
  // own @media (prefers-reduced-motion: no-preference) blocks in style.css.
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- DOM refs ----------

  const els = {
    panel: document.querySelector(".panel"),
    healthDot: document.getElementById("health-dot"),
    healthDetail: document.getElementById("health-detail"),
    historyBadge: document.getElementById("history-badge"),
    titleText: document.getElementById("title-text"),
    messageList: document.getElementById("message-list"),
    loadingOlder: document.getElementById("loading-older"),
    // The single home for every turn element, regardless of how it
    // arrived — see insertTurnElement. Was two containers
    // (indexed-turns/live-turns); merged after a turn.window for an
    // already-live-tracked index found nothing in indexed-turns (searching
    // the wrong container), fell through to "create new," and rendered
    // the same message twice.
    turns: document.getElementById("turns"),
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
    resizeGrip: document.getElementById("resize-grip"),
    gripTopLeft: document.getElementById("grip-top-left"),
    gripTopRight: document.getElementById("grip-top-right"),
    toast: document.getElementById("toast"),
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

  // Inline SVGs matching the header icon buttons exactly (same viewBox and
  // stroke attributes as #settings-btn/#hide-btn in index.html) except sized
  // 14px instead of 16px, per the message action buttons being smaller.
  // stroke="currentColor" so .turn-action-btn's CSS color controls them.
  const ICON_ATTRS = 'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  const COPY_ICON = `<svg ${ICON_ATTRS}><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"></path></svg>`;
  const RETRY_ICON = `<svg ${ICON_ATTRS}><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>`;
  const CHECK_ICON = `<svg ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"></path></svg>`;

  function createTurnElement(role) {
    const el = document.createElement("div");
    el.className = "turn turn-" + (role === "user" ? "user" : "assistant");

    const content = document.createElement("div");
    content.className = "turn-content";
    if (role !== "user") {
      // Placeholder for the gap between turn.start and the first delta —
      // an assistant reply can take a moment to start streaming, and an
      // empty bubble showing nothing but background color in that gap
      // reads as broken rather than as loading. paintTurn's innerHTML
      // assignment overwrites this the instant real text arrives (see
      // paintTurn below), so nothing needs to remove it explicitly. Never
      // added for a user turn — those are always painted with real text
      // in the same tick they're created (see renderOptimisticUserTurn),
      // so there's no gap for a placeholder to fill.
      content.innerHTML =
        '<span class="turn-loading" aria-hidden="true">' +
        '<span class="turn-loading-dot"></span>' +
        '<span class="turn-loading-dot"></span>' +
        '<span class="turn-loading-dot"></span>' +
        "</span>";
    }
    el.appendChild(content);

    // Copy (bubble-only) and retry/resend (needs the extension — see
    // handleRetryClick) sit outside the bubble, as a sibling of
    // .turn-content rather than nested inside it — nesting them in the
    // bubble made them sit on top of message content (code blocks
    // especially) and get hard to see. The earlier hover-ambiguity bug this
    // used to have (the wrong message's icons appearing near a scroll
    // boundary) is fixed differently now: .turn itself reserves real
    // padding-bottom for this row (see style.css), so .turn's own hoverable
    // box fully contains it — two turns' boxes can't overlap by
    // definition, so neither can their action rows. Always both buttons
    // created (not conditionally, based on role) so hovering never changes
    // which icons are reserved, only their opacity; retry's own click
    // handler is what tells a user turn from an assistant one apart when
    // deciding which action to ask the extension to perform.
    const actions = document.createElement("div");
    actions.className = "turn-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "turn-action-btn turn-copy-btn";
    copyBtn.title = "Copy";
    copyBtn.innerHTML = COPY_ICON;
    actions.appendChild(copyBtn);

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "turn-action-btn turn-retry-btn";
    retryBtn.title = role === "user" ? "Resend" : "Retry";
    retryBtn.innerHTML = RETRY_ICON;
    actions.appendChild(retryBtn);

    el.appendChild(actions);
    return el;
  }

  // classList.add/remove rather than overwriting el.className outright —
  // paintTurn repaints the same element many times a second while a reply
  // streams in (see handleTurnDelta), and a blind className reset would
  // strip playEntranceAnimation's "turn-enter" class before its animation
  // (see below) had a chance to finish.
  // force skips the guard below — only handleTurnEnd passes it, since
  // turn.end's text is authoritative (SPEC.md §4: "the full final text ...
  // replaces whatever the deltas produced") including the rare case where a
  // reply genuinely produces nothing. Without that escape hatch, a
  // genuinely-empty final answer would leave the loading dots showing
  // forever — the guard exists to protect against a PREMATURE empty read,
  // not to treat "empty" as unpaintable in general.
  function paintTurn(el, role, text, { force = false } = {}) {
    el.classList.remove("turn-user", "turn-assistant");
    el.classList.add("turn", "turn-" + (role === "user" ? "user" : "assistant"));
    // .turn-actions is a sibling of .turn-content, not a child of it (see
    // createTurnElement), so overwriting .turn-content's innerHTML here
    // can't touch it — the intermediate .turn-content-body wrapper a
    // previous version of this needed for exactly that reason is gone; it
    // was only ever needed while the actions row lived inside .turn-content.
    const content = el.querySelector(".turn-content");
    // An empty string is never meaningful content for an assistant turn —
    // it's either a premature turn.window read of a row that hasn't started
    // streaming yet (see upsertIndexedTurn) or an in-progress delta/replace
    // with nothing accumulated so far. Skipping the repaint in that case is
    // what stops those from wiping createTurnElement's loading dots (also a
    // child of .turn-content) before real content ever arrives. Checking for
    // .turn-loading specifically — rather than also gating on role — means
    // this is a no-op for anything that's already shown real content (the
    // dots are long gone by then) and for user turns (which never get dots
    // in the first place), with nothing else to special-case.
    if (!force && !text && content.querySelector(".turn-loading")) {
      return;
    }
    content.innerHTML = renderMarkdown(text);
    // Raw (pre-markdown) text for the copy button — kept as a plain JS
    // property rather than a dataset/HTML attribute, since it's arbitrary
    // message text (any length, any characters) rather than a short token.
    el._rawText = text;
  }

  // Marks a freshly-created turn element as one to fade/slide in — only for
  // turns that are genuinely new (an incoming reply, a message the operator
  // just sent). History loaded via mergeTurnWindow/upsertIndexedTurn never
  // calls this, so a batch of a dozen backfilled turns appears instantly
  // instead of animating in one by one like a slot machine.
  function playEntranceAnimation(el) {
    el.classList.add("turn-enter");
    el.addEventListener("animationend", () => el.classList.remove("turn-enter"), { once: true });
  }

  // Defensive: if "one index, one element" is ever violated again (this is
  // exactly the bug that motivated merging indexed-turns/live-turns into a
  // single els.turns — see the els.turns comment above), this makes it
  // loudly visible in the console the moment it happens rather than
  // silently rendering a duplicate that's only noticed later from a
  // screenshot.
  // The one place that answers "does this index already have an element in
  // the DOM" — used both when merging turn.window/history data
  // (upsertIndexedTurn) and when a turn.start arrives (handleTurnStart).
  // turn.window routinely arrives before turn.start for the same index (the
  // extension's row observer fires on row insertion, before streaming
  // begins), so upsertIndexedTurn's element is usually already there by the
  // time turn.start shows up. Both call sites have to agree on the same
  // answer, or whichever runs second creates a duplicate for that index
  // instead of adopting the first (this was the cause of the "index N has 2
  // DOM elements" invariant violation).
  function findTurnElementByIndex(index) {
    if (typeof index !== "number") return null;
    return els.turns.querySelector(`[data-index="${index}"]`);
  }

  function warnIfDuplicateIndex(index) {
    if (typeof index !== "number") return;
    const matches = els.turns.querySelectorAll(`[data-index="${index}"]`);
    if (matches.length > 1) {
      console.error(
        `[bubble-ui] INVARIANT VIOLATION: index ${index} has ${matches.length} DOM elements in #turns — should be exactly one.`,
        matches
      );
      // Surfaced in the bubble itself, not just the console — this fired
      // silently before and was only found by reading terminal output.
      // showToast is defined later in this file as a function declaration
      // (hoisted), so it's already callable here regardless of source order.
      showToast(`Bug: message ${index} is rendered twice. Check the console for details.`);
    }
  }

  // The one place any turn element gets placed into (or moved within)
  // els.turns. index === null means "not yet known" (an optimistic send
  // before reconciliation, or one of the rare fallback-creation paths in
  // handleTurnDelta/handleTurnReplace/handleTurnEnd) — appended at the
  // end, which for a chat transcript is always the right place for
  // something whose position isn't determined yet. A known index is
  // inserted in sorted order among siblings that also have one.
  //
  // insertBefore/appendChild MOVE a node if it's already elsewhere in the
  // DOM rather than inserting a second copy, so this also handles
  // repositioning an optimistic element into sorted order once
  // reconciliation gives it a real index (see handleTurnStart) — not just
  // placing brand-new elements.
  function insertTurnElement(el, index) {
    if (typeof index !== "number") {
      els.turns.appendChild(el);
      return;
    }
    const siblings = Array.from(els.turns.children).filter((c) => c !== el);
    let inserted = false;
    for (const sibling of siblings) {
      const siblingIndex = Number(sibling.dataset.index);
      if (!Number.isNaN(siblingIndex) && siblingIndex > index) {
        els.turns.insertBefore(el, sibling);
        inserted = true;
        break;
      }
    }
    if (!inserted) els.turns.appendChild(el);
    warnIfDuplicateIndex(index);
  }

  function upsertIndexedTurn(index, role, text) {
    state.turnsByIndex.set(index, { role, text });
    if (state.minLoadedIndex === null || index < state.minLoadedIndex) {
      state.minLoadedIndex = index;
    }

    let el = findTurnElementByIndex(index);
    if (el) {
      paintTurn(el, role, text);
      warnIfDuplicateIndex(index);
      return;
    }
    el = createTurnElement(role);
    el.dataset.index = String(index);
    paintTurn(el, role, text);
    insertTurnElement(el, index);
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
    insertTurnElement(el, null);
    playEntranceAnimation(el);
    state.pendingOptimistic.set(promptId, el);
    state.userScrolledUp = false;
    updateEmptyState();
    updateHistoryBadge();
    scrollToBottom();
  }

  function handleTurnStart(msg) {
    let el = null;
    let isNewElement = false;
    let adopted = false;
    const index = typeof msg.index === "number" ? msg.index : null;

    if (msg.origin === "bubble" && msg.promptId && state.pendingOptimistic.has(msg.promptId)) {
      // Reconcile: this is the echo of a message the bubble already rendered
      // optimistically. Reuse that element rather than adding a duplicate.
      el = state.pendingOptimistic.get(msg.promptId);
      state.pendingOptimistic.delete(msg.promptId);
      delete el.dataset.promptId;
    } else {
      // turn.window normally arrives before turn.start for the same index
      // (see findTurnElementByIndex) — adopt that element instead of
      // creating a second one for the same slot.
      el = findTurnElementByIndex(index);
      if (el) {
        adopted = true;
      } else {
        el = createTurnElement(msg.role);
        isNewElement = true;
      }
    }

    el.dataset.turnId = msg.turnId;
    // Lets retry work on this turn as soon as it starts, rather than only
    // once some later turn.window/harvest happens to cover it — the
    // message the operator just sent or the reply just received is the
    // most likely thing to want to retry (see SPEC.md §4's retry message).
    if (index !== null) el.dataset.index = String(index);
    // Covers both cases: placing a brand-new element, and — since this
    // moves rather than duplicates a node already in the DOM — repositioning
    // the reconciled optimistic element into sorted order now that it has a
    // real index, rather than leaving it wherever it was appended when sent.
    insertTurnElement(el, index);
    if (isNewElement) playEntranceAnimation(el);

    state.liveTurns.set(msg.turnId, { el, buffer: "" });
    updateEmptyState();
    updateHistoryBadge();

    // DIAGNOSTIC (message-not-visible bug, 2026-08-29) — insertTurnElement
    // places by sorted index, so a newly-inserted turn is not necessarily
    // the LAST element in DOM order: if a HIGHER index is already loaded
    // from an earlier, gappy sync (turnsInDom below is regularly far short
    // of total — see the previous "turn.window" logging), the new element
    // lands ABOVE it instead of at the bottom. scrollToBottom() scrolls to
    // whatever DOM order says is last, which may not be this element even
    // when it fires. domOrder/elIsLastInDom below settle that directly;
    // userScrolledUp/autoScrollFired settle the separate question of
    // whether the scroll was even attempted.
    const willAutoScroll = !state.userScrolledUp;
    if (willAutoScroll) scrollToBottom();
    const domOrder = Array.from(els.turns.children).map((c) =>
      c.dataset.index !== undefined ? c.dataset.index : "none"
    );
    console.log(
      `[bubble-ui] turn.start: turnId=${msg.turnId} index=${index} role=${msg.role} ` +
        `conversationIdOnMessage=N/A(protocol carries none) currentConversation=${state.conversationId} ` +
        `adopted=${adopted} isNewElement=${isNewElement} elConnected=${el.isConnected} ` +
        `turnsInDom=${els.turns.children.length}\n` +
        `  domOrder=[${domOrder.join(",")}] elIsLastInDom=${els.turns.lastElementChild === el} ` +
        `userScrolledUp=${state.userScrolledUp} autoScrollFired=${willAutoScroll} ` +
        `scrollTop=${els.messageList.scrollTop} scrollHeight=${els.messageList.scrollHeight} ` +
        `clientHeight=${els.messageList.clientHeight}`
    );
  }

  function handleTurnDelta(msg) {
    let live = state.liveTurns.get(msg.turnId);
    const hadLiveTurn = !!live;
    if (!live) {
      // No matching turn.start (e.g. app restarted mid-stream) — start one
      // now so the text isn't silently lost.
      // DIAGNOSTIC (bug: two elements for the same index): this element
      // gets NO index at all — turn.delta never carries one — so if a
      // later turn.window arrives for what should be the same message,
      // upsertIndexedTurn's lookup can never find this element. Worth
      // knowing whether this fallback is firing at all. Remove once
      // resolved.
      console.log(`[bubble-ui] handleTurnDelta: no live turn for turnId=${msg.turnId} — creating one with NO index.`);
      const el = createTurnElement("assistant");
      insertTurnElement(el, null);
      playEntranceAnimation(el);
      live = { el, buffer: "" };
      state.liveTurns.set(msg.turnId, live);
      updateEmptyState();
      updateHistoryBadge();
    }
    live.buffer += msg.text || "";
    paintTurn(live.el, live.el.className.includes("turn-user") ? "user" : "assistant", live.buffer);
    if (!state.userScrolledUp) scrollToBottom();

    // DIAGNOSTIC (new-message-not-appearing bug, 2026-08-29) — same protocol
    // gap as turn.start: no conversationId on this message type, so nothing
    // here is ever accepted/rejected on that basis. hadLiveTurn=false would
    // mean turn.start never registered this turnId before the first delta
    // arrived — that's the one way this path itself could produce an
    // orphaned, unindexed element instead of updating the right one.
    console.log(
      `[bubble-ui] turn.delta: turnId=${msg.turnId} conversationIdOnMessage=N/A(protocol carries none) ` +
        `currentConversation=${state.conversationId} hadLiveTurn=${hadLiveTurn} bufferLen=${live.buffer.length} ` +
        `elConnected=${live.el.isConnected}`
    );
  }

  // The extension's text extraction can reshape text already sent as
  // deltas (see SPEC.md §4 on turn.replace) — a pure append protocol can't
  // represent that. This overwrites the turn's buffer in place rather than
  // appending; like handleTurnDelta/handleTurnEnd, it must never create a
  // second element for a turnId it already knows about.
  function handleTurnReplace(msg) {
    let live = state.liveTurns.get(msg.turnId);
    if (!live) {
      // DIAGNOSTIC (bug: two elements for the same index) — see handleTurnDelta.
      console.log(`[bubble-ui] handleTurnReplace: no live turn for turnId=${msg.turnId} — creating one with NO index.`);
      const el = createTurnElement("assistant");
      insertTurnElement(el, null);
      playEntranceAnimation(el);
      live = { el, buffer: "" };
      state.liveTurns.set(msg.turnId, live);
      updateEmptyState();
      updateHistoryBadge();
    }
    live.buffer = msg.text || "";
    paintTurn(live.el, live.el.className.includes("turn-user") ? "user" : "assistant", live.buffer);
    if (!state.userScrolledUp) scrollToBottom();
  }

  function handleTurnEnd(msg) {
    let live = state.liveTurns.get(msg.turnId);
    if (!live) {
      // DIAGNOSTIC (bug: two elements for the same index) — see handleTurnDelta.
      console.log(`[bubble-ui] handleTurnEnd: no live turn for turnId=${msg.turnId} — creating one with NO index.`);
      const el = createTurnElement("assistant");
      insertTurnElement(el, null);
      playEntranceAnimation(el);
      live = { el, buffer: "" };
      state.liveTurns.set(msg.turnId, live);
    }
    // The final text is authoritative and replaces whatever the deltas
    // produced — force: true so a genuinely empty reply still clears the
    // loading dots (see paintTurn) instead of leaving them stuck forever.
    paintTurn(live.el, live.el.className.includes("turn-user") ? "user" : "assistant", msg.text, { force: true });
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

  // ---------- message actions: copy / retry, and code-block copy buttons ----------
  // One delegated listener (works for dynamically added turns and code
  // blocks alike, no per-element listeners to attach/leak).

  els.messageList.addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".turn-copy-btn");
    if (copyBtn) {
      handleCopyClick(copyBtn);
      return;
    }

    const retryBtn = e.target.closest(".turn-retry-btn");
    if (retryBtn) {
      handleRetryClick(retryBtn);
      return;
    }

    const codeBtn = e.target.closest(".copy-btn");
    if (codeBtn) {
      const codeEl = codeBtn.closest(".code-block").querySelector("code");
      const text = codeEl.textContent;
      navigator.clipboard
        .writeText(text)
        .then(() => flashButton(codeBtn, "Copied!"))
        .catch(() => flashButton(codeBtn, "Failed"));
    }
  });

  // Bubble-only — no extension involvement. Copies the turn's raw (pre-
  // markdown) text, stashed on the element by paintTurn.
  function handleCopyClick(btn) {
    const turnEl = btn.closest(".turn");
    const text = (turnEl && turnEl._rawText) || "";
    navigator.clipboard
      .writeText(text)
      .then(() => flashIcon(btn, CHECK_ICON))
      .catch(() => {});
  }

  // Needs the extension — asks it to click the retry/resend button for
  // this turn's row on the actual claude.ai page (SPEC.md §4's retry
  // message). Only possible once the turn's index is known: a message the
  // operator just sent doesn't have one yet at the moment it's rendered
  // optimistically, since that only arrives once the extension's turn.start
  // round-trips (see handleTurnStart) — retrying before then has nothing to
  // target on the page, so this shows the same toast a failed retry would
  // rather than sending a meaningless request.
  function handleRetryClick(btn) {
    const turnEl = btn.closest(".turn");
    const indexAttr = turnEl && turnEl.dataset.index;
    if (indexAttr === undefined) {
      showToast("This message isn't ready to retry yet — try again in a moment.");
      return;
    }
    window.bubble.retryTurn(state.conversationId, Number(indexAttr));
  }

  // Swaps a message-action button's icon (e.g. to CHECK_ICON) for ~1.5s.
  // Keeps the action row visible for that whole time via .pinned, since the
  // operator may have already moved the mouse off .turn by the time this
  // fires (hover alone would hide the confirmation early).
  function flashIcon(btn, iconHtml) {
    const original = btn.innerHTML;
    const actions = btn.closest(".turn-actions");
    btn.innerHTML = iconHtml;
    btn.disabled = true;
    if (actions) actions.classList.add("pinned");
    setTimeout(() => {
      btn.innerHTML = original;
      btn.disabled = false;
      if (actions) actions.classList.remove("pinned");
    }, 1500);
  }

  // ---------- toast ----------
  // Small transient banner for things worth surfacing but not worth a
  // permanent UI state change — currently just a failed retry (SPEC.md §4).

  let toastTimer = null;
  function showToast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    // rAF so the hidden->visible transition actually runs — toggling
    // opacity in the same tick as removing `hidden` can get coalesced by
    // the browser into a single style recalc with no transition.
    requestAnimationFrame(() => els.toast.classList.add("visible"));
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("visible");
      setTimeout(() => {
        els.toast.hidden = true;
      }, 200);
    }, 4000);
  }

  function flashButton(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1200);
  }

  // Toggled by main.js while the window is actively resizing or moving
  // (from any source — the header drag, the still-native bottom-left
  // corner, or the JS-driven grips below) so style.css can swap .panel's
  // box-shadow for a cheaper one for the duration. See main.js's
  // onWindowDragActivity for why this lives there and not here.
  window.bubble.onDragState((dragging) => {
    document.body.classList.toggle("dragging", dragging);
  });

  // ---------- resize grips ----------
  // Native OS edge/corner resize is unreliable on this window (transparent +
  // frameless on macOS) — every grip below drives the resize directly via
  // IPC instead of depending on OS hit-testing. Target bounds are computed
  // fresh from a fixed starting point on every mousemove (not accumulated
  // deltas), so a dropped or coalesced event can't cause drift.
  //
  // mousemove fires far more often than the window can actually redraw a
  // resize, so sending on every event caused visible stutter. Throttled to
  // one send per animation frame: each mousemove only updates a "pending"
  // target (overwriting whatever was there — intermediate values are
  // dropped, not queued), and a single rAF callback flushes whatever's
  // pending right before the next paint. mouseup sends one last,
  // un-throttled update computed directly from the cursor's exact final
  // position, so the end state isn't left at whatever the last frame's
  // pending value happened to be.

  // Populated from main.js so the clamping below can't drift out of sync
  // with the BrowserWindow's own min/max constraints (see main.js). Falls
  // back to those same values until the IPC round-trip resolves, which is
  // effectively immediate — well before a user could start dragging.
  let sizeLimits = { minWidth: 320, minHeight: 400, maxWidth: 700, maxHeight: 10000 };
  window.bubble.getSizeLimits().then((limits) => {
    if (limits) sizeLimits = limits;
  });

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // gripEl: element to attach the drag to and toggle '.resizing' on for the
  // hover-visibility CSS. computeTarget(evt, start) turns a mouse event plus
  // the drag's starting snapshot into the bounds that grip should produce.
  // apply(target) sends that result to the main process.
  function setupResizeGrip(gripEl, computeTarget, apply) {
    gripEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const start = {
        mouseX: e.screenX,
        mouseY: e.screenY,
        winX: window.screenX,
        winY: window.screenY,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      gripEl.classList.add("resizing");

      let pending = null;
      let rafId = null;

      function flush() {
        rafId = null;
        if (pending) {
          apply(pending);
          pending = null;
        }
      }

      function onMouseMove(moveEvent) {
        pending = computeTarget(moveEvent, start);
        if (rafId === null) rafId = requestAnimationFrame(flush);
      }

      function onMouseUp(upEvent) {
        gripEl.classList.remove("resizing");
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        apply(computeTarget(upEvent, start));
      }

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    });
  }

  // Bottom-right: anchors the top-left corner (window's x/y never change),
  // so plain width/height via setSize is enough — same as before this grip
  // had company.
  setupResizeGrip(
    els.resizeGrip,
    (evt, start) => ({
      width: clamp(start.width + (evt.screenX - start.mouseX), sizeLimits.minWidth, sizeLimits.maxWidth),
      height: clamp(start.height + (evt.screenY - start.mouseY), sizeLimits.minHeight, sizeLimits.maxHeight),
    }),
    (target) => window.bubble.resizeWindow(target.width, target.height)
  );

  // Top-left: anchors the bottom-right corner, so the window's origin has
  // to move as it resizes — x/y are recomputed from the *clamped* size
  // (not the raw drag delta) so the anchored corner can't drift if the
  // drag pushes past a min/max limit.
  setupResizeGrip(
    els.gripTopLeft,
    (evt, start) => {
      const width = clamp(start.width - (evt.screenX - start.mouseX), sizeLimits.minWidth, sizeLimits.maxWidth);
      const height = clamp(start.height - (evt.screenY - start.mouseY), sizeLimits.minHeight, sizeLimits.maxHeight);
      return {
        x: start.winX + start.width - width,
        y: start.winY + start.height - height,
        width,
        height,
      };
    },
    (target) => window.bubble.resizeBounds(target.x, target.y, target.width, target.height)
  );

  // Top-right: anchors the bottom-left corner — x stays fixed, y moves with
  // height the same way top-left's does.
  setupResizeGrip(
    els.gripTopRight,
    (evt, start) => {
      const width = clamp(start.width + (evt.screenX - start.mouseX), sizeLimits.minWidth, sizeLimits.maxWidth);
      const height = clamp(start.height - (evt.screenY - start.mouseY), sizeLimits.minHeight, sizeLimits.maxHeight);
      return {
        x: start.winX,
        y: start.winY + start.height - height,
        width,
        height,
      };
    },
    (target) => window.bubble.resizeBounds(target.x, target.y, target.width, target.height)
  );

  // ---------- header buttons ----------

  // Fades/scales .panel out (see style.css's .panel-hidden), then tells
  // main.js to actually call win.hide() — the window must stay mapped
  // until the animation is done or there'd be nothing on screen to animate.
  // Shared by the hide button (which starts the animation itself, since
  // it's already in the renderer) and window.bubble.onRequestHide below
  // (Cmd+Shift+C / the tray, which only main.js hears and has to ask the
  // renderer to animate before it can hide anything). Skips straight to
  // hiding under prefers-reduced-motion, since no transition will run to
  // wait for.
  function beginHideAnimation() {
    if (prefersReducedMotion) {
      window.bubble.hide();
      return;
    }
    els.panel.classList.add("panel-hidden");
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      els.panel.removeEventListener("transitionend", onEnd);
      window.bubble.hide();
    }
    function onEnd(e) {
      if (e.target === els.panel) finish();
    }
    els.panel.addEventListener("transitionend", onEnd);
    // Safety net in case transitionend never fires for some reason (e.g. a
    // dropped event) — without it a missed event would leave the bubble
    // stuck invisible-but-not-actually-hidden.
    setTimeout(finish, 250);
  }

  els.hideBtn.addEventListener("click", beginHideAnimation);
  window.bubble.onRequestHide(beginHideAnimation);

  // The window is already visible again by the time this fires (main.js
  // calls win.show() first) — removing the class here is what plays the
  // fade/scale back in over .panel's transition.
  window.bubble.onRequestShow(() => {
    els.panel.classList.remove("panel-hidden");
  });

  els.settingsBtn.addEventListener("click", openSettings);
  els.settingsClose.addEventListener("click", closeSettings);

  function openSettings() {
    els.settingsOverlay.classList.add("settings-open");
    els.tokenValue.value = "loading…";
    window.bubble.getToken().then((token) => {
      els.tokenValue.value = token || "";
    });
  }

  function closeSettings() {
    els.settingsOverlay.classList.remove("settings-open");
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

    els.turns.innerHTML = "";
    els.titleText.textContent = title || (conversationId ? "Untitled conversation" : "New conversation");
    updateHistoryBadge();
    updateEmptyState();
  }

  // ---------- server events ----------

  window.bubble.onServerEvent((event) => {
    switch (event.type) {
      case "error":
        showToast(event.message || "Something went wrong.");
        break;

      case "peers":
        state.extensionConnected = !!event.extension;
        if (!state.extensionConnected) state.captureStatus = null;
        renderHealth();
        break;

      case "status":
        state.captureStatus = event.capture || null;
        renderHealth();
        break;

      case "conversation": {
        // DIAGNOSTIC (conversation-switch bug, step 3) — confirms the event
        // actually reached the bubble and whether it decided to reset.
        const willReset = event.conversationId !== state.conversationId;
        console.log(
          `[bubble-ui] conversation event: incoming=${event.conversationId} ` +
            `current=${state.conversationId} willReset=${willReset}`
        );
        if (willReset) {
          resetConversationState(event.conversationId, event.title);
        }
        break;
      }

      case "history": {
        // DIAGNOSTIC (new-message-not-appearing bug, 2026-08-29) — history
        // is resent on every "conversation" message the server receives,
        // including a redundant reconnect reannounce to the SAME id (see
        // server.js's case "conversation") — logged here so a resync that
        // happens to land mid-reply is visible, not just a real switch.
        const accepted = event.conversationId === state.conversationId;
        console.log(
          `[bubble-ui] history: for=${event.conversationId} current=${state.conversationId} ` +
            `accepted=${accepted}${accepted ? "" : " (dropped: conversationId mismatch)"} total=${event.total}`
        );
        if (!accepted) break;
        mergeTurnWindow(indexedMapToArray(event.turns), event.total);
        break;
      }

      case "turn.window": {
        const accepted = event.conversationId === state.conversationId;
        console.log(
          `[bubble-ui] turn.window: for=${event.conversationId} current=${state.conversationId} ` +
            `accepted=${accepted}${accepted ? "" : " (dropped: conversationId mismatch)"} ` +
            `indices=${event.turns.map((t) => t.index).join(",")} total=${event.total}`
        );
        if (!accepted) break;
        mergeTurnWindow(event.turns, event.total);
        break;
      }

      case "turn.start":
        handleTurnStart(event);
        break;

      case "turn.delta":
        handleTurnDelta(event);
        break;

      case "turn.replace":
        handleTurnReplace(event);
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
