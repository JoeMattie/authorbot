/**
 * Byte-stable rendering and parsing of work-item artifacts
 * `.authorbot/work-items/<id>.md` (`authorbot.work-item/v1`, Phase 0 contract
 * §4; design §13; Phase 3 contract §4). Stable path, status in frontmatter
 * (Phase 0 §4 ADR) - a status change is a re-render in which only the
 * frontmatter `status` line differs.
 *
 * Body sections per design §13 / Phase 3 contract §4, in fixed order:
 * Context (the annotation body), Original text (the quoted target between
 * `authorbot:original` delimiters), Requested change, Acceptance criteria,
 * Submission contract (naming the base revision).
 *
 * ## Phase 4 additions (contract §5-§6)
 *
 * - **Completion metadata**: an applied work item re-renders with frontmatter
 *   `status: completed` and an appended `## Completion` section (submission
 *   id, applied revision, completed-at, completed-by). The five §13 sections
 *   stay byte-intact; the canonical `authorbot.work-item/v1` frontmatter is
 *   strict, so completion metadata lives in the body, not the frontmatter.
 * - **Conflict artifacts**: a `resolve_conflict` work item (design §12.6)
 *   carries BOTH texts between distinct delimiter pairs - the *current*
 *   chapter text between the standard `authorbot:original` delimiters (it is
 *   the text the resolver revises; `base_revision` names the current
 *   revision), and the *submitted* change between
 *   `authorbot:original:submitted` delimiters inside the Requested change
 *   section. The submitted delimiters live inside the `authorbot:original:`
 *   escape namespace, so the existing fence-safe escaping covers lookalikes
 *   in free text, and the Phase 0 delimiter validator (which matches
 *   `authorbot:original:(start|end)` exactly) still sees exactly one
 *   balanced pair.
 *
 * ## Delimiter/heading escaping (round-trip safety)
 *
 * Free text (Context, Original text, Requested change) may itself contain
 * lines that look like the `authorbot:original` delimiters, like a section
 * heading, or like a Markdown code fence (` ``` ` / `~~~`). To keep parsing
 * exact - and to keep a quoted code fence from swallowing a delimiter line so
 * the Phase 0 delimiter validator no longer sees it as an HTML comment - the
 * renderer escapes any free-text line MATCHING `/^\s*<!--\s*authorbot:original:/`
 * (the same whitespace tolerance the validator's own regex has - see
 * `DANGEROUS_LINE`), opening/closing a fenced code block, or exactly equal to
 * one of the five section headings, by prefixing it with the escape marker
 * `<!-- authorbot:original:escape -->`. The parser strips exactly one escape
 * marker per line. This is a proper prefix code:
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
/**
 * Delimiters around the *submitted change* in a `resolve_conflict` artifact
 * (Phase 4 contract §5). Deliberately inside the `authorbot:original:`
 * namespace: the fence-safe escaping already covers lookalike free-text
 * lines, and the Phase 0 delimiter validator ignores them (module docs).
 */
export const SUBMITTED_TEXT_START = "<!-- authorbot:original:submitted:start -->";
export const SUBMITTED_TEXT_END = "<!-- authorbot:original:submitted:end -->";
/**
 * Any free-text line matching this must be escaped.
 *
 * A REGEX, not a `startsWith` on the literal prefix, because the validator this
 * escaping exists to satisfy is itself a regex:
 * `/^\s*<!--\s*authorbot:original:(start|end)\s*-->\s*$/`
 * (`@authorbot/markdown` `delimiters.ts`). It tolerates leading whitespace and
 * whitespace after `<!--`; the old literal `"<!-- authorbot:original:"` did
 * not. Anything the validator counts and the escaper misses is a hole, and this
 * one was reachable from an annotation body: a comment containing a delimiter
 * line with a single leading space passed the markdown safety scan, was emitted
 * verbatim into `## Context`, and the committed artifact then failed
 * `checkWorkItemDelimiters` with `WORK_ITEM_DELIMITER_INVALID` - permanently,
 * because the write path does not run that check and the bad bytes land first.
 *
 * The predicate is deliberately WIDER than the validator (no `(start|end)`, no
 * end anchor): over-escaping a line that was never dangerous is invisible -
 * `unescapeWorkItemText` restores it byte for byte - while under-escaping one
 * breaks the repository. When the two cannot be identical, the escaper is the
 * one that should err.
 */
