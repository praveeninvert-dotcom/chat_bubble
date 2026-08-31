# SELECTORS.md

Facts about the claude.ai DOM. **Every value here must be observed, never
guessed.** Claude Code cannot fill this file in — it runs in a terminal and
cannot see a web page.

Until the UNKNOWN entries below are filled in, no code in `extension/` can be
written.

---

## How to fill this in

1. Open `https://claude.ai` in Chrome and open any conversation with at least
   one Claude reply in it.
2. Press `F12` (Windows) or `Cmd+Option+J` (Mac). Click the **Console** tab.
3. If Chrome warns you about pasting, type `allow pasting` and press Enter.
4. Run each command below and paste its output into the matching slot.

---

## Discovery commands

### D1 — the composer

```js
document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => {
  console.log(i, el.tagName, [...el.attributes].map(a => `${a.name}="${a.value}"`).join(' '));
});
```

Look for an entry with a `data-testid` attribute. Class names change between
deploys; `data-testid` values usually survive.

### D2 — can text be inserted

```js
const box = document.querySelector('[contenteditable="true"]');
box.focus();
document.execCommand('insertText', false, 'test injection');
```

Record two things: whether the text appeared in the box, and whether the send
button became active the way it does when you type by hand.

If the text appeared but the button stayed inactive, try D2b.

### D2b — fallback injection via synthetic paste

```js
const box = document.querySelector('[contenteditable="true"]');
box.focus();
const dt = new DataTransfer();
dt.setData('text/plain', 'test injection two');
box.dispatchEvent(new ClipboardEvent('paste', {
  clipboardData: dt, bubbles: true, cancelable: true
}));
```

### D3 — the send and stop buttons

Type something by hand into the composer, then run:

```js
document.querySelectorAll('button').forEach((b, i) => {
  const t = [...b.attributes].map(a => `${a.name}="${a.value}"`).join(' ');
  if (t.includes('send') || t.includes('submit') || b.getAttribute('aria-label')) {
    console.log(i, b.getAttribute('aria-label'), t.slice(0, 200));
  }
});
```

Then send a message and, **while Claude is still typing**, run the same command
again. The button that changes between the two runs is the send/stop control.
That state change is the completion signal.

### D4 — message turns

```js
const nodes = document.querySelectorAll('[data-testid]');
const seen = {};
nodes.forEach(n => {
  const t = n.getAttribute('data-testid');
  seen[t] = (seen[t] || 0) + 1;
});
console.log(seen);
```

Look for testids that appear once per message. Then inspect one directly:

```js
const el = document.querySelector('PUT_A_TESTID_HERE');
console.log(el.outerHTML.slice(0, 1500));
```

### D5 — the conversation container

Right-click on any message, choose **Inspect**. In the Elements panel, walk up
the tree until you find the element that contains every message and nothing
else. Right-click it, choose **Copy → Copy selector**, and paste that here.

That element is what the MutationObserver watches.

### D6 — does a code block survive textContent

Ask Claude for a short code sample first, then:

```js
const msgs = document.querySelectorAll('PUT_ASSISTANT_TESTID_HERE');
console.log(JSON.stringify(msgs[msgs.length - 1].textContent.slice(0, 400)));
```

Check whether newlines and indentation are present in the output.

---

## Recorded values — ALL CONFIRMED 2026-08-27

### Composer and sending

| Fact | Value |
|---|---|
| Composer | `[data-testid="chat-input"]` |
| Composer type | `div[contenteditable="true"][role="textbox"]`, class `tiptap ProseMirror` |
| Send button | `[data-testid="chat-input-send"]` |
| Send button state | `disabled === true` when composer empty, `false` when it has content |
| Attach button | `[data-testid="chat-input-attach"]` |
| Model selector | `[data-testid="model-selector-dropdown"]` |

### Injection — WORKS

| Technique | Result |
|---|---|
| `execCommand('insertText', false, text)` | **Works.** Returns `true`, text appears, send button enables. **Use this.** |
| Synthetic `paste` with `DataTransfer` | Also works. `dispatchEvent` returns `false` because ProseMirror calls `preventDefault` — that indicates the editor handled it. Keep as a backup if `execCommand` is ever removed. |
| Setting `textContent` / `innerText` | Not tested, not to be used. TipTap holds internal document state. |

