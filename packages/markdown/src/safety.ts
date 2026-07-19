import type { Root } from "mdast";
import type { Position } from "unist";
import { visit } from "unist-util-visit";

/**
 * Safety scan per contract section 5:
 *
 * - `RAW_HTML_FORBIDDEN`: raw HTML nodes in prose. Authorbot marker comments
 *   (`<!-- authorbot:... -->`) are exempt; every other html node — including
 *   ordinary HTML comments — is reported. Enforcement (checking
 *   `content.raw_html`) is the caller's concern.
 * - `URL_SCHEME_FORBIDDEN`: link/image/definition URLs whose scheme is
 *   outside `http`, `https`, `mailto`, or relative.
 */

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto"]);

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * True when the html value is exactly one authorbot comment
 * (`<!-- authorbot:... -->`) and nothing else.
 */
export function isAuthorbotComment(value: string): boolean {
  const trimmed = value.trim();
  if (!/^<!--\s*authorbot:/.test(trimmed)) {
    return false;
  }
  // Exactly one comment terminator, at the very end: a node that smuggles
  // additional HTML after the comment is not exempt.
  return trimmed.endsWith("-->") && trimmed.indexOf("-->") === trimmed.length - 3;
}

/**
 * Returns the forbidden scheme (lowercased) of a URL, or null when the URL is
 * relative or uses an allowed scheme. Control characters and whitespace are
 * stripped before scheme detection so `java\nscript:` cannot slip through.
 */
export function forbiddenUrlScheme(url: string): string | null {
  const cleaned = url.replace(/[\u0000-\u0020]+/g, "");
  const match = SCHEME_PATTERN.exec(cleaned);
  if (match === null) {
    return null; // relative (also covers scheme-relative `//host/...` and `#anchor`)
  }
  const scheme = (match[1] ?? "").toLowerCase();
  return ALLOWED_SCHEMES.has(scheme) ? null : scheme;
}

export interface RawHtmlFinding {
  /** Raw value of the html node. */
  value: string;
  position: Position | undefined;
}

export interface ForbiddenUrlFinding {
  url: string;
  /** The offending scheme, lowercased (e.g. `javascript`). */
  scheme: string;
  nodeType: "link" | "image" | "definition";
  position: Position | undefined;
}

export interface SafetyScanResult {
  rawHtml: RawHtmlFinding[];
  forbiddenUrls: ForbiddenUrlFinding[];
}

/** Scan a parsed document for raw HTML and forbidden URL schemes. */
export function scanSafety(ast: Root): SafetyScanResult {
  const rawHtml: RawHtmlFinding[] = [];
  const forbiddenUrls: ForbiddenUrlFinding[] = [];

  visit(ast, (node) => {
    if (node.type === "html") {
      if (!isAuthorbotComment(node.value)) {
        rawHtml.push({ value: node.value, position: node.position });
      }
      return;
    }
    if (node.type === "link" || node.type === "image" || node.type === "definition") {
      const scheme = forbiddenUrlScheme(node.url);
      if (scheme !== null) {
        forbiddenUrls.push({
          url: node.url,
          scheme,
          nodeType: node.type,
          position: node.position,
        });
      }
    }
  });

  return { rawHtml, forbiddenUrls };
}
