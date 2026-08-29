# SPEC.md — Claude session bubble

Version 3. Local-only architecture. Supersedes v2.1, which routed through a
Cloudflare Worker. See §10 for what changed and why.

---

## 1. Goal

One person can drive a single claude.ai conversation from a small always-on-top
window that floats above whatever else they are doing on their Mac.

Typing in the bubble puts the message into the real claude.ai composer and sends
it. Claude's reply streams back into the bubble. Messages typed directly into
claude.ai also appear in the bubble.

## 2. Non-goals

- No access from a phone, a second machine, or anywhere off this device.
- No sharing, no second user.
- No public distribution. This is not a Chrome Web Store product.
- No use of the Anthropic API and no API keys anywhere in the system.
- Nothing leaves the machine. No cloud component of any kind.

## 3. Components

Two, not three. The desktop app is both the relay and the UI.

### 3.1 Chrome extension (MV3)

Runs only on `https://claude.ai/*`.

**Manifest permissions:** `storage` (for the pairing token) and a host permission
for `https://claude.ai/*`. Nothing else. No `tabs`, no `<all_urls>`.

**Content script** holds the WebSocket and does all DOM work.

Responsibilities:

1. Read the pairing token from `chrome.storage.local`. If absent, do nothing and
   report an unpaired state in the options page.
2. Read the conversation ID from the URL (`https://claude.ai/chat/<id>`), or note
   that there is none (`https://claude.ai/new`).
3. Connect to `ws://127.0.0.1:8787/?role=extension&token=<token>`. Before
   connecting, check `navigator.permissions.query({ name: 'local-network-access' })`.
   If the state is not `granted`, show the operator a specific message about the
   Local Network Access permission instead of reporting a generic connection
   failure — the two look identical in the console and would waste an hour.
4. On attach, send a `turn.window` containing the rows currently rendered, each
   with its `data-index` and the total from the `aria-label`. This is a partial
   view — the transcript is virtualized. See §4.1.
4a. On `history.request`, harvest older messages by stepping the scroll
   container upward, sending a `turn.window` per step, then restoring the
   original scroll position.
5. Observe the conversation container and emit `turn.start` / `turn.delta` /
   `turn.end` for turns appearing after attach.
6. Receive `prompt` messages, inject into the composer, submit.
7. Detect SPA navigation and send a `conversation` message with the new ID.
8. Handle the **unstarted-chat case**. `claude.ai/new` has no conversation ID.
   Sending the first message transitions the URL to `/chat/<id>` without a page
   reload. The extension must attach on `/new`, report a null conversation, and
   emit a real `conversation` message once the ID appears. A prompt sent from the
   bubble while on `/new` should start the conversation.
9. Reconnect with backoff whenever the socket drops. The desktop app may not be
   running.

**Options page** accepts the pairing token, pasted from the desktop app.

**Background service worker** is not used for the socket. It exists only if the
options page needs it.

### 3.2 Desktop app (Electron, macOS)

One app, two jobs.

**Job one — WebSocket server.** Listens on `127.0.0.1:8787` in the main process,
using the `ws` package. Never binds `0.0.0.0`. Holds at most one `extension`
connection and one `bubble` connection, routes messages between them per §4, and
persists completed turns to a JSON file in `app.getPath('userData')`.

**Job two — the bubble window.** A frameless, transparent, always-on-top
`BrowserWindow` rendering the React bubble.

macOS window configuration that actually produces the behaviour wanted:

```js
const win = new BrowserWindow({
  width: 380, height: 560,
  frame: false, transparent: true, resizable: true,
  alwaysOnTop: true, skipTaskbar: true,
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
});
win.setAlwaysOnTop(true, 'floating');
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
```

`'floating'` is the level that keeps it above ordinary windows.
`visibleOnFullScreen` is what makes it survive when another app goes fullscreen.
Without both, the bubble disappears exactly when it is most wanted.

Dragging uses `-webkit-app-region: drag` on the bubble's header strip, with
`-webkit-app-region: no-drag` on every button inside it. Otherwise the buttons
become drag handles and stop being clickable.