const DANGEROUS_LINE = /^\s*<!--\s*authorbot:original:/;
/**
 * A free-text line that could open or close a Markdown fenced code block. Such
 * a line, left bare, would make the delimiter validator (which only counts a
 * delimiter line Markdown parses as an HTML comment node) treat the
 * `authorbot:original` delimiters as swallowed code - a validator-only failure
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

/** Optional trailing section carrying completion metadata (Phase 4 §5). */
export const COMPLETION_HEADING = "## Completion";

/**
 * Every heading the renderer anchors on, and therefore escapes in free text.
 * (Adding `## Completion` in Phase 4 changes rendered bytes only for free
 * text containing exactly that line - previously never emitted.)
 */
const ESCAPED_HEADINGS: readonly string[] = [...WORK_ITEM_SECTION_HEADINGS, COMPLETION_HEADING];

/** Default acceptance-criteria template (Phase 3 contract §4). */
export const DEFAULT_ACCEPTANCE_CRITERIA: readonly string[] = [
  "Preserve point of view.",
  "Change only the selected span.",
  "Keep continuity facts intact.",
];

/** Default acceptance criteria for `resolve_conflict` items (Phase 4 §5). */
export const DEFAULT_CONFLICT_ACCEPTANCE_CRITERIA: readonly string[] = [
  "Merge the submitted change with the current text; never discard either silently.",
  "Preserve the newer revision's changes outside the conflicting span.",
  "Keep continuity facts intact.",
];

/**
 * Submission type named by the Submission contract section, per work type
 * (design §13 example, §22.1 "range replacement, block replacement, and
 * whole-chapter submission types"). `resolve_conflict` submits the merged
 * chapter as a `chapter_replacement` (Phase 4; matches
 * `@authorbot/domain.requiredSubmissionType`). `write_chapter`/`planning`
 * submission flows are deferred (Phase 4 contract §1) and fail closed.
 */
export const SUBMISSION_TYPE_BY_WORK_TYPE: Partial<Record<WorkItemType, string>> = {
  revise_range: "range_replacement",
  revise_block: "block_replacement",
  revise_chapter: "chapter_replacement",
  resolve_conflict: "chapter_replacement",
};

/** Escape one free-text block for embedding in the artifact body. */
export function escapeWorkItemText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      DANGEROUS_LINE.test(line) ||
      CODE_FENCE.test(line) ||
      ESCAPED_HEADINGS.includes(line)
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
   * carries no quote - block/chapter scope). Preserved byte-exactly between
   * the `authorbot:original` delimiters (CRLF normalized to LF).
   */
  originalText: string;
  /** Requested change section (the voted proposal, design §13). */
  requestedChange: string;
  /** One line per criterion; defaults to {@link DEFAULT_ACCEPTANCE_CRITERIA}. */
  acceptanceCriteria?: readonly string[];
  /**
   * The submitted change of a `resolve_conflict` artifact, preserved
   * byte-exactly between the `authorbot:original:submitted` delimiters
   * inside the Requested change section (Phase 4 contract §5).
   */
  submittedText?: string;
  /**
   * Completion metadata for an applied work item (Phase 4 contract §5):
   * rendered as a trailing `## Completion` section. The §13 sections are
   * unaffected. Normally paired with `status: "completed"`.
   */
  completion?: WorkItemCompletion;
}

/** `## Completion` section fields - all single-line values. */
export interface WorkItemCompletion {
  /** Submission UUIDv7 that produced the applied edit. */
  submissionId: string;
  /** Chapter revision the edit produced. */
  appliedRevision: number;
  /** RFC 3339 UTC timestamp of the apply commit's finalization. */
  completedAt: string;
  /** Actor reference (`github:octocat`) of the submitter. */
  completedBy: string;
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

