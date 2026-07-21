/**
 * The outside world, as `authorbot upgrade` sees it.
 *
 * Every effect the command has — reading files, running git, talking to the
 * npm registry, invoking wrangler, fetching a URL — goes through one of these
 * interfaces. Nothing below imports `node:child_process` or `fetch`. The
 * point is not testability alone: it is that a command which rewrites an
 * author's prose and redeploys their site should have an enumerable list of
 * everything it can touch, and this is that list.
 */

import type { ValidationReport } from "../validate/findings.js";
import type { BookRepoMigration } from "./migrations.js";

/** Filesystem access, rooted nowhere — paths are absolute. */
export interface UpgradeFs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /**
   * Files under `dir`, recursively, as relative posix paths, sorted.
   * `.git` and `node_modules` are excluded: neither is book content, and a
   * migration has no business in either.
   */
  listFiles(dir: string): Promise<string[]>;
  /** Copy a repository into a fresh directory, honouring the same exclusions. */
  copyTree(source: string, destination: string): Promise<void>;
  makeTempDir(prefix: string): Promise<string>;
  removeTree(path: string): Promise<void>;
}

export interface CommitRequest {
  readonly message: string;
  /** Repo-relative paths to stage. Nothing else is committed. */
  readonly paths: readonly string[];
}

export interface PullRequestRequest {
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface GitPort {
  /** True when the working tree and index have no changes. */
  isClean(repo: string): Promise<boolean>;
  currentBranch(repo: string): Promise<string>;
  /** Create `name` from the current HEAD and switch to it. */
  createBranch(repo: string, name: string): Promise<void>;
  checkout(repo: string, name: string): Promise<void>;
  deleteBranch(repo: string, name: string): Promise<void>;
  /** Stage the given paths and commit them. Returns the new commit sha. */
  commit(repo: string, request: CommitRequest): Promise<string>;
  push(repo: string, branch: string): Promise<void>;
  /** Open a pull request. Returns its URL. */
  openPullRequest(repo: string, request: PullRequestRequest): Promise<string>;
}

/** Published releases of a package. */
export interface ReleasesPort {
  /** Every published version of `packageName`, unordered. */
  listVersions(packageName: string): Promise<string[]>;
}

export interface D1MigrationResult {
  /** Migration filenames applied by this run; empty when already current. */
  readonly applied: string[];
}

export interface DeployResult {
  /**
   * The deployed URL, when the deploy tool reported one. `undefined` means
   * the deploy happened but we do not know where — which is why health
   * cannot then be verified.
   */
  readonly url?: string;
}

export interface WranglerPort {
  applyD1Migrations(repo: string, databaseName: string): Promise<D1MigrationResult>;
  deploy(repo: string): Promise<DeployResult>;
}

export interface HealthResult {
  readonly ok: boolean;
  readonly status?: number;
  readonly detail?: string;
}

export interface HealthPort {
  check(url: string): Promise<HealthResult>;
}

/**
 * Everything `runUpgrade` is allowed to do, in one bag.
 *
 * `validate` is injected alongside the ports rather than imported directly so
 * that the before/after gate can be exercised with a validator that fails on
 * demand — the gate is the safety property most worth testing, and it is
 * untestable if the only way to trip it is to author a genuinely broken book.
 */
export interface UpgradeDeps {
  readonly fs: UpgradeFs;
  readonly git: GitPort;
  readonly releases: ReleasesPort;
  readonly wrangler: WranglerPort;
  readonly health: HealthPort;
  readonly validate: (repoPath: string) => Promise<ValidationReport>;
  readonly migrations: readonly BookRepoMigration[];
  /** Injected so branch names are deterministic under test. */
  readonly now: () => Date;
}
