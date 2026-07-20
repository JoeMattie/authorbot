/**
 * `BookRepoWriter` — the Git write boundary (Phase 2 contract §5, design
 * §14). One commit per logical mutation, structured trailers (design §14.3),
 * never force. Implementations: `LocalGitAdapter` (Node, tests/local dev)
 * and the Phase 5 `GitHubAdapter` stub.
 */

/** A file to write and stage, path relative to the repository root. */
export interface CommitFile {
  path: string;
  content: string;
}

export interface CommitFilesInput {
  /** Branch the commit must land on (the project's default branch). */
  branch: string;
  /**
   * When set, the commit is refused with a `non-fast-forward` error unless
   * the branch head equals this SHA (stale expected head, design §14.2).
   */
  expectedHeadOverride?: string;
  /** Exactly the files of this logical mutation; nothing else is staged. */
  files: readonly CommitFile[];
  /** Commit subject (may include a body; trailers are appended separately). */
  message: string;
  /**
   * Structured trailers (design §14.3), e.g. `Authorbot-Actor`,
   * `Authorbot-Annotation`, `Authorbot-Operation`. Rendered in insertion
   * order as `Key: value` lines in the trailer block.
   */
  trailers: Readonly<Record<string, string>>;
  /**
   * A commit object this operation created on an earlier attempt whose ref
   * update was never confirmed (the process died, or the `PATCH` response
   * never arrived). If it turns out to be an ancestor of the branch head, it
   * LANDED and its SHA is returned instead of committing again.
   *
   * This is what makes replay idempotency depend on operation *identity*
   * rather than on how many commits a third party happened to push: the
   * `Authorbot-Operation` trailer scan is bounded by `operationScanDepth`, so
   * six commits pushed between the crash and the replay hid the landed commit
   * and produced either a duplicate audit commit or a spurious conflict.
   * Adapters that cannot test ancestry ignore this field.
   */
  attemptedCommitSha?: string;
  /**
   * Called with the new commit's SHA after the commit object exists but
   * BEFORE the ref update. Persisting it here is what lets a later replay
   * pass it back as `attemptedCommitSha`; the window this closes is exactly
   * the one between "the commit object exists" and "we know whether the ref
   * moved". Failures propagate — a SHA we could not record is a SHA a replay
   * cannot recognise, so committing anyway would recreate the defect.
   */
  onCommitCreated?(commitSha: string): Promise<void>;
}

export interface CommitFilesResult {
  commitSha: string;
}

export interface BookRepoWriter {
  /**
   * Commit the rendered files as one commit. Idempotent per operation: when
   * `trailers` carry `Authorbot-Operation` and a commit with that trailer
   * already exists on the branch, its SHA is returned without committing
   * again (crash-recovery safety).
   */
  commitFiles(input: CommitFilesInput): Promise<CommitFilesResult>;
  /**
   * Read one committed file from the branch head (Phase 4: the attribution
   * append reads the prior artifact so the whole file can be re-rendered in
   * the same commit as the edit). Returns `null` when the path does not
   * exist at the branch head. Optional: adapters without read access omit
   * it, and the processor fails `submission.apply` rows with a clear error
   * instead of clobbering (the GitHub adapter gains it in Phase 5).
   */
  readFile?(branch: string, filePath: string): Promise<string | null>;
  /**
   * Current head SHA of the branch, or `null` when the branch has no commits
   * yet. Callers that compute content from a read of the branch use it to pin
   * `expectedHeadOverride` on the resulting commit, so a plan built from one
   * head can never land on a different one (design §14.2). Optional: adapters
   * that cannot report a head omit it and their commits go unpinned.
   */
  resolveHead?(branch: string): Promise<string | null>;
}

/** Trailer key that makes commits idempotent per Git operation. */
export const OPERATION_TRAILER = "Authorbot-Operation";
export const ACTOR_TRAILER = "Authorbot-Actor";
export const ANNOTATION_TRAILER = "Authorbot-Annotation";
export const WORK_ITEM_TRAILER = "Authorbot-Work-Item";
/** Base revision the applied submission targeted (design §14.3, Phase 4). */
export const BASE_REVISION_TRAILER = "Authorbot-Base-Revision";

export type GitWriteFailure =
  /** Branch head is not where the caller expected (retryable → `conflict`). */
  | "non-fast-forward"
  /** Work tree holds uncommitted changes that are not this mutation's files. */
  | "dirty-tree"
  /** The work tree is not on the requested branch. */
  | "wrong-branch"
  /** Any other git failure (spawn error, non-zero exit, invalid input). */
  | "git-failure"
  /** Phase 5 adapter not implemented yet. */
  | "not-implemented";

/** Distinctly-typed write failures so the processor can classify retries. */
export class GitWriteError extends Error {
  override readonly name = "GitWriteError";
  readonly kind: GitWriteFailure;
  /** Only stale-head (`non-fast-forward`) failures are retryable. */
  readonly retryable: boolean;

  constructor(kind: GitWriteFailure, message: string, options?: { retryable?: boolean }) {
    super(message);
    this.kind = kind;
    this.retryable = options?.retryable ?? kind === "non-fast-forward";
  }
}

export function isGitWriteError(error: unknown): error is GitWriteError {
  return error instanceof GitWriteError;
}

const TRAILER_KEY_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Compose the full commit message: subject, blank line, trailer block.
 * Deterministic for identical input (trailer insertion order preserved).
 */
export function formatCommitMessage(
  message: string,
  trailers: Readonly<Record<string, string>>,
): string {
  const subject = message.replace(/\r\n/g, "\n").trimEnd();
  if (subject === "") {
    throw new Error("commit message must not be empty");
  }
  const lines = Object.entries(trailers).map(([key, value]) => {
    if (!TRAILER_KEY_REGEX.test(key)) {
      throw new Error(`invalid commit trailer key: ${JSON.stringify(key)}`);
    }
    if (value.includes("\n") || value.includes("\r")) {
      throw new Error(`commit trailer ${key} must not contain newlines`);
    }
    return `${key}: ${value}`;
  });
  if (lines.length === 0) {
    return `${subject}\n`;
  }
  return `${subject}\n\n${lines.join("\n")}\n`;
}
