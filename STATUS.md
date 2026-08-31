# STATUS.md

Update this at the end of every working session.

**Current phase:** Extension build (Phase 4) is code-complete. Phase 5
(end-to-end, full-day use) has not been run to completion.
**Architecture:** v3, local only. See SPEC.md §10.
**Last updated:** 2026-08-31, cleanup pass (see git log for what "cleanup
pass" covered — no feature work).

This file is written from the code and the git log, not from memory. If a
checkbox below turns out to be wrong, trust the code over this file and fix
this file.

---

## Superseded

The Cloudflare Worker in `worker/` was built and verified: SQLite-backed Durable
Object, hibernation API, room validation, echo round-trip, and a working test
client. It is no longer part of the design. Kept in the repo in case remote
access is ever wanted. Do not build on it.

---

## What is built and verified

Verified means: an automated test passes, or a commit/SPEC.md note records the
operator confirming it against the real page.

- **Phase 0 — feasibility (2026-08-27).** `ws://localhost` from claude.ai
  works under Chrome's Local Network Access permission. `execCommand('insertText')`
  injection works. `data-perf-row-streaming` flipping to `"false"` is a
  reliable per-turn completion signal. `innerText` preserves code-block
  formatting. All confirmed against the real page.
- **Phase 1 — Electron shell.** Frameless, transparent, always-on-top
  (`'floating'` level + `visibleOnFullScreen`) window built 2026-08-27.
  Hardened 2026-08-28 with crash handling (`uncaughtException`/
  `unhandledRejection` logged, not fatal), single-instance lock, a tray icon
  (recovery route if the window is ever stuck hidden), and `Cmd+Shift+C` to
  toggle visibility. Drag via `-webkit-app-region`, resize grips on all four
  corners.
- **Phase 2 — local server.** `desktop/server.js`: binds `127.0.0.1` only,
  origin allowlist (`https://claude.ai` or `chrome-extension://*`), pairing
  token required (`BAD_TOKEN` otherwise), one extension connection at a time
  (`ROLE_TAKEN` on a second), `MAX_MESSAGE_BYTES` enforced via the `ws`
  library's `maxPayload`. Persists only on `turn.window` and `turn.end` (never
  `turn.delta`), matching SPEC.md's rule. The `conversationId`-on-every-turn-
  message guard (added 2026-08-29 after a real cross-conversation history
  corruption bug — see SPEC.md §4) is covered by
  `desktop/test-conversation-guard.js`, which passes: mismatched turns are
  dropped and logged, and a turn.end with no prior turn.start recovers via its
  own carried `index` instead of being lost.
- **Phase 3 — bubble UI.** `desktop/renderer/app.js`: renders history on
  start, streams deltas progressively, reconciles optimistic sends on
  `promptId`, shows all three health states (connected+capturing,
  connected+capture-broken with the specific reason, extension offline), and
  has a settings panel with token copy/regenerate. IPC-only — the renderer
  never opens a socket. `desktop/renderer/markdown.js` (used for rendering)
  has its own unit suite, `desktop/test-markdown.js` — 22/22 passing,
  including three tests specifically for `javascript:`/`data:`/`file:` URL
  rejection in links.
- **Extension Part A–C — connection, conversation tracking, streaming
  capture.** Built 2026-08-29. Token read from `chrome.storage.local`,
  reconnect with backoff, Local Network Access permission check
  (`navigator.permissions.query`) with a specific message rather than a
  generic connection failure. `turn.window` merges by index, never replaces.
  `turn.delta`/`turn.replace` split (the fix for a duplicate-reply bug
  confirmed 2026-08-28: streaming text is sometimes rewritten, not appended,
  when code-fence rebuilding kicks in).
- **Text extraction.** `extension/content.test.js` — 29 assertions passing
  against a minimal fake-DOM harness (`extension/test-fakedom.js`). Covers
  code-fence rebuilding, accessibility-prefix stripping, timestamp stripping,
  headings/lists/tables/blockquotes/links, and exclusion of the
  MessageActions toolbar (copy button, timestamp, retry counter — one
  container exclusion added 2026-08-31, replacing five earlier
  per-element rules).
- **Conversation-switch correctness (2026-08-29).** `document.title` lagging
  behind a same-tab conversation switch, and a reconnect orphaning an
  in-flight turn's destination conversation, were both real bugs, fixed, and
  documented in SPEC.md §4. The conversationId-guard part of the fix is what
  `test-conversation-guard.js` (above) checks.

---

## What is built but unverified

Code exists and looks complete, but there is no automated test and no noted
operator confirmation against the real page.

- **Retry (`extension/content.js`, `handleRetry`/`withRowInView`/
  `watchRetriedRow`).** Locating a row by index, scrolling it into view if
  virtualized away, clicking the right retry/resend button, and re-sending
  the updated text once streaming settles — all implemented, none of it
  covered by `content.test.js` (which only tests the pure text-extraction
  functions, not DOM interaction).
- **Interrupted-response retry.** A reply the operator or claude.ai stopped
  shows no normal action bar — just an inline notice and two buttons
  distinguished only by their text. This is now documented in SPEC.md's
  `retry` section (added this session) and is **the most fragile selector in
  the project** per SELECTORS.md — untested against a real interrupted
  response since the diagnostic logging that traced its implementation was
  removed in this cleanup pass.
