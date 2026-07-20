import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdownToHtml } from "../src/index.js";

/** Valid lowercase UUIDv7s for markers. */
const B1 = "0190f27e-1a93-7b61-996a-9f94849d27a8";
const B2 = "0190f27e-76db-79c2-a455-a16916f79126";

const marker = (id: string): string => `<!-- authorbot:block id="${id}" -->`;

describe("escapeHtml", () => {
  it("escapes the five HTML special characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("renderMarkdownToHtml — escaping", () => {
  it("escapes angle brackets and quotes in prose", () => {
    const html = renderMarkdownToHtml(`Tom said "5 < 7 & 7 > 5".`);
    expect(html).toContain("&quot;5 &lt; 7 &amp; 7 &gt; 5&quot;");
    expect(html).not.toContain("<5");
  });

  it("escapes code block contents", () => {
    const html = renderMarkdownToHtml("```js\nif (a < b) alert('<script>');\n```\n");
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("escapes inline code", () => {
    const html = renderMarkdownToHtml("Use `<b>` sparingly.");
    expect(html).toContain("<code>&lt;b&gt;</code>");
  });

  it("escapes attribute values in link titles and URLs", () => {
    const html = renderMarkdownToHtml(
      `[x](https://example.com/?a=1&b=2 'ti"tle')`,
    );
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(html).toContain('title="ti&quot;tle"');
  });
});

describe("renderMarkdownToHtml — raw HTML policy", () => {
  it("renders raw HTML as escaped text when raw_html is false", () => {
    const html = renderMarkdownToHtml("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("escapes inline raw HTML inside paragraphs", () => {
    const html = renderMarkdownToHtml("Hello <b onclick='x'>world</b>.");
    expect(html).not.toContain("<b");
    expect(html).toContain("&lt;b onclick=&#39;x&#39;&gt;");
  });

  it("emits raw HTML verbatim only when raw_html is true", () => {
    const html = renderMarkdownToHtml("<aside>note</aside>", { rawHtmlAllowed: true });
    expect(html).toContain("<aside>note</aside>");
  });

  it("strips authorbot marker comments even when raw_html is true", () => {
    const html = renderMarkdownToHtml(`${marker(B1)}\nA paragraph.`, {
      rawHtmlAllowed: true,
    });
    expect(html).not.toContain("authorbot");
    expect(html).toContain(`<p id="b-${B1}">A paragraph.</p>`);
  });
});

describe("renderMarkdownToHtml — block anchors", () => {
  it("anchors a marked paragraph and strips the marker", () => {
    const html = renderMarkdownToHtml(`${marker(B1)}\nThe drift appeared.`);
    expect(html).toBe(`<p id="b-${B1}">The drift appeared.</p>\n`);
  });

  it("anchors marked headings, code blocks, and blockquotes", () => {
    const source = [
      marker(B1),
      "# Title",
      "",
      marker(B2),
      "> Quoted line.",
      "",
    ].join("\n");
    const html = renderMarkdownToHtml(source);
    expect(html).toContain(`<h1 id="b-${B1}">Title</h1>`);
    expect(html).toContain(`<blockquote id="b-${B2}">`);
  });

  it("does not anchor a block separated from its marker by a blank line", () => {
    const html = renderMarkdownToHtml(`${marker(B1)}\n\nDetached paragraph.`);
    expect(html).toContain("<p>Detached paragraph.</p>");
    expect(html).not.toContain(`id="b-${B1}"`);
  });

  it("ignores markers with a non-UUIDv7 id", () => {
    const html = renderMarkdownToHtml(`${marker("not-a-uuid")}\nParagraph.`);
    expect(html).toContain("<p>Paragraph.</p>");
    expect(html).not.toContain("id=");
    expect(html).not.toContain("authorbot");
  });

  it("anchors marked blocks nested in blockquotes", () => {
    const source = [`> ${marker(B1)}`, "> Inner paragraph."].join("\n");
    const html = renderMarkdownToHtml(source);
    expect(html).toContain(`<p id="b-${B1}">Inner paragraph.</p>`);
  });

  it("anchors a marked list on the <ul> only, never its first item too", () => {
    // Regression: a list and its first list item share a start position in
    // mdast, so the same id was stamped on both (invalid duplicate HTML ids).
    const html = renderMarkdownToHtml(`${marker(B1)}\n- first\n- second\n`);
    expect(html).toContain(`<ul id="b-${B1}">`);
    expect(html).toContain("<li>first</li>");
    expect(html.match(new RegExp(`id="b-${B1}"`, "g"))).toHaveLength(1);
  });

  it("hoists a list-item marker onto the <li> without duplicating it on the child block", () => {
    // Regression: `- <!-- marker -->` followed by an indented blockquote or
    // code block rendered the id on both the <li> and the inner element.
    const quoted = renderMarkdownToHtml(
      [`- ${marker(B1)}`, "", "  > Quoted inside the item."].join("\n"),
    );
    expect(quoted).toContain(`<li id="b-${B1}">`);
    expect(quoted.match(new RegExp(`id="b-${B1}"`, "g"))).toHaveLength(1);

    const coded = renderMarkdownToHtml(
      [`- ${marker(B2)}`, "", "  ```", "  code();", "  ```"].join("\n"),
    );
    expect(coded).toContain(`<li id="b-${B2}">`);
    expect(coded.match(new RegExp(`id="b-${B2}"`, "g"))).toHaveLength(1);
  });

  it("still anchors a tight marked list item on the <li>", () => {
    const html = renderMarkdownToHtml(
      [`- ${marker(B1)}`, "  A marked item.", "- Unmarked item."].join("\n"),
    );
    expect(html).toContain(`<li id="b-${B1}">A marked item.</li>`);
    expect(html.match(new RegExp(`id="b-${B1}"`, "g"))).toHaveLength(1);
  });
});

describe("renderMarkdownToHtml — URL schemes", () => {
  it("drops links with disallowed schemes but keeps their text", () => {
    const html = renderMarkdownToHtml("[click me](javascript:alert(1))");
    expect(html).toContain("click me");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("javascript:");
  });

  it("drops data: and vbscript: links", () => {
    for (const url of ["data:text/html,x", "vbscript:x", "file:///etc/passwd"]) {
      const html = renderMarkdownToHtml(`[x](${url})`);
      expect(html).not.toContain("<a");
    }
  });

  it("defeats whitespace scheme smuggling in bracketed destinations", () => {
    const html = renderMarkdownToHtml("[x](<java script:alert(1)>)");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("script:");
  });

  it("keeps http, https, mailto, and relative links", () => {
    for (const url of [
      "https://example.com/a",
      "http://example.com/",
      "mailto:me@example.com",
      "../other/",
      "#b-anchor",
    ]) {
      const html = renderMarkdownToHtml(`[x](${url})`);
      expect(html).toContain(`<a href="${url}">x</a>`);
    }
  });

  it("collapses images with disallowed schemes to their alt text (marked as non-atom text)", () => {
    const html = renderMarkdownToHtml("![a diagram](javascript:evil())");
    // data-ab-skip: the alt text has no atom in the normalized stream, so the
    // islands' DOM normalizer must exclude it (Phase 2b §2.2 parity).
    expect(html).toBe("<p><span data-ab-skip>a diagram</span></p>\n");
  });

  it("renders images with allowed schemes", () => {
    const html = renderMarkdownToHtml("![alt](https://example.com/i.png)");
    expect(html).toContain('<img src="https://example.com/i.png" alt="alt" />');
  });

  it("filters schemes on reference-style links too", () => {
    const bad = renderMarkdownToHtml("[x][ref]\n\n[ref]: javascript:alert(1)");
    expect(bad).not.toContain("<a");
    const good = renderMarkdownToHtml("[x][ref]\n\n[ref]: https://example.com/");
    expect(good).toContain('<a href="https://example.com/">x</a>');
  });
});

describe("renderMarkdownToHtml — structure", () => {
  it("renders ordered and unordered lists", () => {
    const html = renderMarkdownToHtml("- one\n- two\n\n2. a\n3. b\n");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('<ol start="2">');
  });

  it("renders emphasis, strong, breaks, and thematic breaks", () => {
    const html = renderMarkdownToHtml("*em* **strong**\n\n---\n");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<hr />");
  });

  it("omits frontmatter from output", () => {
    const html = renderMarkdownToHtml("---\ntitle: X\n---\n\nBody.");
    expect(html).not.toContain("title");
    expect(html).toContain("<p>Body.</p>");
  });

  it("renders unresolved reference links as plain text", () => {
    const html = renderMarkdownToHtml("[x][nope]");
    expect(html).not.toContain("<a");
    expect(html).toContain("x");
  });
});

describe("renderMarkdownToHtml — GFM", () => {
  const table = [
    "| Left | Center | Right | Default |",
    "|:-----|:------:|------:|---------|",
    "| a | b | c | d |",
    "",
  ].join("\n");

  it("renders tables with a header row of <th scope=\"col\"> in a scroll wrapper", () => {
    const html = renderMarkdownToHtml(table);
    expect(html).toContain('<div class="table-wrap"><table>');
    expect(html).toContain("<thead>");
    expect(html).toContain('<th scope="col" style="text-align:left">Left</th>');
    expect(html).toContain("<tbody>");
    expect(html).toContain("</table></div>");
    // No pipe characters survive into the rendered output.
    expect(html).not.toContain("|");
  });

  it("honors the align array per column and omits style for default columns", () => {
    const html = renderMarkdownToHtml(table);
    expect(html).toContain('<th scope="col" style="text-align:center">Center</th>');
    expect(html).toContain('<th scope="col" style="text-align:right">Right</th>');
    expect(html).toContain('<th scope="col">Default</th>');
    expect(html).toContain('<td style="text-align:left">a</td>');
    expect(html).toContain("<td>d</td>");
  });

  it("escapes text and drops forbidden links inside table cells", () => {
    const html = renderMarkdownToHtml(
      [
        "| Name | Link |",
        "|---|---|",
        '| <script>alert(1)</script> | [click](javascript:alert(1)) |',
        "",
      ].join("\n"),
    );
    // Escaped raw HTML fragments are wrapped as non-atom text (§2.2 parity).
    expect(html).toContain("<span data-ab-skip>&lt;script&gt;</span>alert(1)");
    expect(html).toContain("&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<td>click</td>");
  });

  it("anchors a marked table on the wrapper exactly once", () => {
    const html = renderMarkdownToHtml(`${marker(B1)}\n${table}`);
    expect(html).toContain(`<div class="table-wrap" id="b-${B1}"><table>`);
    expect(html.match(new RegExp(`id="b-${B1}"`, "g"))).toHaveLength(1);
    expect(html).not.toContain("authorbot");
  });

  it("renders strikethrough as <del>", () => {
    const html = renderMarkdownToHtml("Keep ~~drop this~~ the rest.");
    expect(html).toContain("Keep <del>drop this</del> the rest.");
  });

  it("renders task-list items as disabled checkboxes without any script", () => {
    const html = renderMarkdownToHtml("- [x] logged\n- [ ] explained\n");
    expect(html).toContain('<ul class="task-list">');
    expect(html).toContain(
      '<li class="task-item"><input type="checkbox" disabled checked /> logged</li>',
    );
    expect(html).toContain(
      '<li class="task-item"><input type="checkbox" disabled /> explained</li>',
    );
    expect(html).not.toContain("<script");
  });

  it("renders autolink literals as links subject to the scheme allow-list", () => {
    const html = renderMarkdownToHtml("See www.example.com or joe@example.com.");
    expect(html).toContain('<a href="http://www.example.com">www.example.com</a>');
    expect(html).toContain('<a href="mailto:joe@example.com">joe@example.com</a>');
  });

  it("renders footnotes as sup links plus an endnote list with back links", () => {
    const html = renderMarkdownToHtml(
      "A claim[^n] repeated[^n].\n\n[^n]: The <em>note</em>.\n",
    );
    expect(html).toContain('<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>');
    // The second reference links to the same note without duplicating the id.
    expect(html.match(/id="fnref-1"/g)).toHaveLength(1);
    expect(html.match(/href="#fn-1"/g)).toHaveLength(2);
    expect(html).toContain('<li id="fn-1">');
    expect(html).toContain('href="#fnref-1"');
    // Footnote bodies go through the same escaping as everything else (the
    // escaped fragments are wrapped as non-atom text for §2.2 parity).
    expect(html).toContain("&lt;em&gt;");
    expect(html).toContain("&lt;/em&gt;");
    expect(html).not.toContain("<em>note</em>");
  });

  it("strips unreferenced footnote definitions without crashing", () => {
    const html = renderMarkdownToHtml("Plain prose.\n\n[^ghost]: Never referenced.\n");
    expect(html).toContain("<p>Plain prose.</p>");
    expect(html).not.toContain("Never referenced");
    expect(html).not.toContain("footnotes");
  });
});
