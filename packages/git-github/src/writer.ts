/**
 * `GitHubBookRepoWriter` - the production `BookRepoWriter` (Phase 5 contract
 * §4, design §14.2/§14.3), replacing `LocalGitAdapter` on the deployed
 * Worker.
 *
 * One logical mutation becomes one commit through the Git Data API, in the
 * order design §14.2 prescribes:
 *
 *   1. `GET  /repos/{o}/{r}/git/ref/heads/{branch}`   → current head
 *   2. `GET  /repos/{o}/{r}/git/commits/{head}`       → the head's tree
 *   3. `POST /repos/{o}/{r}/git/blobs`                → one blob per file
 *   4. `POST /repos/{o}/{r}/git/trees` with `base_tree` = the head's tree
 *   5. `POST /repos/{o}/{r}/git/commits` with the head as the sole parent
 *   6. `PATCH /repos/{o}/{r}/git/refs/heads/{branch}` with `force: false`
 *
 * `base_tree` is what keeps the commit additive: files nobody touched are
 * carried over rather than dropped, so a mutation can never silently delete
 * the rest of the book.
 *
 * **Never a force update.** A `422` on step 6 means the head moved under us;
 * the whole sequence restarts from a fresh ref read, bounded at
 * `maxAttempts` (default 3). Exhaustion, and a `expectedHeadOverride` that no
 * longer matches the branch, both raise a typed `non-fast-forward`
 * `GitWriteError` - a conflict the caller re-plans from, never a clobber.
 *
 * Worker-compatible: `fetch` and WebCrypto only, no `node:` imports. The
 * `fetch` implementation is injected, so tests drive the whole sequence
 * against the deterministic fake GitHub in `@authorbot/git-github/testing`.
 *
 * Credentials: the installation token is fetched per request from the
 * injected token source, sent only in the `Authorization` header, and never
 * logged, persisted, or included in an error message or return value.
 */
import {
  formatCommitMessage,
  GitWriteError,
  OPERATION_TRAILER,
} from "@authorbot/repo-coordinator/writer";
import type {
  BookRepoWriter,
  CommitFile,
  CommitFilesInput,
  CommitFilesResult,
  GitWriteFailure,
} from "@authorbot/repo-coordinator/writer";
import { scrubSecrets } from "./app-auth.js";
import {
  GITHUB_ACCEPT,
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from "./constants.js";
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8 } from "./git-objects.js";

// ---------------------------------------------------------------- token seam

/** Options a caller may pass when asking for an installation token. */
export interface InstallationTokenRequest {
  /**
   * Discard any cached token and mint a fresh one. Set after a `401`, which
   * is how contract §2's "refreshed on 401" is honoured.
   */
  forceRefresh?: boolean;
}

/** Function form of the installation-token seam. */
export type InstallationTokenGetter = (
  request?: InstallationTokenRequest,
) => Promise<string>;

/**
 * Object form of the installation-token seam. Deliberately the exact shape of
 * `GitHubAppAuth.installationToken` from `src/app-auth.ts` (Phase 5 §2: mint
 * an app JWT, exchange it for an installation token, cache it per isolate
 * until five minutes before expiry), so a `GitHubAppAuth` instance is passed
 * as `tokens` with no adapter:
 *
 * ```ts
 * const auth = getGitHubAppAuth(credentials);
 * new GitHubBookRepoWriter({ repo, tokens: auth });
 * ```
 *
 * The writer depends on that one *method*, not on the module - a bare async
 * function is equally accepted - so the two land independently and tests can
 * supply a constant token.
 */
export interface InstallationTokenSource {
  installationToken: InstallationTokenGetter;
}

export type InstallationTokenProvider =
  | InstallationTokenSource
  | InstallationTokenGetter;

/** Normalize either accepted token-source shape to a plain getter. */
export function toInstallationTokenGetter(
  provider: InstallationTokenProvider,
): InstallationTokenGetter {
  if (typeof provider === "function") return provider;
  return (request) => provider.installationToken(request);
}

