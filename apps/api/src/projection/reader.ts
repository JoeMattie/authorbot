/**
 * BookRepoReader: the projection's view of a committed book repository
 * (Phase 2 contract §5, design §7.5). Implementations: `LocalFsBookRepoReader`
 * (Node, `@authorbot/api/local`) for tests/local dev; a GitHub-backed reader
 * arrives with Phase 5. Readers return raw snapshots already validated
 * against `@authorbot/schemas`.
 */
import type {
  ParsedDecisionArtifact,
  ParsedWorkItemArtifact,
} from "@authorbot/repo-coordinator";
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

/** A parsed `.authorbot/decisions/<id>.yml` for rebuild (Phase 3 §4). */
export interface RepoDecisionSnapshot {
  parsed: ParsedDecisionArtifact;
}

/** A parsed `.authorbot/work-items/<id>.md` for rebuild (Phase 3 §4). */
export interface RepoWorkItemSnapshot {
  parsed: ParsedWorkItemArtifact;
}

export interface BookRepoSnapshot {
  chapters: RepoChapterSnapshot[];
  annotations: RepoAnnotationSnapshot[];
  replies: RepoReplySnapshot[];
  /**
   * Committed Phase 3 decision artifacts (Phase 3 contract §4 rebuildability).
   * Optional so pre-Phase-3 snapshot fixtures stay valid; absent ⇒ none.
   */
  decisions?: RepoDecisionSnapshot[];
  /** Committed Phase 3 work-item artifacts (Phase 3 contract §4). */
  workItems?: RepoWorkItemSnapshot[];
  /** Head commit the snapshot was read at, when known. */
  headCommit?: string;
  /**
   * Raw UTF-8 text of every matched path, from the SAME tree as everything
   * else in this snapshot.
   *
   * Reconciliation re-anchors annotations against chapter source. Reading that
   * source back through `readTextFile` re-resolved the branch head, so a push
   * landing mid-pass produced a re-anchor computed against one commit's bytes
   * while the revision and block ids came from another's - a decision recorded
   * at a revision that never contained that text, and persisted as an
   * append-only audit row a later converging pass does not undo. Taking the
   * source from the snapshot keeps the whole pass on one commit, which is the
   * invariant the Git-backed reader exists to provide.
   *
   * Optional: readers that do not retain file text omit it and callers fall
   * back to `readTextFile`.
   */
  files?: ReadonlyMap<string, string>;
}

/** One bounded page of repository text files selected by a configured glob. */
export interface RepoTextFilePage {
  /** Branch head used for this page, when the reader can name it. */
  headCommit: string | null;
  files: Array<{ path: string; source: string }>;
  /** Last returned path when another page exists, otherwise null. */
  nextAfter: string | null;
}

export interface BookRepoReader {
  readSnapshot(): Promise<BookRepoSnapshot>;
  /**
   * Current head commit of the branch this reader reads, when it can name
   * one. Used to detect that a snapshot went stale mid-pass before acting on
   * a conclusion drawn from it.
   */
  readHeadCommit?(): Promise<string>;
  /**
   * Raw text of one committed repository file (repo-relative path), or null
   * when it does not exist. Phase 4 uses this for the claim task bundle's
   * `document.source` (contract §3: full chapter Markdown) and for the
   * submission-apply pipeline's current-source + attribution reads - the
   * chapters projection deliberately stores only hashes/block ids, never
   * source. Optional so pre-Phase-4 readers/fixtures stay valid; endpoints
   * that need source respond with a problem when it is absent.
   */
  readTextFile?(path: string): Promise<string | null>;
  /**
   * Read at most one small page of files matching a repository-relative glob.
   * Implementations must bound source reads independently of the repository's
   * total file count; story-bible character pagination is the first caller.
   */
  listTextFiles?(
    glob: string,
    options?: { after?: string; limit?: number },
  ): Promise<RepoTextFilePage>;
}

// NOTE: valid block ids are persisted on the `chapters` projection row
// (`block_ids` JSON column) by the rebuild, so contract §4's "blockId exists
// in that revision" check works from the database alone - including on
// reader-less instances (the Worker before Phase 5) sharing a DB that a
// reader-ful instance rebuilt. The former in-memory ProjectionIndex (and its
// reader-less skip path) is gone.
