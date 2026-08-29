// [bubble-ext] content script.
// Part A: connection shell — token, WebSocket, reconnect with backoff.
// Part B: reading the conversation — conversation id/title tracking,
// turn.window from the currently-rendered rows, capture health.
// Part C: streaming (turn.start/delta/end) and full text extraction,
// including code-fence rebuilding and content placeholders.
// Sending prompts and history harvesting are Part D.
//
// The text-extraction functions below are pure (no chrome.* / no DOM
// mutation beyond a hide/restore on the row passed in) so they can be
// exercised from plain Node — see content.test.js, run with
// `node extension/content.test.js`, no browser and no dependency needed.

// ---------------------------------------------------------------------
// Text extraction (pure — see content.test.js)
// ---------------------------------------------------------------------

const ROLE_PREFIX_RE = /^(Claude responded|You said):\s*/;

// Confirmed 2026-08-28: <time data-cds="RelativeTime">6 days ago</time>.
// Excluded by selector in extractRowText(), same as the action buttons.
// This regex stays only as a fallback in cleanText() in case that element
// is ever renamed or missing.
const TRAILING_TIMESTAMP_RE = /\s*(just now|\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago)\s*$/i;

// claude.ai appends " - Claude" to document.title. Anchored at the end so
// a conversation genuinely named e.g. "Comparing GPT-4 - Claude" only has
// the app's own trailing suffix removed, not the "- Claude" that's part of
// the real title.
const TITLE_SUFFIX_RE = / - Claude$/;

function stripTitleSuffix(title) {
  return (title || "").replace(TITLE_SUFFIX_RE, "");
}

// Rows begin with an accessibility announcement — "Claude responded: " or
// "You said: " followed by a preview of the message (an exact truncated
// copy for some messages, a paraphrase for others — see SELECTORS.md). That
// whole announcement, prefix included, lives in a single sr-only <h2> that
// extractRowText excludes by selector before this function ever sees the
// text (real fix; no text comparison can reliably tell a paraphrased
// preview from real content). What remains here is a fallback only, for
// the case that element isn't found — strip a leading prefix if present,
// nothing more. Do not try to also drop a "duplicate" that follows: without
// the DOM signal, there's no reliable way to tell a genuine duplicate
// apart from a legitimate first line, and guessing risks eating real
// content.
function stripAccessibilityDuplicate(text) {
  const prefixMatch = text.match(ROLE_PREFIX_RE);
  if (!prefixMatch) return text;
  return text.slice(prefixMatch[0].length);
}

function cleanText(raw) {
  let text = raw || "";
  text = stripAccessibilityDuplicate(text);
  text = text.replace(TRAILING_TIMESTAMP_RE, "");
  return text.trim();
}

// Per-message controls (copy/retry/thumbs/read-aloud/edit) render as text
// inside the row and leak into innerText as garbage. Hiding the actual live
// elements — not a detached clone — and restoring them synchronously
// (nothing repaints in between) keeps innerText's layout-aware behaviour,
// which a clone removed from the document would lose: innerText on a
// detached node falls back to textContent, which is exactly the
// code-formatting-destroying behaviour SPEC.md §7 ruled out.
const EXCLUDED_CONTROL_SELECTORS = [
  '[data-testid="action-bar-copy"]',
  '[data-testid="action-bar-retry"]',
  '[data-testid="action-bar-thumbs-up"]',
  '[data-testid="action-bar-thumbs-down"]',
  '[data-testid="action-bar-read-aloud"]',
  '[data-testid="user-message-retry"]',
  '[data-testid="user-message-edit"]',
  '[data-testid="user-message-copy"]',
].join(",");

// Confirmed 2026-08-28: the relative-timestamp element itself.
const TIMESTAMP_SELECTOR = 'time[data-cds="RelativeTime"]';

// Confirmed 2026-08-28: <h2 data-find-omitted="" class="sr-only select-none">
// You said: <preview></h2> — the screen-reader-only announcement holding
// both the "Claude responded: " / "You said: " prefix and the (sometimes
// paraphrased) preview described above. Scoped to h2.sr-only rather than a
// bare .sr-only in case that utility class is reused elsewhere for
// something that should stay.
const ACCESSIBILITY_PREVIEW_SELECTOR = "h2.sr-only";

// Tool/MCP status UI (a connecting/searching pill with a status icon and an
// expand caret) leaks its own text — a stray "V" and status strings like
// "Connecting to visualize..." — into the message. Per SPEC.md §7, tool use
// should leave a short trace rather than vanish outright, so a fixed
// "[tool]" placeholder is substituted in its place rather than just hiding
// it: extracting the pill's actual status text isn't attempted, since that
// text is UI chrome describing a transient connection/search state (not a
// clean "<query>" string SPEC.md's [searched: <query>] format assumes),
// and a fixed placeholder is immune to whatever phrasing a given tool
// happens to use.
const TOOL_STATUS_PILL_SELECTOR = '[data-testid="tool-status-pill"]';
// Defensive: only known to matter if spark/caret ever render outside a
// pill, since a hidden pill already hides any children nested inside it.
const TOOL_STATUS_MINOR_SELECTORS = '[data-testid="tool-status-spark"], [data-testid="tool-status-caret"]';
const TOOL_PLACEHOLDER = "[tool]";

// Confirmed 2026-08-28: icon glyphs rendered with a private-use font
// (Anthropicons). Their codepoints render as striped boxes anywhere outside
// claude.ai's own font, so they're pure UI chrome — hidden silently.
const ICON_GLYPH_SELECTOR = 'span[data-cds="Icon"]';

