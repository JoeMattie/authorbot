/**
 * BookRepoReader: the projection's view of a committed book repository
 * (Phase 2 contract §5, design §7.5). Implementations: `LocalFsBookRepoReader`
 * (Node, `@authorbot/api/local`) for tests/local dev; a GitHub-backed reader
 * arrives with Phase 5. Readers return raw snapshots already validated
 * against `@authorbot/schemas`.
 */
import type { Annotation, ChapterFrontmatter, Reply } from "@authorbot/schemas";

export interface RepoChapterSnapshot {
  frontmatter: ChapterFrontmatter;
  /** Repo-relative path, e.g. `chapters/001-baseline.md`. */
  path: string;
  /** `sha256:<hex>` of the raw file bytes. */
  contentHash: string;
  /** Valid block-marker ids in document order (contract §4 block checks). */
  blockIds: string[];
}

export interface RepoAnnotationSnapshot {
  record: Annotation;
  /** Markdown body (content after the frontmatter block). */
  body: string;
}

export interface RepoReplySnapshot {
  record: Reply;
  body: string;
}

export interface BookRepoSnapshot {
  chapters: RepoChapterSnapshot[];
  annotations: RepoAnnotationSnapshot[];
  replies: RepoReplySnapshot[];
  /** Head commit the snapshot was read at, when known. */
  headCommit?: string;
}

export interface BookRepoReader {
  readSnapshot(): Promise<BookRepoSnapshot>;
}

// NOTE: valid block ids are persisted on the `chapters` projection row
// (`block_ids` JSON column) by the rebuild, so contract §4's "blockId exists
// in that revision" check works from the database alone — including on
// reader-less instances (the Worker before Phase 5) sharing a DB that a
// reader-ful instance rebuilt. The former in-memory ProjectionIndex (and its
// reader-less skip path) is gone.
