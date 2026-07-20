/**
 * Byte-stable rendering, parsing, and idempotent appending of attribution
 * artifacts `.authorbot/attribution/<chapter-id>.yml`
 * (`authorbot.attribution/v1`, Phase 0 contract §4; Phase 4 contract §6).
 *
 * An accepted edit appends `{ revision, actor, work_item_id }` **in the same
 * commit as the edit** (contract §6), so the commit SHA of that very commit
 * cannot appear inside the file it is part of.
 *
 * ## Commit-reference convention (contract ambiguity, resolved here)
 *
 * The optional `commit` field is **omitted** for entries appended in the same
 * commit as the chapter edit. The introducing commit is identified *by
 * convention* instead: it is the commit whose `Authorbot-Operation` /
 * `Authorbot-Work-Item` trailers (design §14.3) match the operation that
 * applied the entry's work item — recoverable at any time via
 * `git log --grep`. Entries written by later tooling that already knows a
 * commit SHA (e.g. Phase 5 backfills or manual imports) may set `commit`
 * explicitly; both shapes are schema-valid and round-trip.
 *
 * ## Idempotency
 *
 * `appendAttributionEntry` is safe to re-run (crash-recovery replays,
 * non-fast-forward retries): an entry with the same `revision` and
 * `work_item_id` (or, for work-item-less entries, the same `revision` and
 * `actor`) is recognized as already present and the existing bytes are
 * returned unchanged.
 */
import { parse, stringify } from "yaml";
import { attributionSchema, type Attribution, type AttributionEntry } from "@authorbot/schemas";
import { YAML_OPTIONS, type RenderedFile } from "./render.js";

/** `.authorbot/attribution/<chapter-id>.yml` (Phase 0 contract §4). */
export function attributionFilePath(chapterId: string): string {
  return `.authorbot/attribution/${chapterId}.yml`;
}

/** camelCase input for one attribution entry (design §8.4 / contract §6). */
export interface AttributionEntryInput {
  /** Chapter revision this entry credits. */
  revision: number;
  /** Actor reference (`github:octocat`), never an internal actor UUID. */
  actor: string;
  workItemId?: string;
  /** See the module's commit-reference convention before setting this. */
  commit?: string;
}

function toArtifactEntry(entry: AttributionEntryInput): Record<string, unknown> {
  return {
    revision: entry.revision,
    actor: entry.actor,
    ...(entry.workItemId === undefined ? {} : { work_item_id: entry.workItemId }),
    ...(entry.commit === undefined ? {} : { commit: entry.commit }),
  };
}

/** Render `.authorbot/attribution/<chapter-id>.yml`. Byte-stable. */
export function renderAttributionArtifact(input: {
  chapterId: string;
  entries: readonly AttributionEntryInput[];
}): RenderedFile {
  const doc: Record<string, unknown> = {
    schema: "authorbot.attribution/v1",
    chapter_id: input.chapterId,
    entries: input.entries.map(toArtifactEntry),
  };
  attributionSchema.parse(doc);
  return {
    path: attributionFilePath(input.chapterId),
    content: stringify(doc, YAML_OPTIONS),
  };
}

/**
 * Parse `.authorbot/attribution/<chapter-id>.yml` for projection rebuild
 * (Phase 4 contract §6). Throws on malformed artifacts.
 */
export function parseAttributionArtifact(content: string): Attribution {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (error) {
    throw new Error(
      `attribution artifact: unparseable YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("attribution artifact: document is not a mapping");
  }
  return attributionSchema.parse(raw);
}

function sameEntry(existing: AttributionEntry, entry: AttributionEntryInput): boolean {
  if (existing.revision !== entry.revision) return false;
  if (entry.workItemId !== undefined || existing.work_item_id !== undefined) {
    return existing.work_item_id === entry.workItemId;
  }
  return existing.actor === entry.actor;
}

export interface AppendAttributionResult {
  /** The full artifact file to commit (unchanged bytes when not appended). */
  file: RenderedFile;
  /** False when an equal entry already existed (idempotent replay). */
  appended: boolean;
}

/**
 * Append one entry to an attribution artifact, creating the file when
 * `existingContent` is null (first attributed revision of the chapter).
 * Existing entries are preserved in order; the new entry is appended last —
 * entries therefore appear in apply order (ascending revision under the
 * one-writer-per-project outbox). Idempotent (module docs).
 *
 * The whole file is re-rendered through the pinned YAML options, so a file
 * this module wrote stays byte-stable across appends; a hand-edited but
 * schema-valid file is normalized on first append.
 */
export function appendAttributionEntry(
  existingContent: string | null,
  chapterId: string,
  entry: AttributionEntryInput,
): AppendAttributionResult {
  if (existingContent === null) {
    return { file: renderAttributionArtifact({ chapterId, entries: [entry] }), appended: true };
  }
  const existing = parseAttributionArtifact(existingContent);
  if (existing.chapter_id !== chapterId) {
    throw new Error(
      `attribution artifact chapter mismatch: file is for ${existing.chapter_id}, entry is for ${chapterId}`,
    );
  }
  if (existing.entries.some((candidate) => sameEntry(candidate, entry))) {
    return {
      file: { path: attributionFilePath(chapterId), content: existingContent },
      appended: false,
    };
  }
  const entries: AttributionEntryInput[] = [
    ...existing.entries.map((candidate) => ({
      revision: candidate.revision,
      actor: candidate.actor,
      ...(candidate.work_item_id === undefined ? {} : { workItemId: candidate.work_item_id }),
      ...(candidate.commit === undefined ? {} : { commit: candidate.commit }),
    })),
    entry,
  ];
  return { file: renderAttributionArtifact({ chapterId, entries }), appended: true };
}
