// Markdown rendering for the bubble's message content: headings, bold,
// italic, strikethrough, inline code, fenced code blocks, links,
// unordered/ordered lists (with nesting), blockquotes, horizontal rules,
// and tables.
//
// Pulled out of app.js so it has no dependency on `document`/`window` and
// can be loaded two ways with no build step: as a plain <script> in
// index.html (defines the functions as globals, for app.js to call) and as
// a plain `require()` from desktop/test-markdown.js (Node has no DOM, so
// app.js itself — which touches `document` at load time — can't be
// required directly).
//
// Renderer output goes straight into `.innerHTML` (see app.js's paintTurn).
// The text and links here come from Claude's output, not from code we
// wrote — every string is escaped before it can reach the DOM, and links
// get extra care (see renderInline below) since they carry a URL into an
// `href` attribute, not just text.
(() => {
  "use strict";

  // Placeholder delimiter for markdown extraction (code blocks/spans/links).
  // NUL can't occur in typed chat text, so it can't collide with real
  // content — a padded-spaces scheme was tried first and rejected: it broke
  // on real prose like "section B2", and a later trim() bug meant the
  // block-level placeholder check never matched at all.
  const PH = String.fromCharCode(0);

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Only these three schemes are ever allowed into an href. Anything else
  // (javascript:, data:, file:, vbscript:, ...) is rejected outright — the
  // link renders as plain text instead, and the rejected URL is discarded
  // entirely (never written into the DOM in any form).
  const ALLOWED_LINK_SCHEMES = /^(https?|mailto):/i;

  // Mirrors the first step of the WHATWG URL parser (strip leading/trailing
  // C0-control-or-space, remove ALL internal tab/CR/LF) before the scheme
  // check runs. Without this, the allowlist above can be bypassed the way a
  // naive prefix check always can: Chrome's own URL parser treats
  // "java\tscript:alert(1)" as exactly the same URL as
  // "javascript:alert(1)", even though a plain regex against the untouched
  // string would not see "javascript:" at the start and would wrongly let
  // it through. The cleaned value is also what gets used as the actual
  // href, not just what's checked — no reason to keep the noisy original.
  function sanitizeLinkUrl(raw) {
    return String(raw).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\r\n]/g, "");
  }

  function renderInline(text) {
    const codeSpans = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      codeSpans.push(code);
      return PH + "K" + (codeSpans.length - 1) + PH;
    });

    // Links are extracted to a placeholder before bold/italic/strikethrough
    // run, same reasoning as code spans above: it keeps those regexes from
    // reaching into (and corrupting) the constructed href — e.g. a URL with
    // an underscore in it tripping the italic regex mid-attribute. The link
    // TEXT is deliberately left exposed between the placeholder markers
    // (not hidden), so bold/italic/strikethrough still apply inside it —
    // only the href construction itself is protected.
    //
    // `text` and `rawUrl` are both substrings of a string escapeHtml already
    // ran over in full (see renderMarkdown, which escapes the whole message
    // before any block/inline parsing starts) — so both are already safe to
    // place as HTML text AND as a double-quoted attribute value: & < > " '
    // are already entities. None of those five characters can appear inside
    // a URL scheme token, so escaping doesn't hide or alter the scheme the
    // check below is looking at.
    const links = [];
    text = text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (whole, linkText, rawUrl) => {
      const url = sanitizeLinkUrl(rawUrl);
      if (!ALLOWED_LINK_SCHEMES.test(url)) {
        return linkText; // disallowed scheme — plain text, not a link. URL is dropped, not kept anywhere.
      }
      links.push(url);
      return PH + "L" + (links.length - 1) + PH + linkText + PH + "/L" + PH;
    });

    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    text = text.replace(/_([^_]+)_/g, "<em>$1</em>");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    const linkRestoreRe = new RegExp(PH + "L(\\d+)" + PH + "([\\s\\S]*?)" + PH + "/L" + PH, "g");
    text = text.replace(linkRestoreRe, (_, i, innerHtml) => {
      const url = links[Number(i)];
      return `<a href="${url}" class="turn-link" rel="noopener noreferrer">${innerHtml}</a>`;
    });

    const codeRestoreRe = new RegExp(PH + "K(\\d+)" + PH, "g");
    text = text.replace(codeRestoreRe, (_, i) => `<code>${codeSpans[Number(i)]}</code>`);
    return text;
  }

  function renderMarkdown(rawText) {
    const blocks = [];
    let text = String(rawText || "").replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push({ lang, code });
      return PH + "B" + (blocks.length - 1) + PH;
    });

    text = escapeHtml(text);

    const blockLineRe = new RegExp("^" + PH + "B\\d+" + PH + "$");

    function isHr(line) {
      return /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
    }

    function indentOf(line) {
      return line.match(/^ */)[0].length;
    }

    function splitTableRow(line) {
      let s = line.trim();
      if (s.startsWith("|")) s = s.slice(1);
      if (s.endsWith("|")) s = s.slice(0, -1);
      return s.split("|").map((c) => c.trim());
    }

    function isTableSeparator(line) {
      const cells = splitTableRow(line);
      return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
    }

    // True for any line that starts a new block, so the plain-paragraph
    // loop below knows when to stop collecting continuation lines. Kept as
    // one function (rather than duplicating each check into the paragraph
    // loop's own while-condition) so adding a new block type here can't
    // silently forget to also stop paragraphs — that's what happened with
    // tables during development: the paragraph loop swallowed a table's
    // header/separator rows as plain text until this got a single check.
    function isBlockStart(line, nextLine) {
      if (blockLineRe.test(line.trim())) return true;
      if (/^(#{1,6})\s+/.test(line)) return true;
      if (isHr(line)) return true;
      if (/^ {0,3}&gt;/.test(line)) return true;
      const rest = line.slice(indentOf(line));
      if (/^[-*]\s+/.test(rest) || /^\d+\.\s+/.test(rest)) return true;
      if (line.includes("|") && nextLine !== undefined && isTableSeparator(nextLine)) return true;
      return false;
    }

    // Parses a run of list items at exactly `indent` spaces (bullet or
    // ordered, per `ordered`, starting at `start`), recursing into itself
    // for any more-deeply-indented continuation lines so nested lists
    // nest correctly instead of flattening. Returns the rendered <ul>/<ol>
    // and the index of the first line it didn't consume.
    function parseList(lines, start, indent, ordered) {
      const itemRe = ordered ? /^(\d+)\.\s+([\s\S]*)$/ : /^[-*]\s+([\s\S]*)$/;
      let i = start;
      let items = "";
      let startNum = null;
      while (i < lines.length) {
        if (lines[i].trim() === "") {
          i++;
          continue;
        }
        const lineIndent = indentOf(lines[i]);
        if (lineIndent !== indent) break;
        const m = lines[i].slice(lineIndent).match(itemRe);
        if (!m) break;
        if (ordered && startNum === null) startNum = parseInt(m[1], 10);
        const itemText = ordered ? m[2] : m[1];
        i++;

        // Nested list: any run of more-deeply-indented lines that are
        // themselves list items belongs inside this <li>, not after it.
        let nested = "";
        while (i < lines.length && lines[i].trim() !== "" && indentOf(lines[i]) > indent) {
          const nestedIndent = indentOf(lines[i]);
          const rest = lines[i].slice(nestedIndent);
          const nestedOrdered = /^\d+\.\s+/.test(rest);
          if (!nestedOrdered && !/^[-*]\s+/.test(rest)) break;
          const result = parseList(lines, i, nestedIndent, nestedOrdered);
          nested += result.html;
          i = result.nextIndex;
        }
        items += `<li>${renderInline(itemText)}${nested}</li>`;
      }
      const tag = ordered ? "ol" : "ul";
      // CommonMark: only the FIRST item's number is meaningful; later ones
      // are ignored and the browser auto-increments from `start`.
      const startAttr = ordered && startNum && startNum !== 1 ? ` start="${startNum}"` : "";
      return { html: `<${tag}${startAttr}>${items}</${tag}>`, nextIndex: i };
    }

    // Block-level parser. A plain function (not the top-level flow directly)
    // so blockquotes can recurse into it for their own contents — a
    // blockquote can contain paragraphs, lists, even a nested blockquote.
    function renderBlocks(lines) {
      let html = "";
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];

        if (blockLineRe.test(line.trim())) {
          html += line.trim();
          i++;
          continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          const level = heading[1].length;
          html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
          i++;
          continue;
        }

        if (isHr(line)) {
          html += "<hr>";
          i++;
          continue;
        }

        // ">" was already turned into "&gt;" by the escapeHtml() call above
        // renderBlocks is first invoked — everything in this function
        // matches against already-escaped text, not raw markdown source.
        if (/^ {0,3}&gt;/.test(line)) {
          const quoteLines = [];
          while (i < lines.length && /^ {0,3}&gt;/.test(lines[i])) {
            quoteLines.push(lines[i].replace(/^ {0,3}&gt;[ \t]?/, ""));
            i++;
          }
          html += `<blockquote>${renderBlocks(quoteLines)}</blockquote>`;
          continue;
        }

        if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
          const headerCells = splitTableRow(line);
          const aligns = splitTableRow(lines[i + 1]).map((c) => {
            // "left" isn't its own case — it's the browser default for a
            // <td>/<th> either way, so a ":---" column needs no style at
            // all, same as a plain "---" column.
            const left = c.startsWith(":");
            const right = c.endsWith(":");
            if (left && right) return "center";
            if (right) return "right";
            return "";
          });
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
            rows.push(splitTableRow(lines[i]));
            i++;
          }
          const alignAttr = (idx) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "");
          const thead =
            "<tr>" + headerCells.map((c, idx) => `<th${alignAttr(idx)}>${renderInline(c)}</th>`).join("") + "</tr>";
          const tbody = rows
            .map((row) => "<tr>" + row.map((c, idx) => `<td${alignAttr(idx)}>${renderInline(c)}</td>`).join("") + "</tr>")
            .join("");
          // .table-wrap is the horizontal-scroll boundary (see style.css) —
          // the table itself is left free to size to its content, wider
          // than the 380px panel or not.
          html += `<div class="table-wrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
          continue;
        }

        const indent = indentOf(line);
        const rest = line.slice(indent);
        if (/^[-*]\s+/.test(rest) || /^\d+\.\s+/.test(rest)) {
          const ordered = /^\d+\.\s+/.test(rest);
          const result = parseList(lines, i, indent, ordered);
          html += result.html;
          i = result.nextIndex;
          continue;
        }

        if (line.trim() === "") {
          i++;
          continue;
        }

        const paraLines = [];
        while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i], lines[i + 1])) {
          paraLines.push(renderInline(lines[i]));
          i++;
        }
        html += `<p>${paraLines.join("<br>")}</p>`;
      }
      return html;
    }

    let html = renderBlocks(text.split("\n"));

    const blockRestoreRe = new RegExp(PH + "B(\\d+)" + PH, "g");
    html = html.replace(blockRestoreRe, (_, idxStr) => {
      const b = blocks[Number(idxStr)];
      const code = b.code.replace(/\n$/, "");
      const escapedCode = escapeHtml(code);
      const langLabel = b.lang ? escapeHtml(b.lang) : "";
      return (
        `<div class="code-block">` +
        `<div class="code-block-header"><span class="code-lang">${langLabel}</span>` +
        `<button class="copy-btn" type="button">Copy</button></div>` +
        `<pre><code>${escapedCode}</code></pre>` +
        `</div>`
      );
    });

    return html;
  }

  const api = { renderMarkdown, escapeHtml, renderInline };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    window.renderMarkdown = renderMarkdown;
    window.escapeHtml = escapeHtml;
    window.renderInline = renderInline;
  }
})();
