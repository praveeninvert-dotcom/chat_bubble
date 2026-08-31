// [bubble-ext] content script.
// Part A: connection shell — token, WebSocket, reconnect with backoff.
// Part B: reading the conversation — conversation id/title tracking,
// turn.window from the currently-rendered rows, capture health.
// Part C: streaming (turn.start/delta/end) and full text extraction,
// including code-fence rebuilding and content placeholders.
// Part D1: prompt injection (a `prompt` message from the bubble goes into
// the composer and gets sent). Part D2, history harvesting, is not yet
// built.
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

// Confirmed 2026-08-31: every per-message control (copy/retry/thumbs/
// read-aloud/edit), the relative timestamp, and — as of this date — the
// "N / N" retry-variant counter all live inside one container:
// <div data-cds="MessageActions" data-reveal="fade" role="toolbar"
//      aria-label="Message actions" data-size="xs" tabindex="-1"
//      class="flex items-center select-none ...">
// Confirmed by discovery script: this container's own text content is only
// whitespace plus the timestamp (19 chars vs 204 for the whole row) — it
// holds nothing but the toolbar. This replaces five separate per-element
// exclusions (each found individually, on five separate occasions, by the
// operator spotting a fresh leak in the bubble) with one container
// exclusion: whatever renders inside this toolbar in the future — a new
// button, a new pill, anything — is now excluded automatically, without
// needing to be spotted and patched one at a time again. Two independent
// selectors are combined so either surviving a redesign alone still works:
// `data-cds="MessageActions"` and `role="toolbar"[aria-label="Message
// actions"]` are unrelated attributes (a11y vs. internal component
// tagging), not two names for the same fact, so it's very unlikely a single
// styling/refactor pass drops both at once. This subsumes the former
// EXCLUDED_CONTROL_SELECTORS (action-bar-copy/retry/thumbs-up/thumbs-down/
// read-aloud, user-message-retry/edit/copy), TIMESTAMP_SELECTOR, and the
// retry-counter class-fingerprint match — all deleted below in favor of
// this one container. Elements are skipped by object identity during the
// DOM walk (see collectExclusions/renderBlocksDom/renderInlineDom), so
// adding the container itself to the skip set is enough to skip its entire
// subtree — no need to also enumerate what's inside it.
//
// h2.sr-only (the accessibility preview), the tool-status pill/spark/caret,
// and icon glyphs are NOT covered by this container — confirmed or left
// unconfirmed as noted at each one below — and keep their own selectors.
const MESSAGE_ACTIONS_SELECTOR = '[data-cds="MessageActions"], [role="toolbar"][aria-label="Message actions"]';

// Confirmed 2026-08-28: <h2 data-find-omitted="" class="sr-only select-none">
// You said: <preview></h2> — the screen-reader-only announcement holding
// both the "Claude responded: " / "You said: " prefix and the (sometimes
// paraphrased) preview described above. Scoped to h2.sr-only rather than a
// bare .sr-only in case that utility class is reused elsewhere for
// something that should stay. Confirmed 2026-08-31 to sit OUTSIDE the
// MessageActions toolbar (it's a heading over the whole row, not a toolbar
// control), so it keeps its own selector rather than being subsumed.
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
// NOT confirmed whether this ever appears inside the MessageActions
// toolbar (the operator's report on 2026-08-31 placed it in the message
// body, but that wasn't independently re-verified with the same rigor as
// the toolbar discovery below) — kept as its own selector rather than
// dropped in favor of the container. Harmless if it later turns out to
// always be inside the toolbar too: excluding the same element twice by
// two different selectors is a no-op, not a bug.

// Confirmed 2026-08-28: icon glyphs rendered with a private-use font
// (Anthropicons). Their codepoints render as striped boxes anywhere outside
// claude.ai's own font, so they're pure UI chrome — hidden silently. NOT
// confirmed whether icon glyphs also render outside the MessageActions
// toolbar (e.g. inline in message content) — kept as its own selector for
// the same reason as tool-status above: redundant-but-harmless if every
// instance turns out to already be inside the toolbar, necessary if any
// aren't.
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

// ---------------------------------------------------------------------
// DOM -> markdown reconstruction
// ---------------------------------------------------------------------
//
// claude.ai renders Claude's markdown into real HTML before this script
// ever sees a row — a real <table>, a real <ul>, a real <a href>. Reading
// innerText (as extractRowText used to, for the whole row) gives back the
// visible TEXT with all of that gone: no pipes, no dashes, no
// [text](url) — that syntax only ever existed in the raw output, before
// the page rendered it. Rebuilding ``` fences from <pre> (below,
// unchanged) solved this for exactly one element type; nothing else ever
// got the same treatment, which is what made every other block type
// arrive at the bubble as plain lines of text.
//
// So this walks the actual DOM tree and re-emits markdown syntax for the
// structure it finds, instead of reading rendered text and hoping syntax
// survived. <pre> is the deliberate exception (see PRE below in
// renderBlocksDom) — its handling is confirmed working and untouched.
//
// Numeric nodeType constants (not the DOM's own Node.TEXT_NODE etc.)
// because this file's extraction functions are required directly from
// plain Node for testing (see content.test.js) — there is no global
// `Node` there.
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// Inline-context rendering: markdown for a node and everything inside it,
// with no block-level line breaks. Used for heading text, list item text,
// table cell text, and link text — none of which can themselves contain a
// paragraph break.
function renderInlineDom(node, skipSet, placeholderMap) {
  if (skipSet.has(node)) return "";
  if (placeholderMap.has(node)) return placeholderMap.get(node);
  if (node.nodeType === TEXT_NODE) return node.textContent;
  if (node.nodeType !== ELEMENT_NODE) return "";

  const children = () =>
    Array.from(node.childNodes)
      .map((c) => renderInlineDom(c, skipSet, placeholderMap))
      .join("");

  switch (node.tagName) {
    case "STRONG":
    case "B":
      return "**" + children() + "**";
    case "EM":
    case "I":
      return "*" + children() + "*";
    case "DEL":
    case "S":
      return "~~" + children() + "~~";
    case "CODE":
      // Deliberately textContent, not children() — an inline code span's
      // content is literal; nothing inside it should be re-interpreted as
      // markdown syntax.
      return "`" + node.textContent + "`";
    case "BR":
      return "\n";
    case "A":
      return "[" + children() + "](" + (node.getAttribute("href") || "") + ")";
    default:
      return children();
  }
}

