import type { Nodes } from "mdast";
import type { Position } from "unist";

/**
 * Normalized-offset → source-offset mapping for one semantic block (Phase 4
 * contract §5; design §8.4). Builds the same normalized plain-text stream as
 * `normalizeBlockText` (a property test guards against drift) but records,
 * per UTF-16 code unit of the normalized text, the exact source byte span
 * that produced it — when such a span exists.
 *
 * Conservatism (documented behavior, never a guess):
 *
 * - Only "exactly mappable" inline atoms get per-character source spans: a
 *   `text` node whose raw source slice equals its value (rules out entity
 *   references), an `inlineCode` node whose inner content is recoverable
 *   between its backtick runs, and a fenced `code` block whose value is a
 *   contiguous source slice. All must be NFC-stable in source.
 * - Everything else (NFD source, entities, indented code, multi-line text
 *   inside blockquotes, hard breaks, joiner spaces between inline nodes)
 *   maps to `null`. A replacement span touching an unmapped character — or
 *   spanning two different atoms, i.e. crossing a markup boundary — is NOT
 *   one contiguous source span and must be refused (§8.4).
 */

export interface MappedUnit {
  /** Inclusive source start offset, or null when unmappable. */
  srcStart: number | null;
  /** Exclusive source end offset, or null when unmappable. */
  srcEnd: number | null;
  /** Index of the contributing atom, or null (joiner/unmappable). */
  atom: number | null;
  /** True when this UTF-16 unit begins a code point. */
  cpStart: boolean;
}

export interface BlockCharMap {
  /** Normalized text, identical to `normalizeBlockText(node).text`. */
  text: string;
  /** One entry per UTF-16 code unit of `text`. */
  units: MappedUnit[];
}

interface SrcAtom {
  value: string;
  position: Position | undefined;
  kind: "text" | "inlineCode" | "code" | "space";
}

/** Containers whose children are flow blocks needing a separator between them. */
const FLOW_CONTAINERS: ReadonlySet<string> = new Set([
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
]);

const WHITESPACE = /\s/;

/** Mirror of normalize.ts `collectAtoms`, keeping node kind for mapping. */
function collectAtoms(node: Nodes, atoms: SrcAtom[]): void {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      atoms.push({ value: node.value, position: node.position, kind: node.type });
      return;
    case "break":
      atoms.push({ value: " ", position: node.position, kind: "space" });
      return;
    case "html":
    case "image":
    case "imageReference":
      return;
    default:
      if ("children" in node) {
        const separate = FLOW_CONTAINERS.has(node.type);
        for (let i = 0; i < node.children.length; i += 1) {
          if (separate && i > 0) {
            atoms.push({ value: " ", position: undefined, kind: "space" });
          }
          const child = node.children[i];
          if (child !== undefined) {
            collectAtoms(child, atoms);
          }
        }
      }
  }
}

/**
 * Source offset of the atom's first value character when the value is an
 * exact contiguous source slice, else null (atom is unmappable).
 */
