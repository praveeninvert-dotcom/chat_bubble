// Plain-Node unit tests for the pure text-extraction functions in
// content.js. No framework, no dependency. Run with:
//   node extension/content.test.js
const assert = require("node:assert");
const { cleanText, stripAccessibilityDuplicate, stripTitleSuffix, insertCodeFences, domToMarkdown } = require("./content.js");
const { el, text } = require("./test-fakedom.js");

// The real fix for the accessibility preview/duplicate is DOM-level now:
// extractRowText hides h2.sr-only before ever reading innerText, so in
// normal operation cleanText never sees a "Claude responded: " / "You
// said: " prefix at all. What's tested here is stripAccessibilityDuplicate's
// fallback behaviour for the case that element isn't found — strip a
// leading prefix only, attempt nothing cleverer.

// Typical case: h2.sr-only already excluded, so raw text has no prefix and
// no trailing timestamp (time element also excluded by selector). Nothing
// here should be touched beyond trimming.
{
  const raw =
    'python\ndef reverse_string(s):\n    return s[::-1]\n\nThat\'s it. Python\'s slice syntax with -1 step walks the string backwards.\n\n\npython\nreverse_string("hello")  # "olleh"';
  const cleaned = cleanText(raw);
  assert.strictEqual(cleaned, raw, "already-clean text should pass through untouched");
  console.log("OK: already-clean text passes through unchanged");
}

// Fallback case: prefix present with no DOM exclusion available (e.g. the
// element wasn't found). Only the prefix should go — no attempt to detect
// or drop a following duplicate, since that's exactly the heuristic that
// was removed for eating legitimate content it couldn't reliably tell
// apart from a real duplicate.
{
  const raw = "Claude responded: some fallback text if exclusion ever fails";
  const cleaned = cleanText(raw);
  assert.strictEqual(cleaned, "some fallback text if exclusion ever fails", "prefix-only fallback should strip just the prefix");
  console.log("OK: prefix-only fallback ->", JSON.stringify(cleaned));
}

// Explicitly document the behaviour change: a raw string that still has a
// literal duplicate after the prefix is NOT deduplicated any more — only
// the prefix is removed. Deduplication now happens by excluding the real
// sr-only element in the DOM, not by comparing text.
{
  const raw = "You said: hello there\nhello there";
  const cleaned = cleanText(raw);
  assert.strictEqual(cleaned, "hello there\nhello there", "the paragraph-break/duplicate heuristic has been removed — only the prefix is stripped");
  console.log("OK: duplicate-detection heuristic confirmed removed ->", JSON.stringify(cleaned));
}

// A row with no recognised prefix at all should pass through unchanged.
{
  const raw = "[searched: weather in Chennai]";
  const cleaned = cleanText(raw);
  assert.strictEqual(cleaned, raw, "unprefixed rows should be left alone");
  console.log("OK: unprefixed row ->", JSON.stringify(cleaned));
}

// Trailing timestamp regex — fallback only now that time[data-cds=
// "RelativeTime"] is excluded by selector, but still exercised here in
// case that element is ever renamed or missing.
{
  assert.strictEqual(cleanText("hi\n\n23 hours ago"), "hi", "'N hours ago' should be stripped");
  assert.strictEqual(cleanText("hi\n\n6 days ago"), "hi", "'N days ago' should be stripped");
  assert.strictEqual(cleanText("hi\n\njust now"), "hi", "'just now' should be stripped");
  console.log("OK: timestamp regex fallback variants");
}

// Title suffix stripping — anchored, so it only removes the app's own
// trailing suffix, never one embedded earlier in a real title.
{
  assert.strictEqual(stripTitleSuffix("Viewing all API calls on a page - Claude"), "Viewing all API calls on a page");
  assert.strictEqual(
    stripTitleSuffix("Comparing GPT-4 - Claude - Claude"),
    "Comparing GPT-4 - Claude",
    "only the trailing app-name suffix should be removed, not one embedded in a real title"
  );
  assert.strictEqual(stripTitleSuffix("Claude"), "Claude", "a bare title with no suffix is left alone");
  assert.strictEqual(stripTitleSuffix(""), "", "empty title is left alone");
  console.log("OK: title suffix stripping");
}