// The code-block copy button (a hover-revealed wrapper inside <pre>). Its
// only distinguishing markup the operator found was Tailwind utility
// classes (sticky/opacity-0/group-hover:.../float-right), which are
// explicitly not to be relied on — they're the first thing to change on a
// styling pass. Selector chosen instead: any <button> inside a <pre>,
// scoped by semantic role/structure rather than styling. Code shown in a
// <pre> is text/syntax-highlighting spans, never an interactive <button> —
// there's no legitimate code content this could wrongly exclude — so "a
// button living inside a pre block" is a stable, self-describing signal
// regardless of how the wrapper around it is styled or named.
const CODE_COPY_BUTTON_SELECTOR = "pre button";

// ASSUMED, not yet confirmed: claude.ai renders images as standard <img>
// tags. This is ordinary HTML semantics (the same category of confidence as
// using document.title for the conversation title) rather than a guessed
// claude.ai-specific class/testid, but hasn't been independently verified —
// check that a message containing an image actually shows [image].
const IMAGE_SELECTOR = "img";
const IMAGE_PLACEHOLDER = "[image]";

// Tags every placeholder <span> extractRowText inserts (for [tool], [image],
// and any future placeholder) so attachRowObserver's MutationObserver can
// tell "extractRowText inserted this" apart from "the page added a real
// row" — without it, inserting/removing a marker would trigger our own
// observer and schedule a pointless re-extraction on every read, forever.
const PLACEHOLDER_MARKER_ATTR = "data-bubble-ext-marker";

// Common language identifiers that appear as the bare "label line"
// immediately before a code block (SELECTORS.md's raw sample: "...\n\npython
// \ndef reverse_string..."). Curated rather than a generic
// "looks like a short token" regex so a genuine short line of prose (e.g.
// "Example:") right before a code block is never mistaken for a language
// tag and swallowed into the fence.
const KNOWN_LANGUAGE_LABELS = new Set([
  "python", "py", "javascript", "js", "jsx", "typescript", "ts", "tsx",
  "bash", "sh", "shell", "zsh", "powershell", "ps1",
  "json", "yaml", "yml", "toml", "xml", "html", "css", "scss", "sass", "less",
  "markdown", "md", "sql", "graphql", "diff", "dockerfile", "makefile",
  "ruby", "rb", "go", "golang", "rust", "rs", "java", "kotlin", "kt", "scala",
  "c", "cpp", "c++", "csharp", "c#", "objective-c", "objectivec", "swift",
  "php", "perl", "lua", "haskell", "elixir", "erlang", "clojure",
  "r", "matlab", "julia", "dart", "vue", "svelte", "plaintext", "text", "txt",
]);

// Pure: given the flattened row text and the exact code text of each <pre>
// block (in DOM order), rebuild ``` fences. Kept separate from DOM access
// (see rebuildCodeFences below) so it can be unit tested without a browser.
//
// <pre> is used only to get each code block's exact boundaries — text
// alone can't reliably find where a code block ENDS, since code can
// contain blank lines. The language label is identified from the
// flattened text itself (no confirmed selector exists for a language-label
// DOM element), by checking whether the line immediately before the code
// is one of KNOWN_LANGUAGE_LABELS; if not, the fence is emitted without a
// language rather than guessing.
function insertCodeFences(text, codeTexts) {
  let raw = text;
  let cursor = 0;
  (codeTexts || []).forEach((codeText) => {
    if (!codeText) return;

    let idx = raw.indexOf(codeText, cursor);
    let matched = codeText;
    if (idx === -1) {
      const trimmedEnd = codeText.replace(/\s+$/, "");
      if (trimmedEnd && trimmedEnd !== codeText) {
        idx = raw.indexOf(trimmedEnd, cursor);
        matched = trimmedEnd;
      }
    }
    if (idx === -1) return; // couldn't locate it — leave the text as-is

    const before = raw.slice(0, idx);
    const lines = before.split("\n");
    let li = lines.length - 1;
    while (li >= 0 && lines[li].trim() === "") li--;

    let prefixEnd = idx;
    let language = "";
    if (li >= 0) {
      const candidate = lines[li].trim();
      if (KNOWN_LANGUAGE_LABELS.has(candidate.toLowerCase())) {
        language = candidate;
        prefixEnd = lines.slice(0, li).join("\n").length + (li > 0 ? 1 : 0);
      }
    }

    const fence = "```" + language + "\n" + matched + "\n```";
    raw = raw.slice(0, prefixEnd) + fence + raw.slice(idx + matched.length);
    cursor = prefixEnd + fence.length;
  });
  return raw;
}

function rebuildCodeFences(row, text) {
  const codeTexts = Array.from(row.querySelectorAll("pre")).map((pre) => pre.innerText || "");
  return insertCodeFences(text, codeTexts);
}

function extractRowText(row) {
  const hiddenElements = [];
  const insertedMarkers = [];

  function hide(el) {
    hiddenElements.push({ el, previousDisplay: el.style.display });
    el.style.display = "none";
  }

  function placeholder(el, text) {
    const marker = document.createElement("span");
    marker.setAttribute(PLACEHOLDER_MARKER_ATTR, "true");
    marker.textContent = text;
    el.parentNode.insertBefore(marker, el);
    insertedMarkers.push(marker);
    hide(el);
  }

  // Pure UI chrome — hidden silently, no placeholder.
  row.querySelectorAll(EXCLUDED_CONTROL_SELECTORS).forEach(hide);
  row.querySelectorAll(TIMESTAMP_SELECTOR).forEach(hide);
  row.querySelectorAll(ACCESSIBILITY_PREVIEW_SELECTOR).forEach(hide);
  row.querySelectorAll(ICON_GLYPH_SELECTOR).forEach(hide);
  row.querySelectorAll(CODE_COPY_BUTTON_SELECTOR).forEach(hide);
  row.querySelectorAll(TOOL_STATUS_MINOR_SELECTORS).forEach(hide);

  // Content the relay can't carry — a placeholder marker takes its place
  // (SPEC.md §7: a visible gap beats a silent one).
  row.querySelectorAll(TOOL_STATUS_PILL_SELECTOR).forEach((pill) => placeholder(pill, TOOL_PLACEHOLDER));
  row.querySelectorAll(IMAGE_SELECTOR).forEach((img) => placeholder(img, IMAGE_PLACEHOLDER));

  let raw;
  try {
    raw = row.innerText || "";
    raw = rebuildCodeFences(row, raw);
  } finally {
    insertedMarkers.forEach((m) => m.remove());
    hiddenElements.forEach(({ el, previousDisplay }) => {
      el.style.display = previousDisplay;
    });
  }
  return cleanText(raw);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { cleanText, stripAccessibilityDuplicate, stripTitleSuffix, insertCodeFences };
}

