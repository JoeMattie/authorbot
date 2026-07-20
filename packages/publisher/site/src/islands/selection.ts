/**
 * Selection capture (Phase 2b contract §2.2): map a DOM Range within a single
 * anchored semantic block to the range-annotation selector
 * `{ blockId, textPosition, textQuote }`, computed against the block's
 * normalized text stream (normalize.ts).
 */
import { locateDomBoundary, normalizeDomBlock } from "./normalize.js";

export interface TextPosition {
  start: number;
  end: number;
}

export interface TextQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
}

export interface RangeSelector {
  blockId: string;
  textPosition: TextPosition;
  textQuote: TextQuote;
}

export interface CapturedSelection {
  block: HTMLElement;
  selector: RangeSelector;
}

/** Contract §2.2: prefix/suffix are at most 32 characters. */
export const QUOTE_CONTEXT = 32;

/** Innermost ancestor (or self) carrying a `b-<uuid>` block anchor. */
export function closestBlock(node: Node | null): HTMLElement | null {
  for (let current = node; current !== null; current = current.parentNode) {
    if (current.nodeType === 1) {
      const el = current as HTMLElement;
      if (el.id.startsWith("b-")) {
        return el;
      }
    }
  }
  return null;
}

function firstText(node: Node): Text | null {
  if (node.nodeType === 3) {
    return node as Text;
  }
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    const found = firstText(child);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function lastText(node: Node): Text | null {
  if (node.nodeType === 3) {
    return node as Text;
  }
  for (let child = node.lastChild; child !== null; child = child.previousSibling) {
    const found = lastText(child);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * Snap a Range boundary (which may sit on an element) to a concrete text-node
 * position, rounding inward along `edge`.
 */
export function resolveTextBoundary(
  container: Node,
  offset: number,
  edge: "start" | "end",
): { node: Text; offset: number } | null {
  if (container.nodeType === 3) {
    return { node: container as Text, offset };
  }
  const children: Node[] = [];
  for (let child = container.firstChild; child !== null; child = child.nextSibling) {
    children.push(child);
  }
  if (edge === "start") {
    for (let i = offset; i < children.length; i += 1) {
      const found = firstText(children[i] as Node);
      if (found !== null) {
        return { node: found, offset: 0 };
      }
    }
    const fallback = lastText(container);
    return fallback === null ? null : { node: fallback, offset: fallback.data.length };
  }
  for (let i = offset - 1; i >= 0; i -= 1) {
    const found = lastText(children[i] as Node);
    if (found !== null) {
      return { node: found, offset: found.data.length };
    }
  }
  const fallback = firstText(container);
  return fallback === null ? null : { node: fallback, offset: 0 };
}

/**
 * Map a Range to a selector, or null when the selection is collapsed, spans
 * more than one anchored block, or contains no visible characters.
 *
 * Boundary clamping (§2.2): the block is derived from the resolved START
 * boundary, not from `commonAncestorContainer` — common browser gestures
 * (triple-click paragraph selection, dragging just past the line end) place
 * the END boundary in the inter-block whitespace or the next sibling, which
 * hoists the common ancestor above the block even though every visible
 * selected character sits inside it. An end boundary outside the block is
 * clamped to the block's last text position instead of rejecting the capture.
 */
export function captureRange(range: {
  collapsed: boolean;
  commonAncestorContainer: Node;
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
}): CapturedSelection | null {
  if (range.collapsed) {
    return null;
  }
  const startBoundary = resolveTextBoundary(range.startContainer, range.startOffset, "start");
  if (startBoundary === null) {
    return null;
  }
  const block = closestBlock(startBoundary.node);
  if (block === null) {
    return null;
  }
  let endBoundary = resolveTextBoundary(range.endContainer, range.endOffset, "end");
  if (endBoundary === null || !block.contains(endBoundary.node)) {
    // The end boundary landed outside the block. If visible characters were
    // actually selected out there, this is a genuine multi-block selection —
    // still rejected. Otherwise (inter-block whitespace, a following element
    // at offset 0) it is a boundary overshoot: clamp to the block's end.
    if (
      endBoundary !== null &&
      endBoundary.node.data.slice(0, endBoundary.offset).trim() !== ""
    ) {
      return null;
    }
    const last = lastText(block);
    if (last === null) {
      return null;
    }
    endBoundary = { node: last, offset: last.data.length };
  }
  const text = normalizeDomBlock(block);
  let start = locateDomBoundary(block, startBoundary.node, startBoundary.offset, "start");
  let end = locateDomBoundary(block, endBoundary.node, endBoundary.offset, "end");
  if (start === null || end === null || end <= start || start >= text.length) {
    return null;
  }
  end = Math.min(end, text.length);
  // Tighten to visible characters: a drag that swallowed surrounding
  // whitespace should not put collapsed joiner spaces into the quote.
  while (start < end && text[start] === " ") {
    start += 1;
  }
  while (end > start && text[end - 1] === " ") {
    end -= 1;
  }
  if (end <= start) {
    return null;
  }
  const exact = text.slice(start, end);
  if (exact.length === 0) {
    return null;
  }
  const textQuote: TextQuote = { exact };
  if (start > 0) {
    textQuote.prefix = text.slice(Math.max(0, start - QUOTE_CONTEXT), start);
  }
  if (end < text.length) {
    textQuote.suffix = text.slice(end, end + QUOTE_CONTEXT);
  }
  return {
    block,
    selector: {
      blockId: block.id.slice(2),
      textPosition: { start, end },
      textQuote,
    },
  };
}
