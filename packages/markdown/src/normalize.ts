import type { Nodes } from "mdast";
import type { Position } from "unist";

/**
 * Normalized plain-text stream for a semantic block (design section 10.1):
 * NFC-normalized, whitespace collapsed to single spaces, trimmed. Positions
 * for annotation text-position selectors are measured against this stream,
 * not raw source or HTML offsets.
 *
 * The mapping is segment-based: each segment covers the characters
 * contributed by one source node (text, inlineCode, or code value) and
 * records that node's source position. Joiner spaces emitted between nodes
 * fall between segments. NFC is applied per text node; combining sequences
 * that span node boundaries are not re-composed.
 */

export interface NormalizedSegment {
  /** Inclusive start offset in the normalized text. */
  normStart: number;
  /** Exclusive end offset in the normalized text. */
  normEnd: number;
  /** Source position of the node that contributed this range. */
  sourcePosition: Position | undefined;
}

export interface NormalizedText {
  text: string;
  segments: NormalizedSegment[];
}

interface Atom {
  value: string;
  position: Position | undefined;
}

/** Containers whose children are flow blocks needing a separator between them. */
const FLOW_CONTAINERS: ReadonlySet<string> = new Set([
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
]);

function collectAtoms(node: Nodes, atoms: Atom[]): void {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      atoms.push({ value: node.value, position: node.position });
      return;
    case "break":
      atoms.push({ value: " ", position: node.position });
      return;
    case "html":
      // Raw HTML and authorbot comments contribute no prose text.
      return;
    case "image":
    case "imageReference":
      return;
    default:
      if ("children" in node) {
        const separate = FLOW_CONTAINERS.has(node.type);
        for (let i = 0; i < node.children.length; i += 1) {
          if (separate && i > 0) {
            atoms.push({ value: " ", position: undefined });
          }
          const child = node.children[i];
          if (child !== undefined) {
            collectAtoms(child, atoms);
          }
        }
      }
  }
}

const WHITESPACE = /\s/;

/**
 * Produce the normalized plain-text stream for one block node, with a
 * segment mapping back to source positions.
 */
export function normalizeBlockText(node: Nodes): NormalizedText {
  const atoms: Atom[] = [];
  collectAtoms(node, atoms);

  let text = "";
  const segments: NormalizedSegment[] = [];
  let pendingSpace = false;

  for (const atom of atoms) {
    const value = atom.value.normalize("NFC");
    let segStart = -1;
    for (const ch of value) {
      if (WHITESPACE.test(ch)) {
        if (text.length > 0) {
          pendingSpace = true;
        }
        continue;
      }
      if (pendingSpace) {
        // A collapsed space flushes when the next non-whitespace character
        // arrives; if this atom's segment is already open the space is
        // inside it, otherwise it falls in the gap before the segment.
        text += " ";
        pendingSpace = false;
      }
      if (segStart === -1) {
        segStart = text.length;
      }
      text += ch;
    }
    if (segStart !== -1) {
      segments.push({
        normStart: segStart,
        normEnd: text.length,
        sourcePosition: atom.position,
      });
    }
  }

  return { text, segments };
}
