/**
 * Deterministic in-process fake GitHub (Phase 5 contract §7).
 *
 * Shaped exactly like `fetch`: `(request: Request) => Promise<Response>`, so
 * it is injected as the `fetchImpl` of the real reader/writer/auth code and
 * exercises the same request-building and response-parsing paths the live
 * client uses. It is an object, not a server - no ports, no `node:http`, no
 * filesystem, no timers - so it runs unchanged in a Worker.
 *
 * Backed by `FakeRepoState`, which uses real git object hashing: the SHAs it
 * returns are the SHAs real git would compute for the same content.
 *
 * Covered surface (the subset the contract names):
 *   POST   /app/installations/{id}/access_tokens
 *   GET    /repos/{owner}/{repo}
 *   GET    /repos/{owner}/{repo}/git/ref/heads/{branch}
 *   POST   /repos/{owner}/{repo}/git/blobs
 *   GET    /repos/{owner}/{repo}/git/blobs/{sha}
 *   POST   /repos/{owner}/{repo}/git/trees
 *   GET    /repos/{owner}/{repo}/git/trees/{sha}[?recursive=1]
 *   POST   /repos/{owner}/{repo}/git/commits
 *   GET    /repos/{owner}/{repo}/git/commits/{sha}
 *   POST   /repos/{owner}/{repo}/git/refs
 *   PATCH  /repos/{owner}/{repo}/git/refs/heads/{branch}
 *
 * Anything else answers `404` with GitHub's error body, so an unimplemented
 * call fails loudly instead of appearing to work.
 */
import {
  FaultController,
  type FakeGitHubFaults,
  type FaultName,
} from "./faults.js";
import {
  decodeBase64,
  encodeBase64,
  isObjectSha,
  type GitFileMode,
  type GitIdentity,
  type GitObjectType,
} from "../git-objects.js";
import {
  FakeRepoError,
  FakeRepoState,
  flattenDirectoryTree,
  type DirectoryTree,
  type RepoFileMap,
  type TreeChange,
} from "./repo-state.js";

export const FAKE_GITHUB_ORIGIN = "https://api.github.com";

export interface FakeGitHubOptions {
  owner?: string;
  repo?: string;
  defaultBranch?: string;
  installationId?: string;
  appId?: string;
  /** Faults armed at construction; add more later with `injectFault`. */
  faults?: FakeGitHubFaults;
  /**
   * Require a live installation token on repository requests (default true).
   * Set false only for tests that are not exercising the auth layer.
   */
  requireAuth?: boolean;
  /**
   * Require the token endpoint's `Authorization` to look like an app JWT
   * (three dot-separated segments). Default true - it catches a client that
   * accidentally presents an installation token to mint another one.
   */
  requireAppJwt?: boolean;
  /** Installation-token lifetime in seconds. Default 3600, as GitHub's. */
  tokenTtlSeconds?: number;
  /** Injectable clock (ms since epoch). Default `Date.now`. */
  now?: () => number;
}

export interface SeedOptions {
  branch?: string;
  message?: string;
  author?: GitIdentity;
}

/** One observed request; assert call counts, ordering and concurrency with it. */
export interface RequestLogEntry {
  /** 1-based arrival order. */
  sequence: number;
  method: string;
  pathname: string;
  search: string;
  /** Clock reading when the request arrived (from the injected `now`). */
  at: number;
}

interface IssuedToken {
  token: string;
  installationId: string;
  expiresAtMs: number;
  revoked: boolean;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function errorResponse(
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      message,
      documentation_url: "https://docs.github.com/rest/git",
      status: String(status),
      ...extra,
    },
    status,
    headers,
  );
}

function normalizeMode(mode: string | undefined, type: GitObjectType): GitFileMode {
  if (mode === undefined) return type === "tree" ? "040000" : "100644";
  const padded = mode.length === 5 ? `0${mode}` : mode;
  const allowed: readonly string[] = ["100644", "100755", "120000", "040000", "160000"];
  if (!allowed.includes(padded)) {
    throw new FakeRepoError(422, `invalid tree entry mode: ${mode}`);
  }
  return padded as GitFileMode;
}

export class FakeGitHub {
  readonly state = new FakeRepoState();
  readonly faults: FaultController;
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch: string;
  readonly installationId: string;
  readonly appId: string;
  /** Every request the fake handled, in arrival order. */
  readonly requests: RequestLogEntry[] = [];