// Renders one <ul>/<ol>, recursing for a nested list found inside an <li>
// so its markdown ends up indented deeper than the parent item — that's
// the only signal markdown.js's own list parser (desktop/renderer/
// markdown.js's parseList) uses to recognise nesting. 2 spaces per level
// is arbitrary; it only has to be MORE than the parent's indent, not some
// specific width. A <pre> found directly inside an <li> (a code block
// inside a bullet) is also carried through as its own continuation line,
// same reasoning as the top-level PRE case in renderBlocksDom below.
function renderListDom(listEl, depth, skipSet, placeholderMap) {
  const ordered = listEl.tagName === "OL";
  const indent = "  ".repeat(depth);
  const startAttr = ordered ? parseInt(listEl.getAttribute("start"), 10) : NaN;
  let n = Number.isFinite(startAttr) ? startAttr : 1;

  const lines = [];
  Array.from(listEl.childNodes).forEach((li) => {
    if (skipSet.has(li)) return;
    if (li.nodeType !== ELEMENT_NODE || li.tagName !== "LI") return;

    const marker = ordered ? `${n}. ` : "- ";
    n++;

    let itemInline = "";
    const continuations = [];
    Array.from(li.childNodes).forEach((liChild) => {
      if (skipSet.has(liChild)) return;
      if (placeholderMap.has(liChild)) {
        itemInline += placeholderMap.get(liChild);
        return;
      }
      if (liChild.nodeType === ELEMENT_NODE && (liChild.tagName === "UL" || liChild.tagName === "OL")) {
        continuations.push(renderListDom(liChild, depth + 1, skipSet, placeholderMap));
        return;
      }
      if (liChild.nodeType === ELEMENT_NODE && liChild.tagName === "PRE") {
        continuations.push(liChild.innerText || "");
        return;
      }
      itemInline += renderInlineDom(liChild, skipSet, placeholderMap);
    });

    lines.push(indent + marker + itemInline.trim());
    if (continuations.length) lines.push(continuations.join("\n"));
  });
  return lines.join("\n");
}

// Renders a <table> as a pipe table with a header separator row — the
// shape markdown.js's own table parser (splitTableRow/isTableSeparator)
// expects. Cell text can't contain a real newline (it would split the
// row) or a literal "|" (that parser's cell splitter has no escaping for
// one) — both are neutralised rather than preserved exactly, which only
// matters for content nobody would type inside a table cell to begin
// with.
function renderTableDom(tableEl, skipSet, placeholderMap) {
  const trs = Array.from(tableEl.querySelectorAll("tr"));
  if (trs.length === 0) return "";

  const cellsOf = (tr) =>
    Array.from(tr.children)
      .filter((c) => (c.tagName === "TH" || c.tagName === "TD") && !skipSet.has(c))
      .map((c) => renderInlineDom(c, skipSet, placeholderMap).replace(/\n/g, " ").replace(/\|/g, "/").trim());

  const header = cellsOf(trs[0]);
  const separator = header.map(() => "---");
  const bodyRows = trs.slice(1).map(cellsOf);
  const toRow = (cells) => "| " + cells.join(" | ") + " |";
  return [toRow(header), toRow(separator), ...bodyRows.map(toRow)].join("\n");
}

// Block-context rendering: walks `node`'s children, pushing one markdown
// block per recognised block-level element into `out`, and accumulating
// any bare inline content (text/formatting sitting directly in the row,
// not wrapped in a block element) into its own paragraph. Recurses for
// anything that's itself a block-level container (blockquote, or a
// generic wrapper like <p>/<div>) so nested structure comes out right.
function renderBlocksDom(node, out, skipSet, placeholderMap) {
  let paragraph = [];
  const flush = () => {
    const text = paragraph.join("").trim();
    if (text) out.push(text);
    paragraph = [];
  };

  Array.from(node.childNodes).forEach((child) => {
    if (skipSet.has(child)) return;
    if (placeholderMap.has(child)) {
      paragraph.push(placeholderMap.get(child));
      return;
    }
    if (child.nodeType === TEXT_NODE) {
      // A whitespace-only text node that contains a newline is HTML source
      // formatting (indentation between sibling tags), not content —
      // including it would flush a spurious empty paragraph between real
      // blocks. A bare space with no newline is kept even if it's "only
      // whitespace" by the same trim() check — that's the literal word
      // separator between two inline siblings, e.g. "<strong>bold</strong>
      // <em>italic</em>", and dropping it would glue them together.
      const isFormattingWhitespace = child.textContent.trim() === "" && /\n/.test(child.textContent);
      if (!isFormattingWhitespace) paragraph.push(child.textContent);
      return;
    }
    if (child.nodeType !== ELEMENT_NODE) return;

    switch (child.tagName) {
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        flush();
        out.push("#".repeat(Number(child.tagName[1])) + " " + renderInlineDom(child, skipSet, placeholderMap));
        break;
      case "HR":
        flush();
        out.push("---");
        break;
      case "UL":
      case "OL":
        flush();
        out.push(renderListDom(child, 0, skipSet, placeholderMap));
        break;
      case "TABLE":
        flush();
        out.push(renderTableDom(child, skipSet, placeholderMap));
        break;
      case "BLOCKQUOTE": {
        flush();
        const inner = [];
        renderBlocksDom(child, inner, skipSet, placeholderMap);
        out.push(
          inner
            .join("\n\n")
            .split("\n")
            .map((line) => (line ? "> " + line : ">"))
            .join("\n")
        );
        break;
      }
      case "PRE":
        // Left as raw text, unwalked — rebuildCodeFences (below, unchanged)
        // finds this exact text via pre.innerText and wraps it in fences.
        // This is the one part of the DOM->markdown walk that predates
        // this rewrite and stays exactly as it was: confirmed working,
        // preserves indentation.
        flush();
        out.push(child.innerText || "");
        break;
      case "P":
      case "DIV": {
        flush();
        const inner = [];
        renderBlocksDom(child, inner, skipSet, placeholderMap);
        if (inner.length) out.push(inner.join("\n\n"));
        break;
      }
      default:
        paragraph.push(renderInlineDom(child, skipSet, placeholderMap));
    }
  });
  flush();
}