function atomBase(source: string, atom: SrcAtom): number | null {
  if (atom.kind === "space") {
    return null;
  }
  const pos = atom.position;
  if (pos?.start.offset === undefined || pos.end.offset === undefined) {
    return null;
  }
  const start = pos.start.offset;
  const value = atom.value;
  if (value.length === 0 || value.normalize("NFC") !== value) {
    return null;
  }
  const slice = source.slice(start, pos.end.offset);

  if (atom.kind === "text") {
    // Entities and any other source transform make slice !== value.
    return slice === value ? start : null;
  }

  if (atom.kind === "inlineCode") {
    const m = /^(`+)/.exec(slice);
    const delim = m?.[1] ?? "";
    if (delim === "" || !slice.endsWith(delim) || slice.length < delim.length * 2 + value.length) {
      return null;
    }
    const inner = slice.slice(delim.length, slice.length - delim.length);
    if (inner === value) {
      return start + delim.length;
    }
    // CommonMark strips one leading+trailing space when both are present.
    if (inner === ` ${value} `) {
      return start + delim.length + 1;
    }
    return null;
  }

  // Fenced code block: value begins after the info line and ends right
  // before the newline preceding the closing fence. Indented code blocks and
  // indented fences fail the checks and stay unmappable.
  if (!slice.startsWith("```") && !slice.startsWith("~~~")) {
    return null;
  }
  const nl = slice.indexOf("\n");
  if (nl === -1) {
    return null;
  }
  const base = start + nl + 1;
  if (source.slice(base, base + value.length) !== value) {
    return null;
  }
  if (source.charAt(base + value.length) !== "\n") {
    return null;
  }
  return base;
}

/**
 * Build the per-code-unit normalized→source map for one block node.
 * `source` must be the full document the node was parsed from.
 */
export function buildBlockCharMap(source: string, node: Nodes): BlockCharMap {
  const atoms: SrcAtom[] = [];
  collectAtoms(node, atoms);

  let text = "";
  const units: MappedUnit[] = [];
  /** Pending collapsed-whitespace run, per normalize.ts semantics. */
  let pending: { srcStart: number; srcEnd: number; atom: number } | "unmapped" | null = null;

  const push = (
    ch: string,
    srcStart: number | null,
    srcEnd: number | null,
    atom: number | null,
  ): void => {
    for (let k = 0; k < ch.length; k += 1) {
      units.push({ srcStart, srcEnd, atom, cpStart: k === 0 });
    }
    text += ch;
  };

  for (let ai = 0; ai < atoms.length; ai += 1) {
    const atom = atoms[ai];
    if (atom === undefined) {
      continue;
    }
    const base = atomBase(source, atom);
    const value = atom.value.normalize("NFC");
    let cu = 0; // code-unit cursor into value (=== atom.value when mappable)
    for (const ch of value) {
      if (WHITESPACE.test(ch)) {
        if (text.length > 0) {
          if (base === null) {
            pending = "unmapped";
          } else if (pending === null) {
            pending = { srcStart: base + cu, srcEnd: base + cu + ch.length, atom: ai };
          } else if (pending !== "unmapped" && pending.atom === ai) {
            pending.srcEnd = base + cu + ch.length;
          } else {
            pending = "unmapped";
          }
        }
        cu += ch.length;
        continue;
      }
      if (pending !== null) {
        // A collapsed space is mappable only when its whole whitespace run
        // came from the same mappable atom as the character flushing it.
        if (pending !== "unmapped" && base !== null && pending.atom === ai) {
          push(" ", pending.srcStart, pending.srcEnd, ai);
        } else {
          push(" ", null, null, null);
        }
        pending = null;
      }
      if (base === null) {
        push(ch, null, null, null);
      } else {
        push(ch, base + cu, base + cu + ch.length, ai);
      }
      cu += ch.length;
    }
  }

  return { text, units };
}

/**
 * Map a normalized-offset span back to ONE contiguous source span (§8.4).
 * Returns null when the span is out of bounds, splits a surrogate pair,
 * touches unmappable characters, or crosses a markup (atom) boundary —
 * callers turn null into the typed NotContiguous refusal.
 */
export function mapNormalizedSpanToSource(
  map: BlockCharMap,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return null;
  }
  if (start < 0 || end > map.text.length || start >= end) {
    return null;
  }
  const boundaryOk = (i: number): boolean =>
    i === map.text.length || map.units[i]?.cpStart === true;
  if (!boundaryOk(start) || !boundaryOk(end)) {
    return null;
  }
  let atom: number | null = null;
  for (let i = start; i < end; i += 1) {
    const u = map.units[i];
    if (u === undefined || u.atom === null || u.srcStart === null || u.srcEnd === null) {
      return null;
    }
    if (atom === null) {
      atom = u.atom;
    } else if (u.atom !== atom) {
      return null;
    }
  }
  const first = map.units[start];
  const last = map.units[end - 1];
  if (
    first === undefined ||
    last === undefined ||
    first.srcStart === null ||
    last.srcEnd === null
  ) {
    return null;
  }
  return { start: first.srcStart, end: last.srcEnd };
}
