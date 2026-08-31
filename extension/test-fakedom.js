// Minimal, test-only DOM stand-in — just enough of the Element/Text node
// shape and querySelectorAll grammar that content.js's DOM-walking
// functions (domToMarkdown and friends) actually use, so tests can build
// real DOM fragments (real node objects, a real tree, real querySelectorAll
// queries) without a browser and without adding a dependency (extension/
// stays vanilla JS, no npm packages, per CLAUDE.md).
//
// Deliberately NOT a general DOM/HTML-parser implementation — it supports
// exactly the selector grammar content.js's own selector constants use
// (bare tag, tag.class, tag[attr="value"], [attr="value"], one or more
// chained attribute selectors on the same token e.g.
// [role="toolbar"][aria-label="x"], comma-separated lists, and the one
// two-token descendant combinator content.js needs, "pre button") and
// nothing more; an unsupported selector throws rather than silently
// matching nothing. innerText is approximated as
// textContent — real <pre>/innerText whitespace fidelity is a
// browser-only behaviour already covered by content.test.js's separate,
// pure insertCodeFences tests, not by anything built here.
//
// Not required by content.js itself, only by content.test.js.
"use strict";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

class FakeText {
  constructor(data) {
    this.nodeType = TEXT_NODE;
    this.textContent = data;
    this.parent = null;
  }
}

class FakeElement {
  constructor(tag, attrs) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = tag.toUpperCase();
    this._attrs = Object.assign({}, attrs);
    this.childNodes = [];
    this.style = { display: "" };
    this.parent = null;
  }

  get children() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE);
  }

  get parentElement() {
    return this.parent || null;
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }

  get innerText() {
    return this.textContent; // approximation — see file header comment
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }

  appendChild(node) {
    node.parent = this;
    this.childNodes.push(node);
    return node;
  }

  matches(selector) {
    return selector
      .split(",")
      .map((s) => s.trim())
      .some((simple) => matchesCombinator(this, simple));
  }

  querySelectorAll(selector) {
    const combinators = selector.split(",").map((s) => s.trim());
    const results = [];
    const walk = (node) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType !== ELEMENT_NODE) return;
        if (combinators.some((c) => matchesCombinator(child, c))) results.push(child);
        walk(child);
      });
    };
    walk(this);
    return results;
  }
}

// Matches "tag", "tag.class", "tag[attr=\"value\"]", "[attr=\"value\"]", or
// one token carrying multiple chained attribute selectors (e.g.
// "[role=\"toolbar\"][aria-label=\"x\"]", optionally tag-prefixed) — no
// combinators here, see matchesCombinator.
function matchesSimple(el, simple) {
  const attrsMatch = simple.match(/^([a-zA-Z0-9]*)((?:\[[a-zA-Z0-9-]+="[^"]*"\])+)$/);
  if (attrsMatch) {
    const [, tag, attrsPart] = attrsMatch;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    const attrRe = /\[([a-zA-Z0-9-]+)="([^"]*)"\]/g;
    let m;
    while ((m = attrRe.exec(attrsPart))) {
      if (el.getAttribute(m[1]) !== m[2]) return false;
    }
    return true;
  }
  const classMatch = simple.match(/^([a-zA-Z0-9]+)\.([a-zA-Z0-9-]+)$/);
  if (classMatch) {
    const [, tag, cls] = classMatch;
    if (el.tagName !== tag.toUpperCase()) return false;
    return (el.getAttribute("class") || "").split(/\s+/).includes(cls);
  }
  if (/^[a-zA-Z0-9]+$/.test(simple)) return el.tagName === simple.toUpperCase();
  throw new Error(`test-fakedom: unsupported selector fragment "${simple}"`);
}

// Splits a combinator on whitespace, except whitespace inside a quoted
// attribute value — needed now that content.js has a selector whose
// attribute value itself contains a space (aria-label="Message actions"),
// which a naive split(/\s+/) would wrongly cut in two.
function splitCombinatorParts(combinator) {
  const parts = [];
  let current = "";
  let inQuotes = false;
  for (const ch of combinator) {
    if (ch === '"') inQuotes = !inQuotes;
    if (/\s/.test(ch) && !inQuotes) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Supports a bare simple selector, or the one two-token descendant
// combinator content.js's own selectors use ("pre button").
function matchesCombinator(el, combinator) {
  const parts = splitCombinatorParts(combinator);
  if (parts.length === 1) return matchesSimple(el, parts[0]);
  if (parts.length === 2) {
    if (!matchesSimple(el, parts[1])) return false;
    for (let ancestor = el.parent; ancestor; ancestor = ancestor.parent) {
      if (matchesSimple(ancestor, parts[0])) return true;
    }
    return false;
  }
  throw new Error(`test-fakedom: unsupported selector "${combinator}" — only bare and two-token descendant selectors are implemented`);
}

// el("div", { "data-testid": "x" }, [child, child, "text"])
// el("div", ["text"])                 — attrs omitted
// Children may be node objects or plain strings (auto-wrapped as text).
function el(tag, attrsOrChildren, maybeChildren) {
  let attrs = {};
  let children = [];
  if (Array.isArray(attrsOrChildren)) {
    children = attrsOrChildren;
  } else if (attrsOrChildren && typeof attrsOrChildren === "object") {
    attrs = attrsOrChildren;
    children = maybeChildren || [];
  }
  const node = new FakeElement(tag, attrs);
  children.forEach((child) => node.appendChild(typeof child === "string" ? new FakeText(child) : child));
  return node;
}

function text(data) {
  return new FakeText(data);
}

module.exports = { el, text };