A global shortcut (suggest `Cmd+Shift+C`) toggles show and hide.

Renderer and main communicate over `contextBridge` IPC. The renderer never
touches the socket directly.

### 3.3 The bubble UI

The existing React component, rendered inside the Electron window.

Responsibilities:

0. Communicate with the main process **only** over `contextBridge` IPC. The
   renderer never opens a WebSocket.
1. Render history received from the main process on start.
2. Clear and re-render when a `conversation` message arrives with a new ID.
3. Render assistant turns progressively as deltas arrive.
4. Send prompts optimistically with a `promptId`, reconcile on `promptId` when
   the matching turn returns — never show a message twice.
5. Show a health state: extension connected and capturing / extension connected
   but capture broken / extension offline. The operator must never be left
   guessing whether it is broken.

---

## 4. Message protocol

JSON over WebSocket. Unchanged from v2.1 except that `room` no longer exists —
there is one server and one pair of clients.

### Client to server

**`hello`** — first message after connecting. Only the extension connects over
WebSocket; see the note below.
```json
{ "type": "hello", "role": "extension", "clientId": "<random>" }
```

> **The bubble is not a WebSocket client.** §3.2 already specifies that the
> renderer reaches the main process over `contextBridge` IPC and never touches
> the socket. The server therefore has exactly one socket client: the extension.
>
> A `role=bubble` connection was inherited from the v2 cloud design, where the
> two clients genuinely had to meet over a network. Locally they are the same
> process. Keeping it would also have created an unsolvable origin problem — the
> Electron renderer presents a `null` or `file://`-derived origin, which the
> allowlist in §5 must refuse, and allowing `null` would admit far more than the
> bubble.
>
> Everywhere below that says "forwards to the bubble", read: hands to the
> renderer over IPC.

**`conversation`** — extension only. Sent after `hello` and whenever the operator
navigates to a different conversation. `conversationId` may be `null` on
`claude.ai/new`.
```json
{ "type": "conversation", "conversationId": "<id or null>", "title": "..." }
```
The server records this, forwards it to the bubble, and sends the bubble the
stored history for that conversation.

**`turn.window`** — extension only. A **partial** view of the transcript: the
rows currently rendered, each carrying its true `index` from the page. Sent on
attach, after a conversation change, and after each harvest step.

```json
{ "type": "turn.window", "conversationId": "<id>", "total": 142,
  "turns": [ { "index": 136, "role": "user", "text": "..." } ] }
```

The server **merges by `index`**, keyed per conversation. It never replaces.
An index already stored is updated in place; an index not stored is inserted in
order. See §4.1 for why this replaced `turn.snapshot`.

**`history.request`** — bubble to extension, over IPC then relayed. Asks for
messages the bubble does not yet have.
```json
{ "type": "history.request", "conversationId": "<id>", "beforeIndex": 136 }
```
The extension harvests the next batch below `beforeIndex` and replies with one or
more `turn.window` messages.

**`prompt`** — bubble to extension.
```json
{ "type": "prompt", "promptId": "<random>", "text": "..." }
```

**`retry`** — bubble to extension, over IPC then relayed. Asks the extension to
retry an assistant reply or resend a user message that's already on the page —
added for the message-level copy/retry actions.
```json
{ "type": "retry", "conversationId": "<id>", "index": 137 }
```
The extension locates the row by `data-index`. The transcript is virtualized
(§4.1) — if the row isn't currently rendered, the extension scrolls it into
view first, reusing the scroll-container-detection logic §4.1's harvest
depends on, clicks `[data-testid="action-bar-retry"]` (assistant row) or
`[data-testid="user-message-retry"]` (user row) — chosen by reading the found
row's own `data-perf-row`, not by trusting a role the bubble might have sent —
then restores the original scroll position. If the row can't be found at all,
the extension sends `error` (`RETRY_FAILED`) rather than doing nothing.

