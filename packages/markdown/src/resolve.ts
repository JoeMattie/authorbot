import type { Root, RootContent } from "mdast";
import type { Position } from "unist";
import { CONTINUE, EXIT, visit } from "unist-util-visit";
import type { AssociatedBlockType } from "./blocks.js";
import { normalizeBlockText } from "./normalize.js";
import { parseChapterMarkdown } from "./parse.js";

/**
 * Selector resolution per design §10.2 steps 1–4 ONLY (Phase 4 contract:
 * fuzzy step 5 is deferred; never guess):
 *
 * 1. Match the stable blockId.
 * 2. Verify the stored text position against the exact quote → `exact`.
 * 3. Search exact quote (+ prefix/suffix to disambiguate) in that block
 *    → `relocated`.
 * 4. Search exact quote (+ context) chapter-wide → `relocated`.
 *
 * `ambiguous` when more than one candidate survives context filtering;
 * `missing` when none. Documented details:
 *
 * - A single quote occurrence is accepted without context verification
 *   (context is a disambiguator among multiple exact matches, not a fuzzy
 *   score).
 * - Context matching is exact, but truncated at block edges: a candidate
 *   flush against the block start/end matches when the stored prefix/suffix
 *   ends/starts with the shorter available text.
 * - Offsets are UTF-16 code units in the normalized block text (the same
 *   stream `normalizeBlockText` produces and Phase 2 annotations store).
 * - An empty exact quote resolves to `missing`.
 */

export interface RangeTarget {
  blockId: string;
  textPosition?: { start: number; end: number } | undefined;
  textQuote: {
    exact: string;
    prefix?: string | undefined;
    suffix?: string | undefined;
  };
}

export type ResolutionKind = "exact" | "relocated" | "ambiguous" | "missing";

export interface ResolvedSpan {
  blockId: string;
  /** Inclusive start offset in the block's normalized text. */
  start: number;
  /** Exclusive end offset in the block's normalized text. */
  end: number;
}

export interface ResolveResult {
  kind: ResolutionKind;
  /** Present for `exact` and `relocated`. */
  span?: ResolvedSpan;
}

/** A valid marker with its associated mdast block node. */
export interface MarkedBlock {
  id: string;
  node: RootContent;
  blockPosition: Position;
}

function findBlockNode(
  ast: Root,
  type: AssociatedBlockType,
  pos: Position,
): RootContent | undefined {
  if (pos.start.offset === undefined || pos.end.offset === undefined) {
    return undefined;
  }
  let found: RootContent | undefined;
  visit(ast, (node) => {
    if (
      node.type === type &&
      node.position !== undefined &&
      node.position.start.offset === pos.start.offset &&
      node.position.end.offset === pos.end.offset
    ) {
      found = node as RootContent;
      return EXIT;
    }
    return CONTINUE;
  });
  return found;
}

/**
 * All valid markers in document order paired with their block nodes.
 * Markers whose id is not UUIDv7 or that identify no block are skipped
 * (validation, not resolution, reports those).
 */
export function listMarkedBlocks(source: string): MarkedBlock[] {
  const parsed = parseChapterMarkdown(source);
  const out: MarkedBlock[] = [];
  for (const marker of parsed.blocks.markers) {
    if (!marker.valid || marker.blockType === null || marker.blockPosition === undefined) {
      continue;
    }
    const node = findBlockNode(parsed.ast, marker.blockType, marker.blockPosition);
    if (node !== undefined) {
      out.push({ id: marker.id, node, blockPosition: marker.blockPosition });
    }
  }
  return out;
}

interface Candidate {
  blockId: string;
  /** Normalized text of the candidate's block. */
  text: string;
  /** Start offset of the exact-quote occurrence. */
  index: number;
}

function occurrencesIn(text: string, exact: string): number[] {
  const out: number[] = [];
  let i = text.indexOf(exact);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(exact, i + 1);
  }
  return out;
}