/** The slice of `fetch` this package uses; the fake GitHub satisfies it. */
export type FetchLike = (
  input: Request | string,
  init?: RequestInit,
) => Promise<Response>;

// --------------------------------------------------------------------- error

export interface GitHubWriteErrorInit {
  kind: GitWriteFailure;
  message: string;
  /** HTTP status that produced the failure, when there was one. */
  status?: number;
  retryable?: boolean;
  /** True when GitHub answered with a primary or secondary rate limit. */
  rateLimited?: boolean;
  /** `retry-after` header, seconds. */
  retryAfterSeconds?: number;
  /** `x-ratelimit-reset` header, epoch seconds. */
  rateLimitResetEpochSeconds?: number;
  /** §14.2 attempts spent when the failure was raised. */
  attempts?: number;
}

/**
 * A `GitWriteError` (so `isGitWriteError` and the processor's retry
 * classification keep working) carrying the GitHub specifics an operator
 * needs. Messages quote GitHub's own `message` field only - never a token,
 * never a request header.
 *
 * The message is additionally run through {@link scrubSecrets} before it
 * reaches `Error`. That is defence in depth, not decoration: this message is
 * persisted to `git_operations.error` and served to any project member by
 * `GET /v1/projects/{id}/operations/{operationId}`, so it is a durable,
 * readable sink. api.github.com does not echo the `Authorization` header
 * today, but `apiOrigin` is a supported option (a proxy, an alternate
 * endpoint), and a token written into D1 would be a retroactive,
 * unrecoverable leak. Contract §2: installation tokens are never persisted.
 */
export class GitHubWriteError extends GitWriteError {
  readonly status: number | undefined;
  readonly rateLimited: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly rateLimitResetEpochSeconds: number | undefined;
  readonly attempts: number | undefined;

  constructor(init: GitHubWriteErrorInit) {
    super(
      init.kind,
      scrubSecrets(init.message),
      init.retryable === undefined ? {} : { retryable: init.retryable },
    );
    this.status = init.status;
    this.rateLimited = init.rateLimited ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.rateLimitResetEpochSeconds = init.rateLimitResetEpochSeconds;
    this.attempts = init.attempts;
  }
}

// ------------------------------------------------------------------- options

export interface GitHubBookRepoWriterOptions {
  /** `owner/name`, exactly as `PROJECT_REPO` spells it. */
  repo: string;
  /** Installation-token source (object or function form). */
  tokens: InstallationTokenProvider;
  /** Injected `fetch`; defaults to the global. Tests pass the fake GitHub. */
  fetchImpl?: FetchLike;
  /** API origin; defaults to `https://api.github.com`. */
  apiOrigin?: string;
  /** Git author/committer name - the *service* identity (design §14.3). */
  authorName?: string;
  /** Git author/committer email - the *service* identity (design §14.3). */
  authorEmail?: string;
  /** Clock for commit timestamps. Defaults to `Date.now`. */
  now?: () => Date;
  /** §14.2 step 6 retry bound. Default 3, minimum 1. */
  maxAttempts?: number;
  /** Parallel blob uploads. Default 8. */
  blobConcurrency?: number;
  /**
   * How far back to look for an `Authorbot-Operation` trailer before
   * committing, making a crash-after-commit replay return the landed SHA
   * instead of committing twice. Costs one `GET /git/commits/{sha}` per
   * commit past the head (the head's own fetch is needed anyway), so the
   * default is deliberately shallow: a replay's commit is at or just below
   * the head, since commits for a project are serialized by the coordinator.
   * `0` disables the scan.
   */
  operationScanDepth?: number;
}

/**
 * The Authorbot service identity. Design §14.3: Git's author/committer is the
 * service; the human or agent who actually did the work is credited in the
 * attribution records inside the commit, so no Git identity is ever forged.
 */
export const AUTHORBOT_GIT_NAME = "Authorbot";
export const AUTHORBOT_GIT_EMAIL = "authorbot@users.noreply.github.com";

