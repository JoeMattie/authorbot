import type { Root, RootContent } from "mdast";
import type { Position } from "unist";
import { visit } from "unist-util-visit";
import { isUuidv7 } from "./uuidv7.js";

/**
 * Block-marker extraction per contract section 3.
 *
 * A marker is `<!-- authorbot:block id="<uuidv7>" -->` on its own line
 * immediately before the semantic block it identifies. v0.1 requires markers
 * on top-level paragraphs, headings, code blocks, and blockquotes; list
 * items, table rows, and blockquote paragraphs are optional marker targets
 * (permitted, not required), so markers are also recognized inside
 * blockquotes and list items. "Immediately before" is enforced by source
 * position: a marker separated from the following block by blank lines does
 * not identify it.
 */

/** Block types a marker may be associated with. */
export type AssociatedBlockType =
  | "paragraph"
  | "heading"
  | "code"
  | "blockquote"
  | "list"
  | "table";

/** Block types that require a marker in Phase 0 (contract section 3). */
export type RequiredBlockType = "paragraph" | "heading" | "code" | "blockquote";

const REQUIRED_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "code",
  "blockquote",
]);

const OPTIONAL_BLOCK_TYPES: ReadonlySet<string> = new Set(["list", "table"]);

/**
 * Container node types whose flow children are scanned for markers: the
 * contract's optional marker units (list item, blockquote paragraph, table
 * row) can only be marked inside their container.
 */
const FLOW_PARENT_TYPES: ReadonlySet<string> = new Set([
  "root",
  "blockquote",
  "listItem",
]);

/** Exact marker grammar. Applied to the trimmed value of a flow-level html node. */
const MARKER_EXACT = /^<!--[ \t]*authorbot:block[ \t]+id="([^"]*)"[ \t]*-->$/;

/** Loose hint that an html node was intended to be a block marker. */
const MARKER_HINT = "authorbot:block";

/** A syntactically parseable marker and its associated block, if any. */
export interface MarkerBlock {
  /** The id attribute as written (may be a non-UUIDv7 string). */
  id: string;
  /**
   * True when the id is a UUIDv7 and a semantic block starts on the line
   * immediately after the marker.
   */
  valid: boolean;
  /** Type of the immediately following block, or null when none follows. */
  blockType: AssociatedBlockType | null;
  /** Source position of the marker comment. */
  position: Position | undefined;
  /** Source position of the associated block, when one exists. */
  blockPosition: Position | undefined;
}

export type MalformedMarkerReason =
  /** Contains `authorbot:block` but does not match the marker grammar. */
  | "bad_syntax"
  /** Marker grammar matched but the id is not a lowercase UUIDv7. */
  | "invalid_id"
  /** Marker is not immediately followed by a semantic block. */
  | "missing_block"
  /** Marker-like comment embedded inline within another block's text. */
  | "not_own_line";

export interface MalformedMarker {
  reason: MalformedMarkerReason;
  /** Raw html value of the offending node. */
  raw: string;
  position: Position | undefined;
  /** The id as written, when the marker grammar parsed far enough to have one. */
  id: string | undefined;
}

/** A top-level required block with no marker on the preceding line. */
export interface UnmarkedBlock {
  blockType: RequiredBlockType;
  position: Position | undefined;
}

export interface BlockScanResult {
  /**
   * All syntactically parseable markers in document order, duplicates
   * included — duplicate-id policy is the caller's concern.
   */
  markers: MarkerBlock[];
  /** Required top-level blocks with no marker (BLOCK_ID_MISSING candidates). */
  unmarked: UnmarkedBlock[];
  /** Marker problems (BLOCK_ID_INVALID candidates). */
  malformed: MalformedMarker[];
}

/** True when `block` starts on the line immediately after `marker` ends. */
function immediatelyPrecedes(
  marker: Position | undefined,
  block: Position | undefined,
): boolean {
  if (marker === undefined || block === undefined) {
    return true; // no positions to compare: stay lenient
  }
  return block.start.line === marker.end.line + 1;
}

/** Scan a parsed chapter for block markers per contract section 3. */
export function extractBlocks(ast: Root): BlockScanResult {
  const markers: MarkerBlock[] = [];
  const unmarked: UnmarkedBlock[] = [];
  const malformed: MalformedMarker[] = [];

  /**
   * Scan a flow-content sequence (root children, blockquote children, or a
   * list item's children). Only top-level required blocks must be marked;
   * nested blocks (blockquote paragraphs, list-item content) may be marked
   * but are never reported as unmarked.
   */
  const scanFlow = (
    children: RootContent[],
    context: "top" | "blockquote" | "listItem",
  ): void => {
    const topLevel = context === "top";
    /** Indices of blocks claimed by the marker on the preceding line. */
    const marked = new Set<number>();
    for (let i = 0; i < children.length; i += 1) {
      const node = children[i];
      if (node === undefined) {
        continue;
      }

      if (node.type === "html" && node.value.includes(MARKER_HINT)) {
        const match = MARKER_EXACT.exec(node.value.trim());
        if (match === null) {
          malformed.push({
            reason: "bad_syntax",
            raw: node.value,
            position: node.position,
            id: undefined,
          });
          continue;
        }

        const id = match[1] ?? "";
        const next = children[i + 1];
        // A marker opening a list item (`- <!-- ... -->`) identifies the item
        // itself, so the blank line of a loose ("spread") item between the
        // marker and the item's content is not a separation; everywhere else
        // the marker must sit on the line immediately before its block.
        const adjacencyExempt = context === "listItem" && i === 0;
        const isBlock =
          next !== undefined &&
          (REQUIRED_BLOCK_TYPES.has(next.type) || OPTIONAL_BLOCK_TYPES.has(next.type)) &&
          (adjacencyExempt || immediatelyPrecedes(node.position, next.position));
        const blockType = isBlock ? (next.type as AssociatedBlockType) : null;
        const idValid = isUuidv7(id);

        if (!idValid) {
          malformed.push({
            reason: "invalid_id",
            raw: node.value,
            position: node.position,
            id,
          });
        }
        if (blockType === null) {
          malformed.push({
            reason: "missing_block",
            raw: node.value,
            position: node.position,
            id,
          });
        } else {
          marked.add(i + 1);
        }
        markers.push({
          id,
          valid: idValid && blockType !== null,
          blockType,
          position: node.position,
          blockPosition: isBlock ? next.position : undefined,
        });
        continue;
      }

      if (topLevel && REQUIRED_BLOCK_TYPES.has(node.type) && !marked.has(i)) {
        unmarked.push({
          blockType: node.type as RequiredBlockType,
          position: node.position,
        });
      }

      // Recurse into containers whose children are contract-optional marker
      // units (blockquote paragraphs, list items).
      if (node.type === "blockquote") {
        scanFlow(node.children, "blockquote");
      } else if (node.type === "list") {
        for (const item of node.children) {
          scanFlow(item.children, "listItem");
        }
      }
    }
  };

  scanFlow(ast.children, "top");

  // Marker-like comments embedded inline (parent is a paragraph, heading, or
  // other non-flow container) are never valid markers: the contract requires
  // the marker on its own line. Flow-level html children of root, blockquote,
  // and listItem were already handled by scanFlow above.
  visit(ast, "html", (node, _index, parent) => {
    if (
      parent !== undefined &&
      parent !== null &&
      !FLOW_PARENT_TYPES.has(parent.type) &&
      node.value.includes(MARKER_HINT)
    ) {
      malformed.push({
        reason: "not_own_line",
        raw: node.value,
        position: node.position,
        id: undefined,
      });
    }
  });

  return { markers, unmarked, malformed };
}
