/**
 * `GitHubBookRepoReader` - the `BookRepoReader` implementation that closes the
 * projection gap (Phase 5 contract §3, design §7.5).
 *
 * It reads a committed book repository through the **Git Data API** rather
 * than the Contents API, because one recursive tree read plus blob fetches is
 * a single consistent view of one commit: every file in a snapshot comes from
 * the same tree, so a push landing mid-read cannot produce a snapshot that
 * never existed. The commit sha is recorded on the snapshot so reconciliation
 * can detect drift (§3, §6).
 *
 * Worker-compatible: `fetch` and WebCrypto only.
 *
 * ## Relationship to `apps/api/src/projection/reader.ts`
 *
 * The snapshot types below are a structural mirror of the Phase 2 interface
 * declared there, which remains the source of truth. They are re-declared
 * rather than imported because `apps/api` depends on this package - importing
 * back would make the dependency graph cyclic. Both sides bottom out in the
 * same `@authorbot/schemas` and `@authorbot/repo-coordinator` types, so
 * `GitHubBookRepoReader` satisfies `BookRepoReader` structurally and
 * `rebuildProjection` works unchanged. `test/reader.test.ts` pins the shape.
 */
import { parseChapterMarkdown } from "@authorbot/markdown";
import {
  parseDecisionArtifact,
  parseWorkItemArtifact,
  type ParsedDecisionArtifact,
  type ParsedWorkItemArtifact,
} from "@authorbot/repo-coordinator";
import {
  annotationSchema,
  chapterFrontmatterSchema,
  replySchema,
  type Annotation,
  type ChapterFrontmatter,
  type Reply,
} from "@authorbot/schemas";
import { scrubSecrets, type AuthorizedFetch } from "./app-auth.js";
import { GITHUB_ACCEPT, GITHUB_API_ORIGIN } from "./constants.js";
import { decodeBase64, decodeUtf8 } from "./git-objects.js";

// ------------------------------------------------------------- snapshot types

export interface RepoChapterSnapshot {
  frontmatter: ChapterFrontmatter;
  /** Repo-relative path, e.g. `chapters/001-baseline.md`. */
  path: string;
  /** `sha256:<hex>` of the raw file bytes. */
  contentHash: string;
  /** Valid block-marker ids in document order. */
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

export interface RepoDecisionSnapshot {
  parsed: ParsedDecisionArtifact;
}

export interface RepoWorkItemSnapshot {
  parsed: ParsedWorkItemArtifact;
}

export interface BookRepoSnapshot {
  chapters: RepoChapterSnapshot[];
  annotations: RepoAnnotationSnapshot[];
  replies: RepoReplySnapshot[];
  decisions?: RepoDecisionSnapshot[];
  workItems?: RepoWorkItemSnapshot[];
  /** Head commit the snapshot was read at, when known. */
  headCommit?: string;
}

export interface BookRepoReader {
  readSnapshot(): Promise<BookRepoSnapshot>;
  readTextFile?(path: string): Promise<string | null>;
}

/**
 * What `GitHubBookRepoReader.readSnapshot` actually returns: the Phase 2
 * snapshot, plus the provenance a Git-backed read can prove and the raw text
 * of every matched file.
 *
 * `files` is not waste. §3 specifies the match set as `chapters/*.md`,
 * `story/**`, `.authorbot/**`, `book.yml`, which is wider than what the
 * projection parses today; handing the already-fetched bytes back means the
 * story/`book.yml` projections that arrive later cost no extra round trip.
 */
export interface GitHubBookRepoSnapshot extends BookRepoSnapshot {
  /** Always present here - a Git read always knows its commit. */
  headCommit: string;
  /** Tree the snapshot was read from (the head commit's root tree). */
  treeSha: string;
  decisions: RepoDecisionSnapshot[];
  workItems: RepoWorkItemSnapshot[];
  /** Every matched path → its UTF-8 text, in path order. */
  files: ReadonlyMap<string, string>;
}

// --------------------------------------------------------------------- errors

export type GitHubReadErrorCode =
  /** GitHub answered with a non-OK status. */
  | "http"
  /** The recursive tree was truncated - a partial snapshot is never returned. */
  | "truncated-tree"
  /** More matching files than `maxFiles` allows. */
  | "file-budget-exceeded"
  /** The branch has no ref. */
  | "missing-ref"
  /** A tree entry pointed at an object GitHub would not return. */
  | "missing-object"
  /** A committed artifact failed schema validation. */
  | "invalid-artifact";

/**
 * A read failure that names its cause, so callers can branch on it.
 *
 * The message is scrubbed by {@link scrubSecrets} for the same reason
 * `GitHubWriteError` scrubs its own: these messages are quoted into
 * coordinator results and operation errors, and a credential that ever
 * reached one would be persisted and member-readable. GitHub does not echo
 * our token today; `apiOrigin` means it is not the only endpoint we can be
 * pointed at.
 */
export class GitHubReadError extends Error {
  override readonly name: string = "GitHubReadError";
  readonly code: GitHubReadErrorCode;
  readonly status: number | undefined;