**Assumption, not a confirmed fact:** retrying an assistant reply is assumed to
replace that reply in place at the same `index`, not append a new row. Under
that assumption, an in-place text change would otherwise go unnoticed — an
index already known is exactly what §4.1's scanning treats as "the user
scrolled," not "new" — so the extension separately watches the retried row's
`data-perf-row-streaming` (§6) and resends its text as an ordinary
`turn.window` entry for that index once it settles. If the assumption is
wrong and claude.ai appends a new row instead, nothing needs to handle it
specially: a new index is picked up by the normal `turn.start` path exactly
like any other new message. If indices shift instead, nothing here detects
that — it would need a full re-harvest to converge, and the general
multi-step `history.request` harvest itself is not yet implemented (only the
single-row locate `retry` needs).

**All four messages below carry `conversationId`** (added 2026-08-29). Editing
this in: the extension always knows which conversation a turn belongs to, so
it says so on every one of these — `turn.start`, `turn.delta`, `turn.replace`,
and `turn.end` alike — rather than making the server infer it. Before this,
none of the four carried it, and the server tracked "which conversation is a
turn for" only through `pendingTurns`, a `turnId → index` map built from
`turn.start` and consumed by `turn.end`. A reconnect — even a benign one, or a
same-id `conversation` reannounce from a title update — used to clear that map
unconditionally, orphaning any turn still streaming through it. `turn.end`'s
handler then fell back to guessing the write index as `convo.total` of
whatever conversation happened to be `currentConversationId` at that moment —
not necessarily the conversation the reply actually belonged to. On
2026-08-29 this silently wrote one conversation's replies into a different
conversation's stored history. With `conversationId` on every turn message,
the server checks it against `currentConversationId` and drops a mismatched
turn instead of guessing where it goes (see `case "turn.end"` in
`server.js`) — a dropped turn is recoverable, since the next `turn.window`
resync fills the correct index in from the page; a misfiled one corrupts
history permanently.

**`turn.start`** — extension only.
```json
{ "type": "turn.start", "turnId": "<random>", "role": "user" | "assistant",
  "origin": "bubble" | "native", "promptId": "<id or null>",
  "conversationId": "<id or null>", "ts": 0, "index": 137 }
```
`index` is the row's `data-index` at the moment the turn is first observed —
the same value `turn.window` carries for the same row (§4.1). Added so the
bubble can tag a live turn's element with its index as soon as it's known,
rather than only once a later `turn.window`/harvest happens to cover it —
`retry` needs a row's index to act on it, and the message just sent or the
reply just received is the most likely thing to want to retry.

**`turn.delta`** — extension only. Text appended to an in-progress turn.
```json
{ "type": "turn.delta", "turnId": "<id>", "conversationId": "<id or null>",
  "text": "chunk" }
```

**`turn.replace`** — extension only. The full current text for a turnId,
replacing whatever `turn.delta` had accumulated so far — not an
optimization, and not safe to remove in favor of always appending.
**Exists because appending isn't always valid mid-stream:** the extension's
own text extraction (e.g. code-fence rebuilding) only activates once a
`<pre>` and its language label are both fully present, which reshapes text
already sent as deltas. Confirmed 2026-08-28: a live reply logged
`isAppend=false` with `deltaLen === fullLen` — the text was being rewritten,
not extended — which without `turn.replace` showed up as the same reply
appearing three times, each longer than the last. Both the server
(`pending.buffer`) and the bubble (`live.buffer`) must overwrite on
`turn.replace`, never append, and must never create a second message for a
turnId they already know — the same rule `turn.delta`/`turn.end` already
follow.
```json
{ "type": "turn.replace", "turnId": "<id>", "conversationId": "<id or null>",
  "text": "current full text" }
```

**`turn.end`** — extension only. `text` is the full final text and is
authoritative; it replaces whatever the deltas produced.
```json
{ "type": "turn.end", "turnId": "<id>", "conversationId": "<id or null>",
  "text": "complete message text" }
```

**`status`** — extension only, every 20 seconds.
```json
{ "type": "status", "conversationId": "<id or null>", "streaming": true,
  "capture": "ok" | "no-container" | "no-composer" }
```

