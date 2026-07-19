import { parseChapterMarkdown, type ParsedChapter } from "@authorbot/markdown";
import { parse as parseYaml } from "yaml";
import type { ZodError } from "zod";
import type { FindingCollector, ValidationCode } from "./findings.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncate(value: string, max = 80): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}

/** Pointer for a 1-indexed source line, or undefined when unknown. */
export function linePointer(line: number | undefined): string | undefined {
  return line === undefined ? undefined : `line ${line}`;
}

/** JSON-Pointer for a Zod issue path (RFC 6901 escaping). */
export function jsonPointer(segments: ReadonlyArray<PropertyKey>): string {
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments
    .map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

export type ParsedYaml = { ok: true; data: unknown } | { ok: false; error: string };

export function parseYamlDoc(source: string): ParsedYaml {
  try {
    return { ok: true, data: parseYaml(source) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface FrontmatterDoc {
  /** Frontmatter mapping, when present and parseable as a YAML mapping. */
  fm: Record<string, unknown> | undefined;
  /** YAML parse error, when the frontmatter block was unparseable. */
  fmError: string | undefined;
  /** The full markdown parse (blocks and ast) for callers that need it. */
  parsed: ParsedChapter;
}

/** Parse a Markdown document's YAML frontmatter (chapters, characters, records). */
export function readFrontmatter(source: string): FrontmatterDoc {
  const parsed = parseChapterMarkdown(source);
  const fm = isRecord(parsed.frontmatter) ? parsed.frontmatter : undefined;
  return { fm, fmError: parsed.frontmatterError, parsed };
}

/** Emit one finding per Zod issue with a JSON-Pointer to the failing field. */
export function emitSchemaIssues(
  findings: FindingCollector,
  code: ValidationCode,
  path: string,
  error: ZodError,
): void {
  for (const issue of error.issues) {
    const pointer = jsonPointer(issue.path);
    findings.error(code, path, `schema violation at ${pointer}: ${issue.message}`, pointer);
  }
}

const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * PATH_UNSAFE reason for a slug or repo-relative path setting, or null when
 * safe (contract section 5: traversal or reserved names).
 */
export function unsafePathReason(value: string): string | null {
  if (/[\u0000-\u001f]/.test(value)) {
    return "contains control characters";
  }
  if (value.split(/[/\\]/).some((segment) => segment === "..")) {
    return "contains path traversal (..)";
  }
  if (value.includes("/") || value.includes("\\")) {
    return "contains a path separator";
  }
  if (value.startsWith(".")) {
    return "starts with a dot";
  }
  if (RESERVED_NAME.test(value)) {
    return "is a reserved device name";
  }
  return null;
}

/**
 * PATH_UNSAFE reason for a configured repo-relative path or glob (may contain
 * `/` between segments, but no traversal, no absolute paths).
 */
export function unsafeRepoPathReason(value: string): string | null {
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return "is not repo-relative";
  }
  if (value.split(/[/\\]/).some((segment) => segment === "..")) {
    return "contains path traversal (..)";
  }
  return null;
}