  readonly #requireAuth: boolean;
  readonly #requireAppJwt: boolean;
  readonly #tokenTtlSeconds: number;
  readonly #now: () => number;
  readonly #tokens = new Map<string, IssuedToken>();
  #tokenCounter = 0;
  #sequence = 0;

  constructor(options: FakeGitHubOptions = {}) {
    this.owner = options.owner ?? "authorbot";
    this.repo = options.repo ?? "book-repo";
    this.defaultBranch = options.defaultBranch ?? "main";
    this.installationId = options.installationId ?? "12345678";
    this.appId = options.appId ?? "1000001";
    this.faults = new FaultController(options.faults ?? {});
    this.#requireAuth = options.requireAuth ?? true;
    this.#requireAppJwt = options.requireAppJwt ?? true;
    this.#tokenTtlSeconds = options.tokenTtlSeconds ?? 3600;
    this.#now = options.now ?? (() => Date.now());
  }

  /** `owner/repo`, as configuration spells it. */
  get fullName(): string {
    return `${this.owner}/${this.repo}`;
  }

  // ---------------------------------------------------------------- seeding

  /**
   * Seed the repository from a path -> content map - e.g. the contents of
   * `examples/book-repo` read by the *caller* and passed in. The fake never
   * touches the filesystem, so it stays Worker-safe.
   */
  async seedFiles(files: RepoFileMap, options: SeedOptions = {}): Promise<string> {
    const branch = options.branch ?? this.defaultBranch;
    return this.state.commitFiles({
      branch,
      files,
      message: options.message ?? "Seed book repository",
      replaceTree: true,
      ...(options.author ? { author: options.author } : {}),
    });
  }

  /** Seed from a nested directory-like plain object. */
  seedDirectory(tree: DirectoryTree, options: SeedOptions = {}): Promise<string> {
    return this.seedFiles(flattenDirectoryTree(tree), options);
  }

  /**
   * Commit out of band, as an external actor would (a push that Authorbot
   * did not make). Used by reconciliation tests and by the moved-head fault.
   */
  externalCommit(
    files: RepoFileMap,
    options: SeedOptions & { deletions?: readonly string[] } = {},
  ): Promise<string> {
    return this.state.commitFiles({
      branch: options.branch ?? this.defaultBranch,
      files,
      message: options.message ?? "External edit",
      ...(options.deletions ? { deletions: options.deletions } : {}),
      ...(options.author ? { author: options.author } : {}),
    });
  }

  // ------------------------------------------------------------------ faults

  /** Arm one fault after construction. `undefined` disarms it. */
  injectFault<Name extends FaultName>(
    name: Name,
    config: FakeGitHubFaults[Name] | undefined,
  ): void {
    this.faults.set(name, config);
  }

  /** Throw if any armed fault never fired (guards vacuously-passing tests). */
  assertAllFaultsFired(): void {
    this.faults.assertAllFired();
  }

  // ------------------------------------------------------------------ tokens

  /** Invalidate every issued installation token (simulates rotation). */
  revokeAllTokens(): void {
    for (const token of this.#tokens.values()) token.revoked = true;
  }

  /** Installation tokens issued so far, newest last. Never logged elsewhere. */
  issuedTokenCount(): number {
    return this.#tokenCounter;
  }

  // ----------------------------------------------------------------- routing

  /**
   * `fetch`-shaped entry point. Bound as a property so it can be handed
   * straight to code that takes a `fetch` implementation.
   */
  readonly fetch = async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    this.#sequence += 1;
    this.requests.push({
      sequence: this.#sequence,
      method: request.method.toUpperCase(),
      pathname: url.pathname,
      search: url.search,
      at: this.#now(),
    });
    try {
      return await this.#route(request, url);
    } catch (error) {
      if (error instanceof FakeRepoError) {
        return errorResponse(error.status, error.message);
      }
      throw error;
    }
  };

  async #route(request: Request, url: URL): Promise<Response> {
    const method = request.method.toUpperCase();
    const segments = url.pathname.split("/").filter((segment) => segment !== "");