  if (input.completion !== undefined) {
    for (const [field, value] of Object.entries(completionLines(input.completion))) {
      if (value.includes("\n") || value.includes("\r")) {
        throw new Error(`work item ${input.id}: completion ${field} must be a single line`);
      }
    }
  }

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
    ...(input.submittedText === undefined
      ? []
      : [
          SUBMITTED_TEXT_START,
          escapeWorkItemText(input.submittedText),
          SUBMITTED_TEXT_END,
          "",
        ]),
    "## Acceptance criteria",
    "",
    ...criteria.map((criterion) => `- ${criterion}`),
    "",
    "## Submission contract",
    "",
    `Submit a \`${submissionType}\` against chapter revision ${input.baseRevision} while holding the current lease.`,
    ...(input.completion === undefined
      ? []
      : [
          "",
          COMPLETION_HEADING,
          "",
          ...Object.values(completionLines(input.completion)),
        ]),
  ].join("\n");

  return { path: workItemFilePath(input.id), content: renderArtifact(frontmatter, body) };
}

/** The `## Completion` bullet lines, in fixed order (render and parse). */
function completionLines(completion: WorkItemCompletion): Record<string, string> {
  return {
    submissionId: `- Submission: ${completion.submissionId}`,
    appliedRevision: `- Applied revision: ${completion.appliedRevision}`,
    completedAt: `- Completed at: ${completion.completedAt}`,
    completedBy: `- Completed by: ${completion.completedBy}`,
  };
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
  /**
   * The submitted change of a `resolve_conflict` artifact (between the
   * `authorbot:original:submitted` delimiters), byte-exact after CRLF→LF
   * normalization. Absent when the artifact carries none.
   */
  submittedText?: string;
  /** Completion metadata of an applied work item, when present. */
  completion?: WorkItemCompletion;
}

export interface ParsedWorkItemArtifact {
  /** Validated frontmatter - statuses intact for projection rebuild. */
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
  // Optional trailing `## Completion` section (Phase 4): bounds block(4).
  const completionIndex = lines.indexOf(COMPLETION_HEADING, (headingIndex[4] ?? 0) + 1);
  const block = (section: number): string[] => {
    const start = (headingIndex[section] ?? 0) + 1;
    const end =
      section + 1 < headingIndex.length
        ? headingIndex[section + 1]
        : completionIndex === -1
          ? lines.length
          : completionIndex;
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

  // Optional submitted-change delimiters inside Requested change (Phase 4
  // conflict artifacts). Free-text lookalikes are escaped, so an unescaped
  // delimiter line is unambiguous.
  const requestedBlock = block(2);
  const submittedStart = requestedBlock.indexOf(SUBMITTED_TEXT_START);
  const submittedEnd = requestedBlock.indexOf(SUBMITTED_TEXT_END);
  let submittedText: string | undefined;
  let requestedLines = requestedBlock;
  if (submittedStart !== -1 || submittedEnd !== -1) {
    if (submittedStart === -1 || submittedEnd === -1 || submittedEnd < submittedStart) {
      throw new Error(
        `work item artifact ${record.id}: malformed authorbot:original:submitted delimiters`,
      );
    }
    submittedText = unescapeWorkItemText(
      requestedBlock.slice(submittedStart + 1, submittedEnd).join("\n"),
    );
    requestedLines = [
      ...requestedBlock.slice(0, submittedStart),
      ...requestedBlock.slice(submittedEnd + 1),
    ];
  }

  const acceptanceCriteria = block(3)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));

  return {
    record,
    sections: {
      context: unescapeWorkItemText(joinTrim(block(0))),
      originalText,
      requestedChange: unescapeWorkItemText(joinTrim(requestedLines)),
      acceptanceCriteria,
      submissionContract: joinTrim(block(4)),
      ...(submittedText === undefined ? {} : { submittedText }),
      ...(completionIndex === -1
        ? {}
        : { completion: parseCompletion(record.id, lines.slice(completionIndex + 1)) }),
    },
  };
}

/** Parse the `## Completion` bullet lines (inverse of the renderer). */
function parseCompletion(workItemId: string, lines: string[]): WorkItemCompletion {
  const value = (label: string): string => {
    const prefix = `- ${label}: `;
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    if (line === undefined) {
      throw new Error(`work item artifact ${workItemId}: Completion section missing "${label}"`);
    }
    return line.slice(prefix.length);
  };
  const appliedRevision = Number(value("Applied revision"));
  if (!Number.isInteger(appliedRevision) || appliedRevision < 1) {
    throw new Error(`work item artifact ${workItemId}: invalid Completion applied revision`);
  }
  return {
    submissionId: value("Submission"),
    appliedRevision,
    completedAt: value("Completed at"),
    completedBy: value("Completed by"),
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