`capture` matters more than it looks. The extension can be connected while its
observer is attached to nothing, because a selector broke after an Anthropic
frontend update. Without this field the bubble shows healthy and sits silent, and
the operator debugs the server for an hour when the problem is a renamed
attribute.

### Server to client

**`history`** — sent after `hello` and after each `conversation` change.
```json
{ "type": "history", "conversationId": "<id>", "turns": [] }
```

**`peers`** — sent to the renderer over IPC whenever the extension connects or
disconnects.
```json
{ "type": "peers", "extension": true }
```

**`error`** — sent by the server on a rejected connection (`BAD_TOKEN` |
`ROLE_TAKEN` | `MALFORMED`), and also relayed as-is from the extension when it
can't carry out something the bubble asked for — currently just `RETRY_FAILED`
(see `retry` above). The bubble shows it rather than failing silently.
```json
{ "type": "error",
  "code": "BAD_TOKEN" | "ROLE_TAKEN" | "MALFORMED" | "RETRY_FAILED",
  "message": "..." }
```

### Rules

- One extension connection at a time. A second is rejected with `ROLE_TAKEN`.
  This happens when claude.ai is open in two tabs.
- Persist only on `turn.end` and `turn.window`. Never on `turn.delta`.
- `turn.window` merges by `index`. It never replaces the stored set.
- Unrecognised message types are dropped, not forwarded.
- Maximum message size enforced; oversized messages rejected.

### 4.1 The transcript is virtualized

**Confirmed 2026-08-27.** claude.ai renders only the rows near the viewport and
destroys the rest. In a 142-message conversation, 6 rows were in the DOM,
indices 136–141. Everything below index 136 did not exist as DOM at all.

Markers: `transcript-sizer`, `data-rs-index`, `data-perf-row-from-tail`,
`last-message-sentinel`.

**The DOM is a window onto the conversation, not the conversation.** Three rules
follow, and violating any of them corrupts history:

1. **Never replace stored turns from a partial view.** The original
   `turn.snapshot` design replaced everything with what was visible — in a long
   chat that means discarding 142 messages and keeping 6. Merge by `index`
   instead. `data-index` on the row is stable and authoritative.
2. **Row removal is never a deletion.** Rows leaving the viewport are destroyed
   by the virtualizer. The MutationObserver must ignore removals entirely.
3. **A re-added row is not a new message.** An index already stored means the
   user scrolled. Only an index above the current maximum is genuinely new.

**Total message count** comes from `aria-label="Message 137 of 142"` on the
row's first child. The bubble uses this to show what it has versus what exists.

**Harvesting older messages.** Confirmed working: setting `scrollTop = 0` on the
scroll container renders index 0, and restoring `scrollTop` returns to position.

The scroll container is the nearest ancestor of `[data-testid="transcript-list"]`
with `overflow-y: auto` and real overflow. Do not hardcode a class name; walk up
and test computed style.

Harvest is **on demand, not on attach.** Scraping 142 messages on every attach
would leave the bubble blank for seconds while claude.ai visibly scrolls. Instead:

- On attach, send whatever is rendered as a `turn.window`.
- When the bubble scrolls to the top of what it has, it sends
  `history.request`. The extension steps `scrollTop` upward, captures each
  window, and restores the original position when done.
- One jump to the top is not sufficient. It renders only the first few rows;
  intermediate positions must be stepped through to cover the middle.
- The claude.ai tab is in the background while the bubble is in use, so the
  scrolling is invisible to the operator. Restore position regardless, in case
  it is not.

**`last-message-sentinel` stays mounted even when scrolled to the top.** The
presence of the highest index does not mean the view is at the bottom. Do not
use it as a position check.

### Echo handling

When the bubble sends a `prompt`, it renders that message immediately with its
own `promptId`. The extension injects the text; claude.ai renders it as a user
turn, which the observer picks up. The extension tags that turn with
`origin: "bubble"` and the matching `promptId`.

The bubble reconciles on `promptId` — replacing its optimistic message rather
than appending a copy. Turns with `origin: "native"` are always appended.

Deduplicating on message text instead would break the moment the operator
legitimately sends the same text twice.

