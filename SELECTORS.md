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

## Recorded values

| Fact | Value | Verified on |
|---|---|---|
| Conversation URL pattern | `https://claude.ai/chat/<uuid>` — **confirm this** | — |
| Composer selector | `UNKNOWN` | — |
| Composer element type | `UNKNOWN` | — |
| Working injection technique | `UNKNOWN` — D2 or D2b | — |
| Send button selector | `UNKNOWN` | — |
| Stop button distinguishing attribute | `UNKNOWN` | — |
| Submit technique | `UNKNOWN` — click button, or Enter keydown | — |
| Conversation container selector | `UNKNOWN` | — |
| User turn selector | `UNKNOWN` | — |
| Assistant turn selector | `UNKNOWN` | — |
| Streaming state indicator | `UNKNOWN` | — |
| `textContent` preserves code formatting | `UNKNOWN` — D6 | — |

---

## Repair log

When the extension breaks after an Anthropic frontend update, record what
changed here. Over time this shows which selectors are stable and which are not.

| Date | What broke | Old value | New value |
|---|---|---|---|
| — | — | — | — |