function prefixMatches(text: string, index: number, prefix: string): boolean {
  if (prefix === "") {
    return true;
  }
  const before = text.slice(Math.max(0, index - prefix.length), index);
  if (before === prefix) {
    return true;
  }
  // Truncated at block start: all available preceding text must be a tail
  // of the stored prefix.
  return index < prefix.length && prefix.endsWith(before);
}

function suffixMatches(text: string, endIndex: number, suffix: string): boolean {
  if (suffix === "") {
    return true;
  }
  const after = text.slice(endIndex, endIndex + suffix.length);
  if (after === suffix) {
    return true;
  }
  return text.length - endIndex < suffix.length && suffix.startsWith(after);
}

type Pick =
  | { kind: "one"; candidate: Candidate }
  | { kind: "ambiguous" }
  | { kind: "zero" };

function pickCandidate(
  candidates: Candidate[],
  exact: string,
  prefix: string,
  suffix: string,
): Pick {
  if (candidates.length === 0) {
    return { kind: "zero" };
  }
  const single = candidates[0];
  if (candidates.length === 1 && single !== undefined) {
    return { kind: "one", candidate: single };
  }
  const filtered = candidates.filter(
    (c) =>
      prefixMatches(c.text, c.index, prefix) &&
      suffixMatches(c.text, c.index + exact.length, suffix),
  );
  const only = filtered[0];
  if (filtered.length === 1 && only !== undefined) {
    return { kind: "one", candidate: only };
  }
  return { kind: "ambiguous" };
}

/** Resolve a stored range selector against a chapter source (§10.2 1–4). */
export function resolveTarget(source: string, target: RangeTarget): ResolveResult {
  const exact = target.textQuote.exact.normalize("NFC");
  if (exact.length === 0) {
    return { kind: "missing" };
  }
  const prefix = (target.textQuote.prefix ?? "").normalize("NFC");
  const suffix = (target.textQuote.suffix ?? "").normalize("NFC");

  const blocks = listMarkedBlocks(source);
  const targetBlock = blocks.find((b) => b.id === target.blockId);

  if (targetBlock !== undefined) {
    const norm = normalizeBlockText(targetBlock.node).text;

    // Step 2: stored position + exact-quote verification.
    const tp = target.textPosition;
    if (
      tp !== undefined &&
      Number.isInteger(tp.start) &&
      Number.isInteger(tp.end) &&
      tp.start >= 0 &&
      tp.start < tp.end &&
      tp.end <= norm.length &&
      norm.slice(tp.start, tp.end) === exact
    ) {
      return {
        kind: "exact",
        span: { blockId: target.blockId, start: tp.start, end: tp.end },
      };
    }

    // Step 3: quote (+ context) within the block.
    const inBlock = occurrencesIn(norm, exact).map(
      (index): Candidate => ({ blockId: target.blockId, text: norm, index }),
    );
    const picked = pickCandidate(inBlock, exact, prefix, suffix);
    if (picked.kind === "one") {
      return {
        kind: "relocated",
        span: {
          blockId: picked.candidate.blockId,
          start: picked.candidate.index,
          end: picked.candidate.index + exact.length,
        },
      };
    }
    if (picked.kind === "ambiguous") {
      return { kind: "ambiguous" };
    }
  }

  // Step 4: quote (+ context) chapter-wide.
  const all: Candidate[] = [];
  for (const b of blocks) {
    const norm = normalizeBlockText(b.node).text;
    for (const index of occurrencesIn(norm, exact)) {
      all.push({ blockId: b.id, text: norm, index });
    }
  }
  const picked = pickCandidate(all, exact, prefix, suffix);
  if (picked.kind === "one") {
    return {
      kind: "relocated",
      span: {
        blockId: picked.candidate.blockId,
        start: picked.candidate.index,
        end: picked.candidate.index + exact.length,
      },
    };
  }
  if (picked.kind === "ambiguous") {
    return { kind: "ambiguous" };
  }
  return { kind: "missing" };
}