/** Mode a path gets when it does not already exist in `base_tree`. */
export const DEFAULT_FILE_MODE = "100644";

/** Regular-file modes a text blob may legitimately keep. */
const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/**
 * The mode to reuse for an existing path, refusing the ones a text blob must
 * never silently replace.
 *
 * `120000` is a symlink and `160000` a submodule gitlink. Overwriting either
 * with a regular blob is a structural change to the repository that no §14.3
 * trailer records, so it is a typed failure rather than a quiet rewrite.
 */
function checkedFileMode(path: string, entry: TreeEntryResponse): string {
  if (REGULAR_FILE_MODES.has(entry.mode)) return entry.mode;
  if (entry.mode === "120000" || entry.mode === "160000") {
    throw new GitHubWriteError({
      kind: "git-failure",
      retryable: false,
      message:
        `refusing to overwrite ${JSON.stringify(path)}: it is a ` +
        `${entry.mode === "120000" ? "symlink" : "submodule"} (mode ${entry.mode}), ` +
        `not a regular file`,
    });
  }
  return DEFAULT_FILE_MODE;
}

// ------------------------------------------------------------- API responses

interface RefResponse {
  ref: string;
  object: { sha: string; type: string };
}

interface CommitResponse {
  sha: string;
  message: string;
  tree: { sha: string };
  parents: readonly { sha: string }[];
}

interface BlobCreateResponse {
  sha: string;
}

interface TreeResponse {
  sha: string;
  truncated?: boolean;
  tree: readonly TreeEntryResponse[];
}

interface TreeEntryResponse {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface BlobReadResponse {
  content: string;
  encoding: string;
}

interface ApiResult<T> {
  status: number;
  headers: Headers;
  body: T;
}

interface GitHubErrorBody {
  message?: unknown;
}

// -------------------------------------------------------------------- writer

export class GitHubBookRepoWriter implements BookRepoWriter {
  readonly owner: string;
  readonly repo: string;

  readonly #token: InstallationTokenGetter;
  readonly #fetch: FetchLike;
  readonly #origin: string;
  readonly #authorName: string;
  readonly #authorEmail: string;
  readonly #now: () => Date;
  readonly #maxAttempts: number;
  readonly #blobConcurrency: number;
  readonly #operationScanDepth: number;

  constructor(options: GitHubBookRepoWriterOptions) {
    const { owner, repo } = parseRepo(options.repo);
    this.owner = owner;
    this.repo = repo;
    this.#token = toInstallationTokenGetter(options.tokens);
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#origin = (options.apiOrigin ?? GITHUB_API_ORIGIN).replace(/\/+$/, "");
    this.#authorName = options.authorName ?? AUTHORBOT_GIT_NAME;
    this.#authorEmail = options.authorEmail ?? AUTHORBOT_GIT_EMAIL;
    this.#now = options.now ?? (() => new Date());
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#blobConcurrency = Math.max(1, options.blobConcurrency ?? 8);
    this.#operationScanDepth = Math.max(0, options.operationScanDepth ?? 5);
  }

  /** `owner/repo`, as configuration spells it. */
  get fullName(): string {
    return `${this.owner}/${this.repo}`;
  }