// Same selectors extractRowText has always excluded (see their
// definitions above) — collected once per row into a skip set and a
// placeholder map so renderBlocksDom/renderInlineDom can check them by
// object identity while walking, rather than hiding elements in the live
// DOM the way the old innerText-based version had to. No DOM mutation
// happens for any of these now: a walker that visits nodes itself can
// simply not recurse into one, where innerText had no such option.
function collectExclusions(row) {
  const skipSet = new Set();
  row.querySelectorAll(MESSAGE_ACTIONS_SELECTOR).forEach((el) => skipSet.add(el));
  row.querySelectorAll(ACCESSIBILITY_PREVIEW_SELECTOR).forEach((el) => skipSet.add(el));
  row.querySelectorAll(ICON_GLYPH_SELECTOR).forEach((el) => skipSet.add(el));
  row.querySelectorAll(TOOL_STATUS_MINOR_SELECTORS).forEach((el) => skipSet.add(el));

  // Content the relay can't carry — the placeholder text takes its place
  // directly in the walk's output (SPEC.md §7: a visible gap beats a
  // silent one), rather than a marker span inserted into the DOM.
  const placeholderMap = new Map();
  row.querySelectorAll(TOOL_STATUS_PILL_SELECTOR).forEach((el) => placeholderMap.set(el, TOOL_PLACEHOLDER));
  row.querySelectorAll(IMAGE_SELECTOR).forEach((el) => placeholderMap.set(el, IMAGE_PLACEHOLDER));

  return { skipSet, placeholderMap };
}

// Walks `row` and returns markdown text, exported so tests can build a
// DOM fragment and check its output directly — see content.test.js.
//
// The one remaining DOM mutation is hiding each code block's own copy
// button before reading pre.innerText (inside rebuildCodeFences and this
// function's own PRE case): it's a hover-reveal button shown via opacity,
// not display:none, so it isn't naturally excluded from innerText the way
// display:none content is — the same reason the pre-existing <pre>
// handling already had to hide it first. Restored synchronously in the
// finally block; never a detached clone, for the same reason as always —
// innerText on a detached node silently falls back to textContent, which
// is exactly the code-formatting-destroying behaviour ruled out for <pre>.
function domToMarkdown(row) {
  const { skipSet, placeholderMap } = collectExclusions(row);

  const copyButtons = Array.from(row.querySelectorAll(CODE_COPY_BUTTON_SELECTOR));
  const previousDisplay = copyButtons.map((btn) => btn.style.display);
  copyButtons.forEach((btn) => {
    btn.style.display = "none";
  });

  try {
    const blocks = [];
    renderBlocksDom(row, blocks, skipSet, placeholderMap);
    return rebuildCodeFences(row, blocks.join("\n\n"));
  } finally {
    copyButtons.forEach((btn, i) => {
      btn.style.display = previousDisplay[i];
    });
  }
}