Clearing the composer: `execCommand('selectAll')` then `execCommand('delete')`.

That the send button flips to `disabled: false` is the proof that matters — it
means TipTap accepted the text into its document model rather than the characters
merely being painted on screen.

### Conversation structure

| Fact | Value |
|---|---|
| Conversation container | `[data-testid="transcript-list"]` — observe this |
| Message row | `[data-testid="transcript-row"]` — one per turn |
| Role | `data-perf-row="human"` or `data-perf-row="assistant"` on the row |
| Ordering | `data-index="0"`, `1`, `2`... on the row |
| Newest turn | `data-last-message="true"` on the row |
| Distance from end | `data-perf-row-from-tail="0"` on the newest |
| User message body | `[data-testid="user-message"]` inside a human row |
| Assistant message body | No dedicated testid. Use `[data-perf-row="assistant"]` on the row. |
| Accessible label | `aria-label="Message 3 of 8"` on the row's first child |

### Streaming and completion — CONFIRMED

`data-perf-row-streaming` on the row is `"true"` during generation and flips to
`"false"` when that turn completes.

This is **per-turn**, not global. It identifies which message finished, so a pause
during tool use cannot be misread as completion. Better than the send-button
approach originally specified.

Watch for it with:

```js
observer.observe(document.querySelector('[data-testid="transcript-list"]'), {
  attributes: true, subtree: true,
  attributeFilter: ['data-perf-row-streaming', 'data-last-message']
});
```

The `turn.end` trigger is a mutation where `data-perf-row-streaming` becomes
`"false"` on a row with `data-perf-row="assistant"`.

Note: only the flip to `"false"` was observed. The flip to `"true"` was not, most
likely because the row is created with the attribute already set — attribute
mutations fire, initial values on newly inserted nodes do not. Detect turn start
from node insertion, not from this attribute.

### Text extraction — mostly good

`innerText` on an assistant row **preserves code block newlines and
indentation.** Confirmed: `def reverse_string(s):\n    return s[::-1]` came
through with its four-space indent intact. Section 7 of SPEC.md is much smaller
than budgeted.

Three cleanups are required:

1. **Code fences are missing.** The language label appears as a bare line
   (`python`) with no backticks. Find `<pre>` elements in the row and wrap their
   content in a fenced block, using the label as the language.
2. **Strip the accessibility prefix.** Rows begin `"Claude responded: "` or
   `"You said: "`, followed by a duplicate of the first fragment of the message.
3. **Strip the trailing timestamp.** `"just now"`, `"5 days ago"` and similar
   appear at the end of the row text.

Raw sample for reference:

```
"Claude responded: That's it.\n\npython\ndef reverse_string(s):\n    return s[::-1]\n\nThat's it. Python's slice syntax with -1 step walks the string backwards.\n\n\npython\nreverse_string(\"hello\")  # \"olleh\"\n\n\n\n\n\njust now"
```

### Virtualization — CONFIRMED 2026-08-27

The transcript renders only rows near the viewport. Measured on a 142-message
conversation: **6 rows in the DOM**, indices 136–141.

| Fact | Value |
|---|---|
| Scroll container | Nearest ancestor of `[data-testid="transcript-list"]` with `overflow-y: auto` and real overflow. Class was `overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]` — **do not hardcode**, walk up and test computed style. |
| True row index | `data-index` on the row. Stable and authoritative. |
| Total message count | Parse from `aria-label="Message 137 of 142"` on the row's first child. |
| Harvesting works | `scroller.scrollTop = 0` renders index 0 after ~1200ms. Restoring `scrollTop` returns to position. |
| One jump is not enough | Top gives 0–5, bottom gives 136–141. Middle indices need intermediate scroll steps. |
| Sentinel stays mounted | The highest index remains in the DOM even when scrolled to the top (`last-message-sentinel`). Do not use its presence as a position check. |

Measured sequence:

```
BEFORE            count: 6  range: 136-141
AFTER scrollTop=0 count: 7  range: 0-141
RESTORED                    range: 131-141
```

### MessageActions toolbar container — CONFIRMED 2026-08-31

**The structural fix for a class of bug hit five separate times.** The
sr-only heading, the action buttons, the timestamp, tool-status pills, and
the "N / N" retry counter were each found individually — the operator
spotting one fresh leak in the bubble at a time, over several days — and
each was patched with its own selector before this one was found. Three of
those five (action buttons, timestamp, retry counter) turned out to all live
inside a single container:

```html
<div data-cds="MessageActions" data-reveal="fade" role="toolbar"
     aria-label="Message actions" data-size="xs" tabindex="-1"
     class="flex items-center select-none ...">
  <!-- copy / retry / thumbs / read-aloud buttons, the timestamp, the
       retry-variant counter -->
</div>
```

Found via a discovery script (operator, 2026-08-31) that located the common
ancestor of the retry button and the retry counter and confirmed it holds
**only** the toolbar: the container's own text content was 19 characters
(all whitespace plus the timestamp) against 204 for the whole row.

| Fact | Value |
|---|---|
| MessageActions toolbar container | `[data-cds="MessageActions"]`, or `[role="toolbar"][aria-label="Message actions"]` as an independent fallback |

Three stable, non-styling attributes confirmed on it: `data-cds`, `role`,
and `aria-label`. No Tailwind classes involved. extension/content.js's
`MESSAGE_ACTIONS_SELECTOR` combines both forms (comma-separated) so either
surviving a redesign alone still works — they're unrelated attributes (a11y
role/label vs. an internal component tag), not two names for the same fact,
so one styling pass dropping both at once is unlikely.

This one container selector **replaces** three former per-element rules,
which are deleted from content.js and no longer documented as separate
fragile entries:

| Subsumed rule | Former value |
|---|---|
| Action buttons (copy/retry/thumbs-up/thumbs-down/read-aloud, user-message-retry/edit/copy) | `EXCLUDED_CONTROL_SELECTORS`, eight `[data-testid="..."]` selectors |
| Relative timestamp | `TIMESTAMP_SELECTOR`, `time[data-cds="RelativeTime"]` (markup itself unchanged — see below) |
| Retry-variant ("N / N") counter | `RETRY_COUNTER_*`, a three-part class fingerprint — **was the fragile, CLASS-MATCH-ONLY rule**; now covered by the container instead |

Because exclusion works by adding the matched element to a skip set the DOM
walk checks by identity before recursing (see `collectExclusions` in
content.js), skipping the container skips everything inside it in one step
— including whatever renders in this toolbar *next*, without needing to be
spotted and patched individually the way the previous five were.

Two exclusions were checked and are explicitly **not** subsumed, since they
were confirmed to sit outside this container (kept as their own selectors):

- `h2.sr-only` (the accessibility-preview heading) — sits over the whole
  row, not inside the toolbar.
- The interrupted-response "Try again" button, below — an interrupted reply
  doesn't render this toolbar at all, so it was never a candidate.

Two more were **not verified either way** and are kept as their own
selectors defensively rather than assumed subsumed:

- The tool-status pill/spark/caret — the operator's original report placed
  this in the message body, not the toolbar, but that was never
  independently re-checked with the same rigor as this discovery.
- Icon glyphs (`span[data-cds="Icon"]`) — likely appear both inside the
  toolbar's own buttons and possibly elsewhere in message content; keeping
  the selector is a no-op where it's redundant with the container and
  necessary anywhere it isn't.

`action-bar-retry` and `user-message-retry` `data-testid`s are still used
directly (not via the deleted `EXCLUDED_CONTROL_SELECTORS` constant) by
`handleRetry()`'s row lookup to actually click retry — see SPEC.md §4's
`retry` message. That lookup is unaffected by this change. Whether these two
elements are always present in the DOM (just hidden via opacity until
hover, like the code-block copy button below) or only rendered once the row
is hovered/focused is unconfirmed — `handleRetry` calls `.click()` on
whatever `row.querySelector(selector)` finds, which works either way as
long as the element exists at all; if it's ever genuinely absent until a
real pointer hover, retry would report `RETRY_FAILED` for a row that DOM
inspection would show the button on.