  /**
   * Commit every file of one logical mutation as a single commit on
   * `branch`, following design §14.2. Returns the new commit's SHA - or, when
   * this operation already landed, the SHA it landed as.
   */
  async commitFiles(input: CommitFilesInput): Promise<CommitFilesResult> {
    const files = normalizeFiles(input.files);
    const message = formatCommitMessage(input.message, input.trailers);
    const operationId = input.trailers[OPERATION_TRAILER];
    const branch = input.branch;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      // 1. Read the branch ref.
      const head = await this.#requireHead(branch);
      // 2. …and the head commit, whose tree becomes the new tree's base.
      const headCommit = await this.#readCommit(head);

      // Idempotency first, exactly as the Phase 4 processor documents: a
      // crash between the commit and the database write replays with the same
      // operation id and a now-stale `expectedHeadOverride`. The dedup has to
      // run *before* the head check or that replay would report a conflict
      // for work that already landed.
      //
      // Identity before proximity: a SHA this operation recorded on an
      // earlier attempt is checked for ancestry first, because that answer is
      // independent of how many commits anyone else pushed in the meantime.
      // The trailer scan below is the fallback for operations that crashed
      // before recording anything.
      if (input.attemptedCommitSha !== undefined && input.attemptedCommitSha !== "") {
        if (await this.#isAncestor(input.attemptedCommitSha, head)) {
          return { commitSha: input.attemptedCommitSha };
        }
      }
      if (operationId !== undefined) {
        const landed = await this.#findOperationCommit(headCommit, operationId);
        if (landed !== null) return { commitSha: landed };
      }

      // A pinned head that no longer matches is a precondition failure, not
      // an invitation to rebase: the content was computed against a head that
      // is gone, so it must be recomputed, never replayed onto a newer one.
      if (input.expectedHeadOverride !== undefined && input.expectedHeadOverride !== head) {
        throw new GitHubWriteError({
          kind: "non-fast-forward",
          retryable: true,
          attempts: attempt,
          message:
            `branch ${JSON.stringify(branch)} head moved: expected ` +
            `${input.expectedHeadOverride}, found ${head}`,
        });
      }

      // 3-5. Blobs, tree on top of the head's tree, commit with one parent.
      const blobs = await this.#createBlobs(files);
      const treeSha = await this.#createTree(headCommit.tree.sha, files, blobs);
      const commitSha = await this.#createCommit(message, treeSha, head);
      // Record the attempt BEFORE the ref update: everything after this point
      // can land the commit without us learning that it did.
      await input.onCommitCreated?.(commitSha);

      // 6. Fast-forward-only ref update. `force` is hard-coded false.
      const patched = await this.#updateRef(branch, commitSha);
      if (patched.status === 200 || patched.status === 201) {
        return { commitSha };
      }

      // Head moved between the read and the update. Pinned callers cannot be
      // rebased for them; unpinned ones rebuild from the new head.
      if (input.expectedHeadOverride !== undefined) {
        throw new GitHubWriteError({
          kind: "non-fast-forward",
          retryable: true,
          status: patched.status,
          attempts: attempt,
          message:
            `branch ${JSON.stringify(branch)} moved past pinned head ` +
            `${input.expectedHeadOverride}: ${errorMessageOf(patched.body)}`,
        });
      }
    }

    throw new GitHubWriteError({
      kind: "non-fast-forward",
      retryable: true,
      attempts: this.#maxAttempts,
      message:
        `branch ${JSON.stringify(branch)} head kept moving: gave up after ` +
        `${this.#maxAttempts} fast-forward attempts (no force update was made)`,
    });
  }