- **History harvest (`handleHistoryRequest`, Part D2).** The estimate-jump-
  then-step algorithm, the `no-progress`/`max-steps`/`aborted-*` stop
  conditions, and the `HISTORY_BUSY` single-flight guard are implemented. The
  concurrent-harvest bug that motivated `HISTORY_BUSY` (2026-08-29, four
  overlapping requests fighting over one scroll position) is understood and
  fixed. The **background-tab case is not** — see Known open bugs, below.
- **Prompt injection from the bubble (Part D1).** `execCommand('insertText')`,
  the streaming/composer-has-text refusals (`PROMPT_BUSY`), and
  `PROMPT_FAILED` reporting are implemented. Not confirmed by an automated
  test or a noted real-page run since Part D1 landed (2026-08-29).
- **SPA navigation / `claude.ai/new`.** `handlePossibleConversationChange`
  handles both an existing-conversation switch and a fresh `/new` →
  `/chat/<id>` transition. Implemented per SPEC.md §3.1 point 8; not
  independently verified in this pass.
- **macOS Local Network privacy prompt.** SPEC.md §8 flags this as untested
  and asks for the result to be recorded once seen. Still not recorded —
  nobody has reported whether Apple's own (distinct from Chrome's) prompt
  ever appeared.
- **Phase 5, end to end, as a whole.** No git history or prior STATUS.md
  entry records the full checklist (bubble → claude.ai → bubble round trip,
  app-switch persistence, tab-close/reopen, quit/relaunch history survival,
  a full working day unattended) having been run start to finish.

---

## Known open bugs

### 1. Background-tab history harvest can stall (open, first reported 2026-08-29)

The harvest indicator showed "20 of 281 loaded" and sat there until the
operator switched to the claude.ai tab and scrolled it by hand — with the
bubble in use, that tab is normally backgrounded, which is exactly when this
needs to work.

Two candidates were identified, not yet distinguished:

1. Chrome throttles background-tab timers and `requestAnimationFrame`, which
   the virtualizer's re-render may depend on.
2. A script-driven `scrollTop` assignment might not produce the same
   downstream effect as real wheel/trackpad input.

2026-08-30 partially addressed candidate 1: the fixed-duration wait was
replaced with `waitForIndicesChange` (`extension/content.js`), which resolves
on an actual DOM change instead of a guessed timeout. **This has not been
confirmed against a genuinely backgrounded tab** — the original diagnostic run
showed `visibilityState=visible` throughout, so candidate 1 was always an
inference. Candidate 2 is untouched.

This cleanup pass removed the verbose per-event diagnostic logging
(`onDiagnosticScroll`, `onDiagnosticVisibility`, per-step elapsed-time/
visibility-state dumps) that was tracing this, per the operator's instruction
to keep only the minimum needed to diagnose it later. What remains: the final
`history: finished — reason=..., steps=..., visibilityState=...` log in
`handleHistoryRequest`'s `finally` block. Reproducing with the claude.ai tab
actually backgrounded and reading that line is the next step; reintroduce
timing/visibility logging around the two `waitForIndicesChange` call sites if
that single line isn't enough to tell the two candidates apart.

### Resolved, kept for context

- **Concurrent harvests fighting over scroll position (2026-08-29).** Fixed by
  `HISTORY_BUSY` — refuse a second `history.request` while one is in flight,
  rather than queueing it. See SPEC.md §4.
- **Cross-conversation history corruption (2026-08-29).** Fixed by adding
  `conversationId` to every turn message and having the server drop a
  mismatch instead of guessing. Covered by `test-conversation-guard.js`.
- **Duplicate replies during streaming (2026-08-28).** Fixed by
  `turn.replace` (full-text overwrite) alongside `turn.delta` (append-only),
  for the case where code-fence rebuilding reshapes already-sent text.

---

## What has not been started

- **Images.** SPEC.md's open question — binary WebSocket frames vs.
  downscaling before base64 (a 4MB phone photo exceeds the 5MB message cap
  once encoded) — is undecided. No code sends or renders images; the
  extension emits `[image]` as a text placeholder only.
- **Auto-launch at login.** Open question in the original plan, no code.
- **Any multi-conversation, account, analytics, or telemetry feature.**
  Explicitly out of scope per CLAUDE.md until the core relay is proven end to
  end.

---

## Open questions carried forward

- How many scroll steps does a full harvest of a genuinely long conversation
  (500+ messages) actually take, and is that an acceptable wait? The
  estimate-jump plus a 40-step hard cap exist, but nobody has recorded a real
  number.
- What happens if the operator resets claude.ai's site permissions mid-session
  (revoking the Local Network Access grant)? The extension's
  `navigator.permissions.query` check (§3.1) should surface this as a specific
  message rather than a generic failure — not independently confirmed.
- Two claude.ai tabs open at once → the second gets `ROLE_TAKEN`. Implemented
  and matches SPEC.md's stated design; not confirmed with two real tabs.

## Decisions made

- Local only, no remote access. Confirmed by operator.
- Electron over Tauri.
- Desktop app owns the pairing token, and only ever logs that one exists —
  never its value (fixed this session; it was previously printed in full on
  every launch and regenerate).
