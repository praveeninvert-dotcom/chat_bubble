# SPEC.md — Claude session bubble

Version 2.1. Supersedes the original project scope document, which contained
six errors listed in §9. See §10 for what changed between v2 and v2.1.

---

## 1. Goal

One person can carry on a single claude.ai conversation from two surfaces at
once: the real claude.ai tab, and a floating chat bubble embedded on a different
website they control.

Typing in the bubble puts the message into the real claude.ai composer and sends
it. Claude's reply streams back into the bubble as it is generated. Messages
typed directly into claude.ai also appear in the bubble.

## 2. Non-goals

- No sharing, no second user, no viewer page.
- No public distribution. This is not a Chrome Web Store product.
- No use of the Anthropic API and no API keys anywhere in the system.
- No support for more than one active conversation at a time.

The room itself is not scoped to a conversation — it is scoped to the
operator's secret, for the lifetime of the extension install. Only one
conversation is *mirrored* at a time; switching which claude.ai conversation is
open replaces the room's active conversation and its stored turns, rather than
opening a second room. See §4 and §5.

## 3. Components

### 3.1 Chrome extension (MV3)

Runs only on `https://claude.ai/*`.

**Manifest permissions:** `storage` (for the room secret), and a host permission
for `https://claude.ai/*`. Nothing else. No `tabs`, no `<all_urls>`.

**Content script** does all the work and holds the WebSocket, because MV3
service workers are terminated when idle.

Responsibilities:

1. Read the conversation ID from the URL (`https://claude.ai/chat/<uuid>`).
2. Read or create the room secret in `chrome.storage.local`.
3. Compute the room key (`SHA-256(secret)` — see §5) and open a WebSocket to
   the Worker. The room key does not depend on the conversation ID.
4. Observe the conversation container for new and changing message nodes. On
   first attach, also read whatever turns are already rendered and send them
   as one `turn.snapshot` — a `MutationObserver` never fires for nodes that
   existed before it started observing, so without this the operator's
   existing conversation would look empty until the next new turn.
5. Emit `turn.start` / `turn.delta` / `turn.end` for each new turn.
6. Receive `prompt` messages and inject them into the composer, then submit.
7. Detect SPA navigation (the URL changes without a page reload). Send a
   `conversation` message announcing the new conversation ID, then a fresh
   `turn.snapshot` backfilling whatever is already rendered for it. Do **not**
   recompute the room key — the room persists for the life of the install; only
   which conversation it mirrors changes.
8. Report capture health via the `capture` field on `status` (§4) whenever a
   known selector fails to resolve, so the bubble can tell "extension offline"
   apart from "extension running but its selectors broke."

**Background service worker** exists only to serve the extension popup, which
displays the room secret for the operator to copy. It holds no socket.

### 3.2 Cloudflare Worker + Durable Object

**Worker:** accepts WebSocket upgrade requests at `/ws?room=<roomKey>&role=<role>`,
validates the parameters, and forwards the socket into the Durable Object whose
name is `roomKey`.

**Durable Object:** one per room. Holds the connected sockets, keeps the last N
completed turns in SQLite storage, and fans messages between the extension and
the bubble.

Uses the **WebSocket Hibernation API** so the object can be evicted between
messages without dropping connections.

**Constraints that shape the design:**

- Free plan requires SQLite-backed DOs. Migration tag must use
  `new_sqlite_classes`. `new_classes` will not deploy.
- Free plan allows 100,000 row writes per day. Persist only completed turns.
- Keep at most 200 turns per room; delete oldest beyond that.

### 3.3 Chat bubble

An existing React component with drag and snap-to-edge behaviour. Currently
calls the Anthropic API directly. That call gets replaced with a WebSocket
client.

Responsibilities:

1. Read the room secret from local config. The room key is derived from the
   secret alone (§5) — the bubble does not need to know the conversation ID in
   advance. It learns which conversation is active from the server, via the
   `conversationId` on `history` and later `conversation` messages.
2. Open a WebSocket to the Worker with `role=bubble`.
3. Render `history` on connect, including which conversation it belongs to.
4. Render streaming turns progressively as deltas arrive.
5. Send `prompt` messages, rendering them optimistically with a client-side ID.
6. Show a clear connection state: connected / relay up but extension offline /
   disconnected. The operator must never be left wondering whether it is broken.

---

## 4. Message protocol

All messages are JSON objects with a `type` field. All are relayed verbatim by
the Durable Object except where noted.

### Client to server

**`hello`** — first message after connecting. Sent by both roles.
```json
{ "type": "hello", "role": "extension" | "bubble", "clientId": "<random>" }
```
No `conversationId` here — the room key no longer depends on it (§5), so
neither role needs to know it before connecting. Which conversation is active
arrives separately, via `history` and `conversation` below.