  /**
   * Head SHA of `branch`, or `null` when the branch does not exist. Callers
   * pin it as `expectedHeadOverride` so a plan built from one head can never
   * land on another (design §14.2).
   */
  async resolveHead(branch: string): Promise<string | null> {
    const result = await this.#call<RefResponse>("GET", this.#refPath(branch), {
      allow: [404],
    });
    if (result.status === 404) return null;
    return result.body.object.sha;
  }

  /**
   * One committed file's text at the branch head, or `null` when the path is
   * absent there. Resolves the path a directory at a time so a huge
   * repository never depends on an untruncated recursive tree.
   *
   * An unknown branch throws rather than answering `null`: the Phase 4
   * attribution append re-renders whatever this returns, so a `null` misread
   * would silently drop the file's history.
   */
  async readFile(branch: string, filePath: string): Promise<string | null> {
    const head = await this.#requireHead(branch);
    const headCommit = await this.#readCommit(head);
    const entry = await this.#resolveEntry(
      headCommit.tree.sha,
      safeRepoPath(filePath),
      new Map(),
    );
    if (entry === null || entry.type !== "blob") return null;
    return await this.#readBlob(entry.sha);
  }

  /**
   * Walk a path a directory at a time, returning the entry it names or `null`
   * when the path is genuinely absent. `cache` memoizes tree listings within
   * one call so a commit touching several files under `.authorbot/` reads
   * each directory once.
   *
   * The point of the walk (rather than one recursive read) is that a huge
   * repository never depends on an untruncated recursive tree - but
   * per-directory listings truncate too, and {@link #readTree} refuses them
   * rather than reporting a present file as missing.
   */
  async #resolveEntry(
    rootTreeSha: string,
    path: string,
    cache: Map<string, TreeResponse>,
  ): Promise<TreeEntryResponse | null> {
    const segments = path.split("/");
    let treeSha = rootTreeSha;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index] as string;
      let tree = cache.get(treeSha);
      if (tree === undefined) {
        const read = await this.#readTree(treeSha);
        if (read === null) return null;
        cache.set(treeSha, read);
        tree = read;
      }
      const entry = tree.tree.find((candidate) => candidate.path === name);
      if (entry === undefined) return null;
      if (index === segments.length - 1) return entry;
      if (entry.type !== "tree") return null;
      treeSha = entry.sha;
    }
    return null;
  }

  /**
   * One tree listing, or `null` when the tree object is gone. A `truncated`
   * listing is an ERROR, never a partial answer - the same rule the reader
   * enforces with `TruncatedTreeError` (contract §3).
   *
   * Without this, a truncated listing made `readFile` return `null` for a file
   * that exists, indistinguishable from "absent". The Phase 4 attribution
   * append treats `null` as "no prior file" and renders a fresh single-entry
   * artifact, so one truncated `.authorbot/attribution/` listing would commit
   * away a chapter's entire attribution history inside a commit that looks
   * like an ordinary apply.
   */
  async #readTree(treeSha: string): Promise<TreeResponse | null> {
    const tree = await this.#call<TreeResponse>(
      "GET",
      `${this.#repoPath()}/git/trees/${treeSha}`,
      { allow: [404] },
    );
    if (tree.status === 404) return null;
    if (tree.body.truncated === true) {
      throw new GitHubWriteError({
        kind: "git-failure",
        // Truncation is a property of the listing, not of the request: a
        // retry against the same tree truncates identically.
        retryable: false,
        message:
          `tree ${treeSha} was truncated by GitHub ` +
          `(${String(tree.body.tree.length)} entries returned); refusing to ` +
          `treat a partial listing as the repository's contents`,
      });
    }
    return tree.body;
  }

  // ------------------------------------------------------------- §14.2 steps

  async #requireHead(branch: string): Promise<string> {
    const head = await this.resolveHead(branch);
    if (head === null) {
      throw new GitHubWriteError({
        kind: "git-failure",
        status: 404,
        message: `branch ${JSON.stringify(branch)} does not exist in ${this.fullName}`,
      });
    }
    return head;
  }

  async #readCommit(sha: string): Promise<CommitResponse> {
    const result = await this.#call<CommitResponse>(
      "GET",
      `${this.#repoPath()}/git/commits/${sha}`,
    );
    return result.body;
  }

  /**
   * Walk first parents from the head looking for a commit whose trailer block
   * carries this operation id. Bounded by `operationScanDepth`; the head
   * commit itself is already in hand, so a depth of 1 costs nothing.
   */
  async #findOperationCommit(
    headCommit: CommitResponse,
    operationId: string,
  ): Promise<string | null> {
    if (this.#operationScanDepth === 0) return null;
    let commit: CommitResponse | null = headCommit;
    for (let depth = 0; depth < this.#operationScanDepth && commit !== null; depth += 1) {
      if (hasOperationTrailer(commit.message, operationId)) return commit.sha;
      const parent: string | undefined = commit.parents[0]?.sha;
      commit = parent === undefined ? null : await this.#readCommit(parent);
    }
    return null;
  }

  /**
   * Is `candidate` reachable from `head`? i.e. did it land on this branch?
   *
   * `GET /compare/{base}...{head}` answers `ahead` or `identical` exactly when
   * `base` is an ancestor of `head`, in one request and at any distance - which
   * is the whole point: the trailer scan's answer degrades as unrelated commits
   * accumulate, this one does not. A commit GitHub no longer knows (404) is
   * not an ancestor.
   */
  async #isAncestor(candidate: string, head: string): Promise<boolean> {
    if (candidate === head) return true;
    const result = await this.#call<{ status?: unknown }>(
      "GET",
      `${this.#repoPath()}/compare/${candidate}...${head}`,
      { allow: [404, 422] },
    );
    if (result.status === 404 || result.status === 422) return false;
    const status = result.body.status;
    return status === "ahead" || status === "identical";
  }

  /** One blob per file, base64 so bytes survive verbatim. Bounded parallel. */
  async #createBlobs(files: readonly CommitFile[]): Promise<string[]> {
    const shas = new Array<string>(files.length);
    let next = 0;
    const workers = Math.min(this.#blobConcurrency, files.length);
    const run = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= files.length) return;
        const file = files[index] as CommitFile;
        const result = await this.#call<BlobCreateResponse>(
          "POST",
          `${this.#repoPath()}/git/blobs`,
          {
            body: {
              content: encodeBase64(encodeUtf8(file.content)),
              encoding: "base64",
            },
          },
        );
        shas[index] = result.body.sha;
      }
    };
    await Promise.all(Array.from({ length: workers }, run));
    return shas;
  }

  /**
   * A tree layered on the head's tree. `base_tree` is what preserves every
   * file this mutation does not mention - without it the commit would be the
   * whole repository, i.e. a deletion of everything else.
   */
  async #createTree(
    baseTree: string,
    files: readonly CommitFile[],
    blobs: readonly string[],
  ): Promise<string> {
    const modes = await this.#baseTreeModes(baseTree, files.map((file) => file.path));
    const result = await this.#call<TreeResponse>("POST", `${this.#repoPath()}/git/trees`, {
      body: {
        base_tree: baseTree,
        tree: files.map((file, index) => ({
          path: file.path,
          mode: modes.get(file.path) ?? DEFAULT_FILE_MODE,
          type: "blob",
          sha: blobs[index] as string,
        })),
      },
    });
    return result.body.sha;
  }

  /**
   * The mode each path already carries in `base_tree`, for the paths this
   * commit rewrites. Absent from the map ⇒ a genuinely new path, which gets
   * {@link DEFAULT_FILE_MODE}.
   *
   * A supplied tree entry overrides the `base_tree` entry WHOLESALE, mode
   * included, so hard-coding `100644` silently rewrote the mode of every file
   * an apply touched. The writable set is not limited to Authorbot's own
   * `.authorbot/**` artifacts: a `submission.apply` commits the author's own
   * `chapters/*.md`, whose executable bit the writer never set and has no
   * business clearing. The mode change would land inside a commit whose
   * message and §14.3 trailers describe only a prose edit.
   *
   * One recursive read normally answers for every path at once; a truncated
   * listing falls back to the per-directory walk rather than defaulting, so a
   * huge repository loses no modes either.
   */
  async #baseTreeModes(
    baseTree: string,
    paths: readonly string[],
  ): Promise<Map<string, string>> {
    const modes = new Map<string, string>();
    const recursive = await this.#call<TreeResponse>(
      "GET",
      `${this.#repoPath()}/git/trees/${baseTree}?recursive=1`,
      { allow: [404] },
    );
    if (recursive.status !== 404 && recursive.body.truncated !== true) {
      const wanted = new Set(paths);
      for (const entry of recursive.body.tree) {
        if (wanted.has(entry.path)) modes.set(entry.path, checkedFileMode(entry.path, entry));
      }
      return modes;
    }
    const cache = new Map<string, TreeResponse>();
    for (const path of paths) {
      const entry = await this.#resolveEntry(baseTree, path, cache);
      if (entry !== null) modes.set(path, checkedFileMode(path, entry));
    }
    return modes;
  }

  async #createCommit(message: string, tree: string, parent: string): Promise<string> {
    const date = this.#now().toISOString();
    const identity = { name: this.#authorName, email: this.#authorEmail, date };
    const result = await this.#call<CommitResponse>("POST", `${this.#repoPath()}/git/commits`, {
      body: {
        message,
        tree,
        parents: [parent],
        author: identity,
        committer: identity,
      },
    });
    return result.body.sha;
  }

  /** `force` is `false`, always and only. Non-fast-forward comes back as 422. */
  #updateRef(branch: string, sha: string): Promise<ApiResult<unknown>> {
    return this.#call<unknown>("PATCH", `${this.#repoPath()}/git/refs/heads/${encodeBranch(branch)}`, {
      body: { sha, force: false },
      allow: [409, 422],
    });
  }

  async #readBlob(sha: string): Promise<string> {
    const result = await this.#call<BlobReadResponse>(
      "GET",
      `${this.#repoPath()}/git/blobs/${sha}`,
    );
    const { content, encoding } = result.body;
    if (encoding !== "base64") {
      throw new GitHubWriteError({
        kind: "git-failure",
        message: `blob ${sha} came back with unsupported encoding ${JSON.stringify(encoding)}`,
      });
    }
    // The real API wraps base64 at 60 columns; `decodeBase64` strips it.
    return decodeUtf8(decodeBase64(content));
  }

  // ---------------------------------------------------------------- HTTP

  #repoPath(): string {
    return `/repos/${this.owner}/${this.repo}`;
  }

  #refPath(branch: string): string {
    return `${this.#repoPath()}/git/ref/heads/${encodeBranch(branch)}`;
  }

  /**
   * One API call. Refreshes the installation token once on `401` (contract
   * §2) and turns every status outside `allow` into a typed `GitWriteError`.
   */
  async #call<T>(
    method: string,
    path: string,
    options: { body?: unknown; allow?: readonly number[] } = {},
  ): Promise<ApiResult<T>> {
    let response = await this.#send(method, path, options.body, false);
    if (response.status === 401) {
      response = await this.#send(method, path, options.body, true);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = undefined;
    }

    const allowed = options.allow ?? [];
    if (response.ok || allowed.includes(response.status)) {
      return { status: response.status, headers: response.headers, body: body as T };
    }
    throw this.#failure(method, path, response, body);
  }

  async #send(
    method: string,
    path: string,
    body: unknown,
    forceRefresh: boolean,
  ): Promise<Response> {
    const token = await this.#token(forceRefresh ? { forceRefresh: true } : undefined);
    const headers: Record<string, string> = {
      // Only place a credential ever appears. Never logged, never returned.
      authorization: `Bearer ${token}`,
      accept: GITHUB_ACCEPT,
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": GITHUB_USER_AGENT,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.#fetch(`${this.#origin}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // A REJECTED fetch - connection reset, TLS failure, request cancelled -
      // is not an HTTP status, so `#failure` never sees it and it would escape
      // as a raw TypeError. The processor's guard is
      // `isGitWriteError(error) && error.retryable`, so a raw TypeError falls
      // through to `failOperation`: terminal, no retry, attempts not even
      // consumed. That is the one failure mode that can leave a commit LANDED
      // (the `PATCH /git/refs` was applied, the response never arrived) with
      // the database recording a conflict - git at revision N+1, D1 at N.
      //
      // Retrying is safe precisely because it is this operation replaying:
      // `#findOperationCommit`'s `Authorbot-Operation` trailer dedup and the
      // `attemptedCommitSha` ancestry check both run before anything is
      // created, so an already-landed commit comes back as its own SHA.
      throw new GitHubWriteError({
        kind: "git-failure",
        retryable: true,
        message:
          `GitHub request ${method} ${path} did not complete (transport failure): ` +
          `${error instanceof Error ? error.message : "unknown transport error"}`,
      });
    }
  }

  /** Classify a failed response. Never quotes headers or the token. */
  #failure(method: string, path: string, response: Response, body: unknown): GitHubWriteError {
    const status = response.status;
    const detail = errorMessageOf(body);
    const where = `${method} ${path}`;

    if (isRateLimited(status, response.headers, detail)) {
      const retryAfter = numericHeader(response.headers, "retry-after");
      const reset = numericHeader(response.headers, "x-ratelimit-reset");
      return new GitHubWriteError({
        kind: "git-failure",
        // Rate limits are the definition of "try again later".
        retryable: true,
        rateLimited: true,
        status,
        ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
        ...(reset === undefined ? {} : { rateLimitResetEpochSeconds: reset }),
        message: `GitHub rate limit hit on ${where}: ${detail}`,
      });
    }

    if (status === 401 || status === 403) {
      return new GitHubWriteError({
        kind: "git-failure",
        retryable: false,
        status,
        message:
          `GitHub refused ${where} with ${status}: ${detail}. Check the ` +
          `installation's contents:write permission and that the app is still installed.`,
      });
    }

    if (status >= 500) {
      return new GitHubWriteError({
        kind: "git-failure",
        retryable: true,
        status,
        message: `GitHub server error ${status} on ${where}: ${detail}`,
      });
    }

    return new GitHubWriteError({
      kind: "git-failure",
      status,
      message: `GitHub request failed ${status} on ${where}: ${detail}`,
    });
  }
}