### Interrupted-response "Try again" button — CONFIRMED 2026-08-29, TEXT MATCH ONLY

**The most fragile selector in this project. If retry mysteriously stops
working on interrupted responses, check here first** — it breaks on a
wording change and breaks entirely for an operator running claude.ai in
another language, unlike everything else in this file.

An interrupted assistant reply doesn't render the normal action bar at all.
Instead the row shows an inline notice reading "Claude's response was
interrupted." with two buttons:

```
0 "Edit prompt"  type="button" data-cds="Button" class="cds-reset group/btn ..."
1 "Try again"    type="button" data-cds="Button" class="cds-reset group/btn ..."
```

Console discovery output (operator, 2026-08-29): **no `data-testid`, no
`aria-label`, no distinguishing attribute of any kind on either button** —
`data-cds="Button"` and the class list are identical between them. The only
thing telling them apart is their visible text.

| Fact | Value |
|---|---|
| Interrupted-response notice text (used to detect the case) | `"response was interrupted"` (matched lowercase, substring) |
| "Try again" button (used to click it) | button inside the row whose trimmed `textContent` is exactly `"Try again"` |

`extension/content.js`'s `handleRetry()` applies this as defensively as the
signal allows: the exact-text match is scoped to a row already confirmed to
contain the interrupted notice, and is only ever acted on when it yields
**exactly one** match. Zero matches (wording changed) or two (should never
happen) both report an error and click nothing — retry never falls back to
clicking "Edit prompt", since that would put the page into an edit state the
operator didn't ask for.

### Retry-variant counter ("N / N") — RESOLVED 2026-08-31

Was its own CLASS-MATCH-ONLY rule (same fragility tier as "Try again"
above) for one day. Now covered by the MessageActions toolbar container
above — the counter lives inside it, so no separate selector is needed any
more. See that section for what replaced it.

### Trailing timestamp element — CONFIRMED 2026-08-28, now covered by the MessageActions container

Excluded as part of the MessageActions toolbar (above) rather than by its
own selector — `TIMESTAMP_SELECTOR` is deleted from content.js. The
element's own markup is recorded here for reference, since knowing what it
looks like still matters (e.g. for `TRAILING_TIMESTAMP_RE`, the text-pattern
fallback in `cleanText()` for the case this element or its container isn't
found):

```html
<time data-cds="RelativeTime" datetime="2026-08-22T16:40:53.683Z"
      class="flex h-control items-center ps-sm pe-sm first:ps-0 last:pe-0
             text-caption text-muted select-none">6 days ago</time>
```

| Fact | Value |
|---|---|
| Timestamp element (for reference — not queried directly any more) | `time[data-cds="RelativeTime"]` |

The old text-pattern regex (matching `"just now"` / `"N <unit> ago"` at the
end of the string) stays in `cleanText()` as a fallback only, in case the
element or its MessageActions container is ever renamed or missing.

### Tool/MCP status UI — CONFIRMED 2026-08-28

Reported directly by the operator during testing (a stray "V" and
"Connecting to visualize..." leaking into message text), not yet
independently re-verified by a discovery command.

| Fact | Value |
|---|---|
| Status pill (container) | `[data-testid="tool-status-pill"]` |
| Status icon | `[data-testid="tool-status-spark"]` |
| Expand caret | `[data-testid="tool-status-caret"]` |

Nesting relationship (is spark/caret always inside the pill, or can they
appear standalone?) is unconfirmed — extension/content.js excludes all three
independently to be safe.

Per SPEC.md §7, tool use renders as a fixed `[tool]` placeholder rather than
being silently dropped or having its status text extracted — see the comment
above `TOOL_STATUS_PILL_SELECTOR` in content.js for why a fixed placeholder
was chosen over attempting `[searched: <query>]`.

### Accessibility preview element — CONFIRMED 2026-08-28

```html
<h2 data-find-omitted="" class="sr-only select-none">You said: is there a way
in which I can see all the API call made in a page</h2>
```

