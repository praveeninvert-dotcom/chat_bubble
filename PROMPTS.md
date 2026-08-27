# PROMPTS.md

Copy these into Claude Code one at a time, in order. Each assumes the previous is
finished and verified.

Open a terminal in VS Code, `cd` into this folder, run `claude`.

On the Pro plan you get roughly 10–40 Claude Code prompts every five hours,
shared with your claude.ai usage. Each prompt below spends several on
back-and-forth. One phase per sitting.

---

## Phase 0 — Browser console. No Claude Code.

Two things, both in claude.ai DevTools. Neither can be delegated: Claude Code
runs in a terminal and cannot see a web page.

**0a — Can Chrome open a localhost socket from claude.ai?**

```js
const ws = new WebSocket('ws://localhost:8787');
ws.onerror = () => console.log('ERROR fired — read the red text above');
ws.onopen  = () => console.log('opened');
```

Nothing is listening, so it fails. What matters is how. `ERR_CONNECTION_REFUSED`
means Chrome allowed the attempt — the architecture works. "Mixed Content" means
Chrome blocked it and the socket has to move into the background service worker.

**0b — Fill in SELECTORS.md Tests 1 through 4.** Run them on a real conversation
at `claude.ai/chat/<id>`, not on `/new`, with Grammarly and QuillBot disabled.

---

## Prompt 1 — Orientation

```
Read CLAUDE.md, SPEC.md, SELECTORS.md, and STATUS.md. Do not write any code.

The architecture changed in SPEC.md v3: the Cloudflare Worker is gone, replaced
by a local Electron app that is both the WebSocket server and the bubble UI.
worker/ is dead code kept for reference.

Tell me, in plain English:
1. A three-sentence summary of the v3 system in your own words.
2. What you can build now and what is blocked, and why.
3. Anywhere SPEC.md contradicts itself or asks for something that will not work.
   Quote the section.
4. Anything the spec assumes that you think is wrong, especially about Electron
   on macOS.

If you disagree with a locked decision in CLAUDE.md, say so and explain, but do
not change it.
```

---

## Prompt 2 — Electron shell

```
Create the Electron app in desktop/. Window only — no WebSocket server yet, no
chat UI.

Requirements:
- Electron main process, preload script with contextIsolation, and a renderer
  showing a placeholder panel
- Frameless, transparent, resizable BrowserWindow, 380x560
- setAlwaysOnTop(true, 'floating')
- setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
- A draggable header strip using -webkit-app-region: drag, with no-drag on any
  button inside it
- A global shortcut Cmd+Shift+C that toggles show/hide
- Quit cleanly from the menu or Cmd+Q

Before you start, tell me what Electron is, what it installs, and roughly how
large the install is.

Then give me the exact commands to run it, and tell me what to look for: the
window should stay visible when I switch to another app and when an app goes
fullscreen.
```

Test the fullscreen behaviour yourself. That is the requirement that made this a
desktop app rather than a web page, and it is the one most likely to be subtly
wrong.

---

## Prompt 3 — Local server and protocol

```
Add the WebSocket server to the Electron main process in desktop/.

Requirements:
- ws package, listening on 127.0.0.1 port 8787. Never 0.0.0.0.
- Reject any upgrade whose Origin header is not https://claude.ai or a
  chrome-extension:// origin
- Require a token query parameter matching a 32-byte token the app generates on
  first run and stores in app.getPath('userData')
- Implement the full protocol in SPEC.md section 4: hello, conversation,
  turn.snapshot, prompt, turn.start, turn.delta, turn.end, status, and the
  server-to-client history, peers, and error messages
- One connection per role; reject a second with ROLE_TAKEN
- Persist to a JSON file in userData on turn.end and turn.snapshot only, never
  on turn.delta
- turn.snapshot replaces stored turns for that conversation, it does not append
- Drop unrecognised message types rather than forwarding them
- Enforce a maximum message size

Explain the JSON file structure before you write it.

Then write desktop/test-client.js: a Node script taking a role and token as
arguments, connecting, printing everything it receives, and sending JSON I type.

Give me commands to run two of them — one as extension, one as bubble — and
confirm a message typed in one appears in the other. That cross-forwarding is
the point of this prompt.
```

Unlike the old Prompt 3, this one **should** relay between terminals. If it does
not, the protocol is broken.

---

## Prompt 4 — Bubble UI

```
The bubble/ folder has a React chat component. Read it and tell me what it does
before changing anything.

Wire it into the Electron renderer:
- Renderer talks to the main process over contextBridge IPC. It never opens a
  socket itself.
- Render history on start; clear and re-render on a conversation change
- Render assistant turns progressively as turn.delta arrives
- Send prompts optimistically with a promptId, reconcile on promptId when the
  matching turn returns. Never show a message twice.
- Show three health states clearly: extension connected and capturing, extension
  connected but capture broken, extension offline
- A settings panel showing the pairing token with a copy button and a regenerate
  action

Test against desktop/test-client.js acting as the extension. Do not add any
other features.
```

---

## Prompt 5 — Extension. Only after Phase 0 is complete.

```
Read SELECTORS.md. If any value in the recorded values table still says UNKNOWN,
stop and tell me which — do not write code against a guessed selector.

If they are filled in, build the Chrome extension in extension/:
- manifest.json, MV3, permissions limited to storage and https://claude.ai/*
- An options page where I paste the pairing token from the desktop app
- The WebSocket lives in the content script, connecting to
  ws://127.0.0.1:8787/?role=extension&token=<token>
- Reconnect with backoff; the desktop app may not be running
- Backfill already-rendered turns as turn.snapshot on attach
- MutationObserver using only the selectors recorded in SELECTORS.md
- Emit turn.start, turn.delta, turn.end using the recorded completion signal
- Inject prompts with the recorded working technique, submit with the recorded
  submit technique
- Tag bubble-originated user turns with origin "bubble" and the matching promptId
- Report capture health in the status message
- Handle claude.ai/new, which has no conversation ID until the first message

Build in that order and let me load and test after each piece. Tell me exactly
how to load an unpacked extension in Chrome and how to see its console output.
```

---

## When something breaks

```
Something is broken. Here is exactly what I did, what I expected, and what
happened:

WHAT I RAN:
[paste the command or describe the click]

WHAT I EXPECTED:
[one sentence]

WHAT HAPPENED:
[paste the full output, including any red error text]

Do not guess at the cause. Tell me what to run next to narrow it down.
```

The last line matters. Without it you get a plausible fix for the wrong problem,
you apply it, and now there are two bugs.