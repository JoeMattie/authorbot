/**
 * Browser-side mirror of `@authorbot/markdown` `normalizeBlockText` (Phase 2b
 * contract §2.2): the normalized plain-text stream of a rendered semantic
 * block - NFC per text node, whitespace collapsed to single spaces, trimmed -
 * computed from the DOM the publisher emitted instead of the mdast AST.
 *
 * Parity is proven by unit tests against the markdown package's own
 * normalization fixtures (test/islands-normalize-parity.test.ts). The
 * correspondence relies on how `render.ts` serializes the AST:
 *
 * - mdast text/inlineCode/code values become DOM text (escaped), so DOM text
 *   nodes are the text atoms.
 * - mdast `break` contributes a single space; the renderer emits `<br />\n`,
 *   whose newline text node collapses identically.
 * - Flow-container joiner spaces (blockquote children, list items, table
 *   rows/cells) map to boundary whitespace injected around block-level
 *   elements here (the renderer separates most with newlines already; table
 *   cells are the exception, hence TD/TH in the boundary set).
 * - mdast html/image/footnoteReference nodes contribute no text; in the DOM
 *   that means skipping IMG/INPUT and `sup.footnote-ref` (the visible
 *   footnote number has no mdast text atom).
 * - Escaped raw HTML (content.raw_html false) and collapsed forbidden-scheme
 *   image alt text DO become visible DOM text, but have no mdast atom: the
 *   renderer wraps them in `<span data-ab-skip>` and the collector excludes
 *   that subtree, so both streams stay identical.
 */

export interface DomAtom {
  value: string;
  /** Source text node, or null for an injected block-boundary space. */
  node: Text | null;
}

/** Elements whose entire subtree is excluded from the normalized stream. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "IMG", "INPUT", "SELECT", "BUTTON"]);

/** Block-level elements: a whitespace boundary is injected on both sides. */
const BOUNDARY_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
  "OL",
  "UL",
  "LI",
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "TD",
  "TH",
  "DIV",
  "SECTION",
  "FIGURE",
  "FIGCAPTION",
  "HR",
]);

function skipElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) {
    return true;
  }
  // Footnote reference numbers have no text atom in the mdast stream.
  if (el.tagName === "SUP" && el.classList.contains("footnote-ref")) {
    return true;
  }
  // Renderer-marked text with no mdast atom (escaped raw HTML, collapsed
  // image alt text): excluded to mirror `normalizeBlockText`, which skips
  // html/image nodes entirely.
  if (el.hasAttribute("data-ab-skip")) {
    return true;
  }
  // Island-injected UI must never leak into anchoring text (defensive; the
  // islands keep block subtrees pristine).
  return el.hasAttribute("data-ab-ui");
}

function collect(node: Node, atoms: DomAtom[]): void {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    atoms.push({ value: (node as Text).data, node: node as Text });
    return;
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) {
    return;
  }
  const el = node as Element;
  if (skipElement(el)) {
    return;
  }
  const boundary = BOUNDARY_TAGS.has(el.tagName);
  if (boundary) {
    atoms.push({ value: " ", node: null });
  }
  for (let child = el.firstChild; child !== null; child = child.nextSibling) {
    collect(child, atoms);
  }
  if (boundary) {
    atoms.push({ value: " ", node: null });
  }
}

/** Text atoms of a rendered block, in document order. */
export function collectDomAtoms(root: Element): DomAtom[] {
  const atoms: DomAtom[] = [];
  for (let child = root.firstChild; child !== null; child = child.nextSibling) {
    collect(child, atoms);
  }
  return atoms;
}

const WHITESPACE = /\s/;

/** Same collapse state machine as `@authorbot/markdown` normalize.ts. */
class Collapser {
  text = "";
  pendingSpace = false;

  feed(nfcValue: string): void {
    for (const ch of nfcValue) {
      if (WHITESPACE.test(ch)) {
        if (this.text.length > 0) {
          this.pendingSpace = true;
        }
        continue;
      }
      if (this.pendingSpace) {
        this.text += " ";
        this.pendingSpace = false;
      }
      this.text += ch;
    }
  }
}

/** Normalized plain-text stream of one rendered semantic block. */
export function normalizeDomBlock(root: Element): string {
  const collapser = new Collapser();
  for (const atom of collectDomAtoms(root)) {
    collapser.feed(atom.value.normalize("NFC"));
  }
  return collapser.text;
}

/**
 * Normalized-stream offset of a DOM text boundary inside `root`, or null when
 * the node is not part of the block's stream. `edge` disambiguates a boundary
 * sitting on collapsed whitespace: a selection start rounds forward past the
 * pending joiner space, a selection end stays before it - so round-tripping a
 * DOM Range yields the tight `[start, end)` of its visible characters.
 */
export function locateDomBoundary(
  root: Element,
  node: Text,
  offset: number,
  edge: "start" | "end",
): number | null {
  const collapser = new Collapser();
  for (const atom of collectDomAtoms(root)) {
    if (atom.node === node) {
      collapser.feed(node.data.slice(0, offset).normalize("NFC"));
      if (edge === "start") {
        return collapser.text.length + (collapser.pendingSpace ? 1 : 0);
      }
      return collapser.text.length;
    }
    collapser.feed(atom.value.normalize("NFC"));
  }
  return null;
}
