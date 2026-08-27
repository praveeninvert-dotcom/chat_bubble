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

### Still to observe

These were not part of Phase 0 and can be handled when encountered:

- How artifacts, extended thinking, tool-use blocks, and citations appear in
  `innerText`. The census showed `tool-status-pill` exists, so tool use has its
  own markup.
- Whether `data-perf-row-streaming` behaves the same during long tool-use pauses.

## Repair log

When the extension breaks after an Anthropic frontend update, record what
changed here. Over time this shows which selectors are stable and which are not.

| Date | What broke | Old value | New value |
|---|---|---|---|
| — | — | — | — |