// insertCodeFences — the confirmed raw sample (SELECTORS.md), two code
// blocks each preceded by a bare "python" label line, and the DOM-derived
// exact code text for each <pre> (what pre.innerText would return).
{
  const raw =
    "Claude responded: That's it.\n\npython\ndef reverse_string(s):\n    return s[::-1]\n\nThat's it. Python's slice syntax with -1 step walks the string backwards.\n\n\npython\nreverse_string(\"hello\")  # \"olleh\"\n";
  const codeTexts = ['def reverse_string(s):\n    return s[::-1]', 'reverse_string("hello")  # "olleh"'];
  const result = insertCodeFences(raw, codeTexts);
  assert.strictEqual(
    result,
    "Claude responded: That's it.\n\n" +
      "```python\ndef reverse_string(s):\n    return s[::-1]\n```" +
      "\n\nThat's it. Python's slice syntax with -1 step walks the string backwards.\n\n\n" +
      '```python\nreverse_string("hello")  # "olleh"\n```' +
      "\n",
    "both bare 'python' label lines should become ```python fences, dropping the redundant label line"
  );
  console.log("OK: two-code-block fence rebuild matches the confirmed sample");
}

// No <pre> elements — text passes through unchanged.
{
  const raw = "just some prose, no code";
  assert.strictEqual(insertCodeFences(raw, []), raw, "no code blocks means no change");
  console.log("OK: no code blocks -> unchanged");
}

// Label line isn't a known language — fence emitted with no language tag,
// and the prose line is left in place rather than being swallowed.
{
  const raw = "Example:\ndef foo():\n    pass\n";
  const result = insertCodeFences(raw, ["def foo():\n    pass"]);
  assert.strictEqual(result, "Example:\n```\ndef foo():\n    pass\n```\n", "an unrecognised label should not be consumed, only wrapped as a plain fence");
  console.log("OK: unrecognised label left in place, fence has no language ->", JSON.stringify(result));
}

// Code text that can't be located in the row's text at all (e.g. DOM/text
// mismatch) is skipped gracefully rather than corrupting the output.
{
  const raw = "some prose that never mentions the code";
  const result = insertCodeFences(raw, ["totally unrelated code"]);
  assert.strictEqual(result, raw, "an unlocatable code block should be left alone, not guessed at");
  console.log("OK: unlocatable code block skipped without corrupting text");
}

// ---------------------------------------------------------------------
// domToMarkdown — real DOM fragments in, markdown text out.
//
// claude.ai has already rendered Claude's markdown into real HTML by the
// time this extension reads a row: a real <table>, a real <ul>, a real
// <a href>. innerText on that gives back visible text with the syntax
// gone — no pipes, no dashes, no [text](url) — since that syntax only
// ever existed in the raw output, before the page rendered it. So these
// tests build actual DOM fragments (see test-fakedom.js) and check what
// domToMarkdown reconstructs from their STRUCTURE, not from hand-written
// markdown strings — a test built from a markdown string would pass
// whether or not the DOM-reading code underneath it actually worked, and
// that gap is exactly what let this feature ship completely broken while
// a differently-scoped test suite (desktop/test-markdown.js, which tests
// the bubble's markdown *renderer*, an unrelated file in an unrelated
// process) stayed green throughout.
// ---------------------------------------------------------------------

// Headings h1-h6.
{
  const row = el("div", [el("h1", ["Title"]), el("h3", ["Sub"]), el("h6", ["Tiny"])]);
  assert.strictEqual(domToMarkdown(row), "# Title\n\n### Sub\n\n###### Tiny");
  console.log("OK: <h1>-<h6> -> # through ######");
}

// Unordered list.
{
  const row = el("div", [el("ul", [el("li", ["a"]), el("li", ["b"])])]);
  assert.strictEqual(domToMarkdown(row), "- a\n- b");
  console.log("OK: <ul><li> -> - item");
}

