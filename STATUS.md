# STATUS.md

Update this at the end of every working session. Claude Code reads it to find
out where things stand.

**Current phase:** 0 — DOM feasibility not yet tested. Phase 1 (Worker) underway.
**Last updated:** SPEC.md brought to v2.1 and Worker scaffolded (Prompt 2) — see Phase 1 below.

---

## Phase 0 — Prove injection works

No code. Browser console only. Everything downstream depends on this.

- [ ] D1 run, composer selector recorded in SELECTORS.md
- [ ] D2 or D2b run, text successfully inserted into the composer
- [ ] Send button confirmed to activate after injection
- [ ] D3 run, send/stop button state change identified
- [ ] D4 and D5 run, message and container selectors recorded
- [ ] D6 run, code block formatting behaviour recorded

**Exit criterion:** text can be placed in the composer programmatically and
submitted, and a complete assistant reply can be read back.

**If this phase fails:** the project does not work as designed. Stop and
reconsider before building anything.

---

## Phase 1 — Relay

- [ ] Cloudflare account created, `wrangler` installed and logged in (installed locally; no account/login needed until deploy)
- [x] Worker scaffolded with a SQLite-backed Durable Object
- [x] WebSocket upgrade handled, room routing works (validated: bad room/role → 400, good request → 101, verified against a running local instance)
- [ ] Protocol from SPEC.md §4 implemented, including `conversation` and `turn.snapshot`
- [ ] History persisted on `turn.end` only
- [ ] Tested locally with two terminal clients — one as extension, one as bubble
- [ ] Deployed to `*.workers.dev`, tested against the deployed URL

---

## Phase 2 — Bubble

- [ ] Direct API call removed
- [ ] WebSocket client wired in
- [ ] History renders on connect
- [ ] Streaming deltas render progressively
- [ ] Optimistic send with `promptId` reconciliation
- [ ] Connection state visible: connected / extension offline / disconnected
- [ ] Tested against the deployed Worker using a fake extension client

---

## Phase 3 — Extension

Blocked until Phase 0 is complete.

- [ ] `manifest.json` written, extension loads unpacked without errors
- [ ] Room secret generated and stored, popup displays it
- [ ] Content script connects to the Worker
- [ ] Backfill of already-rendered turns on attach (`turn.snapshot`)
- [ ] MutationObserver captures user turns
- [ ] Assistant turns captured with deltas and a correct `turn.end`
- [ ] Markdown reconstruction from message DOM
- [ ] Prompt injection and submit working from a relayed message
- [ ] `origin` and `promptId` tagging correct — no duplicate messages
- [ ] SPA navigation detected, `conversation` message sent, bubble re-renders
- [ ] `capture` health reported, and a broken selector shows in the bubble

---

## Phase 4 — End to end

- [ ] Type in the bubble, message appears in claude.ai and sends
- [ ] Claude's reply streams into the bubble
- [ ] Type in claude.ai, message appears in the bubble
- [ ] Close the claude.ai tab — bubble shows extension offline
- [ ] Reopen the tab — bubble reconnects and history is intact
- [ ] Run for a full working day without intervention

---

## Open questions

- Does the send-button state change reliably signal completion during tool use?
- Does the assistant message node carry its own streaming attribute? Check in D3.
- Where does the existing React bubble component live? It is not in this repo yet.
- How much Markdown reconstruction is needed before the bubble reads acceptably?
- Where will the bubble be hosted, and is that page private?

## Decisions still to make

- Bubble host: localhost during development. Production host undecided.
- History retention: 200 turns per room, subject to revision.