  constructor(code: GitHubReadErrorCode, message: string, status?: number) {
    super(scrubSecrets(message));
    this.code = code;
    this.status = status;
  }
}

/**
 * The recursive tree came back `truncated: true`.
 *
 * This is its own type because the failure mode it prevents is the worst one
 * available to a projection: silently rebuilding from a partial tree deletes
 * every chapter and annotation GitHub happened to omit. §3 makes it an
 * explicit error; callers must never fall back to the partial listing.
 */
export class TruncatedTreeError extends GitHubReadError {
  override readonly name = "TruncatedTreeError";
  readonly treeSha: string;
  /** How many entries GitHub did return before truncating. */
  readonly returnedEntries: number;

  constructor(treeSha: string, returnedEntries: number) {
    super(
      "truncated-tree",
      `tree ${treeSha} was truncated by GitHub (${returnedEntries} entries returned); ` +
        "refusing to build a partial snapshot",
    );
    this.treeSha = treeSha;
    this.returnedEntries = returnedEntries;
  }
}

export function isGitHubReadError(value: unknown): value is GitHubReadError {
  return value instanceof GitHubReadError;
}

// ------------------------------------------------------------------ paths

/**
 * Path containment, identical in guarantee to `LocalFsBookRepoReader`
 * (`apps/api/src/projection/local-fs.ts`): **absolute paths and `..` segments
 * are refused outright**, before anything else happens.
 *
 * The local reader additionally resolves against the repository root and
 * checks the result stays at or beneath it, because a filesystem can be
 * escaped by a symlink or a normalized prefix - famously, `/srv/book` plus
 * `../book-secrets/creds.env` normalizes to a SIBLING directory that passes a
 * naive `startsWith` test. Here the "root" is a git tree, which has no
 * parent to escape to and no symlink to follow, so refusing `..` and absolute
 * inputs *is* the whole boundary. Both readers therefore refuse exactly the
 * same inputs, which is what the contract requires: the sibling-prefix attack
 * is rejected at the `..` check on both sides, and `test/reader.test.ts`
 * asserts it here.
 *
 * Windows drive letters and backslash separators are handled too: the Worker
 * never sees them, but a path can originate from an operator's machine, and
 * `chapters\..\..\etc` must not become a request.
 */
export function isContainedRepoPath(path: string): boolean {
  if (path === "" || path.trim() !== path) return false;
  // Absolute: POSIX root, UNC, or a Windows drive.
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split(/[\\/]/);
  if (segments.includes("..")) return false;
  // A trailing or doubled separator means the caller did not mean a file.
  if (segments.some((segment) => segment === "")) return false;
  return true;
}

/** Normalize a contained path to its git form: `/` separators, no `.` segments. */
export function normalizeRepoPath(path: string): string {
  return path
    .split(/[\\/]/)
    .filter((segment) => segment !== ".")
    .join("/");
}

const CHAPTER_PATH = /^chapters\/[^/]+\.md$/;
const DECISION_PATH = /^\.authorbot\/decisions\/([^/]+)\.yml$/;
const WORK_ITEM_PATH = /^\.authorbot\/work-items\/([^/]+)\.md$/;
const ANNOTATION_PATH = /^\.authorbot\/annotations\/([^/]+)\/annotation\.md$/;
const REPLY_PATH = /^\.authorbot\/annotations\/([^/]+)\/replies\/([^/]+)\.md$/;

/**
 * The §3 match set: `chapters/*.md`, `story/**`, `.authorbot/**`, `book.yml`.
 * Everything else in the repository (README, site config, assets) is left
 * unfetched.
 */
export function isSnapshotPath(path: string): boolean {
  return (
    CHAPTER_PATH.test(path) ||
    path === "book.yml" ||
    path.startsWith("story/") ||
    path.startsWith(".authorbot/")
  );
}

// ------------------------------------------------------------------- helpers

/**
 * Strip a leading YAML frontmatter block; returns the Markdown body.
 *
 * Byte-for-byte the same algorithm as `stripFrontmatter` in
 * `apps/api/src/projection/local-fs.ts` - annotation and reply bodies are
 * compared against projections built by either reader, so any divergence
 * would show up as spurious content changes. It is duplicated rather than
 * imported because that module is Node-only (`node:fs`).
 */
export function stripFrontmatter(source: string): string {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return source.trim();
  }
  const close = source.indexOf("\n---", 3);
  if (close === -1) {
    return source.trim();
  }
  const afterClose = source.indexOf("\n", close + 1 + 3);
  return (afterClose === -1 ? "" : source.slice(afterClose + 1)).trim();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBufferView);
  let out = "";
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Encode a branch name for a ref path, keeping `/` as a path separator. */
function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