| Fact | Value |
|---|---|
| Accessibility preview element | `h2.sr-only` (scoped to inside the row — `.sr-only` alone is a generic utility class that may be reused elsewhere) |

This single element holds both the "Claude responded: " / "You said: "
prefix and the preview that follows it — sometimes a truncated exact copy of
the real message, sometimes a paraphrase (e.g. "Requestly for logging API
calls — straightforward setup:" as the preview vs. "Here's how to use
Requestly for logging API calls:" as the real opening). Because it can be a
paraphrase, no text-comparison approach could reliably strip it — excluding
this element by selector, the same way as the action-bar controls and the
timestamp, is the real fix. extension/content.js now does this;
`stripAccessibilityDuplicate()`'s old paragraph-break/duplicate-detection
heuristic was removed and replaced with a plain prefix-strip kept only as a
fallback for the case this element isn't found.

### Icon glyphs — CONFIRMED 2026-08-28

```html
<span data-cds="Icon" aria-hidden="true"
      style="font-family: var(--font-anthropicons, Anthropicons-Variable); ...">
```

| Fact | Value |
|---|---|
| Icon glyph span | `span[data-cds="Icon"]` |

Private-use icon font (Anthropicons). Renders as striped boxes anywhere
outside claude.ai's own font — pure UI chrome, hidden silently by
extension/content.js.

### Code-block copy button — CONFIRMED 2026-08-28 (selector chosen, not observed directly)

```html
<div class="sticky opacity-0 group-hover/copy:opacity-100 ... float-right">
  <!-- copy button -->
</div>
```

The operator found no stable attribute on the wrapper itself — only
Tailwind utility classes, which are explicitly excluded as a selector
target (first thing to change on a styling pass).

| Fact | Value |
|---|---|
| Copy button (inside a code block) | `pre button` |

Chosen over targeting the wrapper div: any `<button>` living inside a
`<pre>` is UI chrome by construction — code shown in a `<pre>` is
text/syntax-highlighting spans, never an interactive button, so this
selector can't wrongly exclude real code content. Scoped semantically
(role/structure) rather than by styling, per the operator's instruction.

### Content placeholders — SPEC.md §7

| Structure | Selector | Status |
|---|---|---|
| Tool/MCP status pill | `[data-testid="tool-status-pill"]` (+ `-spark`, `-caret`) | CONFIRMED 2026-08-28, see above |
| Image | `img` | **ASSUMED**, not confirmed — standard HTML semantics, not a guessed claude.ai class |
| Artifact panel | — | **UNKNOWN** |
| Extended thinking | — | **UNKNOWN** |

extension/content.js implements `[tool]` and `[image]` (the pill and any
`img` in the row are hidden and replaced with a placeholder `<span>` at the
same position). Artifact and extended-thinking placeholders are not
implemented — no selector exists to build them on, and guessing one is
exactly what SELECTORS.md/CLAUDE.md's hard rules rule out.

To find them: open a conversation containing an artifact (or one where
extended thinking is visible), then in the console on the relevant row:

```js
(() => {
  const rows = document.querySelectorAll('[data-testid="transcript-row"][data-perf-row="assistant"]');
  const row = rows[rows.length - 1];
  const testids = new Set();
  row.querySelectorAll('[data-testid]').forEach((el) => testids.add(el.getAttribute('data-testid')));
  console.log([...testids]);
})();
```

Run once on a row with an artifact and once on a row with visible extended
thinking; paste back both testid lists (or just the ones that look new).
For the artifact panel, also note where its title text lives, since the
placeholder needs to read `[artifact: <title>]`.

### Still to observe

These were not part of Phase 0 and can be handled when encountered:

- The artifact panel and extended-thinking elements (see above).
- How citations appear in `innerText`.
- Whether `data-perf-row-streaming` behaves the same during long tool-use pauses.

## Repair log

When the extension breaks after an Anthropic frontend update, record what
changed here. Over time this shows which selectors are stable and which are not.

| Date | What broke | Old value | New value |
|---|---|---|---|
| — | — | — | — |