    // POST /app/installations/{id}/access_tokens
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[0] === "app" &&
      segments[1] === "installations" &&
      segments[3] === "access_tokens"
    ) {
      return this.#createInstallationToken(request, segments[2] as string);
    }

    if (segments[0] !== "repos" || segments.length < 3) {
      return errorResponse(404, "Not Found");
    }
    const owner = segments[1] as string;
    const repo = segments[2] as string;
    if (owner !== this.owner || repo !== this.repo) {
      return errorResponse(404, "Not Found");
    }

    const rateLimited = this.faults.take("rateLimited");
    if (rateLimited) {
      const reset = rateLimited.resetEpochSeconds ?? Math.floor(this.#now() / 1000) + 60;
      const headers: Record<string, string> = {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-used": "5000",
        "x-ratelimit-resource": "core",
        "x-ratelimit-reset": String(reset),
      };
      if (rateLimited.retryAfterSeconds !== undefined) {
        headers["retry-after"] = String(rateLimited.retryAfterSeconds);
      }
      return errorResponse(
        403,
        rateLimited.secondary
          ? "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."
          : "API rate limit exceeded",
        {},
        headers,
      );
    }

    const unauthorized = this.#checkRepoAuth(request);
    if (unauthorized) return unauthorized;

    const rest = segments.slice(3);
    if (rest.length === 0 && method === "GET") {
      return this.#repoMetadata();
    }
    if (method === "GET" && rest[0] === "compare" && rest.length === 2) {
      return this.#compare(decodeURIComponent(rest[1] as string));
    }
    if (rest[0] !== "git") {
      return errorResponse(404, "Not Found");
    }

    const resource = rest[1];
    const tail = rest.slice(2);

    if (method === "GET" && resource === "ref") {
      return this.#getRef(tail);
    }
    if (method === "POST" && resource === "refs" && tail.length === 0) {
      return this.#createRef(request);
    }
    if (method === "PATCH" && resource === "refs") {
      return this.#updateRef(request, tail);
    }
    if (method === "POST" && resource === "blobs" && tail.length === 0) {
      return this.#createBlob(request);
    }
    if (method === "GET" && resource === "blobs" && tail.length === 1) {
      return this.#getBlob(request, tail[0] as string);
    }
    if (method === "POST" && resource === "trees" && tail.length === 0) {
      return this.#createTree(request);
    }
    if (method === "GET" && resource === "trees" && tail.length === 1) {
      return this.#getTree(tail[0] as string, url);
    }
    if (method === "POST" && resource === "commits" && tail.length === 0) {
      return this.#createCommit(request);
    }
    if (method === "GET" && resource === "commits" && tail.length === 1) {
      return this.#getCommit(tail[0] as string);
    }
    return errorResponse(404, "Not Found");
  }

  // -------------------------------------------------------------------- auth

  #createInstallationToken(request: Request, installationId: string): Response {
    const authorization = request.headers.get("authorization") ?? "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
    if (!bearer) {
      return errorResponse(401, "Requires authentication");
    }
    if (this.#requireAppJwt && bearer.split(".").length !== 3) {
      return errorResponse(401, "A JSON web token could not be decoded");
    }
    if (installationId !== this.installationId) {
      return errorResponse(404, "Not Found");
    }
    const failure = this.faults.take("installationTokenFailure");
    if (failure) {
      return errorResponse(failure.status ?? 401, failure.message ?? "Bad credentials");
    }
    this.#tokenCounter += 1;
    const token = `ghs_fake${String(this.#tokenCounter).padStart(4, "0")}`;
    const expiresAtMs = this.#now() + this.#tokenTtlSeconds * 1000;
    this.#tokens.set(token, { token, installationId, expiresAtMs, revoked: false });
    return json(
      {
        token,
        expires_at: new Date(expiresAtMs).toISOString(),
        permissions: { contents: "write", metadata: "read" },
        repository_selection: "selected",
      },
      201,
    );
  }

  /** Returns a 401 response when the request may not touch the repository. */
  #checkRepoAuth(request: Request): Response | null {
    if (this.faults.take("unauthorized")) {
      return errorResponse(401, "Bad credentials");
    }
    if (!this.#requireAuth) return null;
    const authorization = request.headers.get("authorization") ?? "";
    const presented = /^(?:Bearer|token)\s+(.+)$/i.exec(authorization)?.[1];
    if (!presented) {
      return errorResponse(401, "Requires authentication");
    }
    const issued = this.#tokens.get(presented);
    if (!issued || issued.revoked || issued.expiresAtMs <= this.#now()) {
      return errorResponse(401, "Bad credentials");
    }
    return null;
  }

  // ---------------------------------------------------------------- handlers

  #repoMetadata(): Response {
    return json({
      id: 987654321,
      node_id: "R_fake",
      name: this.repo,
      full_name: this.fullName,
      private: true,
      owner: { login: this.owner, type: "Organization" },
      default_branch: this.defaultBranch,
      html_url: `https://github.com/${this.fullName}`,
      url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}`,
    });
  }

  #branchFromSegments(segments: readonly string[]): string | null {
    if (segments.length < 2 || segments[0] !== "heads") return null;
    return segments.slice(1).map(decodeURIComponent).join("/");
  }

  #refBody(branch: string, sha: string): unknown {
    return {
      ref: `refs/heads/${branch}`,
      node_id: `REF_${branch}`,
      url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/git/refs/heads/${branch}`,
      object: {
        sha,
        type: "commit",
        url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/git/commits/${sha}`,
      },
    };
  }

  async #getRef(segments: readonly string[]): Promise<Response> {
    const branch = this.#branchFromSegments(segments);
    if (branch === null) return errorResponse(404, "Not Found");
    const sha = this.state.getRef(branch);
    if (sha === null) return errorResponse(404, "Not Found");

    // Fire the moved-head fault *after* reading: the client holds the sha it
    // just read while an external push lands, exactly as in a real race.
    const moved = this.faults.take("movedHead", (fault) => fault.branch === branch);
    if (moved) {
      await this.state.commitFiles({
        branch,
        files: moved.files,
        message: moved.message ?? "Concurrent external push",
      });
    }
    return json(this.#refBody(branch, sha));
  }

  async #createRef(request: Request): Promise<Response> {
    const body = (await request.json()) as { ref?: unknown; sha?: unknown };
    const ref = typeof body.ref === "string" ? body.ref : "";
    const sha = typeof body.sha === "string" ? body.sha : "";
    const branch = /^refs\/heads\/(.+)$/.exec(ref)?.[1];
    if (!branch) return errorResponse(422, "Invalid ref name");
    if (!this.state.commits.has(sha)) return errorResponse(422, `Object does not exist: ${sha}`);
    if (this.state.getRef(branch) !== null) {
      return errorResponse(422, "Reference already exists");
    }
    this.state.setRefUnchecked(branch, sha);
    return json(this.#refBody(branch, sha), 201);
  }

  async #updateRef(request: Request, segments: readonly string[]): Promise<Response> {
    const branch = this.#branchFromSegments(segments);
    if (branch === null) return errorResponse(404, "Not Found");
    const body = (await request.json()) as { sha?: unknown; force?: unknown };
    const sha = typeof body.sha === "string" ? body.sha : "";
    const force = body.force === true;

    const forced = this.faults.take(
      "nonFastForward",
      (fault) => fault.branch === undefined || fault.branch === branch,
    );
    if (forced) {
      return errorResponse(422, "Update is not a fast forward");
    }

    this.state.updateRef(branch, sha, { force });
    return json(this.#refBody(branch, sha));
  }

  async #createBlob(request: Request): Promise<Response> {
    const body = (await request.json()) as { content?: unknown; encoding?: unknown };
    if (typeof body.content !== "string") {
      return errorResponse(422, "Invalid request.\n\n\"content\" wasn't supplied.");
    }
    const encoding = body.encoding === undefined ? "utf-8" : body.encoding;
    let bytes: Uint8Array;
    if (encoding === "base64") {
      bytes = decodeBase64(body.content);
    } else if (encoding === "utf-8") {
      bytes = new TextEncoder().encode(body.content);
    } else {
      return errorResponse(422, `Invalid encoding: ${String(encoding)}`);
    }
    const sha = await this.state.putBlob(bytes);
    return json(
      { sha, url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/git/blobs/${sha}` },
      201,
    );
  }

  #getBlob(request: Request, sha: string): Response {
    if (!isObjectSha(sha)) return errorResponse(422, `Invalid sha: ${sha}`);
    const bytes = this.state.blobs.get(sha);
    if (!bytes) return errorResponse(404, "Not Found");
    if ((request.headers.get("accept") ?? "").includes("application/vnd.github.raw")) {
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return json({
      sha,
      size: bytes.length,
      node_id: `B_${sha.slice(0, 8)}`,
      url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/git/blobs/${sha}`,
      // Wrapped at 60 characters, as the real API does - consumers must strip
      // whitespace before decoding.
      content: encodeBase64(bytes, true),
      encoding: "base64",
    });
  }

  async #createTree(request: Request): Promise<Response> {
    const body = (await request.json()) as { base_tree?: unknown; tree?: unknown };
    if (!Array.isArray(body.tree)) {
      return errorResponse(422, "Invalid request.\n\n\"tree\" wasn't supplied.");
    }
    const baseTree = typeof body.base_tree === "string" ? body.base_tree : null;
    const changes: TreeChange[] = [];
    for (const raw of body.tree as readonly Record<string, unknown>[]) {
      const path = raw["path"];
      if (typeof path !== "string" || path === "") {
        return errorResponse(422, "Invalid request.\n\n\"path\" wasn't supplied.");
      }
      const type = (raw["type"] as GitObjectType | undefined) ?? "blob";
      const mode = normalizeMode(raw["mode"] as string | undefined, type);
      const change: TreeChange = { path, mode, type };
      if (raw["sha"] === null) {
        change.sha = null;
      } else if (typeof raw["sha"] === "string") {
        change.sha = raw["sha"];
      } else if (typeof raw["content"] === "string") {
        change.content = raw["content"];
      } else {
        return errorResponse(422, `Invalid tree entry for ${path}: needs sha or content`);
      }
      changes.push(change);
    }
    const sha = await this.state.createTree(baseTree, changes);
    return json(
      {
        sha,
        url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/git/trees/${sha}`,
        truncated: false,
        tree: this.state.listTree(sha, false),
      },
      201,
    );
  }

  /**
   * `GET /repos/{o}/{r}/compare/{base}...{head}`, reduced to the one field the
   * writer reads: `status`. Computed from the real commit graph
   * (`FakeRepoState.isAncestor`), so it answers exactly as GitHub would -
   * `identical` when the two shas match, `ahead` when `base` is reachable from
   * `head`, `behind` when the reverse holds, `diverged` otherwise.
   *
   * This is the endpoint that makes replay idempotency independent of commit
   * count: the writer asks whether the commit it created before crashing is
   * an ancestor of the current head, and the answer does not degrade as
   * unrelated commits pile up on the branch.
   */
  #compare(range: string): Response {
    const separator = range.indexOf("...");
    if (separator === -1) return errorResponse(404, "Not Found");
    const base = range.slice(0, separator);
    const head = range.slice(separator + 3);
    const baseSha = this.state.getRef(base) ?? base;
    const headSha = this.state.getRef(head) ?? head;
    if (!this.state.commits.has(baseSha) || !this.state.commits.has(headSha)) {
      return errorResponse(404, "Not Found");
    }
    const status =
      baseSha === headSha
        ? "identical"
        : this.state.isAncestor(baseSha, headSha)
          ? "ahead"
          : this.state.isAncestor(headSha, baseSha)
            ? "behind"
            : "diverged";
    return json({
      url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/compare/${range}`,
      status,
      base_commit: this.#commitBody(baseSha),
      merge_base_commit: this.#commitBody(baseSha),
      ahead_by: 0,
      behind_by: 0,
      total_commits: 0,
      commits: [],
      files: [],
    });
  }

  #getTree(sha: string, url: URL): Response {
    if (!isObjectSha(sha)) return errorResponse(422, `Invalid sha: ${sha}`);
    if (!this.state.trees.has(sha)) return errorResponse(404, "Not Found");
    const recursiveParam = url.searchParams.get("recursive");
    const recursive = recursiveParam !== null && recursiveParam !== "0" && recursiveParam !== "false";
    let entries = this.state.listTree(sha, recursive);
    let truncated = false;
    const fault = this.faults.take("truncatedTree");
    if (fault) {
      truncated = true;
      entries = entries.slice(0, fault.keepEntries ?? 1);
    }
    return json({
      sha,
      url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/git/trees/${sha}`,
      truncated,
      tree: entries,
    });
  }

  #commitBody(sha: string): unknown {
    const commit = this.state.getCommit(sha);
    return {
      sha,
      node_id: `C_${sha.slice(0, 8)}`,
      url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/git/commits/${sha}`,
      html_url: `https://github.com/${this.fullName}/commit/${sha}`,
      message: commit.message,
      author: { name: commit.author.name, email: commit.author.email, date: commit.author.date },
      committer: {
        name: commit.committer.name,
        email: commit.committer.email,
        date: commit.committer.date,
      },
      tree: {
        sha: commit.tree,
        url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/git/trees/${commit.tree}`,
      },
      parents: commit.parents.map((parent) => ({
        sha: parent,
        url: `${FAKE_GITHUB_ORIGIN}/repos/${this.fullName}/git/commits/${parent}`,
      })),
    };
  }

  async #createCommit(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const message = body["message"];
    const tree = body["tree"];
    if (typeof message !== "string" || message === "") {
      return errorResponse(422, "Invalid request.\n\n\"message\" wasn't supplied.");
    }
    if (typeof tree !== "string" || !this.state.trees.has(tree)) {
      return errorResponse(422, `Tree SHA does not exist: ${String(tree)}`);
    }
    const parentsRaw = body["parents"];
    const parents = Array.isArray(parentsRaw) ? (parentsRaw as unknown[]).map(String) : [];
    for (const parent of parents) {
      if (!this.state.commits.has(parent)) {
        return errorResponse(422, `Parent SHA does not exist: ${parent}`);
      }
    }
    const fallback: GitIdentity = {
      name: "Authorbot",
      email: "authorbot@users.noreply.github.com",
      date: this.state.nextTimestamp(),
    };
    const author = this.#identity(body["author"], fallback);
    const committer = this.#identity(body["committer"], author);
    const sha = await this.state.putCommit({ tree, parents, message, author, committer });
    return json(this.#commitBody(sha), 201);
  }

  #identity(raw: unknown, fallback: GitIdentity): GitIdentity {
    if (typeof raw !== "object" || raw === null) return fallback;
    const record = raw as Record<string, unknown>;
    return {
      name: typeof record["name"] === "string" ? record["name"] : fallback.name,
      email: typeof record["email"] === "string" ? record["email"] : fallback.email,
      date: typeof record["date"] === "string" ? record["date"] : fallback.date,
      ...(typeof record["timezone"] === "string" ? { timezone: record["timezone"] } : {}),
    };
  }

  #getCommit(sha: string): Response {
    if (!isObjectSha(sha)) return errorResponse(422, `Invalid sha: ${sha}`);
    if (!this.state.commits.has(sha)) return errorResponse(404, "Not Found");
    return json(this.#commitBody(sha));
  }

  // ------------------------------------------------------------- assertions

  /** Text of a file at the branch head, or `null`. Convenience for tests. */
  fileAtHead(path: string, branch = this.defaultBranch): string | null {
    const head = this.state.getRef(branch);
    if (head === null) return null;
    return this.state.readFile(head, path);
  }

  /** Number of logged requests matching a method and pathname predicate. */
  countRequests(method: string, match: (pathname: string) => boolean): number {
    const wanted = method.toUpperCase();
    return this.requests.filter(
      (entry) => entry.method === wanted && match(entry.pathname),
    ).length;
  }
}

export interface CreateFakeGitHubOptions extends FakeGitHubOptions {
  /** Seed from a path -> content map (e.g. `examples/book-repo` read by the caller). */
  files?: RepoFileMap;
  /** Seed from a nested directory-like plain object. */
  directory?: DirectoryTree;
  /** Message of the seed commit. */
  seedMessage?: string;
}

/**
 * Construct and seed a fake GitHub in one step. Async because seeding hashes
 * objects with WebCrypto.
 */
export async function createFakeGitHub(
  options: CreateFakeGitHubOptions = {},
): Promise<FakeGitHub> {
  const fake = new FakeGitHub(options);
  const files: Record<string, string | Uint8Array> = {
    ...(options.directory ? flattenDirectoryTree(options.directory) : {}),
    ...(options.files ?? {}),
  };
  if (Object.keys(files).length > 0) {
    await fake.seedFiles(files, {
      ...(options.seedMessage ? { message: options.seedMessage } : {}),
    });
  }
  return fake;
}
