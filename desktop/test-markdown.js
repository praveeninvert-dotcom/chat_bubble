// Unit tests for desktop/renderer/markdown.js — the bubble's markdown
// renderer. Pure string-in/string-out tests against renderMarkdown
// directly: no DOM, no Electron, no server. markdown.js has no dependency
// on `document`/`window` for exactly this reason (see its header comment).
//
// Run: node desktop/test-markdown.js
"use strict";

const assert = require("node:assert").strict;
const { renderMarkdown } = require("./renderer/markdown");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ---------- previously-existing behavior (regression check after pulling ----------
// ---------- markdown.js out of app.js) ----------

test("heading", () => {
  assert.equal(renderMarkdown("# Title"), "<h1>Title</h1>");
});

test("bold and italic", () => {
  assert.equal(renderMarkdown("**bold** and *italic*"), "<p><strong>bold</strong> and <em>italic</em></p>");
});

test("inline code", () => {
  assert.equal(renderMarkdown("`x = 1`"), "<p><code>x = 1</code></p>");
});

test("fenced code block", () => {
  const html = renderMarkdown("```js\nconst x = 1;\n```");
  assert.match(html, /<div class="code-block">/);
  assert.match(html, /<span class="code-lang">js<\/span>/);
  assert.match(html, /<pre><code>const x = 1;<\/code><\/pre>/);
});

test("unordered list", () => {
  assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
});

// ---------- new: horizontal rules ----------

test("horizontal rule", () => {
  assert.equal(renderMarkdown("above\n\n---\n\nbelow"), "<p>above</p><hr><p>below</p>");
});

test("horizontal rule variants (asterisks, underscores, spaced dashes)", () => {
  assert.equal(renderMarkdown("***"), "<hr>");
  assert.equal(renderMarkdown("___"), "<hr>");
  assert.equal(renderMarkdown("- - -"), "<hr>");
});

test("two-asterisk bold is not mistaken for a horizontal rule", () => {
  assert.equal(renderMarkdown("**bold**"), "<p><strong>bold</strong></p>");
});

// ---------- new: blockquotes ----------

test("blockquote", () => {
  assert.equal(renderMarkdown("> quoted text"), "<blockquote><p>quoted text</p></blockquote>");
});

test("multi-line blockquote joins into one block", () => {
  assert.equal(renderMarkdown("> line one\n> line two"), "<blockquote><p>line one<br>line two</p></blockquote>");
});

// ---------- new: ordered lists with correct numbering ----------

test("ordered list numbers sequentially regardless of the source's own digits", () => {
  assert.equal(
    renderMarkdown("1. first\n1. second\n1. third"),
    "<ol><li>first</li><li>second</li><li>third</li></ol>"
  );
});

test("ordered list starting above 1 carries a start attribute", () => {
  assert.equal(renderMarkdown("3. third\n4. fourth"), '<ol start="3"><li>third</li><li>fourth</li></ol>');
});

// ---------- new: nested lists ----------

test("nested unordered list", () => {
  assert.equal(
    renderMarkdown("- top\n  - nested\n- top2"),
    "<ul><li>top<ul><li>nested</li></ul></li><li>top2</li></ul>"
  );
});

test("ordered list nested inside an unordered item", () => {
  assert.equal(
    renderMarkdown("- top\n  1. nested one\n  2. nested two"),
    "<ul><li>top<ol><li>nested one</li><li>nested two</li></ol></li></ul>"
  );
});

// ---------- new: strikethrough ----------

test("strikethrough", () => {
  assert.equal(renderMarkdown("~~gone~~"), "<p><del>gone</del></p>");
});

// ---------- new: tables ----------

test("table renders inside the horizontal-scroll wrapper", () => {
  const html = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.match(html, /^<div class="table-wrap"><table>/);
  assert.match(html, /<thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody>/);
});

test("table column alignment from the separator row", () => {
  const html = renderMarkdown("| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |");
  assert.match(html, /<th>L<\/th>/);
  assert.match(html, /<th style="text-align:center">C<\/th>/);
  assert.match(html, /<th style="text-align:right">R<\/th>/);
});

// ---------- new: links ----------

test("http/https/mailto links render as anchors", () => {
  assert.equal(
    renderMarkdown("[docs](https://example.com/path)"),
    '<p><a href="https://example.com/path" class="turn-link" rel="noopener noreferrer">docs</a></p>'
  );
  assert.match(renderMarkdown("[email](mailto:a@b.com)"), /<a href="mailto:a@b\.com"/);
});

// ---------- new: links — security ----------
//
// escapeHtml runs over the WHOLE message once, before any of this —
// renderMarkdown escapes & < > " ' up front, then every block/inline
// pass (headings, lists, links, bold/italic/...) is just a further regex
// pass over that already-escaped string. That's why these tests check
// renderMarkdown's actual output rather than an internal helper: the
// escaping these rely on isn't a separate step bolted onto links, it's the
// same pass every other bit of message text already goes through.

test("SECURITY: javascript: URL is rejected — rendered as plain text, not a link", () => {
  const html = renderMarkdown("[click me](javascript:evil)");
  assert.equal(html, "<p>click me</p>");
  assert.ok(!html.includes("<a "), "must not produce an anchor tag");
  assert.ok(!html.includes("javascript:"), "the rejected URL must not appear anywhere in the output");
});

test("SECURITY: data: and file: URLs are also rejected", () => {
  assert.equal(renderMarkdown("[x](data:text/plain,hello)"), "<p>x</p>");
  assert.equal(renderMarkdown("[x](file:///etc/passwd)"), "<p>x</p>");
});

test("SECURITY: a tab-obfuscated javascript: scheme is still rejected", () => {
  // A naive `/^javascript:/` check on the untouched string would miss this
  // — Chrome's own URL parser drops embedded tabs before reading the
  // scheme, so "java\tscript:evil" IS "javascript:evil" as far as
  // navigation is concerned, even though the raw string doesn't start with
  // "javascript:". See sanitizeLinkUrl in markdown.js.
  const html = renderMarkdown("[click me](java\tscript:evil)");
  assert.equal(html, "<p>click me</p>");
  assert.ok(!html.includes("<a "), "must not produce an anchor tag");
});

test("SECURITY: a quote character in the URL cannot break out of the href attribute", () => {
  const html = renderMarkdown('[x](https://example.com/page?q="onmouseover="x)');
  const expected =
    '<p><a href="https://example.com/page?q=&quot;onmouseover=&quot;x" class="turn-link" rel="noopener noreferrer">x</a></p>';
  assert.equal(html, expected);
  assert.ok(!html.includes('q="onmouseover="'), "a raw, unescaped quote must never survive into the attribute value");
});

// ---------- run ----------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`PASS - ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL - ${name}`);
    console.log(`       ${err.message}`);
  }
}

console.log("");
console.log(
  failed === 0
    ? `RESULT: PASS — all ${tests.length} tests passed.`
    : `RESULT: FAIL — ${failed} of ${tests.length} tests failed.`
);
process.exit(failed === 0 ? 0 : 1);