---

## 5. Security model

Local-only removes most of the previous threat surface. Nothing is exposed to the
internet and no conversation content leaves the machine. Two exposures remain.

**Any web page can open a socket to localhost.** A site open in another tab can
attempt `ws://127.0.0.1:8787`. Three defences, all required:

1. **Bind to `127.0.0.1` only.** Never `0.0.0.0`, which would expose the server
   to the local network.
2. **Origin check on upgrade — allowlist.** Accept a connection **only** if its
   `Origin` header is exactly `https://claude.ai` (confirmed by test 2026-08-27)
   or begins with `chrome-extension://`. Reject everything else, including a
   missing or `null` origin. A page cannot forge its origin.

   Stated as code, so it cannot be misread:

   ```js
   const ok = origin === 'https://claude.ai' || origin.startsWith('chrome-extension://');
   if (!ok) { socket.destroy(); return; }
   ```

   An earlier revision of this document stated this rule inverted, telling the
   implementer to reject the two legitimate origins. Default-deny is the
   behaviour; anything not on the list is refused.
3. **Pairing token.** A 32-byte random value generated by the desktop app on
   first run, stored in its userData directory, displayed in a settings panel,
   and pasted by hand into the extension's options page. Rejected connections get
   `BAD_TOKEN` and are closed.

**Token rotation.** The settings panel exposes a regenerate action. Rotating
invalidates the extension's stored token until it is re-pasted.

**Nothing authenticating ever crosses the socket.** No cookies, no `sessionKey`,
no org ID, no bearer token. If any of those would need to travel, the design is
wrong.

## 6. Streaming and completion detection

Claude's replies stream. The assistant node is inserted nearly empty and mutates
continuously for several seconds. A naive "node added → read text" reads an empty
node.

**Completion signal — resolved.** `data-perf-row-streaming` on a
`[data-testid="transcript-row"]` flips from `"true"` to `"false"` when that turn
finishes generating. Confirmed 2026-08-27.

This is per-turn rather than global, so it identifies *which* message completed.
A pause during tool use cannot be misread as completion, which was the failure
mode that made this section difficult. The send-button approach is no longer
needed.

**Why not debounce on mutation quiet:** Claude pauses mid-response during tool
use — web search, code execution. A quiet-period heuristic would fire `turn.end`
during the pause, then a second turn afterwards, showing a truncated answer
followed by a fragment.

**Degraded mode** — a long debounce (2500ms) — remains documented only as a last
resort if the attribute is ever removed. It carries the split-turn bug described
above and should not be built unless forced.

**Turn start** is detected from node insertion into the transcript list, not from
the streaming attribute. A newly inserted row already carries
`data-perf-row-streaming="true"`, and attribute observers do not fire for initial
values on new nodes.

## 7. Text extraction

`textContent` on a rendered assistant message destroys code block newlines and
indentation, collapses tables, and flattens lists.

**Confirmed 2026-08-27: `innerText` preserves code block newlines and
indentation.** This section is much smaller than originally budgeted. Three
cleanups are required rather than a full HTML-to-Markdown walk:

1. Rebuild code fences. The language label appears as a bare text line with no
   backticks. Find `<pre>` in the row and wrap its content, using the label.
2. Strip the accessibility prefix: rows begin `"Claude responded: "` or
   `"You said: "` followed by a duplicate of the message's opening fragment.
3. Strip the trailing timestamp: `"just now"`, `"5 days ago"`.

That covers prose and code. Real claude.ai turns also contain structures
that are not prose, each needing a decision:

| Structure | Bubble behaviour |
|---|---|
| Artifact panel | `[artifact: <title>]`. Do not mirror the panel. |
| Extended thinking | Skip, or `[thinking]`. Decide once, be consistent. |
| Tool use / search | `[searched: <query>]`. Do not mirror result cards. |
| Citations | Strip interactive markup, keep visible text. |
| Images | `[image]`. The relay carries text only. |

None of these fall out of generic HTML-to-Markdown conversion.

## 8. Known risks

