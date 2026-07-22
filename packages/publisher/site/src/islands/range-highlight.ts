/**
 * Turn a persisted normalized-text selector back into a DOM Range.
 *
 * Annotation selectors are stored against the normalized prose stream, not
 * raw text-node offsets. `locateDomBoundary` is the canonical DOM -> stream
 * mapping, so this small inverse deliberately asks it for candidate
 * boundaries rather than maintaining a second normalization algorithm.
 */
import { collectDomAtoms, locateDomBoundary } from "./normalize.js";

export interface HighlightSelector {
  textPosition: { start: number; end: number };
  textQuote?: { exact: string };
}

function normalizedQuote(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function textNodes(root: Element): Text[] {
  const seen = new Set<Text>();
  const nodes: Text[] = [];
  for (const atom of collectDomAtoms(root)) {
    if (atom.node !== null && !seen.has(atom.node)) {
      seen.add(atom.node);
      nodes.push(atom.node);
    }
  }
  return nodes;
}

function boundaryAt(
  root: Element,
  target: number,
  edge: "start" | "end",
): { node: Text; offset: number } | null {
  for (const node of textNodes(root)) {
    for (let offset = 0; offset <= node.data.length; offset += 1) {
      if (locateDomBoundary(root, node, offset, edge) === target) {
        return { node, offset };
      }
    }
  }
  return null;
}

/** Resolve a selector only when the live text still matches its quote. */
export function rangeForSelector(root: Element, selector: HighlightSelector): Range | null {
  const { start, end } = selector.textPosition;
  if (start < 0 || end <= start) {
    return null;
  }
  const startBoundary = boundaryAt(root, start, "start");
  const endBoundary = boundaryAt(root, end, "end");
  if (startBoundary === null || endBoundary === null) {
    return null;
  }
  const range = document.createRange();
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);
  if (range.collapsed) {
    return null;
  }
  const quote = selector.textQuote?.exact;
  if (quote !== undefined && normalizedQuote(range.toString()) !== normalizedQuote(quote)) {
    return null;
  }
  return range;
}

/** Remove island-owned marks while retaining every original prose node. */
export function clearRangeHighlights(root: ParentNode): void {
  for (const mark of root.querySelectorAll<HTMLElement>("mark.ab-inline-highlight")) {
    mark.replaceWith(...Array.from(mark.childNodes));
  }
  if (root instanceof HTMLElement) {
    root.normalize();
  }
}