// ------------------------------------------------------------------ helpers

function parseRepo(repo: string): { owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo.trim());
  if (!match) {
    throw new GitHubWriteError({
      kind: "git-failure",
      message: `repository must be "owner/name", got ${JSON.stringify(repo)}`,
    });
  }
  return { owner: match[1] as string, repo: match[2] as string };
}

/** Branch names may contain `/`; each segment is encoded, the slashes kept. */
function encodeBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function normalizeFiles(files: readonly CommitFile[]): readonly CommitFile[] {
  if (files.length === 0) {
    throw new GitHubWriteError({
      kind: "git-failure",
      message: "commitFiles requires at least one file",
    });
  }
  const seen = new Set<string>();
  return files.map((file) => {
    const path = safeRepoPath(file.path);
    if (seen.has(path)) {
      throw new GitHubWriteError({
        kind: "git-failure",
        message: `duplicate file path in one commit: ${JSON.stringify(path)}`,
      });
    }
    seen.add(path);
    return { path, content: file.content };
  });
}

/**
 * Reject absolute paths, traversal, backslashes and NULs before any request
 * is built - identical containment rules to the local adapter, applied
 * without `node:path` so this stays Worker-safe.
 */
export function safeRepoPath(filePath: string): string {
  const unsafe = (): never => {
    throw new GitHubWriteError({
      kind: "git-failure",
      message: `unsafe file path: ${JSON.stringify(filePath)}`,
    });
  };
  if (filePath === "" || filePath.includes("\\") || filePath.includes("\0")) unsafe();
  if (filePath.startsWith("/")) unsafe();
  const segments: string[] = [];
  for (const raw of filePath.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") unsafe();
    segments.push(raw);
  }
  if (segments.length === 0) unsafe();
  return segments.join("/");
}

/** True when `message`'s trailer block carries `Authorbot-Operation: <id>`. */
function hasOperationTrailer(message: string, operationId: string): boolean {
  const wanted = `${OPERATION_TRAILER}: ${operationId}`;
  return message.split("\n").some((line) => line.trim() === wanted);
}

function errorMessageOf(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const message = (body as GitHubErrorBody).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return "no error message";
}

function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isRateLimited(status: number, headers: Headers, detail: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  if (headers.get("x-ratelimit-remaining") === "0") return true;
  if (headers.get("retry-after") !== null) return true;
  return /rate limit/i.test(detail);
}
