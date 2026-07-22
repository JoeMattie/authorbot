/**
 * Turn a persisted normalized-text selector back into a DOM Range.
 *
 * Annotation selectors are stored against the normalized prose stream, not
 * raw text-node offsets. `locateDomBoundary` is the canonical DOM -> stream
 * mapping. This inverse walks that same normalized stream once and records the
 * requested DOM boundaries as it goes; it must not rescan the full block once
 * for every character in a long paragraph or code block.
 */
import { collectDomAtoms } from "./normalize.js";

export interface HighlightSelector {
  textPosition: { start: number; end: number };
  textQuote?: { exact: string };
}

function normalizedQuote(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

interface ScanState {
  length: number;
  pendingSpace: boolean;
}

interface BoundaryRequest {
  key: "start" | "end";
  target: number;
  edge: "start" | "end";
}

interface DomBoundary {
  node: Text;
  offset: number;
}

const WHITESPACE = /\s/u;
const GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function feed(state: ScanState, value: string): void {
  for (const ch of value) {
    if (WHITESPACE.test(ch)) {
      if (state.length > 0) state.pendingSpace = true;
      continue;
    }
    if (state.pendingSpace) {
      state.length += 1;
      state.pendingSpace = false;
    }
    state.length += ch.length;
  }
}

function position(state: ScanState, edge: "start" | "end"): number {
  return state.length + (edge === "start" && state.pendingSpace ? 1 : 0);
}

function segments(value: string): { index: number; segment: string }[] {
  if (GRAPHEME_SEGMENTER === null) {
    // `Intl.Segmenter` is available in supported engines. Keep a linear
    // base-plus-mark fallback for embedders on older runtimes so the common
    // decomposed-accent case still maps to the same NFC stream.
    const fallback: { index: number; segment: string }[] = [];
    let index = 0;
    for (const match of value.matchAll(/\P{Mark}\p{Mark}*|\p{Mark}+/gu)) {
      const segment = match[0];
      fallback.push({ index, segment });
      index += segment.length;
    }
    return fallback;
  }
  return Array.from(GRAPHEME_SEGMENTER.segment(value), ({ index, segment }) => ({
    index,
    segment,
  }));
}

function boundariesFor(
  root: Element,
  requests: BoundaryRequest[],
): Map<BoundaryRequest["key"], DomBoundary> {
  const found = new Map<BoundaryRequest["key"], DomBoundary>();
  const state: ScanState = { length: 0, pendingSpace: false };

  const testBoundary = (
    node: Text,
    offset: number,
    candidate: ScanState,
    preferLaterEnd = false,
  ): void => {
    for (const request of requests) {
      if (
        position(candidate, request.edge) === request.target &&
        (!found.has(request.key) || (preferLaterEnd && request.edge === "end"))
      ) {
        found.set(request.key, { node, offset });
      }
    }
  };

  for (const atom of collectDomAtoms(root)) {
    if (atom.node === null) {
      feed(state, atom.value.normalize("NFC"));
      continue;
    }
    const node = atom.node;
    const parts = segments(node.data);
    for (const part of parts) {
      // Check every DOM boundary inside this grapheme against a copy of the
      // state at its start. Graphemes are normally one or two code units, so
      // NFC stays exact without turning the full block scan quadratic.
      for (let inner = 0; inner < part.segment.length; inner += 1) {
        const candidate = { ...state };
        feed(candidate, part.segment.slice(0, inner).normalize("NFC"));
        testBoundary(node, part.index + inner, candidate);
      }
      feed(state, part.segment.normalize("NFC"));
      // A composed grapheme can have the same normalized length immediately
      // before and after its combining marks. For an end boundary, keep the
      // later DOM offset so the selected grapheme stays intact. Do not do this
      // for whitespace, where the earlier boundary deliberately excludes the
      // collapsed trailing run.
      testBoundary(
        node,
        part.index + part.segment.length,
        state,
        !/^\s+$/u.test(part.segment),
      );
    }
    testBoundary(node, node.data.length, state);
    if (found.size === requests.length) return found;
  }
  return found;
}

/** Resolve a selector only when the live text still matches its quote. */
export function rangeForSelector(root: Element, selector: HighlightSelector): Range | null {
  const { start, end } = selector.textPosition;
  if (start < 0 || end <= start) {
    return null;
  }
  const boundaries = boundariesFor(root, [
    { key: "start", target: start, edge: "start" },
    { key: "end", target: end, edge: "end" },
  ]);
  const startBoundary = boundaries.get("start") ?? null;
  const endBoundary = boundaries.get("end") ?? null;
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
