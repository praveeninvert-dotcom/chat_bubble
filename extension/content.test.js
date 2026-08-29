// Plain-Node unit tests for the pure text-extraction functions in
// content.js. No framework, no dependency. Run with:
//   node extension/content.test.js
const assert = require("node:assert");
const { cleanText, stripAccessibilityDuplicate, stripTitleSuffix, insertCodeFences } = require("./content.js");

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

console.log("\nAll content.js text-extraction tests passed.");
