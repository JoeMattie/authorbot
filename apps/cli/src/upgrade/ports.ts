/**
 * The outside world, as `authorbot upgrade` sees it.
 *
 * Every effect the command has - reading files, running git, talking to the
 * npm registry, invoking wrangler, fetching a URL - goes through one of these
 * interfaces. Nothing below imports `node:child_process` or `fetch`. The
 * point is not testability alone: it is that a command which rewrites an
 * author's prose and redeploys their site should have an enumerable list of
 * everything it can touch, and this is that list.
 */

import type { ValidationReport } from "../validate/findings.js";
import type { BookRepoMigration } from "./migrations.js";

/** Filesystem access, rooted nowhere - paths are absolute. */
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
  /** Exact commit currently checked out. Used to detect same-branch races. */
  head(repo: string): Promise<string>;
  /**
   * Create `name` and switch to it. When `startPoint` is provided, the branch
   * must be anchored to that exact commit rather than whatever HEAD happens to
   * contain when the subprocess starts.
   */
  createBranch(repo: string, name: string, startPoint?: string): Promise<void>;
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
  listVersions(packageName: string, repoPath: string): Promise<string[]>;
}

export interface D1MigrationResult {
  /** Migration filenames applied by this run; empty when already current. */
  readonly applied: string[];
}

export interface DeployResult {
  /**
   * The deployed URL, when the deploy tool reported one. `undefined` means
   * the deploy happened but we do not know where - which is why health
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
 * demand - the gate is the safety property most worth testing, and it is
 * untestable if the only way to trip it is to author a genuinely broken book.
 */
/**
 * Bringing `package-lock.json` back into agreement with a just-rewritten
 * `package.json`.
 *
 * The toolchain bump used to change the pin and commit that alone, leaving the
 * lockfile pinning the version being upgraded away from. `npm ci` - which both
 * generated workflows run, and which exists precisely to refuse a lockfile
 * that disagrees with its manifest - then failed on the upgrade's own pull
 * request. Every upgrade opened a pull request whose CI could not pass.
 */
export interface LockfilePort {
  /**
   * Regenerate the lockfile from package.json without installing anything.
   * A failure is fatal for this upgrade attempt: opening a pull request with a
   * lockfile that disagrees with package.json knowingly creates a CI failure.
   * Implementations must preserve the underlying command diagnostic.
   */
  relock(repoPath: string): Promise<void>;
}

export interface UpgradeBootstrapRequest {
  /** Exact selected CLI release which must own the upgrade. */
  readonly targetVersion: string;
  /** Book repository used to look for an already-installed exact match. */
  readonly repoPath: string;
  /** Original process cwd. Relative argv paths must keep the same meaning. */
  readonly cwd: string;
  /** Original arguments after `authorbot upgrade`. */
  readonly args: readonly string[];
}

export interface UpgradeBootstrapResult {
  /** Target helper exit status, or 1 when a signal supplied no numeric status. */
  readonly exitCode: number;
  /**
   * Non-fatal problem after child execution began, such as a signal or
   * temporary-directory cleanup failure. The exit status above remains the
   * target helper's result when it supplied one.
   */
  readonly warning?: string;
}

/**
 * Start the release which is about to be installed before the current helper
 * can mutate the book.
 *
 * A book's package.json and node_modules can disagree after an interrupted
 * install. The executable npm selects for plain `npx authorbot` is then the
 * stale one. Upgrades cannot safely continue with that executable because it
 * may not know the target release's migrations or package alignment rules.
 */
export interface UpgradeBootstrapPort {
  /** Version of the CLI package which owns this running process. */
  readonly runningVersion: string;
  /**
   * Version requested by the parent handoff, when this process is a child.
   * Its presence prevents an npm or PATH resolution error from recursing.
   */
  readonly requestedVersion?: string;
  /**
   * Run an exact installed copy, or acquire it in a throwaway directory and
   * run that. A thrown error means child execution never began, so callers may
   * truthfully report that the book was not changed by the target helper.
   */
  handoff(request: UpgradeBootstrapRequest): Promise<UpgradeBootstrapResult>;
}

export interface UpgradeDeps {
  readonly fs: UpgradeFs;
  readonly git: GitPort;
  readonly lockfile: LockfilePort;
  readonly releases: ReleasesPort;
  readonly wrangler: WranglerPort;
  readonly health: HealthPort;
  readonly validate: (repoPath: string) => Promise<ValidationReport>;
  readonly migrations: readonly BookRepoMigration[];
  /** Injected so branch names are deterministic under test. */
  readonly now: () => Date;
  /**
   * Present in the real CLI and injectable in bootstrap tests. Ordinary
   * upgrade tests omit it so every other effect remains fully fake.
   */
  readonly bootstrap?: UpgradeBootstrapPort;
}
