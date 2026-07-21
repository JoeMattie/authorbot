/**
 * Byte-stable rendering of annotation and reply artifacts (Phase 0 contract
 * §4 formats; Phase 2 contract §5).
 *
 * Byte stability: the same input always produces the same bytes. Frontmatter
 * keys are emitted in a fixed order, YAML serialization options are pinned
 * (`lineWidth: 0`, two-space indent, no anchors), line endings are normalized
 * to `\n`, and the body ends with exactly one trailing newline. A withdraw is
 * a re-render of the same annotation with `status: withdrawn` - only the
 * frontmatter `status` line changes.
 *
 * Every rendered frontmatter object is validated against the Phase 0
 * `authorbot.annotation/v1` / `authorbot.reply/v1` schemas before it is
 * serialized, so a malformed record can never reach the book repository.
 */
import { stringify } from "yaml";
import {
  annotationSchema,
  replySchema,
  type AnnotationKind,
  type AnnotationStatus,
} from "@authorbot/schemas";

/** A file to be committed, path relative to the book-repository root. */
export interface RenderedFile {
  path: string;
  content: string;
}

/** Pinned YAML options - changing these changes committed bytes. */
export const YAML_OPTIONS = {
  indent: 2,
  lineWidth: 0,
  aliasDuplicateObjects: false,
} as const;

/** `.authorbot/annotations/<id>` (Phase 0 contract §4). */
export function annotationDirectory(annotationId: string): string {
  return `.authorbot/annotations/${annotationId}`;
}

/** `.authorbot/annotations/<id>/annotation.md` (Phase 0 contract §4). */
export function annotationFilePath(annotationId: string): string {
  return `${annotationDirectory(annotationId)}/annotation.md`;
}

/** `.authorbot/annotations/<id>/replies/<reply-id>.md` (Phase 0 contract §4). */
export function replyFilePath(annotationId: string, replyId: string): string {
  return `${annotationDirectory(annotationId)}/replies/${replyId}.md`;
}

export type AnnotationArtifactScope = "range" | "block" | "chapter";

export interface AnnotationArtifactInput {
  /** Annotation UUIDv7. */
  id: string;
  kind: AnnotationKind;
  scope: AnnotationArtifactScope;
  chapterId: string;
  chapterRevision: number;
  /** Actor reference (`github:octocat`), never an internal actor UUID. */
  author: string;
  /**
   * Artifact status. `pending_git` is a database-only state and is not part
   * of the artifact schema; creates render `open`, withdraws `withdrawn`.
   */
  status: AnnotationStatus;
  /** RFC 3339 UTC timestamp. */
  createdAt: string;
  /**
   * Target selector (design §10.1 camelCase payload). Required for `range`
   * and `block` scopes, forbidden for `chapter` scope.
   */
  target?: unknown;
  /** Markdown body. */
  body: string;
}

/** Render `.authorbot/annotations/<id>/annotation.md`. Byte-stable. */
export function renderAnnotationArtifact(input: AnnotationArtifactInput): RenderedFile {
  if (input.scope === "chapter" && input.target !== undefined && input.target !== null) {
    throw new Error(`annotation ${input.id}: chapter scope must not carry a target`);
  }
  const base: Record<string, unknown> = {
    schema: "authorbot.annotation/v1",
    id: input.id,
    kind: input.kind,
    scope: input.scope,
    chapter_id: input.chapterId,
    chapter_revision: input.chapterRevision,
    author: input.author,
    status: input.status,
    created_at: input.createdAt,
  };
  const frontmatter =
    input.scope === "chapter" ? base : { ...base, target: input.target };
  // Validate before serializing; throws on malformed records (bad target
  // shape, missing target for range/block, non-UUIDv7 ids, bad actor ref…).
  annotationSchema.parse(frontmatter);
  return {
    path: annotationFilePath(input.id),
    content: renderArtifact(frontmatter, input.body),
  };
}

export interface ReplyArtifactInput {
  /** Reply UUIDv7. */
  id: string;
  annotationId: string;
  parentReplyId?: string | null;
  /** Actor reference (`github:octocat`). */
  author: string;
  /** RFC 3339 UTC timestamp. */
  createdAt: string;
  /** Markdown body. */
  body: string;
}

/** Render `.authorbot/annotations/<id>/replies/<reply-id>.md`. Byte-stable. */
export function renderReplyArtifact(input: ReplyArtifactInput): RenderedFile {
  const frontmatter: Record<string, unknown> = {
    schema: "authorbot.reply/v1",
    id: input.id,
    annotation_id: input.annotationId,
    ...(input.parentReplyId === null || input.parentReplyId === undefined
      ? {}
      : { parent_reply_id: input.parentReplyId }),
    author: input.author,
    created_at: input.createdAt,
  };
  replySchema.parse(frontmatter);
  return {
    path: replyFilePath(input.annotationId, input.id),
    content: renderArtifact(frontmatter, input.body),
  };
}

/**
 * Assemble the artifact bytes: frontmatter fence, one blank line, normalized
 * body, exactly one trailing newline. Shared by every frontmatter-bearing
 * artifact renderer in this package.
 */
export function renderArtifact(frontmatter: unknown, body: string): string {
  const yamlText = stringify(frontmatter, YAML_OPTIONS); // ends with "\n"
  const normalizedBody = body.replace(/\r\n/g, "\n").trim();
  if (normalizedBody === "") {
    return `---\n${yamlText}---\n`;
  }
  return `---\n${yamlText}---\n\n${normalizedBody}\n`;
}