function extractRowText(row) {
  return cleanText(domToMarkdown(row));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { cleanText, stripAccessibilityDuplicate, stripTitleSuffix, insertCodeFences, domToMarkdown };
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
    // Set once waitForRenderedConversation's initial read is confirmed (see
    // initDomTracking). Guards handlePossibleConversationChange, which the
    // title observer can otherwise trigger from a URL read taken before the
    // SPA has settled — the same race this whole mechanism exists to avoid,
    // just reached through a second path.
    initialConversationConfirmed: false,
    // Confirmed 2026-08-29: document.title lags behind a same-tab switch
    // between existing conversations — reading it in the same instant the
    // URL/id changes captured the PREVIOUS conversation's title, sent
    // alongside the NEW id, which showed up in the bubble as the header
    // always being one switch behind. See handlePossibleConversationChange.
    // titleConfirmed is false from the moment an id change is detected
    // until document.title is trusted again; pendingStaleTitle is the value
    // read at that exact moment (the one being distrusted), used to detect
    // when a later read has actually moved on from it; titleChangeTs bounds
    // how long that wait lasts.
    titleConfirmed: true,
    pendingStaleTitle: null,
    titleChangeTs: 0,
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
    if (msg.type === "prompt") {
      handlePrompt(msg);
      return;
    }
    if (msg.type === "history.request") {
      handleHistoryRequest(msg);
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

  // Confirmed signal (SPEC.md §6): a row's data-perf-row-streaming flips to
  // "false" on completion. Checking for ANY row still "true" is a reliable
  // global "is Claude currently generating" — used both for the status
  // message below and by handlePrompt (Part D1) to decide whether it's safe
  // to send.
  function isAnyRowStreaming() {
    const container = document.querySelector('[data-testid="transcript-list"]');
    return !!(container && container.querySelector('[data-perf-row-streaming="true"]'));
  }

  function sendStatus() {
    const capture = computeCaptureHealth();
    if (capture !== state.lastCapture) {
      log(`Capture health: ${capture}`);
      state.lastCapture = capture;
    }
    send({ type: "status", conversationId: state.conversationId, streaming: isAnyRowStreaming(), capture });
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
    liveTurn.lastText = fullText;
    if (isAppend) {
      if (delta) {
        send({
          type: "turn.delta",
          turnId: liveTurn.turnId,
          conversationId: state.conversationId,
          index: liveTurn.index,
          text: delta,
        });
      }
    } else {
      send({
        type: "turn.replace",
        turnId: liveTurn.turnId,
        conversationId: state.conversationId,
        index: liveTurn.index,
        text: fullText,
      });
    }
  }

  function finishLiveTurn(idx, liveTurn) {
    stopLiveTurn(liveTurn);
    const finalText = extractRowText(liveTurn.row);
    send({
      type: "turn.end",
      turnId: liveTurn.turnId,
      conversationId: state.conversationId,
      index: idx,
      text: finalText,
    });
    state.liveTurns.delete(idx);
  }

  // Per-row observer for an in-progress assistant turn: watches its text
  // for deltas and its data-perf-row-streaming attribute for completion
  // (SPEC.md §6 — the flip to "false" is the only reliable completion
  // signal; a quiet-mutation debounce would misfire during a tool-use
  // pause). Also watches characterData, since streaming updates may change
  // existing text nodes in place rather than replacing whole nodes.
  function watchStreaming(row, idx, liveTurn) {
    const observer = new MutationObserver(() => {
      // No filtering needed here: extractRowText/domToMarkdown no longer
      // mutates the DOM in any way this observer would see — it walks the
      // tree read-only rather than inserting/removing marker nodes, and
      // its one remaining mutation (hiding a code block's copy button via
      // style.display) is excluded by attributeFilter below regardless.
      // Every mutation MutationObserver hands this callback is therefore
      // a real one.
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

    // index is the same data-index value turn.window carries for this row
    // (SPEC.md §4) — included so the bubble can tag the element with it as
    // soon as the turn starts, rather than waiting for a turn.window/harvest
    // that happens to cover it later. retry (below) needs it, and the
    // message the operator just sent or the reply just received is the most
    // likely thing to want to retry. conversationId (SPEC.md §4, 2026-08-29)
    // lets the server verify this turn still belongs to what it thinks is
    // current instead of guessing if the mapping is ever lost — see SPEC.md
    // §4's note on why that guess used to corrupt history.
    send({
      type: "turn.start",
      turnId,
      role,
      origin,
      promptId,
      conversationId: state.conversationId,
      ts: Date.now(),
      index: idx,
    });
    // index is kept on liveTurn itself (not just as the state.liveTurns map
    // key) so emitDeltaIfChanged — which only receives liveTurn, not idx —
    // can send it on turn.delta/turn.replace too (SPEC.md §4, 2026-08-30):
    // the server needs it to persist a turn even if it never saw this
    // turn.start (e.g. a desktop app restart mid-reply lost pendingTurns).
    const liveTurn = { turnId, role, index: idx, lastText: "", row, textObserver: null };
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

  // Confirmed 2026-08-29: document.title doesn't update in the same instant
  // as location.pathname when switching between EXISTING conversations via
  // the sidebar (no page reload) — how long the real title takes to catch
  // up isn't guaranteed. A give-up ceiling for the wait below, the same
  // idea as waitForRenderedConversation's INITIAL_ID_CONFIRM_TIMEOUT_MS: if
  // document.title genuinely never diverges from the stale value (an
  // untested case), the header shouldn't be stuck on "Untitled
  // conversation" forever.
  const TITLE_CONFIRM_TIMEOUT_MS = 5000;

  function handlePossibleConversationChange() {
    if (!state.initialConversationConfirmed) return;
    const id = getConversationIdFromUrl();
    const rawTitle = computeTitle();
    const idChanged = id !== state.conversationId;

    if (idChanged) {
      log(
        `Conversation changed: id=${id || "null"} (title not trusted yet — document.title currently reads ` +
          `${JSON.stringify(rawTitle)}, which is likely still the previous page's — see the fix note above ` +
          `TITLE_CONFIRM_TIMEOUT_MS)`
      );
      const previousConversationId = state.conversationId;
      state.conversationId = id;
      // null, not rawTitle — sending rawTitle here is exactly the bug this
      // fixes (SPEC.md's conversation message): it was reliably the
      // PREVIOUS conversation's title, since document.title hadn't caught
      // up yet at this exact instant. pendingStaleTitle/titleChangeTs are
      // what the branch below uses to recognise the moment it actually
      // does.
      state.title = null;
      state.titleConfirmed = false;
      state.pendingStaleTitle = rawTitle;
      state.titleChangeTs = Date.now();
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
      // Sent immediately, title:null and all — turn capture (attachRowObserver,
      // sendTurnWindow, resetLiveTurnTracking above) must not wait on a
      // cosmetic header value that might take an unknown amount of time, or
      // in an untested case might never change at all.
      announceConversation();
      return;
    }

    if (!state.titleConfirmed) {
      const stillLooksStale = rawTitle === state.pendingStaleTitle;
      const timedOut = Date.now() - state.titleChangeTs > TITLE_CONFIRM_TIMEOUT_MS;
      if (stillLooksStale && !timedOut) return; // keep waiting
      state.title = rawTitle;
      state.titleConfirmed = true;
      log(
        `Title confirmed for conversation ${state.conversationId || "null"}: ${JSON.stringify(rawTitle)}` +
          (stillLooksStale ? " (gave up waiting for document.title to change — using whatever is there now)" : "")
      );
      sendConversation();
      return;
    }

    // Steady state: same conversation, already-confirmed title. Only a
    // genuine later change (e.g. claude.ai auto-titling a conversation
    // after its first reply) reaches here.
    if (rawTitle !== state.title) {
      state.title = rawTitle;
      log(`Title updated: ${JSON.stringify(rawTitle)}`);
      sendConversation();
    }
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
      // No exclusion needed here for our own reads: extractRowText/
      // domToMarkdown walks each row read-only and never inserts or
      // removes a node, so every addition this observer sees is real.
      const hasAdditions = mutations.some((m) => m.addedNodes.length > 0);
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
  // Part D1: prompt injection (SPEC.md §4's `prompt` message)
  // -------------------------------------------------------------------

  // Reuses the composer/send-button facts SELECTORS.md already recorded
  // (D1-D3) instead of guessing at TipTap's empty-document DOM shape: the
  // send button's disabled state already distinguishes "composer empty"
  // from "composer has content." Checking it BEFORE inserting anything
  // doubles as "does the operator already have unsent text typed in here" —
  // no new selector needed.
  function isComposerEmpty() {
    const sendBtn = document.querySelector('[data-testid="chat-input-send"]');
    return !sendBtn || sendBtn.disabled === true;
  }

  // Handles a relayed `prompt` (SPEC.md §4): focus the composer, insert the
  // text, confirm the send button actually enabled, click it, and remember
  // the promptId so the resulting user turn is tagged origin:"bubble"
  // instead of "native" (see startLiveTurn/consumePendingPromptId — that's
  // what stops the bubble showing the message twice).
  //
  // claude.ai/new needs no special case: it uses the same
  // [data-testid="chat-input"] / [data-testid="chat-input-send"] composer as
  // an existing conversation (SELECTORS.md), and sending from it is exactly
  // what transitions the URL to /chat/<id> — handlePossibleConversationChange
  // (Part B) picks that up on its own poll tick.
  //
  // Two cases are refused rather than guessed through, both reported back as
  // an `error` so the bubble shows something instead of silently doing
  // nothing:
  //
  // 1. Claude is already generating a reply. SELECTORS.md's D3 discovery
  //    step (find the send/stop control) was never completed with a
  //    recorded fact about what [data-testid="chat-input-send"] turns into
  //    while streaming — whether it becomes a stop button under the same
  //    testid, changes aria-label, or something else entirely. Clicking it
  //    blindly here risks interrupting the in-progress reply instead of
  //    sending a new one. data-perf-row-streaming (SPEC.md §6, confirmed) is
  //    used instead — it says "Claude is busy" without touching that
  //    unconfirmed ground.
  // 2. The composer already has text the operator typed by hand into
  //    claude.ai directly. Overwriting or appending to it would silently
  //    destroy that. Refusing and telling the operator to send or clear it
  //    first is the boring, safe option — no attempt to merge or stash it.
  //
  // Both are reported with the same code (PROMPT_BUSY): from the operator's
  // side, both mean the same thing — "try again in a moment," not a bug.
  async function handlePrompt(msg) {
    if (!msg || typeof msg.text !== "string" || !msg.promptId) {
      send({ type: "error", code: "PROMPT_FAILED", message: "Prompt message was missing text or a promptId." });
      return;
    }
    log(`prompt: received promptId=${msg.promptId}, length=${msg.text.length}`);

    const composer = document.querySelector('[data-testid="chat-input"]');
    if (!composer) {
      send({
        type: "error",
        code: "PROMPT_FAILED",
        message: "Composer not found on the page — not on a claude.ai chat page, or the layout changed.",
      });
      return;
    }

    if (isAnyRowStreaming()) {
      log("prompt: refused — Claude is currently generating a reply.");
      send({
        type: "error",
        code: "PROMPT_BUSY",
        message: "Claude is still responding. Wait for it to finish, then send again.",
      });
      return;
    }

    if (!isComposerEmpty()) {
      log("prompt: refused — composer already has text.");
      send({
        type: "error",
        code: "PROMPT_BUSY",
        message: "The composer already has text typed into it. Send or clear that first, then try again.",
      });
      return;
    }

    composer.focus();
    const inserted = document.execCommand("insertText", false, msg.text);
    if (!inserted) {
      send({
        type: "error",
        code: "PROMPT_FAILED",
        message: "execCommand('insertText') returned false — injection did not work.",
      });
      return;
    }

    // The proof that matters (SELECTORS.md): TipTap accepted the text into
    // its own document model rather than the characters merely being
    // painted on screen. If this doesn't flip, report instead of clicking
    // blindly — clicking a button still reading "disabled" wouldn't send
    // anything, but silently doing nothing is worse than saying so.
    const sendBtn = document.querySelector('[data-testid="chat-input-send"]');
    if (!sendBtn) {
      send({ type: "error", code: "PROMPT_FAILED", message: "Send button not found after inserting text." });
      return;
    }
    if (sendBtn.disabled !== false) {
      log(`prompt: send button did not enable after injection (disabled=${sendBtn.disabled}).`);
      send({
        type: "error",
        code: "PROMPT_FAILED",
        message: "Text was inserted but the send button did not enable — not sending.",
      });
      return;
    }

    state.pendingPromptId = msg.promptId;
    sendBtn.click();
    log(`prompt: sent promptId=${msg.promptId}.`);
  }

  // -------------------------------------------------------------------
  // Part D (retry, SPEC.md §4). The single-row locate/scroll/restore
  // mechanism retry needs. findScrollContainer, estimateScrollTopForIndex,
  // and SCROLL_SETTLE_MS are also reused by history harvesting (Part D2,
  // further below) rather than re-solving the same scroll-container problem
  // twice.
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

  // Confirmed 2026-08-27 (SELECTORS.md): scrollTop=0 renders index 0 after
  // ~1200ms. Used as the settle delay after every programmatic scroll step —
  // by withRowInView below and by history harvesting (Part D2, further
  // down).
  const SCROLL_SETTLE_MS = 1200;

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

  // A cheap read of which indices are currently rendered — used by the
  // history harvest below to detect progress, and by withRowInView's retry
  // path. Deliberately not collectWindow()/parseRow — those call
  // extractRowText, which does its own DOM manipulation (hide/restore,
  // marker insert/remove) on every row, which would be wasted work and an
  // unwanted side effect just to read a list of numbers.
  function renderedIndices() {
    const list = document.querySelector('[data-testid="transcript-list"]');
    if (!list) return [];
    return Array.from(list.querySelectorAll('[data-testid="transcript-row"]'))
      .map((row) => parseInt(row.getAttribute("data-index"), 10))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
  }

  // Shared by withRowInView (retry, below — one exact index) and
  // handleHistoryRequest (Part D2, further down — stepping toward a
  // boundary index): the same proportional-estimate math, factored out
  // once instead of duplicated. Falls back to the very top (0) when total
  // isn't known yet, matching the one jump SELECTORS.md confirmed actually
  // renders new rows.
  function estimateScrollTopForIndex(scroller, index, total) {
    if (!total || total <= 1) return 0;
    return Math.round((index / (total - 1)) * (scroller.scrollHeight - scroller.clientHeight));
  }

  // Scrolls the transcript so the row at `index` is rendered, if it isn't
  // already (the virtualizer only renders rows near the viewport — SPEC.md
  // §4.1), runs fn(row) (row is null if it still couldn't be found), then
  // restores the original scroll position regardless of outcome — the
  // claude.ai tab is normally in the background, but SPEC.md §4.1 says to
  // restore either way in case it isn't.
  async function withRowInView(index, fn) {
    let row = findRowByIndex(index);
    if (row) return fn(row);

    const scroller = findScrollContainer();
    if (!scroller) {
      log(`retry: index=${index} not rendered and no scroll container found.`);
      return fn(null);
    }

    const originalScrollTop = scroller.scrollTop;
    const wait = () => new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_MS));

    // retry knows the exact index it wants, unlike a full harvest — jump
    // toward an estimate of where it lives using the currently-known total
    // (§4.1), then fall back to the one jump SELECTORS.md confirmed
    // actually renders new rows if total isn't known yet or the estimate
    // misses.
    const collected = collectWindow();
    const total = collected && collected.total ? collected.total : null;
    const target = estimateScrollTopForIndex(scroller, index, total);
    scroller.scrollTop = target;
    await wait();
    row = findRowByIndex(index);

    if (!row) {
      scroller.scrollTop = 0;
      await wait();
      row = findRowByIndex(index);
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
      const isInterrupted = row.textContent.toLowerCase().includes(INTERRUPTED_RESPONSE_TEXT);

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

  // -------------------------------------------------------------------
  // Part D2: history harvesting (SPEC.md §4's `history.request`)
  // -------------------------------------------------------------------

  // Hard ceiling regardless of the no-progress check below — a very long
  // conversation, or an estimate that lands somewhere the virtualizer
  // doesn't respond well to, should stop well before the operator wonders
  // if it's hung, not loop indefinitely. In practice the initial estimate
  // jump (see handleHistoryRequest) means real harvests finish in a
  // handful of steps; this is a safety net, not the expected path.
  const MAX_HARVEST_STEPS = 40;

  // Handles a relayed `history.request` (SPEC.md §4.1): step the transcript's
  // scroll container upward, sending a turn.window after every step, until
  // either the requested boundary is covered or the top of the conversation
  // is reached — then ALWAYS restore the original scroll position and report
  // `history.done`, which is what the bubble waits for to know the harvest
  // is over (as opposed to just one more incremental batch arriving — a
  // long harvest sends many turn.window messages before it's actually
  // finished).
  //
  // Reuses findScrollContainer, estimateScrollTopForIndex, and
  // renderedIndices from the retry work above rather than re-solving the
  // same scroll-container problem — the one thing genuinely new here is the
  // stepping loop itself, since withRowInView's contract (find one exact
  // row, run a callback, restore) doesn't fit "capture a batch after every
  // step." Settling after each step uses waitForIndicesChange, not
  // SCROLL_SETTLE_MS/wait() (retry's own fixed wait, unchanged) — see the
  // comment above HARVEST_STEP_SETTLE_TIMEOUT_MS, below, for why.
  //
  // The very first move is a jump toward an ESTIMATE of where beforeIndex
  // lives (the same math retry's withRowInView uses), not a plain step from
  // wherever the live view currently sits. Without it, a harvest deep into a
  // long conversation would have to step through — and resend via
  // turn.window — every index between the live tail and beforeIndex that
  // the bubble already has, one virtualizer window at a time. The estimate
  // jump is what keeps "do not harvest more than asked" from also meaning
  // "and take forever getting there."
  // OPEN BUG, 2026-08-29: harvest indicator showed "20 of 281 loaded" and
  // just sat there for a while, only actually loading anything once the
  // operator switched to the claude.ai tab and scrolled it by hand. Two
  // candidates, not yet distinguished:
  //   1. The claude.ai tab is normally BACKGROUNDED while the bubble is
  //      used (the whole point of this project) — Chrome throttles
  //      background-tab timers and requestAnimationFrame, which a
  //      virtualizer may depend on to re-render after a scroll event.
  //   2. Setting scroller.scrollTop programmatically might not be producing
  //      a real "scroll" event the way physical wheel/trackpad input does —
  //      or produces one the virtualizer doesn't act on the same way.
  // 2026-08-30: candidate 1 is partially addressed — the fixed wait below
  // was replaced by waitForIndicesChange, which resolves as soon as the DOM
  // actually shows new rows instead of guessing a duration. This has NOT
  // been confirmed against a genuinely backgrounded tab (the original run
  // showed visibilityState=visible throughout, so candidate 1 was always an
  // inference). The next investigation should reproduce with the claude.ai
  // tab actually backgrounded and check the reason/steps logged in
  // handleHistoryRequest's `finally` block below — reintroduce timing/
  // visibilityState logging around the waitForIndicesChange calls if that's
  // not enough to tell the two candidates apart.
  const realNow = () => Date.now();

  // Generous ceiling for how long ONE step waits for the virtualizer to
  // actually re-render after a scrollTop change — deliberately much larger
  // than the ~1200ms an active, foregrounded tab needs (SELECTORS.md),
  // because a backgrounded tab (this app's normal operating condition) may
  // throttle the timers/rAF the virtualizer's re-render depends on. Distinct
  // from SCROLL_SETTLE_MS, which retry's withRowInView still uses unchanged
  // — this constant only affects history harvesting. Most steps resolve far
  // sooner than this via waitForIndicesChange below; the ceiling only binds
  // a step that's genuinely stuck (or badly throttled), so it can't hang
  // the harvest forever.
  const HARVEST_STEP_SETTLE_TIMEOUT_MS = 8000;

  // Waits for renderedIndices() to actually change from previousKey — a
  // real DOM signal instead of a fixed timeout, so a backgrounded tab's
  // throttled timers/rAF can't cause the wait to end before the virtualizer
  // has genuinely re-rendered. Resolves `true` (changed) as soon as a
  // childList mutation on the transcript container produces a different
  // rendered index set, or `false` (timed out) after timeoutMs with no
  // change — whichever comes first. A step that times out is exactly what
  // the existing no-progress check (in handleHistoryRequest, below) already
  // expects to see on its next read, so no other stop-condition logic needs
  // to change.
  function waitForIndicesChange(previousKey, timeoutMs) {
    return new Promise((resolve) => {
      if (renderedIndices().join(",") !== previousKey) {
        resolve(true);
        return;
      }
      const container = document.querySelector('[data-testid="transcript-list"]');
      let settled = false;
      let observer = null;
      function finish(changed) {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        clearTimeout(timer);
        resolve(changed);
      }
      if (container) {
        observer = new MutationObserver(() => {
          if (renderedIndices().join(",") !== previousKey) finish(true);
        });
        observer.observe(container, { childList: true, subtree: true });
      }
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  // Confirmed 2026-08-29: four history.request messages arrived within 1.5
  // seconds (beforeIndex 16, 12, 10, 7), all manipulating the same scroll
  // container concurrently — one harvest's finally block restored
  // scrollTop out from under another mid-jump, which is what made the
  // whole thing look stalled until a manual scroll intervened.
  // originalScrollTop is only meaningful if exactly one harvest owns the
  // scroll position at a time, so a second request arriving while one is
  // already running is REFUSED, not queued: the bubble-side fix (below)
  // means it shouldn't send a second request before the first's
  // history.done arrives, so a real overlap here means something upstream
  // is still wrong — and by the time a queued run reached an old
  // beforeIndex, the bubble has likely already moved past it anyway.
  let historyHarvestInFlight = false;
  let currentHarvestBeforeIndex = null;

  async function handleHistoryRequest(msg) {
    log(`history: received request for beforeIndex=${msg && msg.beforeIndex} conversationId=${msg && msg.conversationId}`);

    if (!msg || typeof msg.beforeIndex !== "number") {
      send({ type: "error", code: "HISTORY_FAILED", message: "History request was missing beforeIndex." });
      return;
    }
    if (msg.conversationId !== state.conversationId) {
      log(`history: conversationId mismatch — request had ${msg.conversationId}, current is ${state.conversationId}.`);
      send({ type: "error", code: "HISTORY_FAILED", message: "Conversation changed before history could be harvested." });
      return;
    }
    if (historyHarvestInFlight) {
      log(
        `history: refused — a harvest for beforeIndex=${currentHarvestBeforeIndex} is already running ` +
          `(new request wanted beforeIndex=${msg.beforeIndex}).`
      );
      send({ type: "error", code: "HISTORY_BUSY", message: "A history harvest is already in progress. Wait for it to finish." });
      return;
    }
    historyHarvestInFlight = true;
    currentHarvestBeforeIndex = msg.beforeIndex;

    const requestConversationId = msg.conversationId;
    const beforeIndex = msg.beforeIndex;

    const scroller = findScrollContainer();
    if (!scroller) {
      log("history: no scroll container found — nothing to harvest.");
      historyHarvestInFlight = false;
      currentHarvestBeforeIndex = null;
      send({ type: "history.done", conversationId: requestConversationId, beforeIndex, reason: "no-scroll-container" });
      return;
    }

    const originalScrollTop = scroller.scrollTop;

    // Genuine user input (wheel/touch) during the harvest is the signal to
    // back off — per-instruction, abort and restore rather than fighting
    // the operator for control of the scroll position. Setting
    // scroller.scrollTop ourselves also fires a "scroll" event, which is
    // why wheel/touchstart are watched instead of "scroll" — those only
    // fire from real input, never from a script assigning scrollTop.
    // Doesn't catch a direct scrollbar-thumb drag with no wheel/touch
    // involved — a known gap, not a guessed-away one.
    let userInterfered = false;
    const markInterference = () => {
      userInterfered = true;
    };
    scroller.addEventListener("wheel", markInterference, { passive: true });
    scroller.addEventListener("touchstart", markInterference, { passive: true });

    let reason = null;
    let steps = 0;
    let lastIndicesKey = null;

    try {
      const initialCollected = collectWindow();
      const total = initialCollected && initialCollected.total ? initialCollected.total : null;
      const initialTarget = estimateScrollTopForIndex(scroller, beforeIndex, total);
      log(
        `history: jumping toward estimate for beforeIndex=${beforeIndex}, total=${total}, ` +
          `originalScrollTop=${originalScrollTop} -> target=${initialTarget}`
      );

      const indicesBeforeJump = renderedIndices();
      scroller.scrollTop = initialTarget;
      await waitForIndicesChange(indicesBeforeJump.join(","), HARVEST_STEP_SETTLE_TIMEOUT_MS);

      while (reason === null) {
        steps++;
        if (requestConversationId !== state.conversationId) {
          reason = "aborted-conversation-change";
          break;
        }
        if (userInterfered) {
          reason = "aborted-scroll";
          break;
        }
        if (steps > MAX_HARVEST_STEPS) {
          reason = "max-steps";
          break;
        }

        const indices = renderedIndices();
        const minIndex = indices.length ? indices[0] : null;
        log(`history: step ${steps} — rendered [${indices.join(", ")}], scrollTop=${scroller.scrollTop}`);

        // Send what's rendered right now regardless of what the stop-check
        // below decides — every step's window is real data the bubble
        // doesn't have yet, even the one that turns out to be the last.
        sendTurnWindow();

        // last-message-sentinel stays mounted even at the top (SPEC.md
        // §4.1) — it's not part of renderedIndices()/collectWindow() (both
        // read [data-testid="transcript-row"], not the sentinel), so it
        // can't cause minIndex to look wrong here. Noted per the operator's
        // instruction, not because anything below currently touches it.
        if (minIndex === 0) {
          reason = "reached-top";
          break;
        }
        if (minIndex !== null && minIndex < beforeIndex) {
          reason = "reached-target";
          break;
        }

        const indicesKey = indices.join(",");
        if (indicesKey === lastIndicesKey) {
          reason = "no-progress";
          break;
        }
        lastIndicesKey = indicesKey;

        if (scroller.scrollTop > 0) {
          scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight);
          await waitForIndicesChange(indicesKey, HARVEST_STEP_SETTLE_TIMEOUT_MS);
        }
      }
    } finally {
      scroller.removeEventListener("wheel", markInterference);
      scroller.removeEventListener("touchstart", markInterference);
      scroller.scrollTop = originalScrollTop;
      log(
        `history: finished — reason=${reason || "unknown"}, steps=${steps}, restored scrollTop=${originalScrollTop}, ` +
          `t=${realNow()}, visibilityState=${document.visibilityState}`
      );
      historyHarvestInFlight = false;
      currentHarvestBeforeIndex = null;
      send({ type: "history.done", conversationId: requestConversationId, beforeIndex, reason: reason || "unknown" });
    }
  }

  // Confirmed 2026-08-29 (conversation-switch bug): location.pathname is
  // only trustworthy once claude.ai's own router has settled on it, and a
  // content script can start running before that happens — a reconnecting
  // content script announced the PREVIOUS conversation's id because it
  // trusted a URL read taken at injection time, before a switch had
  // actually landed. A rendered message row is a much stronger signal:
  // claude.ai doesn't paint one until it knows which conversation it's
  // showing. Wait for at least one row before trusting the URL; give up
  // after INITIAL_ID_CONFIRM_TIMEOUT_MS so a genuinely-empty claude.ai/new
  // (or a conversation that's just slow to load) isn't stuck waiting
  // forever — ongoing changes after this are still caught by pollTick as
  // before, this only guards the very first read.
  const INITIAL_ID_CONFIRM_TIMEOUT_MS = 3000;
  const INITIAL_ID_CHECK_MS = 100;

  function waitForRenderedConversation(onConfirmed) {
    const deadline = Date.now() + INITIAL_ID_CONFIRM_TIMEOUT_MS;
    function check() {
      const container = document.querySelector('[data-testid="transcript-list"]');
      const hasRows = !!(container && container.querySelector('[data-testid="transcript-row"]'));
      if (hasRows || Date.now() >= deadline) {
        onConfirmed();
        return;
      }
      setTimeout(check, INITIAL_ID_CHECK_MS);
    }
    check();
  }

  function initDomTracking() {
    // Harmless to start immediately — neither sends anything over the
    // socket, they only track local state and DOM structure.
    observeTitle();
    attachRowObserver();
    setInterval(sendStatus, STATUS_INTERVAL_MS);

    waitForRenderedConversation(() => {
      state.conversationId = getConversationIdFromUrl();
      state.title = computeTitle();
      state.initialConversationConfirmed = true;
      // No baseline scan here — the baseline is established inside
      // sendTurnWindow, from the first successful read of the
      // actually-rendered DOM (see sendTurnWindow).
      log(`Initial conversation: id=${state.conversationId || "null"} title=${JSON.stringify(state.title)}`);
      setInterval(pollTick, NAV_POLL_MS);
      connect();
    });
  }

  initDomTracking();
})();