// ---------------------------------------------------------------------
// Everything below touches chrome.* / the live page and only runs in the
// browser.
// ---------------------------------------------------------------------
(function () {
  if (typeof chrome === "undefined" || !chrome.storage) return;

  const SERVER_URL = "ws://127.0.0.1:8787/";
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 30000;
  const STATUS_INTERVAL_MS = 20000;
  const NAV_POLL_MS = 1000;
  const ROW_BATCH_DEBOUNCE_MS = 200;

  let socket = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer = null;

  // Conversation/DOM tracking state. Independent of socket connectivity —
  // it starts as soon as the content script loads and keeps running across
  // reconnects, so whatever the socket sends on "open" is already current.
  const state = {
    conversationId: null,
    title: "",
    container: null,
    rowObserver: null,
    rowDebounceTimer: null,
    titleObserver: null,
    lastCapture: null,
    lastSentWindowKey: null,
    // Streaming (Part C). baselineMaxIndex/baselineEstablished mark
    // whatever's already rendered as of the FIRST successful turn.window
    // read for this conversation as "pre-existing history" — see
    // sendTurnWindow, which sets these — so backfilled history never fires
    // turn.start; only an index ABOVE that baseline (SPEC.md §4.1) is a
    // genuinely new turn. knownIndices then tracks which of those
    // above-baseline indices have already become a live turn, so a row
    // that's scrolled away and back isn't treated as new a second time.
    // liveTurns tracks turns currently being watched for deltas/completion,
    // keyed by index.
    baselineMaxIndex: -1,
    baselineEstablished: false,
    knownIndices: new Set(),
    liveTurns: new Map(),
    // Part D will set this right before injecting a prompt, so the
    // resulting user turn can be tagged origin:"bubble" with a matching
    // promptId. Always null for now — everything is origin:"native".
    pendingPromptId: null,
  };

  function log(...args) {
    console.log("[bubble-ext]", ...args);
  }

  function warn(...args) {
    console.warn("[bubble-ext]", ...args);
  }

  function randomClientId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // -------------------------------------------------------------------
  // Part A: connection
  // -------------------------------------------------------------------

  async function checkLocalNetworkAccess() {
    if (!navigator.permissions || !navigator.permissions.query) {
      return true;
    }
    try {
      const status = await navigator.permissions.query({ name: "local-network-access" });
      if (status.state !== "granted") {
        warn(
          `Local Network Access permission is "${status.state}", not "granted". ` +
            "This is a Chrome permission problem, not a connection failure — it will " +
            "look identical to the desktop app being offline. Fix: click the site " +
            "info icon left of the address bar on claude.ai, or open " +
            "chrome://settings/content/localNetworkAccess, and allow this site."
        );
        return false;
      }
      return true;
    } catch (err) {
      log("Local Network Access permission check unsupported on this Chrome version, skipping:", err.message);
      return true;
    }
  }

  function getToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["pairingToken"], (result) => {
        resolve(result.pairingToken || null);
      });
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    log(`Reconnecting in ${Math.round(delay / 1000)}s…`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  function handleMessage(msg) {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "error") {
      warn(`Server error [${msg.code}]: ${msg.message}`);
      return;
    }
    if (msg.type === "retry") {
      handleRetry(msg);
      return;
    }
    log("Received", msg.type, "(handled starting in a later part)");
  }

  async function connect() {
    const granted = await checkLocalNetworkAccess();
    if (!granted) {
      scheduleReconnect();
      return;
    }

    const token = await getToken();
    if (!token) {
      warn("No pairing token saved. Open this extension's options page and paste the token shown in the desktop app.");
      scheduleReconnect();
      return;
    }

    const url = `${SERVER_URL}?role=extension&token=${encodeURIComponent(token)}`;
    log("Connecting to desktop app…");

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      warn("Failed to open WebSocket:", err.message);
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      log("Connected to desktop app.");
      reconnectDelay = RECONNECT_MIN_MS;
      send({ type: "hello", role: "extension", clientId: randomClientId() });
      // Resync the server with whatever the DOM tracker already knows —
      // conversationId/title may have changed while disconnected.
      announceConversation();
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        warn("Received non-JSON message, ignoring.");
        return;
      }
      handleMessage(msg);
    });

    ws.addEventListener("close", (event) => {
      log(`Disconnected (code ${event.code}).`);
      socket = null;
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      warn("Socket error. Is the desktop app running?");
    });
  }

  // -------------------------------------------------------------------
  // Part B: reading the conversation
  // -------------------------------------------------------------------

  // https://claude.ai/chat/<id> has an id. https://claude.ai/new and every
  // other path (settings, recents, ...) do not — SPEC.md §3.1 point 8.
  function getConversationIdFromUrl() {
    const match = location.pathname.match(/^\/chat\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  // No confirmed claude.ai-specific selector exists for the conversation
  // title (SELECTORS.md has none recorded). document.title is the
  // browser's own <title> element, not a guessed claude.ai selector.
  function computeTitle() {
    return stripTitleSuffix(document.title);
  }

  function computeCaptureHealth() {
    if (!document.querySelector('[data-testid="transcript-list"]')) return "no-container";
    if (!document.querySelector('[data-testid="chat-input"]')) return "no-composer";
    return "ok";
  }

  // "Message 137 of 142" lives in aria-label on the row's first child
  // (SELECTORS.md). Only the total (M) is needed here — data-index on the
  // row itself is the authoritative, already-zero-based position.
  function parseTotalFromRow(row) {
    const labelEl = row.firstElementChild;
    const label = labelEl && labelEl.getAttribute ? labelEl.getAttribute("aria-label") : null;
    if (!label) return null;
    const match = label.match(/Message\s+\d+\s+of\s+(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  function parseRow(row) {
    const indexAttr = row.getAttribute("data-index");
    const index = indexAttr !== null ? parseInt(indexAttr, 10) : NaN;
    if (Number.isNaN(index)) return null;
    const roleAttr = row.getAttribute("data-perf-row");
    const role = roleAttr === "human" ? "user" : roleAttr === "assistant" ? "assistant" : roleAttr || "unknown";
    const text = extractRowText(row);
    return { index, role, text };
  }

  function collectWindow() {
    const container = document.querySelector('[data-testid="transcript-list"]');
    if (!container) return null;
    const rowEls = container.querySelectorAll('[data-testid="transcript-row"]');
    const turns = [];
    let total = 0;
    rowEls.forEach((row) => {
      const parsed = parseRow(row);
      if (parsed) turns.push(parsed);
      const t = parseTotalFromRow(row);
      if (t && t > total) total = t;
    });
    return { turns, total };
  }

  function sendTurnWindow() {
    if (!state.conversationId) return;
    const collected = collectWindow();

    // Whatever collectWindow() reads the FIRST time it finds actual rows
    // for this conversation is what "pre-existing history" means going
    // forward (SPEC.md §4.1: only an index ABOVE the max is genuinely
    // new). Deriving it from this same DOM read, rather than a separate
    // scan taken at content-script injection time, is what makes it
    // race-free: that earlier scan could run — and did — before React had
    // rendered any rows at all, which made every backfilled row look new
    // the instant it appeared.
    //
    // Requires a NON-empty read, deliberately — an earlier version of this
    // established the baseline from the first read regardless of emptiness
    // (specifically to handle claude.ai/new, where nothing rendering is
    // correct and shouldn't block a baseline forever). That reintroduced a
    // narrower version of the same race for an ordinary reload of an
    // EXISTING conversation: the transcript-list container can mount
    // before React populates it with row children, so the first read still
    // landed on zero rows some of the time — baseline got set to -1, and
    // everything that rendered afterward (starting from whichever indices
    // happened to mount first) looked new. claude.ai/new is instead
    // handled directly in handlePossibleConversationChange, from the URL
    // transition itself rather than an ambiguous empty DOM snapshot — see
    // the comment there.
    if (!state.baselineEstablished && collected && collected.turns.length > 0) {
      const maxIndex = collected.turns.reduce((max, t) => Math.max(max, t.index), -1);
      state.baselineMaxIndex = maxIndex;
      state.baselineEstablished = true;
      log(`Live-turn baseline established at index ${maxIndex} (${collected.turns.length} row(s) rendered on first read).`);
    }

    if (!collected || collected.turns.length === 0) return;

    // The observer can fire several times for the same visible rows (e.g.
    // React re-rendering rows in place without any real content change).
    // Skip sending — and skip the resulting disk write — when nothing
    // actually changed since the last send. turns (part of the key) is
    // collected.turns, i.e. {index, role, text} objects — JSON.stringify
    // walks the text field too, so this is keyed on content, not just
    // indices/count.
    const key = JSON.stringify({ id: state.conversationId, total: collected.total, turns: collected.turns });
    if (key === state.lastSentWindowKey) return;
    state.lastSentWindowKey = key;

    log(
      `Sending turn.window: ${collected.turns.length} row(s), indices ` +
        `${collected.turns[0].index}-${collected.turns[collected.turns.length - 1].index}, total ${collected.total}`
    );
    send({
      type: "turn.window",
      conversationId: state.conversationId,
      total: collected.total,
      turns: collected.turns,
    });
  }

  function sendConversation() {
    send({ type: "conversation", conversationId: state.conversationId, title: state.title });
  }

  function sendStatus() {
    const capture = computeCaptureHealth();
    if (capture !== state.lastCapture) {
      log(`Capture health: ${capture}`);
      state.lastCapture = capture;
    }
    const container = document.querySelector('[data-testid="transcript-list"]');
    const streaming = !!(container && container.querySelector('[data-perf-row-streaming="true"]'));
    send({ type: "status", conversationId: state.conversationId, streaming, capture });
  }

  // -------------------------------------------------------------------
  // Part C: streaming (turn.start / turn.delta / turn.end)
  // -------------------------------------------------------------------

  function stopLiveTurn(liveTurn) {
    if (liveTurn.textObserver) {
      liveTurn.textObserver.disconnect();
      liveTurn.textObserver = null;
    }
  }

  // Called on conversation change — indices and any in-flight turns from
  // the old conversation are meaningless for the new one.
  function resetLiveTurnTracking() {
    state.liveTurns.forEach(stopLiveTurn);
    state.liveTurns.clear();
    state.knownIndices.clear();
    state.baselineMaxIndex = -1;
    state.baselineEstablished = false;
  }

  function consumePendingPromptId() {
    const id = state.pendingPromptId;
    state.pendingPromptId = null;
    return id;
  }

  function emitDeltaIfChanged(liveTurn) {
    const fullText = extractRowText(liveTurn.row);
    if (fullText === liveTurn.lastText) return;
    // Streaming doesn't always append in place. Confirmed 2026-08-28: code-
    // fence rebuilding only activates once a <pre> and its language label
    // are both fully present, which reshapes text already sent as deltas —
    // a pure append protocol can't represent that. When the new text
    // doesn't start with what was already sent, send turn.replace (the
    // full current text) instead of diffing against a snapshot that's been
    // rewritten out from under it. See SPEC.md §4.
    const isAppend = fullText.startsWith(liveTurn.lastText);
    const delta = isAppend ? fullText.slice(liveTurn.lastText.length) : fullText;
    // DIAGNOSTIC (2026-08-28, tracking the duplicate-bubble bug) — keep in
    // for now per operator request.
    log(
      `turn.delta diagnostic: turnId=${liveTurn.turnId} isAppend=${isAppend} ` +
        `prevLen=${liveTurn.lastText.length} fullLen=${fullText.length} deltaLen=${delta.length} ` +
        `sentAs=${isAppend ? "turn.delta" : "turn.replace"}`
    );
    liveTurn.lastText = fullText;
    if (isAppend) {
      if (delta) send({ type: "turn.delta", turnId: liveTurn.turnId, text: delta });
    } else {
      send({ type: "turn.replace", turnId: liveTurn.turnId, text: fullText });
    }
  }

  function finishLiveTurn(idx, liveTurn) {
    stopLiveTurn(liveTurn);
    const finalText = extractRowText(liveTurn.row);
    send({ type: "turn.end", turnId: liveTurn.turnId, text: finalText });
    state.liveTurns.delete(idx);
  }

  // Per-row observer for an in-progress assistant turn: watches its text
  // for deltas and its data-perf-row-streaming attribute for completion
  // (SPEC.md §6 — the flip to "false" is the only reliable completion
  // signal; a quiet-mutation debounce would misfire during a tool-use
  // pause). Also watches characterData, since streaming updates may change
  // existing text nodes in place rather than replacing whole nodes.
  function watchStreaming(row, idx, liveTurn) {
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations caused by our OWN extractRowText() calls (the
      // [tool]/[image] marker insert-then-remove) — otherwise reading this
      // row's text would trigger this same observer, which would read the
      // text again, forever. Attribute/characterData records never come
      // from us (extractRowText only ever inserts/removes whole marker
      // nodes and toggles style.display, which attributeFilter excludes),
      // so only childList records need filtering.
      const hasRealChange = mutations.some((m) => {
        if (m.type !== "childList") return true;
        const nodes = [...m.addedNodes, ...m.removedNodes];
        return nodes.some((n) => !(n.hasAttribute && n.hasAttribute(PLACEHOLDER_MARKER_ATTR)));
      });
      if (!hasRealChange) return;

      emitDeltaIfChanged(liveTurn);
      if (row.getAttribute("data-perf-row-streaming") === "false") {
        finishLiveTurn(idx, liveTurn);
      }
    });
    observer.observe(row, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-perf-row-streaming"],
    });
    liveTurn.textObserver = observer;
  }

  function startLiveTurn(row, idx) {
    const roleAttr = row.getAttribute("data-perf-row");
    const role = roleAttr === "human" ? "user" : roleAttr === "assistant" ? "assistant" : "unknown";
    const turnId = randomClientId();
    const promptId = role === "user" ? consumePendingPromptId() : null;
    const origin = promptId ? "bubble" : "native";

    // DIAGNOSTIC (2026-08-28, tracking the duplicate-bubble bug) — remove
    // once resolved. If this fires more than once for what should be a
    // single reply, the row's index isn't being recognised as "already
    // known" between scans.
    log(`turn.start diagnostic: turnId=${turnId} role=${role} index=${idx}`);
    // index is the same data-index value turn.window carries for this row
    // (SPEC.md §4) — included so the bubble can tag the element with it as
    // soon as the turn starts, rather than waiting for a turn.window/harvest
    // that happens to cover it later. retry (below) needs it, and the
    // message the operator just sent or the reply just received is the most
    // likely thing to want to retry.
    send({ type: "turn.start", turnId, role, origin, promptId, ts: Date.now(), index: idx });
    const liveTurn = { turnId, role, lastText: "", row, textObserver: null };
    state.liveTurns.set(idx, liveTurn);

    if (role === "assistant") {
      watchStreaming(row, idx, liveTurn);
    } else {
      // User rows (and anything unrecognised) render complete immediately —
      // there's no streaming attribute transition to wait for.
      finishLiveTurn(idx, liveTurn);
    }
  }

  // Any row currently rendered whose index is ABOVE the baseline (see
  // sendTurnWindow) and isn't already tracked is a genuinely new turn
  // (SPEC.md §4.1's "only an index above the max is new" applies here too,
  // just for turn.start instead of turn.window — an index at or below the
  // baseline is pre-existing history no matter how it reappears, and an
  // index above it but already in knownIndices just means its row was
  // scrolled away and back).
  function scanForNewLiveTurns() {
    if (!state.container) return;
    // Nothing counts as "new" until we know what "already existing" means.
    // Scanning before the baseline is established is exactly what caused
    // every backfilled row to look new — see sendTurnWindow. In practice
    // this doesn't return early: the caller (attachRowObserver's debounced
    // callback) sends the turn.window that establishes it first — this is
    // just a safety net against a future refactor breaking that order.
    if (!state.baselineEstablished) return;
    state.container.querySelectorAll('[data-testid="transcript-row"]').forEach((row) => {
      const idx = parseInt(row.getAttribute("data-index"), 10);
      if (Number.isNaN(idx) || idx <= state.baselineMaxIndex || state.knownIndices.has(idx)) return;
      state.knownIndices.add(idx);
      startLiveTurn(row, idx);
    });
  }

  // Safety net for a live turn whose row got virtualized away mid-stream
  // (scrolled out of view) and reattached later without its own observer
  // catching the completion — checked on every poll tick using data
  // collectWindow already reads.
  function reconcileLiveTurns() {
    state.liveTurns.forEach((liveTurn, idx) => {
      if (!liveTurn.row.isConnected) return;
      if (liveTurn.row.getAttribute("data-perf-row-streaming") === "false") {
        finishLiveTurn(idx, liveTurn);
      }
    });
  }

  // Called on attach (socket open) and on any detected conversation/title
  // change. Re-finds the container (React may have replaced it wholesale on
  // navigation) and sends a fresh snapshot.
  function announceConversation() {
    sendConversation();
    attachRowObserver();
    sendTurnWindow();
    sendStatus();
  }

  function handlePossibleConversationChange() {
    const id = getConversationIdFromUrl();
    const title = computeTitle();
    const idChanged = id !== state.conversationId;
    const titleChanged = title !== state.title;
    if (!idChanged && !titleChanged) return;
    log(`Conversation ${idChanged ? "changed" : "title updated"}: id=${id || "null"} title=${JSON.stringify(title)}`);
    const previousConversationId = state.conversationId;
    state.conversationId = id;
    state.title = title;
    if (idChanged) {
      // Clears the baseline too — normally announceConversation below (via
      // sendTurnWindow) re-establishes it once the new conversation
      // actually has rows rendered (see sendTurnWindow).
      resetLiveTurnTracking();
      if (previousConversationId === null && id !== null) {
        // claude.ai/new -> a real conversation. This one can't have any
        // pre-existing history — it didn't exist a moment ago — so the
        // baseline is known immediately rather than waiting for a
        // non-empty DOM read. Waiting would be actively wrong here: that
        // first non-empty read would be the operator's own first message,
        // which needs to fire turn.start, not get swallowed as "history"
        // (SPEC.md §3.1 point 8).
        state.baselineMaxIndex = -1;
        state.baselineEstablished = true;
      }
    }
    announceConversation();
  }

  // Structural observer only: rows being added or removed as the operator
  // scrolls. Text changes inside a row (streaming) are watched separately,
  // per-row, by watchStreaming() once a row is recognised as a new live
  // turn — not here.
  function attachRowObserver() {
    const container = document.querySelector('[data-testid="transcript-list"]');
    if (!container) {
      if (state.rowObserver) state.rowObserver.disconnect();
      state.rowObserver = null;
      state.container = null;
      return;
    }
    if (container === state.container && state.rowObserver) return;

    if (state.rowObserver) state.rowObserver.disconnect();
    state.container = container;
    state.rowObserver = new MutationObserver((mutations) => {
      // IGNORE removals entirely — the virtualizer destroys rows on scroll;
      // a removed row is not a deleted message (SPEC.md §4.1). Only react
      // to additions, and debounce, since scrolling can add many rows in a
      // single burst. A row whose index is already known just means the
      // user scrolled back to it — resending it in turn.window is harmless
      // because the server merges by index rather than replacing, and
      // sendTurnWindow's own dedup skips the send if nothing changed.
      //
      // Also ignore our own placeholder markers (see
      // extractRowText/PLACEHOLDER_MARKER_ATTR) — otherwise reading a row's
      // text would trigger this observer, which would schedule another
      // read, forever.
      const hasAdditions = mutations.some((m) =>
        Array.from(m.addedNodes).some((n) => !(n.hasAttribute && n.hasAttribute(PLACEHOLDER_MARKER_ATTR)))
      );
      if (!hasAdditions) return;
      if (state.rowDebounceTimer) clearTimeout(state.rowDebounceTimer);
      state.rowDebounceTimer = setTimeout(() => {
        state.rowDebounceTimer = null;
        // sendTurnWindow first: for the very first batch this observer
        // ever sees, it's what establishes the baseline (see sendTurnWindow
        // and scanForNewLiveTurns) — scanning before that exists would
        // treat that entire first batch as new, which was bug 2.
        sendTurnWindow();
        scanForNewLiveTurns();
      }, ROW_BATCH_DEBOUNCE_MS);
    });
    state.rowObserver.observe(container, { childList: true, subtree: true });
    log("Observing transcript container.");
  }

  function observeTitle() {
    const titleEl = document.querySelector("title");
    if (!titleEl) return;
    if (state.titleObserver) state.titleObserver.disconnect();
    state.titleObserver = new MutationObserver(() => {
      handlePossibleConversationChange();
    });
    state.titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // One poll loop covers two jobs: detect SPA navigation (URL changes
  // without a page reload — history.pushState isn't hooked; polling is
  // simpler and doesn't depend on unconfirmed claude.ai internals), and
  // re-attach the row observer if React swapped the container node even
  // without a URL change.
  function pollTick() {
    handlePossibleConversationChange();
    attachRowObserver();
    reconcileLiveTurns();
  }

  // -------------------------------------------------------------------
  // Part D (partial): retry (SPEC.md §4). Only the single-row
  // locate/scroll/restore mechanism retry needs is built here — the general
  // multi-step history.request harvest (batches of older messages, §4.1) is
  // a separate, larger piece that is NOT implemented yet. findScrollContainer
  // and withRowInView are written so that future work can reuse them rather
  // than re-solving the same scroll-container problem twice.
  // -------------------------------------------------------------------

  // NOT a confirmed selector-backed fact — a plain text match. Confirmed by
  // the operator 2026-08-29: an interrupted assistant reply renders
  // "Claude's response was interrupted." with "Edit prompt"/"Try again"
  // buttons instead of the normal action bar, so action-bar-retry
  // genuinely isn't on that row. Used to detect the case (for the error
  // message and to know to look for TRY_AGAIN_BUTTON_TEXT below).
  const INTERRUPTED_RESPONSE_TEXT = "response was interrupted";

  // THE MOST FRAGILE MATCH IN THIS PROJECT — see SELECTORS.md's entry for
  // it, and check there first if retry ever mysteriously stops working on
  // interrupted responses. Console discovery 2026-08-29 found no
  // data-testid, aria-label, or any other distinguishing attribute on
  // either button — "Edit prompt" and "Try again" are attribute-identical,
  // the only difference is their visible text. Breaks on a wording change;
  // breaks entirely in another language. handleRetry only ever acts on
  // this when exactly one button in the row matches it exactly — see there
  // for why, and why "Edit prompt" is never a fallback.
  const TRY_AGAIN_BUTTON_TEXT = "Try again";

  function findScrollContainer() {
    const list = document.querySelector('[data-testid="transcript-list"]');
    if (!list) return null;
    let el = list.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function findRowByIndex(index) {
    const list = document.querySelector('[data-testid="transcript-list"]');
    if (!list) return null;
    return list.querySelector(`[data-testid="transcript-row"][data-index="${index}"]`);
  }

  // Debug-only: a cheap read of which indices are currently rendered, for
  // the diagnostic logging below. Deliberately not collectWindow()/parseRow
  // — those call extractRowText, which does its own DOM manipulation
  // (hide/restore, marker insert/remove) on every row, which is wasted work
  // and an unwanted side effect just to log a list of numbers.
  function renderedIndices() {
    const list = document.querySelector('[data-testid="transcript-list"]');
    if (!list) return [];
    return Array.from(list.querySelectorAll('[data-testid="transcript-row"]'))
      .map((row) => parseInt(row.getAttribute("data-index"), 10))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
  }

  // Scrolls the transcript so the row at `index` is rendered, if it isn't
  // already (the virtualizer only renders rows near the viewport — SPEC.md
  // §4.1), runs fn(row) (row is null if it still couldn't be found), then
  // restores the original scroll position regardless of outcome — the
  // claude.ai tab is normally in the background, but SPEC.md §4.1 says to
  // restore either way in case it isn't.
  //
  // DIAGNOSTIC (bug: retry reported "couldn't find message 17" even though
  // a turn.start log showed that index existing) — logs what's rendered at
  // each decision point so a real failure can be told apart from a stale
  // assumption about what's in the DOM. Kept in until that's resolved.
  async function withRowInView(index, fn) {
    log(`retry: looking for index=${index}. Currently rendered: [${renderedIndices().join(", ")}]`);

    let row = findRowByIndex(index);
    if (row) {
      log(`retry: index=${index} was already rendered, no scroll needed.`);
      return fn(row);
    }

    const scroller = findScrollContainer();
    if (!scroller) {
      log(`retry: index=${index} not rendered and no scroll container found (nothing scrollable, or transcript-list missing).`);
      return fn(null);
    }

    const originalScrollTop = scroller.scrollTop;
    const wait = () => new Promise((resolve) => setTimeout(resolve, 1200));

    // retry knows the exact index it wants, unlike a full harvest — jump
    // toward an estimate of where it lives using the currently-known total
    // (§4.1), then fall back to the one jump SELECTORS.md confirmed
    // actually renders new rows if total isn't known yet or the estimate
    // misses.
    const collected = collectWindow();
    const total = collected && collected.total ? collected.total : null;
    let target;
    if (total && total > 1) {
      target = Math.round((index / (total - 1)) * (scroller.scrollHeight - scroller.clientHeight));
    } else {
      target = 0;
    }
    log(
      `retry: index=${index} not rendered, scrolling. total=${total} scrollHeight=${scroller.scrollHeight} ` +
        `clientHeight=${scroller.clientHeight} originalScrollTop=${originalScrollTop} -> target=${target}`
    );
    scroller.scrollTop = target;
    await wait();
    row = findRowByIndex(index);
    log(`retry: after first scroll, rendered: [${renderedIndices().join(", ")}] — found=${!!row}`);

    if (!row) {
      log(`retry: index=${index} still not found, falling back to scrollTop=0.`);
      scroller.scrollTop = 0;
      await wait();
      row = findRowByIndex(index);
      log(`retry: after fallback scroll, rendered: [${renderedIndices().join(", ")}] — found=${!!row}`);
    }

    try {
      return fn(row);
    } finally {
      scroller.scrollTop = originalScrollTop;
    }
  }

  // Watches the exact row retry/resend was just clicked on for its
  // data-perf-row-streaming completion signal (SPEC.md §6), then resends
  // its text as an ordinary turn.window entry. This exists because a
  // retried row's index is already "known" (SPEC.md §4.1's scanning skips
  // indices it already has as "the user scrolled back", not "new") — so
  // without this, an in-place text change from a retry would never be
  // observed at all. Only meaningful for an assistant row (user rows don't
  // stream); see the retry message's write-up in SPEC.md §4 for why a
  // user-message-retry's downstream effect isn't watched the same way.
  function watchRetriedRow(row) {
    const idx = row.getAttribute("data-index");
    // One-shot attach/send logging kept (cheap, fires at most twice per
    // retry) — the per-mutation log that used to sit inside the observer
    // below was removed; it fired on every DOM mutation while the reply
    // streamed back in, which flooded the terminal.
    log(
      `retry: watchRetriedRow attached for index=${idx}, initial data-perf-row-streaming=` +
        `${row.getAttribute("data-perf-row-streaming")}, isConnected=${row.isConnected}`
    );
    const observer = new MutationObserver(() => {
      const streaming = row.getAttribute("data-perf-row-streaming");
      if (streaming === "false") {
        observer.disconnect();
        const parsed = parseRow(row);
        log(`retry: watchRetriedRow sending updated text for index=${idx}, textLength=${parsed && parsed.text.length}`);
        if (parsed) {
          send({ type: "turn.window", conversationId: state.conversationId, turns: [parsed] });
        }
      }
    });
    observer.observe(row, {
      attributes: true,
      attributeFilter: ["data-perf-row-streaming"],
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  async function handleRetry(msg) {
    log(`retry: received request for index=${msg && msg.index} conversationId=${msg && msg.conversationId}`);

    if (!msg || typeof msg.index !== "number") {
      send({ type: "error", code: "RETRY_FAILED", message: "Retry request was missing an index." });
      return;
    }
    if (msg.conversationId !== state.conversationId) {
      log(`retry: conversationId mismatch — request had ${msg.conversationId}, current is ${state.conversationId}.`);
      send({ type: "error", code: "RETRY_FAILED", message: "Conversation changed before retry could run." });
      return;
    }

    // Failure modes, logged and reported separately rather than collapsing
    // into one generic message: the row was never found (withRowInView's
    // own logging covers that); the row is an interrupted response and its
    // "Try again" text match found something other than exactly one button
    // (see below — reported, not guessed at); or the row isn't interrupted
    // but still had no matching action-bar button, which points at an
    // actual bug rather than a known unhandled message type.
    let rowFoundButNoButton = false;
    let interruptedResponse = false;
    let interruptedButtonCount = 0;
    const clicked = await withRowInView(msg.index, (row) => {
      if (!row) return false;
      // Read the role from the row itself rather than trusting anything the
      // bubble sent — the row we actually found is the only source of truth
      // for which action applies to it.
      const role = row.getAttribute("data-perf-row");

      // DIAGNOSTIC (bug: the interrupted-response branch below wasn't
      // being reached, or wasn't matching — unclear which from the log
      // alone) — logs the match result BOTH ways, not just on success, plus
      // enough of the actual row text to catch an encoding mismatch (a
      // typographic apostrophe, a non-breaking space instead of a regular
      // one, different wording) that a plain string comparison would fail
      // on silently. row.textContent is used here (not extractRowText),
      // so this can include hidden accessibility text before the visible
      // notice — the window below is centered on wherever "interrupted"
      // itself appears, not just the start of the string, so it's not
      // buried in unrelated leading text. Remove once resolved.
      const rowTextLower = row.textContent.toLowerCase();
      const isInterrupted = rowTextLower.includes(INTERRUPTED_RESPONSE_TEXT);
      const interruptedWordIdx = rowTextLower.indexOf("interrupted");
      const windowStart = interruptedWordIdx === -1 ? 0 : Math.max(0, interruptedWordIdx - 20);
      const windowText =
        interruptedWordIdx === -1 ? row.textContent.slice(0, 60) : row.textContent.slice(windowStart, windowStart + 60);
      log(
        `retry: interrupted-notice check for index=${msg.index}: matched=${isInterrupted}, ` +
          `constant=${JSON.stringify(INTERRUPTED_RESPONSE_TEXT)}, ` +
          `"interrupted" found at char ${interruptedWordIdx} of ${row.textContent.length} in row.textContent. ` +
          `Text around there: ${JSON.stringify(windowText)}, char codes: [${Array.from(windowText)
            .map((c) => c.codePointAt(0))
            .join(",")}]`
      );

      if (isInterrupted) {
        interruptedResponse = true;
        // No stable selector exists for this at all (SELECTORS.md) — text
        // match is the only signal there is, so it's applied as
        // defensively as possible: exact trimmed text, scoped to a row
        // already confirmed (above) to contain the interrupted notice, and
        // only acted on when that yields EXACTLY one match. Zero matches
        // (wording changed) or two (should never happen, but if the page
        // ever renders this differently) both report an error and click
        // nothing — never a guess between this and "Edit prompt", which
        // would put the page into an edit state the operator didn't ask
        // for.
        const candidates = Array.from(row.querySelectorAll("button")).filter(
          (b) => b.textContent.trim() === TRY_AGAIN_BUTTON_TEXT
        );
        interruptedButtonCount = candidates.length;
        log(`retry: row for index=${msg.index} is an interrupted response — found ${candidates.length} "Try again" button(s).`);
        if (candidates.length !== 1) return false;
        candidates[0].click();
        // DIAGNOSTIC (bug: watchRetriedRow not observed firing on this
        // path) — the call is gated on role, read from data-perf-row
        // above; this confirms what that actually evaluated to, in case
        // an interrupted row's data-perf-row differs from a normal
        // assistant row's. Remove once resolved.
        log(`retry: about to check role for watchRetriedRow gate, role=${JSON.stringify(role)}`);
        if (role === "assistant") watchRetriedRow(row);
        return true;
      }

      const selector = role === "assistant" ? '[data-testid="action-bar-retry"]' : '[data-testid="user-message-retry"]';
      const btn = row.querySelector(selector);
      log(`retry: row for index=${msg.index} found, role=${role}, selector=${selector}, button found=${!!btn}`);
      if (!btn) {
        rowFoundButNoButton = true;
        return false;
      }
      btn.click();
      if (role === "assistant") watchRetriedRow(row);
      return true;
    });

    if (!clicked) {
      let message;
      if (interruptedResponse) {
        message =
          interruptedButtonCount === 0
            ? `Message ${msg.index} is an interrupted response, but no "Try again" button was found on it — its wording may have changed.`
            : `Message ${msg.index} is an interrupted response with ${interruptedButtonCount} "Try again" buttons found — not retrying, to avoid clicking the wrong one.`;
      } else if (rowFoundButNoButton) {
        message = `Found message ${msg.index} but no retry/resend button on it.`;
      } else {
        message = `Couldn't find message ${msg.index} on the page to retry.`;
      }
      log(`retry: failed for index=${msg.index} — ${message}`);
      send({ type: "error", code: "RETRY_FAILED", message });
    }
  }

  function initDomTracking() {
    state.conversationId = getConversationIdFromUrl();
    state.title = computeTitle();
    // No baseline scan here — the baseline is now established inside
    // sendTurnWindow, from the first successful read of the actually-
    // rendered DOM (see sendTurnWindow), not a snapshot taken here at
    // script-injection time, before React may have rendered anything.
    observeTitle();
    attachRowObserver();
    setInterval(pollTick, NAV_POLL_MS);
    setInterval(sendStatus, STATUS_INTERVAL_MS);
    log(`Initial conversation: id=${state.conversationId || "null"} title=${JSON.stringify(state.title)}`);
  }

  initDomTracking();
  connect();
})();
