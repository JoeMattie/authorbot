/**
 * Byte-stable rendering and parsing of work-item artifacts
 * `.authorbot/work-items/<id>.md` (`authorbot.work-item/v1`, Phase 0 contract
 * §4; design §13; Phase 3 contract §4). Stable path, status in frontmatter
 * (Phase 0 §4 ADR) — a status change is a re-render in which only the
 * frontmatter `status` line differs.
 *
 * Body sections per design §13 / Phase 3 contract §4, in fixed order:
 * Context (the annotation body), Original text (the quoted target between
 * `authorbot:original` delimiters), Requested change, Acceptance criteria,
 * Submission contract (naming the base revision).
 *
 * ## Delimiter/heading escaping (round-trip safety)
 *
 * Free text (Context, Original text, Requested change) may itself contain
 * lines that look like the `authorbot:original` delimiters, like a section
 * heading, or like a Markdown code fence (` ``` ` / `~~~`). To keep parsing
 * exact — and to keep a quoted code fence from swallowing a delimiter line so
 * the Phase 0 delimiter validator no longer sees it as an HTML comment — the
 * renderer escapes any free-text line that starts with
 * `<!-- authorbot:original:`, opens/closes a fenced code block, or is exactly
 * equal to one of the five section headings, by prefixing it with the escape
 * marker `<!-- authorbot:original:escape -->`. The parser strips exactly one
 * escape marker per line. This is a proper prefix code:
 *
 * - After escaping, no free-text line equals a heading or a delimiter, so the
 *   real headings and delimiters are globally unique in the document and the
 *   parser can anchor on exact line matches.
 * - A literal escape marker in source text starts with the dangerous prefix,
 *   so it gains one more marker and loses exactly one on parse.
 * - The marker is an HTML comment, so escaped lines render unchanged in
 *   Markdown viewers.
 *
 * Round-trip guarantees: `originalText` round-trips exactly after CRLF→LF
 * normalization (leading/trailing blank lines included, delimiter-lookalike
 * lines included); `context` and `requestedChange` round-trip after CRLF→LF
 * normalization plus edge trimming (the renderer trims them; interior
 * whitespace is preserved).
 */
import { parse } from "yaml";
import {
  workItemSchema,
  type WorkItem,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkItemType,
} from "@authorbot/schemas";
import { renderArtifact, type RenderedFile } from "./render.js";

/** `.authorbot/work-items/<id>.md` (Phase 0 contract §4, stable path). */
export function workItemFilePath(workItemId: string): string {
  return `.authorbot/work-items/${workItemId}.md`;
}

/** `authorbot:original` delimiters (design §13). */
export const ORIGINAL_TEXT_START = "<!-- authorbot:original:start -->";
export const ORIGINAL_TEXT_END = "<!-- authorbot:original:end -->";
/** Escape marker prefixed to dangerous free-text lines (module docs). */
export const ORIGINAL_TEXT_ESCAPE = "<!-- authorbot:original:escape -->";
/** Any free-text line starting with this must be escaped. */
const DANGEROUS_PREFIX = "<!-- authorbot:original:";
/**
 * A free-text line that could open or close a Markdown fenced code block. Such
 * a line, left bare, would make the delimiter validator (which only counts a
 * delimiter line Markdown parses as an HTML comment node) treat the
 * `authorbot:original` delimiters as swallowed code — a validator-only failure
 * on artifacts that quote code fences. Escaping it (an HTML-comment prefix)
 * keeps it inert while round-tripping exactly.
 */