| Risk | Severity | Handling |
|---|---|---|
| Selectors break on an Anthropic frontend update | High, recurring | No mitigation available. Expect periodic manual repair. Failure is silent, so `capture` health must be visible in the UI. |
| Injection rejected by the TipTap editor | **Resolved 2026-08-27** | `execCommand('insertText')` works: text lands and the send button enables. Synthetic paste also works as a backup. |
| Chrome Local Network Access permission revoked | Bubble stops receiving, silently | **Transport confirmed working 2026-08-27.** Chrome 142+ gates localhost access behind a per-site permission rather than blocking it. Granted for claude.ai. Clearing site data or resetting site permissions revokes it. The extension should check `navigator.permissions.query({name:'local-network-access'})` on load and surface a clear message if the state is not `granted`, rather than failing as a connection error. |
| Terms of service | Account suspension | Automated interaction with the consumer interface is outside what the terms permit. The exposure is the operator's account and its history. Accepted knowingly for personal use. Not accepted for distribution. |
| claude.ai tab closed or discarded by Chrome memory saver | Bubble silently dead | `peers` drives an explicit offline state in the UI. |
| Other extensions hooking the composer | Injection silently fails or double-fires | Grammarly and QuillBot both hook contenteditable on claude.ai. Confirmed present. Test with them disabled. |
| Desktop app not running | Extension has nowhere to connect | Extension reconnects with backoff and reports offline in its options page. |
| Virtualized transcript corrupts history | **Resolved by design 2026-08-27** | Confirmed: 6 of 142 rows in DOM. Merge by `index`, ignore removals, harvest on demand. See §4.1. |
| Image exceeds max message size | Attachment silently rejected | A phone photo of 4MB becomes ~5.3MB base64, over the 5MB cap. Send images as binary WebSocket frames, or downscale in the bubble before encoding. Decide in Phase 3. |
| macOS Local Network privacy prompt | Possible silent failure | Distinct from Chrome's Local Network Access. Apple's prompt targets LAN and Bonjour discovery; pure loopback inside one process is unlikely to trigger it, and the app is both server and only local client. Untested. If a prompt appears during Phase 1, allow it and record the result here. |

## 9. What is deliberately absent

- No database. A JSON file in userData is sufficient.
- No cloud service, no account, no deploy step, no free-tier limits.
- No build step for the extension. Vanilla JS.
- No auth system beyond the pairing token.
- No telemetry.

## 10. Changes in version 3

The bubble was respecified as a desktop overlay that floats above other
applications and stays available when switching apps. A web page cannot do that —
it lives inside a browser tab and disappears on app switch.

Consequences:

1. **Cloudflare Worker and Durable Object removed.** With both ends of the relay
   on one machine, a round trip to the internet served no purpose. The `worker/`
   directory stays in the repo, unused, in case remote access is ever wanted.
2. **Electron chosen over Tauri.** Tauri produces smaller binaries but requires
   Rust. Electron is JavaScript throughout, the existing React bubble ports
   nearly unchanged, and macOS supports the exact window behaviour needed.
3. **Three components became two.** The desktop app is both relay and UI.
4. **SQLite replaced by a JSON file.** No free-tier write budget to respect, so
   the storage constraints that shaped v2 no longer apply.
5. **Security model rewritten.** No public endpoint. The threat is now local
   pages probing localhost, handled by binding, origin check, and pairing token.
6. **Token direction reversed.** The desktop app generates it; the extension
   receives it. Previously the extension owned the secret.
7. **Protocol §4 survives intact** apart from dropping `room`.
8. **`turn.snapshot` became `turn.window`, merge instead of replace.** The
   transcript is virtualized; the original replace-on-snapshot design would have
   destroyed history. See §4.1.
9. **The bubble stopped being a WebSocket client.** It is in the same process as
   the server, so it uses IPC. This removed a connection, a role, an origin
   problem, and a class of failure. Found during the v3 orientation review.
10. **The §5 origin check was stated inverted** in an intermediate revision and is
   now written as an explicit allowlist with code.

Prior version retained as `SPEC_v2_archive.md`.