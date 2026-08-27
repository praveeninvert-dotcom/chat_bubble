# STATUS.md

Update this at the end of every working session.

**Current phase:** 0 COMPLETE. Nothing is blocked.
**Architecture:** v3, local only. See SPEC.md §10.
**Last updated:** pivot from Cloudflare relay to local Electron app

---

## Superseded

The Cloudflare Worker in `worker/` was built and verified: SQLite-backed Durable
Object, hibernation API, room validation, echo round-trip, and a working test
client. It is no longer part of the design. Kept in the repo in case remote
access is ever wanted. Do not build on it.

---

## Phase 0 — Feasibility

- [x] 0a — **DONE 2026-08-27.** `ws://localhost` from claude.ai works. Gated by
      Chrome Local Network Access permission (Chrome 142+), granted for
      claude.ai. Full round trip confirmed against a local `ws` server. Origin
      header is exactly `https://claude.ai`.
- [x] Test 1 — **injection works.** `execCommand('insertText')` places text and
      enables the send button. TipTap accepted it.
- [x] Test 2 — container is `[data-testid="transcript-list"]`, rows are
      `[data-testid="transcript-row"]`, role is `data-perf-row`
- [x] Test 3 — **completion signal found.** `data-perf-row-streaming` flips to
      `"false"` per turn. Better than the send-button approach.
- [x] Test 4 — `innerText` preserves code indentation. Fences must be rebuilt
      from `<pre>`; a11y prefix and trailing timestamp must be stripped.

**Exit criterion:** text can be placed in the composer programmatically and
submitted, a complete assistant reply can be read back, and the browser permits a
localhost socket.

**Result: passed.** Injection works, the completion signal is better than
specified, and formatting survives. No blockers remain.
**Localhost transport:** confirmed working. The socket stays in the content
script as planned.

---

## Phase 1 — Electron shell

- [ ] Electron installed, app launches
- [ ] Frameless transparent window, 380x560
- [ ] Stays on top when switching apps
- [ ] Stays visible when another app goes fullscreen
- [ ] Note whether macOS shows a Local Network privacy prompt
- [ ] Header drags the window; buttons inside it still click
- [ ] Cmd+Shift+C toggles visibility
- [ ] Quits cleanly

---

## Phase 2 — Local server

- [ ] `ws` server on 127.0.0.1:8787, not 0.0.0.0
- [ ] Origin **allowlist**: accept only `https://claude.ai` and
      `chrome-extension://*`, reject everything else including `null`
- [ ] Pairing token generated, stored, required on connect
- [ ] Full protocol from SPEC.md §4 implemented
- [ ] One extension connection; ROLE_TAKEN on a second (claude.ai in two tabs)
- [ ] JSON persistence on turn.end and turn.snapshot only
- [ ] turn.snapshot replaces rather than appends
- [ ] One test client as the extension; messages reach the renderer over IPC

---

## Phase 3 — Bubble UI

- [ ] Existing React component rendering in the Electron window
- [ ] IPC bridge; renderer never opens a WebSocket (see SPEC.md §4 note)
- [ ] History renders on start
- [ ] Deltas render progressively
- [ ] Optimistic send with promptId reconciliation, no duplicates
- [ ] Three health states visible
- [ ] Settings panel with token copy and regenerate

---

## Phase 4 — Extension

Unblocked — Phase 0 passed 2026-08-27.

- [ ] manifest.json, loads unpacked without errors
- [ ] Options page accepts the pairing token
- [ ] Content script connects to the local server
- [ ] Backfill of already-rendered turns
- [ ] MutationObserver captures user turns
- [ ] Assistant turns captured with deltas and a correct turn.end
- [ ] Markdown reconstruction from message DOM
- [ ] Injection and submit working from a relayed prompt
- [ ] origin and promptId tagging correct, no duplicates
- [ ] SPA navigation detected, conversation message sent
- [ ] claude.ai/new handled
- [ ] capture health reported and visible in the bubble

---

## Phase 5 — End to end

- [ ] Type in the bubble, message appears in claude.ai and sends
- [ ] Reply streams into the bubble
- [ ] Type in claude.ai, message appears in the bubble
- [ ] Switch to another app — bubble stays visible and usable
- [ ] Close the claude.ai tab — bubble shows extension offline
- [ ] Reopen — reconnects, history intact
- [ ] Quit and relaunch the desktop app — history survives
- [ ] Run for a full working day without intervention

---

## Open questions

- Does the send-button state change reliably signal completion during tool use?
- Does the assistant message node carry its own streaming attribute? Check in
  Test 3.
- Should the bubble auto-launch at login?
- What happens if the operator resets claude.ai site permissions? The Local
  Network Access grant is lost and the extension must say so clearly.
- What happens if claude.ai is open in two tabs at once? Two extension
  connections, one rejected — is that the right behaviour?

## Decisions made

- Local only, no remote access. Confirmed by operator.
- Electron over Tauri.
- Desktop app owns the pairing token.