const CODE_FENCE = /^\s*(?:```|~~~)/;

/** The five §13 section headings, in document order. */
export const WORK_ITEM_SECTION_HEADINGS = [
  "## Context",
  "## Original text",
  "## Requested change",
  "## Acceptance criteria",
  "## Submission contract",
] as const;

/** Default acceptance-criteria template (Phase 3 contract §4). */
export const DEFAULT_ACCEPTANCE_CRITERIA: readonly string[] = [
  "Preserve point of view.",
  "Change only the selected span.",
  "Keep continuity facts intact.",
];

/**
 * Submission type named by the Submission contract section, per work type
 * (design §13 example, §22.1 "range replacement, block replacement, and
 * whole-chapter submission types"). Phase 3 only ever creates the three
 * `revise_*` types; rendering any other type fails closed until Phase 4
 * defines its submission vocabulary.
 */
export const SUBMISSION_TYPE_BY_WORK_TYPE: Partial<Record<WorkItemType, string>> = {
  revise_range: "range_replacement",
  revise_block: "block_replacement",
  revise_chapter: "chapter_replacement",
};

/** Escape one free-text block for embedding in the artifact body. */
export function escapeWorkItemText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line.startsWith(DANGEROUS_PREFIX) ||
      CODE_FENCE.test(line) ||
      (WORK_ITEM_SECTION_HEADINGS as readonly string[]).includes(line)
        ? `${ORIGINAL_TEXT_ESCAPE}${line}`
        : line,
    )
    .join("\n");
}

/** Inverse of {@link escapeWorkItemText}: strip one escape marker per line. */
export function unescapeWorkItemText(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.startsWith(ORIGINAL_TEXT_ESCAPE) ? line.slice(ORIGINAL_TEXT_ESCAPE.length) : line,
    )
    .join("\n");
}

export interface WorkItemArtifactInput {
  /** Work item UUIDv7. */
  id: string;
  type: WorkItemType;
  status: WorkItemStatus;
  sourceAnnotationId: string;
  chapterId: string;
  baseRevision: number;
  priority: WorkItemPriority;
  /** Actor reference (`system:rule-engine`, `github:octocat`), never a UUID. */
  createdBy: string;
  /** RFC 3339 UTC timestamp. */
  createdAt: string;
  /** Context section: the annotation body (Phase 3 contract §4). */
  context: string;
  /**
   * The exact original text of the quoted target (empty when the target
   * carries no quote — block/chapter scope). Preserved byte-exactly between
   * the `authorbot:original` delimiters (CRLF normalized to LF).
   */
  originalText: string;
  /** Requested change section (the voted proposal, design §13). */
  requestedChange: string;
  /** One line per criterion; defaults to {@link DEFAULT_ACCEPTANCE_CRITERIA}. */
  acceptanceCriteria?: readonly string[];
}

/** Render `.authorbot/work-items/<id>.md`. Byte-stable. */
export function renderWorkItemArtifact(input: WorkItemArtifactInput): RenderedFile {
  const submissionType = SUBMISSION_TYPE_BY_WORK_TYPE[input.type];
  if (submissionType === undefined) {
    throw new Error(
      `work item ${input.id}: no submission type defined for work type ${input.type} (Phase 4)`,
    );
  }
  const criteria = input.acceptanceCriteria ?? DEFAULT_ACCEPTANCE_CRITERIA;
  for (const criterion of criteria) {
    if (criterion.includes("\n") || criterion.includes("\r")) {
      throw new Error(`work item ${input.id}: acceptance criteria must be single lines`);
    }
  }
  const frontmatter: Record<string, unknown> = {
    schema: "authorbot.work-item/v1",
    id: input.id,
    type: input.type,
    status: input.status,
    source_annotation_id: input.sourceAnnotationId,
    chapter_id: input.chapterId,
    base_revision: input.baseRevision,
    priority: input.priority,
    created_by: input.createdBy,
    created_at: input.createdAt,
  };
  workItemSchema.parse(frontmatter);

  const context = escapeWorkItemText(normalizeTrim(input.context));
  const requestedChange = escapeWorkItemText(normalizeTrim(input.requestedChange));
  const originalText = escapeWorkItemText(input.originalText);
  const body = [
    "## Context",
    "",
    context,
    "",
    "## Original text",
    "",
    ORIGINAL_TEXT_START,
    originalText,
    ORIGINAL_TEXT_END,
    "",
    "## Requested change",
    "",
    requestedChange,
    "",
    "## Acceptance criteria",
    "",
    ...criteria.map((criterion) => `- ${criterion}`),
    "",
    "## Submission contract",
    "",
    `Submit a \`${submissionType}\` against chapter revision ${input.baseRevision} while holding the current lease.`,
  ].join("\n");

  return { path: workItemFilePath(input.id), content: renderArtifact(frontmatter, body) };
}

export interface WorkItemArtifactSections {
  context: string;
  /** Exact original text, unescaped (see module round-trip guarantees). */
  originalText: string;
  requestedChange: string;
  /** Bullet items of the Acceptance criteria section, marker stripped. */
  acceptanceCriteria: string[];
  /** Raw Submission contract section text. */
  submissionContract: string;
}

export interface ParsedWorkItemArtifact {
  /** Validated frontmatter — statuses intact for projection rebuild. */
  record: WorkItem;
  sections: WorkItemArtifactSections;
}

/**
 * Parse `.authorbot/work-items/<id>.md` for projection rebuild (Phase 3
 * contract §4 rebuildability). Throws on malformed artifacts.
 */
export function parseWorkItemArtifact(content: string): ParsedWorkItemArtifact {
  const { frontmatter, body } = splitFrontmatter(content);
  const record = workItemSchema.parse(frontmatter);

  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const headingIndex: number[] = [];
  let searchFrom = 0;
  for (const heading of WORK_ITEM_SECTION_HEADINGS) {
    const index = lines.indexOf(heading, searchFrom);
    if (index === -1) {
      throw new Error(`work item artifact ${record.id}: missing section ${JSON.stringify(heading)}`);
    }
    headingIndex.push(index);
    searchFrom = index + 1;
  }
  const block = (section: number): string[] => {
    const start = (headingIndex[section] ?? 0) + 1;
    const end = section + 1 < headingIndex.length ? headingIndex[section + 1] : lines.length;
    return lines.slice(start, end);
  };

  const originalBlock = block(1);
  const startIndex = originalBlock.indexOf(ORIGINAL_TEXT_START);
  const endIndex = originalBlock.indexOf(ORIGINAL_TEXT_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `work item artifact ${record.id}: malformed authorbot:original delimiters`,
    );
  }
  const originalText = unescapeWorkItemText(
    originalBlock.slice(startIndex + 1, endIndex).join("\n"),
  );

  const acceptanceCriteria = block(3)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));

  return {
    record,
    sections: {
      context: unescapeWorkItemText(joinTrim(block(0))),
      originalText,
      requestedChange: unescapeWorkItemText(joinTrim(block(2))),
      acceptanceCriteria,
      submissionContract: joinTrim(block(4)),
    },
  };
}

function normalizeTrim(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function joinTrim(lines: string[]): string {
  return lines.join("\n").trim();
}

/** Split the leading YAML frontmatter fence from the Markdown body. */
function splitFrontmatter(content: string): { frontmatter: unknown; body: string } {
  const source = content.replace(/\r\n/g, "\n");
  if (!source.startsWith("---\n")) {
    throw new Error("work item artifact: missing frontmatter");
  }
  const close = source.indexOf("\n---\n", 3);
  if (close === -1) {
    throw new Error("work item artifact: unterminated frontmatter");
  }
  const yamlText = source.slice(4, close + 1);
  const body = source.slice(close + 5);
  let frontmatter: unknown;
  try {
    frontmatter = parse(yamlText);
  } catch (error) {
    throw new Error(
      `work item artifact: unparseable frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { frontmatter, body };
}
