// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { normalizeDomBlock } from "../site/src/islands/normalize.js";
import {
  captureRange,
  closestBlock,
  QUOTE_CONTEXT,
  resolveTextBoundary,
} from "../site/src/islands/selection.js";

/**
 * Selection → selector mapping (Phase 2b contract §2.2): a DOM Range within a
 * single anchored block yields `{ blockId, textPosition, textQuote }` against
 * the block's normalized text; anything else yields null.
 */

function mount(html: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "prose";
  container.innerHTML = html; // trusted test fixture
  document.body.append(container);
  return container;
}

interface RangeLike {
  collapsed: boolean;
  commonAncestorContainer: Node;
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
}

function rangeOf(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
  common: Node,
): RangeLike {
  return {
    collapsed: start === end && startOffset === endOffset,
    commonAncestorContainer: common,
    startContainer: start,
    startOffset,
    endContainer: end,
    endOffset,
  };
}

describe("closestBlock", () => {
  it("finds the innermost b- ancestor", () => {
    const root = mount('<ul id="b-11111"><li id="b-22222">alpha</li></ul>');
    const text = root.querySelector("li")?.firstChild as Text;
    expect(closestBlock(text)?.id).toBe("b-22222");
  });

  it("finds the block identity projected by the Milkdown Notes decoration", () => {
    const root = mount('<p data-authorbot-block-id="rich-111">decorated prose</p>');
    const text = root.querySelector("p")?.firstChild as Text;
    expect(closestBlock(text)?.dataset.authorbotBlockId).toBe("rich-111");
  });

  it("returns null outside any anchored block", () => {
    const root = mount("<p>unanchored</p>");
    expect(closestBlock(root.querySelector("p")?.firstChild ?? null)).toBeNull();
  });
});