interface TreeEntryRecord {
  sha: string;
  size: number;
}

interface RefResponse {
  object?: { sha?: unknown };
}

interface CommitResponse {
  tree?: { sha?: unknown };
}

interface TreeResponse {
  sha?: unknown;
  truncated?: unknown;
  tree?: unknown;
}

interface BlobResponse {
  content?: unknown;
  encoding?: unknown;
}

// -------------------------------------------------------------------- options

export interface GitHubBookRepoReaderOptions {
  owner: string;
  repo: string;
  /** Branch to read; defaults to `main`. */
  branch?: string;
  /**
   * Credentialed `fetch` - normally `GitHubAppAuth.authorizedFetch`. Tests
   * pass the fake GitHub's `fetch` directly.
   */
  fetch: AuthorizedFetch;
  apiOrigin?: string;
  /**
   * Parallel blob fetches. §3 caps this at 8; larger values are clamped
   * rather than rejected, because exceeding it is a performance mistake, not
   * a correctness one, and failing a projection rebuild over it would be
   * worse than quietly doing the right thing.
   */
  maxConcurrency?: number;
  /** Hard cap on matched files per snapshot. Default 2000. */
  maxFiles?: number;
  /** Override the §3 match set (tests, and future story projections). */
  includePath?: (path: string) => boolean;
}

export const MAX_BLOB_CONCURRENCY = 8;
const DEFAULT_MAX_FILES = 2000;

export class GitHubBookRepoReader implements BookRepoReader {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly apiOrigin: string;
  readonly maxConcurrency: number;
  readonly maxFiles: number;

  readonly #fetch: AuthorizedFetch;
  readonly #includePath: (path: string) => boolean;
  /**
   * Path → entry, keyed by commit sha. A commit is immutable, so this is a
   * cache that can never go stale; it only ever avoids re-reading a tree we
   * have already read. The head ref is re-resolved on every call, so a caller
   * that writes and then reads through the same instance still sees its write.
   */
  readonly #treeIndex = new Map<string, { treeSha: string; entries: Map<string, TreeEntryRecord> }>();

  constructor(options: GitHubBookRepoReaderOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch ?? "main";
    this.apiOrigin = options.apiOrigin ?? GITHUB_API_ORIGIN;
    this.maxConcurrency = Math.max(1, Math.min(options.maxConcurrency ?? MAX_BLOB_CONCURRENCY, MAX_BLOB_CONCURRENCY));
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.#fetch = options.fetch;
    this.#includePath = options.includePath ?? isSnapshotPath;
  }

  private get repoPath(): string {
    return `${this.apiOrigin}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  // ------------------------------------------------------------------ HTTP

  async #getJson<T>(url: string, what: string): Promise<T> {
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { accept: GITHUB_ACCEPT },
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === "string") detail = `: ${body.message}`;
      } catch {
        // Non-JSON error bodies carry nothing we need.
      }
      throw new GitHubReadError(
        response.status === 404 ? "missing-object" : "http",
        `${what} failed (${response.status})${detail}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  /** Current head commit sha of the configured branch. */
  async readHeadCommit(): Promise<string> {
    const url = `${this.repoPath}/git/ref/heads/${encodeBranch(this.branch)}`;
    let body: RefResponse;
    try {
      body = await this.#getJson<RefResponse>(url, `reading ref heads/${this.branch}`);
    } catch (error) {
      if (isGitHubReadError(error) && error.status === 404) {
        throw new GitHubReadError(
          "missing-ref",
          `branch ${this.branch} does not exist in ${this.owner}/${this.repo}`,
          404,
        );
      }
      throw error;
    }
    const sha = body.object?.sha;
    if (typeof sha !== "string" || sha === "") {
      throw new GitHubReadError("missing-ref", `ref heads/${this.branch} carried no commit sha`);
    }
    return sha;
  }

  async #rootTreeSha(commitSha: string): Promise<string> {
    const body = await this.#getJson<CommitResponse>(
      `${this.repoPath}/git/commits/${commitSha}`,
      `reading commit ${commitSha}`,
    );
    const sha = body.tree?.sha;
    if (typeof sha !== "string" || sha === "") {
      throw new GitHubReadError("missing-object", `commit ${commitSha} carried no tree sha`);
    }
    return sha;
  }

  /**
   * The full path → blob index of one commit, from a single recursive tree
   * read. Truncation throws (see {@link TruncatedTreeError}).
   */
  async #indexFor(
    commitSha: string,
  ): Promise<{ treeSha: string; entries: Map<string, TreeEntryRecord> }> {
    const cached = this.#treeIndex.get(commitSha);
    if (cached !== undefined) return cached;

    const treeSha = await this.#rootTreeSha(commitSha);
    const body = await this.#getJson<TreeResponse>(
      `${this.repoPath}/git/trees/${treeSha}?recursive=1`,
      `reading tree ${treeSha}`,
    );
    const raw = Array.isArray(body.tree) ? (body.tree as readonly Record<string, unknown>[]) : [];
    if (body.truncated === true) {
      throw new TruncatedTreeError(treeSha, raw.length);
    }
    const entries = new Map<string, TreeEntryRecord>();
    for (const entry of raw) {
      if (entry["type"] !== "blob") continue;
      const path = entry["path"];
      const sha = entry["sha"];
      if (typeof path !== "string" || typeof sha !== "string") continue;
      const size = typeof entry["size"] === "number" ? entry["size"] : 0;
      entries.set(path, { sha, size });
    }
    const index = { treeSha, entries };
    this.#treeIndex.set(commitSha, index);
    return index;
  }

  async #readBlobText(sha: string): Promise<string> {
    const body = await this.#getJson<BlobResponse>(
      `${this.repoPath}/git/blobs/${sha}`,
      `reading blob ${sha}`,
    );
    if (typeof body.content !== "string") {
      throw new GitHubReadError("missing-object", `blob ${sha} carried no content`);
    }
    if (body.encoding !== "base64") {
      throw new GitHubReadError("missing-object", `blob ${sha} used unsupported encoding`);
    }
    // GitHub wraps base64 at 60 columns; `decodeBase64` strips the newlines.
    return decodeUtf8(decodeBase64(body.content));
  }

  async #readBlobBytes(sha: string): Promise<Uint8Array> {
    const body = await this.#getJson<BlobResponse>(
      `${this.repoPath}/git/blobs/${sha}`,
      `reading blob ${sha}`,
    );
    if (typeof body.content !== "string" || body.encoding !== "base64") {
      throw new GitHubReadError("missing-object", `blob ${sha} carried no base64 content`);
    }
    return decodeBase64(body.content);
  }

  // -------------------------------------------------------------- interface

  /**
   * Raw text of one committed repository file, or `null` when it does not
   * exist. Containment is checked first, so a traversal attempt costs no
   * request at all - the guard cannot be probed for timing or existence.
   */
  async readTextFile(path: string): Promise<string | null> {
    if (!isContainedRepoPath(path)) return null;
    const normalized = normalizeRepoPath(path);
    const head = await this.readHeadCommit();
    const { entries } = await this.#indexFor(head);
    const entry = entries.get(normalized);
    if (entry === undefined) return null;
    return this.#readBlobText(entry.sha);
  }

  /**
   * One consistent snapshot of the branch head: a single recursive tree read,
   * then bounded-concurrency blob fetches for matching paths only.
   */
  async readSnapshot(): Promise<GitHubBookRepoSnapshot> {
    const headCommit = await this.readHeadCommit();
    const { treeSha, entries } = await this.#indexFor(headCommit);

    const paths = [...entries.keys()].filter(this.#includePath).sort();
    if (paths.length > this.maxFiles) {
      throw new GitHubReadError(
        "file-budget-exceeded",
        `snapshot matched ${paths.length} files, above the ${this.maxFiles} limit`,
      );
    }

    const bytes = await this.#fetchAll(paths, entries);
    const files = new Map<string, string>();
    for (const path of paths) {
      files.set(path, decodeUtf8(bytes.get(path) as Uint8Array));
    }

    const snapshot: GitHubBookRepoSnapshot = {
      headCommit,
      treeSha,
      chapters: await this.#chapters(paths, bytes),
      ...this.#annotationsAndReplies(paths, files),
      decisions: this.#decisions(paths, files),
      workItems: this.#workItems(paths, files),
      files,
    };
    return snapshot;
  }

  /**
   * Fetch every path with at most {@link maxConcurrency} requests in flight.
   *
   * A fixed pool of workers pulling from a shared cursor, rather than
   * chunked `Promise.all` batches: batching stalls the whole group on its
   * slowest member, and - the reason it matters for the contract - it makes
   * the *observed* peak concurrency lower than the bound, so a test asserting
   * the bound would pass for the wrong reason.
   */
  async #fetchAll(
    paths: readonly string[],
    entries: ReadonlyMap<string, TreeEntryRecord>,
  ): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= paths.length) return;
        const path = paths[index] as string;
        const entry = entries.get(path);
        if (entry === undefined) continue;
        out.set(path, await this.#readBlobBytes(entry.sha));
      }
    };
    const workers = Math.min(this.maxConcurrency, Math.max(paths.length, 1));
    await Promise.all(Array.from({ length: workers }, worker));
    return out;
  }

  // ---------------------------------------------------------------- parsing

  async #chapters(
    paths: readonly string[],
    bytes: ReadonlyMap<string, Uint8Array>,
  ): Promise<RepoChapterSnapshot[]> {
    const chapters: RepoChapterSnapshot[] = [];
    for (const path of paths.filter((candidate) => CHAPTER_PATH.test(candidate))) {
      const raw = bytes.get(path) as Uint8Array;
      const source = decodeUtf8(raw);
      const parsed = parseChapterMarkdown(source);
      if (parsed.frontmatterError !== undefined) {
        throw new GitHubReadError(
          "invalid-artifact",
          `${path}: unparseable frontmatter: ${parsed.frontmatterError}`,
        );
      }
      const frontmatter = chapterFrontmatterSchema.safeParse(parsed.frontmatter);
      if (!frontmatter.success) {
        throw new GitHubReadError("invalid-artifact", `${path}: invalid chapter frontmatter`);
      }
      chapters.push({
        frontmatter: frontmatter.data,
        path,
        // Hashed over the raw bytes, so the digest matches `sha256sum` on the
        // checked-out file and the local reader's hash of the same content.
        contentHash: `sha256:${await sha256Hex(raw)}`,
        blockIds: parsed.blocks.markers.filter((marker) => marker.valid).map((marker) => marker.id),
      });
    }
    return chapters;
  }

  #annotationsAndReplies(
    paths: readonly string[],
    files: ReadonlyMap<string, string>,
  ): { annotations: RepoAnnotationSnapshot[]; replies: RepoReplySnapshot[] } {
    const annotations: RepoAnnotationSnapshot[] = [];
    const replies: RepoReplySnapshot[] = [];

    // Group by annotation id, mirroring the local reader's directory walk:
    // ids in sorted order, each id's replies sorted within it. A directory
    // without `annotation.md` is not an annotation, and its replies are
    // ignored rather than orphaned.
    const ids = paths
      .map((path) => ANNOTATION_PATH.exec(path)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort();

    for (const id of ids) {
      const path = `.authorbot/annotations/${id}/annotation.md`;
      const source = files.get(path) as string;
      const record = annotationSchema.safeParse(parseChapterMarkdown(source).frontmatter);
      if (!record.success) {
        throw new GitHubReadError("invalid-artifact", `${path}: invalid annotation`);
      }
      annotations.push({ record: record.data, body: stripFrontmatter(source) });

      const replyPaths = paths
        .filter((candidate) => REPLY_PATH.exec(candidate)?.[1] === id)
        .sort();
      for (const replyPath of replyPaths) {
        const replySource = files.get(replyPath) as string;
        const replyRecord = replySchema.safeParse(parseChapterMarkdown(replySource).frontmatter);
        if (!replyRecord.success) {
          throw new GitHubReadError("invalid-artifact", `${replyPath}: invalid reply`);
        }
        replies.push({ record: replyRecord.data, body: stripFrontmatter(replySource) });
      }
    }
    return { annotations, replies };
  }

  #decisions(
    paths: readonly string[],
    files: ReadonlyMap<string, string>,
  ): RepoDecisionSnapshot[] {
    const decisions: RepoDecisionSnapshot[] = [];
    for (const path of paths.filter((candidate) => DECISION_PATH.test(candidate)).sort()) {
      const name = path.slice(".authorbot/decisions/".length);
      try {
        decisions.push({ parsed: parseDecisionArtifact(files.get(path) as string) });
      } catch (error) {
        throw new GitHubReadError(
          "invalid-artifact",
          `.authorbot/decisions/${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return decisions;
  }

  #workItems(
    paths: readonly string[],
    files: ReadonlyMap<string, string>,
  ): RepoWorkItemSnapshot[] {
    const workItems: RepoWorkItemSnapshot[] = [];
    for (const path of paths.filter((candidate) => WORK_ITEM_PATH.test(candidate)).sort()) {
      const name = path.slice(".authorbot/work-items/".length);
      try {
        workItems.push({ parsed: parseWorkItemArtifact(files.get(path) as string) });
      } catch (error) {
        throw new GitHubReadError(
          "invalid-artifact",
          `.authorbot/work-items/${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return workItems;
  }
}
