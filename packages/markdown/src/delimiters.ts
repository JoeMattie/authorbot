import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * Work-item original-text delimiter check (contract sections 3 and 5,
 * `WORK_ITEM_DELIMITER_INVALID`).
 *
 * `<!-- authorbot:original:start -->` … `<!-- authorbot:original:end -->`
 * pairs must be balanced, non-nested, and number at most `maxSections`
 * (default 1 - "exactly one balanced pair when the section is present";
 * zero pairs means the section is absent, which is valid).
 *
 * The contract defines delimiters as HTML comments, so a delimiter line only
 * counts when Markdown actually parses it as HTML: lines quoted inside
 * fenced/indented code blocks or the YAML frontmatter are code/text, not
 * comments, and are ignored. A counted delimiter line may carry surrounding
 * whitespace but nothing else.
 */

const DELIMITER_LINE = /^\s*<!--\s*authorbot:original:(start|end)\s*-->\s*$/;

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

/** 1-indexed source lines covered by mdast `html` nodes (block or inline). */
function htmlNodeLines(source: string): Set<number> {
  const lines = new Set<number>();
  visit(processor.parse(source), "html", (node) => {
    const position = node.position;
    if (position !== undefined) {
      for (let line = position.start.line; line <= position.end.line; line += 1) {
        lines.add(line);
      }
    }
  });
  return lines;
}

export interface DelimiterSection {
  /** 1-indexed line of the start delimiter. */
  startLine: number;
  /** 1-indexed line of the end delimiter. */
  endLine: number;
}

export type DelimiterIssueReason =
  /** An end delimiter with no open start. */
  | "unopened_end"
  /** A start delimiter never closed before end of input. */
  | "unclosed_start"
  /** A start delimiter inside an already-open section. */
  | "nested_start"
  /** More balanced sections than `maxSections`. */
  | "too_many_sections";

export interface DelimiterIssue {
  reason: DelimiterIssueReason;
  /** 1-indexed line the issue anchors to. */
  line: number;
}

export interface DelimiterCheckResult {
  valid: boolean;
  /** Balanced sections found, in document order. */
  sections: DelimiterSection[];
  issues: DelimiterIssue[];
}

export interface DelimiterCheckOptions {
  /** Maximum number of balanced sections allowed. Default 1. */
  maxSections?: number;
}

/** Verify original-text delimiters in raw markdown source. */
export function checkWorkItemDelimiters(
  source: string,
  options: DelimiterCheckOptions = {},
): DelimiterCheckResult {
  const maxSections = options.maxSections ?? 1;
  const sections: DelimiterSection[] = [];
  const issues: DelimiterIssue[] = [];
  const openStarts: number[] = [];

  const htmlLines = htmlNodeLines(source);
  const lines = source.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = DELIMITER_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const lineNumber = i + 1;
    if (!htmlLines.has(lineNumber)) {
      continue; // quoted inside code or frontmatter, not a real HTML comment
    }
    if (match[1] === "start") {
      if (openStarts.length > 0) {
        issues.push({ reason: "nested_start", line: lineNumber });
      }
      openStarts.push(lineNumber);
    } else {
      const start = openStarts.pop();
      if (start === undefined) {
        issues.push({ reason: "unopened_end", line: lineNumber });
      } else if (openStarts.length === 0) {
        sections.push({ startLine: start, endLine: lineNumber });
      }
    }
  }

  for (const line of openStarts) {
    issues.push({ reason: "unclosed_start", line });
  }
  if (sections.length > maxSections) {
    const extra = sections[maxSections];
    issues.push({
      reason: "too_many_sections",
      line: extra === undefined ? 1 : extra.startLine,
    });
  }

  return { valid: issues.length === 0, sections, issues };
}