**`conversation`** — extension only. Announces the currently active
conversation: once right after `hello`, and again every time SPA navigation
moves the extension to a different conversation.
```json
{ "type": "conversation", "conversationId": "<uuid>", "ts": 1730000000 }
```
The DO stores the latest value and includes it in `history` for any client
that connects afterward.

**`turn.snapshot`** — extension only. A full replacement of the room's turn
history, built by reading whatever is currently rendered in the DOM. Sent on
first attach to a conversation and again after every `conversation` message,
since a `MutationObserver` cannot see nodes that existed before it attached.
```json
{ "type": "turn.snapshot",
  "turns": [ { "turnId": "...", "role": "user" | "assistant", "text": "...",
  "ts": 0 } ] }
```
Unlike `turn.end`, which appends one persisted turn, `turn.snapshot` replaces
every stored turn in the room. It is not a delta.

**`prompt`** — bubble to extension. The bubble generates `promptId`.
```json
{ "type": "prompt", "promptId": "<random>", "text": "..." }
```

**`turn.start`** — extension only. A new message node appeared.
```json
{ "type": "turn.start", "turnId": "<random>", "role": "user" | "assistant",
  "origin": "bubble" | "native", "promptId": "<id or null>", "ts": 1730000000 }
```

**`turn.delta`** — extension only. Text appended to an in-progress turn.
```json
{ "type": "turn.delta", "turnId": "<id>", "text": "chunk of new text" }
```

**`turn.end`** — extension only. Turn is complete. `text` is the full final
text and is authoritative; it replaces whatever the deltas produced.
```json
{ "type": "turn.end", "turnId": "<id>", "text": "complete message text" }
```

**`status`** — extension only. Heartbeat, generation state, and DOM capture
health. `capture.ok: false` is how the bubble learns a selector broke — see
the risk noted in §8 — rather than looking identically dead as when the
extension itself is offline.
```json
{ "type": "status", "streaming": true,
  "capture": { "ok": true, "detail": null }, "ts": 1730000000 }
```
`conversationId` is not repeated here — it travels on `conversation` and
`history` instead, so there is one place it can go stale, not two.

### Server to client

**`history`** — sent to any client immediately after `hello`.
```json
{ "type": "history", "conversationId": "<uuid or null>",
  "turns": [ { "turnId": "...", "role": "...", "text": "...", "ts": 0 } ] }
```
`conversationId` is `null` only in the narrow window before the extension has
ever sent a `conversation` message for this room (e.g. a bubble connects
before the extension has attached to any conversation).

**`peers`** — sent whenever a client connects or disconnects, so the bubble can
show whether the extension is live.
```json
{ "type": "peers", "extension": true, "bubbles": 1 }
```

**`error`**
```json
{ "type": "error", "code": "BAD_ROOM" | "ROLE_TAKEN" | "MALFORMED", "message": "..." }
```

### Rules

- Only one `extension` socket per room. A second one is rejected with `ROLE_TAKEN`.
- The DO persists a turn only on `turn.end`, appending it to the room's stored turns.
- The DO relays `turn.delta` without persisting it.
- On `turn.snapshot`, the DO replaces every stored turn in the room with the
  snapshot's turns. It does not merge or append.
- On `conversation`, the DO stores the `conversationId` as the room's current
  value and includes it in `history` for future connections.
- Any message type the DO does not recognise is dropped, not forwarded.

### Echo handling

When the bubble sends a `prompt`, it renders that message immediately with its
own `promptId`. The extension injects the text; claude.ai then renders it as a
user turn, which the observer picks up. The extension must tag that turn with
`origin: "bubble"` and the matching `promptId`.

The bubble reconciles on `promptId` — it replaces its optimistic message rather
than appending a second copy. Turns with `origin: "native"` are always appended.

Deduplicating on message text instead would break the moment the operator
legitimately sends the same text twice.

---

## 5. Security model

**Threat:** the Worker is a public internet endpoint. Anyone who learns a room
key can read the conversation and inject prompts into a live authenticated
Claude session.

**Room key derivation:**
```
secret     = 32 random bytes, generated once, stored in chrome.storage.local
roomKey    = hex( SHA-256( secret ) )
```

The conversation UUID is never part of the key — it is visible in the URL bar,
browser history, sync, and any screenshot, so it must not contribute to a
secret. It is also excluded for a second, independent reason: an earlier
version of this design folded the conversation ID into the key, which meant
navigating to a different claude.ai conversation silently pointed the
extension at a brand-new, empty Durable Object while the bubble stayed
connected to the old one — conversation switching just broke the connection.
The key is now derived from the secret alone, so the room persists for the
life of the extension install; which conversation it currently mirrors travels
over the protocol instead, as a `conversation` message (§4).

