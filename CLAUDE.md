# CLAUDE.md

Read this at the start of every session. Read `SPEC.md` before writing any code.
Read `STATUS.md` to find out where the build actually is.

---

## What this project is

A personal bridge that lets one person drive one of their own claude.ai
conversations from a floating chat bubble embedded on a different website.

A Chrome extension runs on claude.ai, reads conversation turns out of the page,
and relays them through a Cloudflare Worker to the bubble. Prompts typed in the
bubble travel back down the same relay and get typed into the claude.ai composer
by the extension.

**Personal tool. Single user. Not multiplayer, not published, not a product.**
If a request implies multiple users, shared links, or distribution, stop and
flag it rather than designing for it.

---

## Who you are working with

The operator is **not a programmer**. They can copy commands, paste output, read
plain English, and use a browser. They cannot review your code for correctness.

This changes how you work:

- Explain what you are about to do in plain language **before** doing it.
- After each change, say what to run to verify it and what a good result looks like.
- Never say "you probably know this" or skip a step because it is obvious.
- Prefer fewer moving parts over elegant abstractions. Boring code wins.
- Ask before installing any dependency. Justify it in one sentence.
- If something fails, give the operator an exact command to run and ask them to
  paste the full output back. Do not guess.

---

## Repo layout

```
claude-bubble/
├── CLAUDE.md        this file
├── SPEC.md          architecture, message protocol, security model
├── SELECTORS.md     DOM facts about claude.ai — mostly UNKNOWN, see below
├── STATUS.md        build phases and what is done
├── PROMPTS.md       the operator's step-by-step prompts for you
├── extension/       Chrome MV3 extension (vanilla JS, no build step)
├── worker/          Cloudflare Worker + Durable Object
└── bubble/          React chat bubble (already exists, needs rewiring)
```

---

## Locked decisions — do not relitigate these

| Decision | Value | Why |
|---|---|---|
| Durable Object storage | **SQLite-backed** (`new_sqlite_classes` in migrations) | The Workers Free plan can only create SQLite-backed DOs. `new_classes` will fail to deploy. |
| WebSocket location in extension | **Content script**, not the background service worker | MV3 service workers are killed when idle and will drop the socket. |
| Room key | `SHA-256(secret)` where `secret` is a 32-byte random value in `chrome.storage.local` | The conversation UUID is not a secret and must not be the key. It is also not part of the key: including it broke conversation switching. The extension announces the active conversation over the protocol instead. |
| History on attach | Backfill the existing DOM with `turn.snapshot`, replacing stored turns | MutationObserver does not fire for nodes that already exist. |
| Response capture | **Streaming deltas** with an authoritative final message on completion | The bubble is specified to mirror in real time. See the protocol in SPEC.md. |
| Persistence writes | Only on `turn.end`, never on `turn.delta` | Free tier allows 100,000 row writes/day. Deltas would burn that in one session. |
| Text injection | `execCommand('insertText')` or synthetic paste — **not** setting `textContent` | The composer is a rich-text editor with internal state. Direct DOM writes get discarded. |

---

## Hard rules

1. **Never invent a CSS selector or `data-testid` value.** If `SELECTORS.md` says
   `UNKNOWN`, the code cannot be written yet. Say so and stop. Do not write a
   plausible-looking placeholder that will silently fail.
2. **Never transport authentication material.** The claude.ai session cookie,
   `sessionKey`, org ID, and any bearer token must never enter the WebSocket,
   the Worker, the Durable Object, or the bubble. The relay carries message text
   and IDs only.
3. **Never call the Anthropic API from the extension or the Worker.** This
   project deliberately has no API key. If a task seems to need one, the design
   is wrong — flag it.
4. **No secrets in committed files.** The room secret lives in
   `chrome.storage.local` and is pasted into the bubble by hand.
5. **The bubble host page must not be publicly readable.** The room secret ends
   up in client-side JavaScript there. If the operator says they want it on a
   public site, stop and explain the consequence.
6. **Do not add features.** No auth systems, no user accounts, no analytics, no
   telemetry, no multi-conversation support until STATUS.md says the core relay
   works end to end.

---

## Conventions

- Vanilla JS in `extension/`. No bundler, no TypeScript, no npm dependencies.
- The Worker may use `wrangler` and nothing else unless justified.
- Every WebSocket message is JSON with a `type` field. See SPEC.md §4.
- Log liberally during development, prefixed `[bubble-ext]`, `[bubble-worker]`,
  `[bubble-ui]` so the operator can tell which component spoke.
- Commit after each working phase. Write the commit message yourself.

---

## Current blocker

The extension cannot be built until `SELECTORS.md` is filled in. That requires
the operator to open claude.ai DevTools and run the discovery commands listed in
that file. Nothing in `extension/` should be written before then.

Work on `worker/` and `bubble/` is unblocked.