// Ordered list, default numbering and an explicit start attribute (a
// real <ol start="N"> is what claude.ai would render for a markdown list
// that didn't start at 1).
{
  const row = el("div", [el("ol", [el("li", ["first"]), el("li", ["second"])])]);
  assert.strictEqual(domToMarkdown(row), "1. first\n2. second");
  console.log("OK: <ol><li> -> numbered items");
}
{
  const row = el("div", [el("ol", { start: "5" }, [el("li", ["five"]), el("li", ["six"])])]);
  assert.strictEqual(domToMarkdown(row), "5. five\n6. six");
  console.log("OK: <ol start=\"5\"> -> numbering continues from the real start attribute");
}

// Nested list — must indent deeper than the parent item, since that's the
// only signal markdown.js's own parser uses to recognise nesting.
{
  const row = el("div", [
    el("ul", [el("li", [text("top"), el("ul", [el("li", ["nested"])])]), el("li", ["top2"])]),
  ]);
  assert.strictEqual(domToMarkdown(row), "- top\n  - nested\n- top2");
  console.log("OK: nested <ul> indents deeper than its parent <li>");
}

// Table — pipe table with a header separator row.
{
  const row = el("div", [
    el("table", [
      el("tr", [el("th", ["A"]), el("th", ["B"])]),
      el("tr", [el("td", ["1"]), el("td", ["2"])]),
    ]),
  ]);
  assert.strictEqual(domToMarkdown(row), "| A | B |\n| --- | --- |\n| 1 | 2 |");
  console.log("OK: <table> -> pipe table with header separator row");
}

// Blockquote.
{
  const row = el("div", [el("blockquote", [el("p", ["quoted text"])])]);
  assert.strictEqual(domToMarkdown(row), "> quoted text");
  console.log("OK: <blockquote> -> > quoted");
}

// Horizontal rule.
{
  const row = el("div", [el("p", ["above"]), el("hr"), el("p", ["below"])]);
  assert.strictEqual(domToMarkdown(row), "above\n\n---\n\nbelow");
  console.log("OK: <hr> -> ---");
}

// Link.
{
  const row = el("div", [el("p", [text("see "), el("a", { href: "https://example.com" }, ["docs"])])]);
  assert.strictEqual(domToMarkdown(row), "see [docs](https://example.com)");
  console.log("OK: <a href> -> [text](url)");
}

// Bold, italic, strikethrough, inline code — both tag spellings of each.
{
  const row = el("div", [
    el("p", [
      el("strong", ["bold"]),
      text(" "),
      el("b", ["bold2"]),
      text(" "),
      el("em", ["italic"]),
      text(" "),
      el("i", ["italic2"]),
      text(" "),
      el("del", ["strike"]),
      text(" "),
      el("s", ["strike2"]),
      text(" "),
      el("code", ["inline"]),
    ]),
  ]);
  assert.strictEqual(
    domToMarkdown(row),
    "**bold** **bold2** *italic* *italic2* ~~strike~~ ~~strike2~~ `inline`"
  );
  console.log("OK: <strong>/<b>, <em>/<i>, <del>/<s>, <code> -> markdown");
}

// <pre> — the existing, confirmed-working fence rebuild (insertCodeFences/
// rebuildCodeFences, untouched by this change) still runs correctly when
// fed by the new DOM walk instead of row.innerText. Expected value matches
// the already-established behaviour above: a recognised language label
// line is consumed into the fence, not left duplicated beside it.
{
  const row = el("div", [el("p", ["python"]), el("pre", ["def f():\n    return 1"])]);
  assert.strictEqual(domToMarkdown(row), "```python\ndef f():\n    return 1\n```");
  console.log("OK: <pre> -> fenced code block via the existing, unchanged rebuildCodeFences");
}

// h2.sr-only is excluded on its own — it sits outside the MessageActions
// toolbar (a heading over the whole row), so it keeps its own selector.
{
  const row = el("div", [
    el("h2", { class: "sr-only" }, ["You said: preview text"]),
    el("p", [text("Real message content")]),
  ]);
  assert.strictEqual(domToMarkdown(row), "Real message content");
  console.log("OK: h2.sr-only is excluded");
}