**The secret moves by hand.** The operator opens the extension popup, copies the
secret, and pastes it into the bubble's local config. It is never transmitted.

**Nothing authenticating ever crosses the relay.** No cookies, no `sessionKey`,
no org ID, no bearer token. If any of those would need to travel, the design is
wrong.

**Bubble host page.** The secret is present in client-side JavaScript on
whatever site hosts the bubble. That page must not be publicly reachable. A
localhost page, a password-protected page, or a private deployment is required.

## 6. Streaming and completion detection

Claude's replies stream. The assistant node is inserted nearly empty and then
mutates continuously for several seconds. A naive "node added → read text" reads
an empty node.

**Completion signal:** the composer's send button reverts from stop-state to
send-state when generation finishes. Watch that, not the message node.

**Why not debounce on mutation quiet:** Claude pauses mid-response during tool
use — web search, code execution, file operations. A quiet-period heuristic
would fire `turn.end` during the pause, then a second turn afterwards. The
bubble would show a truncated answer followed by a fragment.

**Fallback:** if the button-state approach proves unworkable, use a long
debounce (2500ms) and accept occasional split turns. Record the choice here.

Status: **unverified.** Depends on SELECTORS.md.

## 7. Text extraction

`textContent` on a rendered assistant message destroys code block newlines and
indentation, collapses tables, and flattens lists. The bubble would show
undifferentiated paragraphs.

Approach: walk the message node and reconstruct Markdown — fenced blocks for
`<pre>`, backticks for inline `<code>`, `-` for list items, `#` for headings.
Treat this as real work, not a detail.

## 8. Known risks

| Risk | Severity | Handling |
|---|---|---|
| Selectors break on an Anthropic frontend deploy | High, recurring | No mitigation for the breakage itself — expect periodic manual repair. The extension reports `capture.ok: false` on `status` (§4) when a known selector fails to resolve, so the bubble shows "extension connected, capture broken" instead of looking identically dead to "extension offline." |
| Injection technique rejected by the composer's editor | Project-ending if unsolvable | Must be tested before anything else is built. See PROMPTS.md Phase 0. |
| Terms of service | Account suspension | Automated interaction with the consumer interface is outside what the terms permit. The exposure is the operator's account and its history. This is accepted knowingly for personal use. It is **not** accepted for distribution. |
| claude.ai tab closed or discarded by Chrome memory saver | Bubble silently dead | `peers` message drives an explicit offline state in the bubble UI. |

## 9. Corrections to the original scope document

1. **URL format.** The original said the session token derives from "the
   `session_...` value in the URL." There is no such value. Conversation URLs are
   `claude.ai/chat/<uuid>`; `sessionKey` is the authentication cookie. The two
   were conflated.
2. **Durable Object storage backend.** The original did not mention that the
   Workers Free plan can only create SQLite-backed Durable Objects. A
   `new_classes` migration fails to deploy.
3. **In-memory history.** The original stored history in memory. Durable Objects
   are evicted; memory does not survive. Use the storage API.
4. **Build order.** The original scheduled the Worker first and DOM discovery
   fourth, while stating the Worker had no unknowns. The riskiest component must
   be validated first.
5. **Streaming.** The original did not address it at all. It is the hardest part
   of the capture logic and it determines the message protocol.
6. **Security.** The original treated "no viewer page exists" as a protection.
   It is not one. §5 replaces that.

## 10. Changes in v2.1

Applied after review of v2 surfaced two problems that would not have worked as
written. Both are now locked decisions in CLAUDE.md; this section is the
record of why.

1. **Room key no longer includes the conversation ID.** v2 derived the room
   key from `secret + conversationId`. Since the extension is required to
   re-key on SPA navigation (§3.1.7), switching conversations pointed it at a
   new, empty Durable Object while the bubble stayed connected to the old one
   — the two surfaces would silently stop talking to each other. The key is
   now `SHA-256(secret)` alone (§5); the active conversation travels over the
   protocol as a `conversation` message instead.
2. **History on attach was unaddressed.** v2's extension responsibilities said
   only to observe the conversation container "for new and changing message
   nodes" — a `MutationObserver` never sees nodes that existed before it
   attached. Opening the bubble on a conversation that already had turns in it
   would have shown an empty history until the next new message. `turn.snapshot`
   (§4) now backfills whatever is already rendered, both on first attach and
   after every conversation switch.
3. Added `conversation` and `turn.snapshot` to the protocol (§4), and folded
   capture health into `status` rather than adding a fourth message type, to
   keep the protocol surface as small as it can be while still fixing (1) and
   (2).
4. Made explicit (§2) that switching conversations replaces the room's stored
   turns rather than merging across conversations — the room mirrors exactly
   one conversation at a time, per the non-goal that was already there in v2.
