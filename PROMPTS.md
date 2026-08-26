# PROMPTS.md

Copy these into Claude Code one at a time, in order. Do not skip ahead — each
one assumes the previous is finished and verified.

Before the first one: open a terminal in VS Code, `cd` into this folder, and run
`claude`.

A note on budget. On the Pro plan you get roughly 10–40 Claude Code prompts every
five hours, shared with your claude.ai usage. Each prompt below will spend
several of those on back-and-forth. Do one phase per sitting rather than trying
to finish in a day.

---

## Phase 0 — Browser console. No Claude Code.

Open `SELECTORS.md` and work through D1 to D6. Fill in the recorded values table.

This is the only phase that cannot be delegated. Claude Code runs in a terminal
and cannot see a web page. If you paste it a guess about a selector, it will
write code against that guess and the code will fail silently.

When the table has real values in it, tick the Phase 0 boxes in `STATUS.md` and
move on.

---

## Prompt 1 — Orientation

```
Read CLAUDE.md, SPEC.md, SELECTORS.md, and STATUS.md in this repo. Do not write
any code yet.

Then tell me, in plain English:

1. A three-sentence summary of what this system does, in your own words.
2. Which of the three components you can build right now, and which are blocked,
   and why.
3. Any place where SPEC.md contradicts itself, is ambiguous, or asks for
   something that will not work. Be specific — quote the section.
4. Anything the spec assumes that you think is wrong.

If you disagree with a locked decision in CLAUDE.md, say so and explain, but do
not change it.
```

Read the answer carefully. If it says something you don't understand, ask it to
explain that one point before moving on. This prompt exists to catch problems
while they are still cheap.

---

## Prompt 2 — Worker scaffold

```
Set up the Cloudflare Worker in worker/. Nothing else yet.

Requirements:
- A single Worker entry point at worker/src/index.js
- One Durable Object class called SessionRoom
- SQLite-backed storage. The wrangler migration MUST use new_sqlite_classes.
  new_classes will not deploy on the Workers Free plan.
- Use the WebSocket Hibernation API, not raw addEventListener on the socket.
- The Worker accepts WebSocket upgrades at /ws?room=<roomKey>&role=<extension|bubble>
- It validates that room is a 64-character hex string and role is one of the two
  allowed values. Reject anything else with HTTP 400 and a clear reason.
- It routes the socket into the SessionRoom instance named by roomKey.
- No protocol logic yet. On receiving any message, just echo it back to the
  sender with a [bubble-worker] log line.

Before you start:
- Tell me what wrangler is and what I will need to install.
- Tell me whether I need a Cloudflare account and whether it costs anything.
- List every command I will need to run and what each one does.

Then write the code, and give me the exact commands to run it locally and
confirm it works.
```

Expect to create a free Cloudflare account during this step.

---

## Prompt 3 — Test client

```
Write a small Node.js script at worker/test-client.js that connects to the
Worker as a WebSocket client.

It should:
- Take the room key and role as command-line arguments
- Connect, send a hello message, and print everything it receives, prefixed with
  the role name
- Let me type JSON messages into the terminal and send them

Then write worker/test-room.js that prints a valid room key I can use for
testing, generated the same way the extension will generate it (SHA-256 of a
the secret alone, hex encoded (SHA-256 of the secret — see SPEC.md §5).

Give me the exact commands to open two terminals, connect one as extension and
one as bubble, and confirm messages relay between them.
```

Two terminal windows, two clients talking to each other. That is the relay
proven, without any browser involved.

---

## Prompt 4 — Protocol

```
Implement the message protocol from SPEC.md section 4 in the SessionRoom
Durable Object.

Specifically:
- Handle hello, prompt, turn.start, turn.delta, turn.end, and status
- Send history to any client immediately after its hello
- Send peers to all clients whenever a client connects or disconnects
- Reject a second extension connection with an error message of code ROLE_TAKEN
- Persist a turn to SQLite ONLY on turn.end. Never on turn.delta.
- Keep at most 200 turns per room, deleting the oldest beyond that
- Drop any message type not in the spec rather than forwarding it
- Enforce a maximum message size and reject anything larger

Explain the storage schema you chose before you write it.

Then update test-client.js so I can exercise each message type easily, and walk
me through a test that proves history persists after both clients disconnect and
reconnect.
```

---

## Prompt 5 — Deploy

```
Deploy the Worker to Cloudflare and confirm it works from the deployed URL, not
just locally.

Before deploying:
- Explain what will be publicly reachable on the internet once this is live
- Confirm nothing sensitive is in any file that gets deployed
- Show me the .gitignore and tell me if anything is missing

After deploying, give me the commands to run the test clients against the
deployed URL. Update STATUS.md.
```

Stop here and check `STATUS.md` says Phase 1 complete before continuing.

---

## Prompt 6 — Bubble

```
The bubble/ folder contains an existing React chat component that currently
calls the Anthropic API directly. Read it and tell me what it does before
changing anything.

Then replace the direct API call with a WebSocket client that speaks the
protocol in SPEC.md section 4.

It must:
- Read the room secret from a local config file (no conversation ID — the
  extension announces it) that is
  gitignored
- Render history on connect
- Render assistant turns progressively as turn.delta messages arrive
- Send prompts optimistically with a promptId, and reconcile on promptId when
  the matching turn comes back — never show the same message twice
- Show three distinct connection states in the UI: connected, relay up but
  extension offline, and disconnected. I must never be left guessing whether it
  is broken.
- Reconnect automatically with backoff when the socket drops

Do not add any other features. Test it against the deployed Worker using
test-client.js acting as the extension.
```

---

## Prompt 7 — Extension. Only after Phase 0 is done.

```
Read SELECTORS.md. If any value in the recorded values table still says UNKNOWN,
stop and tell me which ones — do not write code against a guessed selector.

If they are all filled in, build the Chrome extension in extension/:

- manifest.json, MV3, permissions limited to storage and host access to
  https://claude.ai/*
- The WebSocket lives in the content script, not the background service worker
- On load: read or generate a 32-byte random secret in chrome.storage.local,
  read the conversation ID from the URL, compute the room key, connect
- A popup that displays the secret so I can copy it into the bubble config
- MutationObserver on the conversation container, using the selectors recorded
  in SELECTORS.md and no others
- Emit turn.start, turn.delta, and turn.end per the spec, using the recorded
  completion signal
- Handle incoming prompt messages by injecting text with the recorded working
  technique and submitting with the recorded submit technique
- Tag bubble-originated user turns with origin "bubble" and the matching
  promptId

Build it in that order and let me load and test after each piece. Tell me
exactly how to load an unpacked extension in Chrome and how to see its console
output.
```

---

## When something breaks

Do not describe the symptom in your own words and ask for a fix. Instead:

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
you apply it, something else changes, and now there are two bugs.