describe("captureRange", () => {
  it("maps a plain selection to offsets and a bounded quote", () => {
    const root = mount('<p id="b-aaa">The drift appeared on a Tuesday, in the fourth decimal place.</p>');
    const text = root.querySelector("p")?.firstChild as Text;
    // Select "drift"
    const capture = captureRange(rangeOf(text, 4, text, 9, text));
    expect(capture).not.toBeNull();
    expect(capture?.selector.blockId).toBe("aaa");
    expect(capture?.selector.textPosition).toEqual({ start: 4, end: 9 });
    expect(capture?.selector.textQuote.exact).toBe("drift");
    expect(capture?.selector.textQuote.prefix).toBe("The ");
    expect(capture?.selector.textQuote.suffix).toBe(
      " appeared on a Tuesday, in the f",
    );
    expect(capture?.selector.textQuote.suffix?.length).toBeLessThanOrEqual(QUOTE_CONTEXT);
  });

  it("keeps range selectors canonical inside the Milkdown Notes surface", () => {
    const root = mount(
      '<p data-authorbot-block-id="rich-222">The drift appeared on a Tuesday.</p>',
    );
    const text = root.querySelector("p")?.firstChild as Text;
    const capture = captureRange(rangeOf(text, 4, text, 9, text));
    expect(capture?.selector).toMatchObject({
      blockId: "rich-222",
      textPosition: { start: 4, end: 9 },
      textQuote: { exact: "drift" },
    });
  });

  it("spans inline formatting inside one block", () => {
    const root = mount('<p id="b-bbb">Some <em>emphasized</em> words</p>');
    const p = root.querySelector("p") as HTMLElement;
    const emText = root.querySelector("em")?.firstChild as Text;
    const tail = p.lastChild as Text; // " words"
    const capture = captureRange(rangeOf(emText, 0, tail, 4, p));
    expect(normalizeDomBlock(p)).toBe("Some emphasized words");
    expect(capture?.selector.textPosition).toEqual({ start: 5, end: 19 });
    expect(capture?.selector.textQuote.exact).toBe("emphasized wor");
  });

  it("collapses whitespace and tightens the quote to visible characters", () => {
    const root = mount('<p id="b-ccc">A   spaced   phrase</p>');
    const text = root.querySelector("p")?.firstChild as Text;
    expect(normalizeDomBlock(root.querySelector("p") as Element)).toBe("A spaced phrase");
    // Raw selection "   spaced   " (offsets 1..12) includes the space runs.
    const capture = captureRange(rangeOf(text, 1, text, 12, text));
    expect(capture?.selector.textPosition).toEqual({ start: 2, end: 8 });
    expect(capture?.selector.textQuote.exact).toBe("spaced");
    expect(capture?.selector.textQuote.prefix).toBe("A ");
  });

  it("handles element-container boundaries (select-all of a block)", () => {
    const root = mount('<p id="b-ddd">Whole <em>block</em> here</p>');
    const p = root.querySelector("p") as HTMLElement;
    const capture = captureRange(rangeOf(p, 0, p, p.childNodes.length, p));
    expect(capture?.selector.textPosition).toEqual({ start: 0, end: 16 });
    expect(capture?.selector.textQuote.exact).toBe("Whole block here");
    expect(capture?.selector.textQuote.prefix).toBeUndefined();
    expect(capture?.selector.textQuote.suffix).toBeUndefined();
  });

  it("treats an anchored list as one block for selections across items", () => {
    const root = mount('<ul id="b-eee"><li>alpha</li><li>beta</li></ul>');
    const ul = root.querySelector("ul") as HTMLElement;
    const first = root.querySelectorAll("li")[0]?.firstChild as Text;
    const second = root.querySelectorAll("li")[1]?.firstChild as Text;
    const capture = captureRange(rangeOf(first, 2, second, 2, ul));
    expect(normalizeDomBlock(ul)).toBe("alpha beta");
    expect(capture?.selector.blockId).toBe("eee");
    expect(capture?.selector.textQuote.exact).toBe("pha be");
  });

  it("rejects selections spanning two sibling blocks", () => {
    const root = mount('<p id="b-fff">one</p><p id="b-ggg">two</p>');
    const first = root.querySelectorAll("p")[0]?.firstChild as Text;
    const second = root.querySelectorAll("p")[1]?.firstChild as Text;
    const capture = captureRange(rangeOf(first, 0, second, 3, root));
    expect(capture).toBeNull();
  });

  it("clamps an end boundary in inter-block whitespace (drag past the line end)", () => {
    // The renderer separates sibling blocks with a newline text node
    // (`</p>\n<p>`): a drag whose end lands there hoists the common ancestor
    // to the prose container, but every visible character is inside b-jjj.
    const container = document.createElement("div");
    container.className = "prose";
    const p1 = document.createElement("p");
    p1.id = "b-jjj";
    p1.textContent = "First paragraph.";
    const p2 = document.createElement("p");
    p2.id = "b-kkk";
    p2.textContent = "Second paragraph.";
    container.append(p1, document.createTextNode("\n"), p2);
    document.body.append(container);
    const text = p1.firstChild as Text;
    const newline = p1.nextSibling as Text;
    const capture = captureRange(rangeOf(text, 6, newline, 1, container));
    expect(capture).not.toBeNull();
    expect(capture?.selector.blockId).toBe("jjj");
    expect(capture?.selector.textQuote.exact).toBe("paragraph.");
  });

  it("clamps an end boundary at offset 0 of the next element (triple-click)", () => {
    // The islands insert a .ab-block-ui div after each block; a triple-click
    // paragraph selection ends at that div's offset 0.
    const container = document.createElement("div");
    container.className = "prose";
    const p = document.createElement("p");
    p.id = "b-lll";
    p.textContent = "Triple clicked paragraph.";
    const ui = document.createElement("div");
    ui.className = "ab-block-ui";
    ui.setAttribute("data-ab-ui", "true");
    const button = document.createElement("button");
    button.textContent = "✎";
    ui.append(button);
    container.append(p, ui);
    document.body.append(container);
    const text = p.firstChild as Text;
    const capture = captureRange(rangeOf(text, 0, ui, 0, container));
    expect(capture).not.toBeNull();
    expect(capture?.selector.blockId).toBe("lll");
    expect(capture?.selector.textQuote.exact).toBe("Triple clicked paragraph.");
    expect(capture?.selector.textPosition).toEqual({ start: 0, end: 25 });
  });

  it("rejects collapsed and whitespace-only selections", () => {
    const root = mount('<p id="b-hhh">gap   here</p>');
    const text = root.querySelector("p")?.firstChild as Text;
    expect(captureRange(rangeOf(text, 2, text, 2, text))).toBeNull();
    // Only the whitespace run selected.
    expect(captureRange(rangeOf(text, 3, text, 6, text))).toBeNull();
  });

  it("resolves element boundaries to text positions", () => {
    const root = mount('<p id="b-iii">alpha <em>beta</em> gamma</p>');
    const p = root.querySelector("p") as HTMLElement;
    const start = resolveTextBoundary(p, 1, "start"); // before <em>
    expect(start?.node.data).toBe("beta");
    expect(start?.offset).toBe(0);
    const end = resolveTextBoundary(p, 2, "end"); // after <em>
    expect(end?.node.data).toBe("beta");
    expect(end?.offset).toBe(4);
  });
});