// The whole MessageActions toolbar is excluded as one subtree, whatever's
// inside it — a copy button, the timestamp, and the "N / N" retry counter,
// none of which need their own selector any more. Identified by
// data-cds="MessageActions".
{
  const row = el("div", [
    el("p", [text("Real message content")]),
    el(
      "div",
      { "data-cds": "MessageActions", role: "toolbar", "aria-label": "Message actions" },
      [
        el("button", { "data-testid": "action-bar-copy" }, ["Copy"]),
        el("time", { "data-cds": "RelativeTime" }, ["6 days ago"]),
        el("div", { class: "inline-flex items-center gap-1" }, [
          el("span", { class: "self-center shrink-0 select-none font-small text-muted" }, ["3 / 3"]),
        ]),
      ]
    ),
  ]);
  assert.strictEqual(domToMarkdown(row), "Real message content");
  console.log("OK: whole MessageActions subtree excluded (button + timestamp + retry counter)");
}

// The secondary selector — role="toolbar" + aria-label="Message actions"
// with no data-cds attribute — also excludes the subtree, proving the two
// combined selectors are genuinely independent, not one disguised as two.
{
  const row = el("div", [
    el("p", [text("Real message content")]),
    el("div", { role: "toolbar", "aria-label": "Message actions" }, [el("button", ["Copy"])]),
  ]);
  assert.strictEqual(domToMarkdown(row), "Real message content");
  console.log("OK: role=toolbar + aria-label fallback (no data-cds) also excludes the subtree");
}

// An unrelated toolbar (role="toolbar" but a different aria-label) is NOT
// excluded — proving the match isn't so broad it eats any toolbar-like
// region in the row.
{
  const row = el("div", [
    el("p", [text("Real message content")]),
    el("div", { role: "toolbar", "aria-label": "Formatting options" }, [text("Bold, Italic")]),
  ]);
  assert.strictEqual(domToMarkdown(row), "Real message content\n\nBold, Italic");
  console.log("OK: an unrelated role=toolbar region (different aria-label) is left alone");
}

// A legitimate "3 / 3" Claude actually writes in a reply, outside any
// MessageActions container, is preserved — the fix is scoped to the
// toolbar, not to the text shape.
{
  const row = el("div", [el("p", [text("The score was 3 / 3")])]);
  assert.strictEqual(domToMarkdown(row), "The score was 3 / 3");
  console.log("OK: '3 / 3' outside the toolbar is left alone");
}

// Icon glyphs (Anthropicons, private-use-font spans) are excluded even
// when nested inside inline formatting, not just at the top level.
{
  const row = el("div", [
    el("p", [el("strong", [el("span", { "data-cds": "Icon" }, [""]), text("bold text")])]),
  ]);
  assert.strictEqual(domToMarkdown(row), "**bold text**");
  console.log("OK: icon-glyph span excluded even nested inside inline formatting");
}

// tool-status-pill and img become their fixed placeholders, each its own
// block when they sit between paragraphs.
{
  const row = el("div", [
    el("p", [text("Before")]),
    el("div", { "data-testid": "tool-status-pill" }, ["Connecting to search..."]),
    el("p", [text("After")]),
  ]);
  assert.strictEqual(domToMarkdown(row), "Before\n\n[tool]\n\nAfter");
  console.log("OK: tool-status-pill -> [tool] placeholder");
}
{
  const row = el("div", [el("p", [text("See:")]), el("img", { src: "photo.png" })]);
  assert.strictEqual(domToMarkdown(row), "See:\n\n[image]");
  console.log("OK: img -> [image] placeholder");
}

// Realistic combined message: heading, a paragraph with bold and a link,
// and a list — the shape an actual reply looks like, not an isolated
// single-tag fixture.
{
  const row = el("div", [
    el("h2", ["Summary"]),
    el("p", [
      text("Here is "),
      el("strong", ["important"]),
      text(" info and a "),
      el("a", { href: "https://x.com" }, ["link"]),
      text("."),
    ]),
    el("ul", [el("li", ["first point"]), el("li", ["second point"])]),
  ]);
  assert.strictEqual(
    domToMarkdown(row),
    "## Summary\n\nHere is **important** info and a [link](https://x.com).\n\n- first point\n- second point"
  );
  console.log("OK: realistic combined message (heading + paragraph + bold + link + list)");
}

console.log("\nAll content.js text-extraction tests passed.");
