/**
 * `LocalGitAdapter` - Node-only `BookRepoWriter` that spawns `git` against a
 * work-tree path (Phase 2 contract §5: tests and local dev; production Git
 * writes move to the GitHub adapter in Phase 5).
 *
 * Guarantees:
 * - stages exactly the rendered files, nothing else;
 * - one commit per logical mutation, author `Authorbot <authorbot@localhost>`;
 * - never force-updates anything;
 * - surfaces `non-fast-forward` (stale expected head), `dirty-tree`
 *   (foreign uncommitted changes), and `wrong-branch` distinctly;
 * - idempotent per operation: a commit already carrying this operation's
 *   `Authorbot-Operation` trailer is returned instead of re-committing.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  formatCommitMessage,
  GitWriteError,
  OPERATION_TRAILER,
  type BookRepoWriter,
  type CommitFile,
  type CommitFilesInput,
  type CommitFilesResult,
} from "./writer.js";

export interface LocalGitAdapterOptions {
  /** Absolute path of an existing git work tree (the book repository). */
  workTreePath: string;
  /** Commit author/committer name (default `Authorbot`). */
  authorName?: string;
  /** Commit author/committer email (default `authorbot@localhost`). */
  authorEmail?: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class LocalGitAdapter implements BookRepoWriter {
  private readonly workTreePath: string;
  private readonly authorName: string;
  private readonly authorEmail: string;

  constructor(options: LocalGitAdapterOptions) {
    this.workTreePath = options.workTreePath;
    this.authorName = options.authorName ?? "Authorbot";
    this.authorEmail = options.authorEmail ?? "authorbot@localhost";
  }

  async commitFiles(input: CommitFilesInput): Promise<CommitFilesResult> {
    if (input.files.length === 0) {
      throw new GitWriteError("git-failure", "commitFiles requires at least one file");
    }
    const relativePaths = input.files.map((file) => safeRelativePath(file.path));
    const fullMessage = formatCommitMessage(input.message, input.trailers);
    const hasHead = (await this.git(["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;

    // Idempotency: a commit for this operation may already exist (crash
    // between the git commit and the database update).
    const operationId = input.trailers[OPERATION_TRAILER];
    if (hasHead && operationId !== undefined) {
      const existing = await this.findOperationCommit(operationId);
      if (existing !== null) {
        return { commitSha: existing };
      }
    }

    await this.assertOnBranch(input.branch);
    await this.assertCleanApartFrom(relativePaths);
    if (input.expectedHeadOverride !== undefined) {
      await this.assertHeadEquals(input.expectedHeadOverride, hasHead);
    }

    await this.writeFiles(input.files);
    await this.mustGit(["add", "--", ...relativePaths]);

    // A replay with identical bytes stages nothing; still record the
    // mutation as its own commit (one commit per logical mutation).
    const staged = (await this.git(["diff", "--cached", "--quiet"])).code !== 0;
    const commitArgs = ["commit", "--quiet", "--no-verify", "-m", fullMessage];
    if (!staged) {
      commitArgs.push("--allow-empty");
    }
    await this.mustGit(commitArgs);

    const head = await this.mustGit(["rev-parse", "HEAD"]);
    return { commitSha: head.stdout.trim() };
  }

  /**
   * Read one committed file at the branch head (`git show <branch>:<path>`),
   * or `null` when the path does not exist there. The branch itself must
   * exist - an unknown branch is a `git-failure`, never a silent `null`
   * (a null misread would let an attribution append clobber history).
   */
  async readFile(branch: string, filePath: string): Promise<string | null> {
    const relative = safeRelativePath(filePath);
    const branchExists =
      (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    if (!branchExists) {
      throw new GitWriteError("git-failure", `branch ${JSON.stringify(branch)} does not exist`);
    }
    const result = await this.git(["show", `${branch}:${relative}`]);
    return result.code === 0 ? result.stdout : null;
  }

  /**
   * Head SHA of `branch`, or `null` when the branch does not exist yet or
   * carries no commits. Used to pin `expectedHeadOverride` on commits whose
   * content was computed from a read of that head.
   */
  async resolveHead(branch: string): Promise<string | null> {
    const result = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (result.code !== 0) {
      return null;
    }
    const sha = result.stdout.trim();
    return sha === "" ? null : sha;
  }

  /** First commit on HEAD's history carrying `Authorbot-Operation: <id>`. */
  private async findOperationCommit(operationId: string): Promise<string | null> {
    const result = await this.mustGit([
      "log",
      "--format=%H",
      "--fixed-strings",
      `--grep=${OPERATION_TRAILER}: ${operationId}`,
      "HEAD",
    ]);
    const first = result.stdout.split("\n", 1)[0]?.trim() ?? "";
    return first === "" ? null : first;
  }

  private async assertOnBranch(branch: string): Promise<void> {
    const result = await this.git(["symbolic-ref", "--short", "--quiet", "HEAD"]);
    const current = result.stdout.trim();
    if (result.code !== 0 || current !== branch) {
      throw new GitWriteError(
        "wrong-branch",
        `work tree is on "${result.code === 0 ? current : "(detached HEAD)"}", expected branch "${branch}"`,
      );
    }
  }

  /**
   * Refuse to commit over foreign uncommitted changes. Leftover writes of
   * exactly this mutation's files (a crash between write and commit) are
   * tolerated - they are about to be overwritten and staged anyway.
   */
  private async assertCleanApartFrom(ownPaths: readonly string[]): Promise<void> {
    const own = new Set(ownPaths);
    // --untracked-files=all: the default untracked mode collapses untracked
    // files to their highest untracked directory ("?? .authorbot/annotations/"),
    // which can never match the exact file paths in `own` - a crash between
    // writeFiles and commit for a create (always a brand-new directory) would
    // otherwise wedge every subsequent commit with dirty-tree.
    const status = await this.mustGit(["status", "--porcelain", "--untracked-files=all"]);
    const foreign: string[] = [];
    for (const line of status.stdout.split("\n")) {
      if (line === "") continue;
      const entry = line.slice(3);
      // Renames appear as "old -> new"; quoted paths contain specials we do
      // not attempt to unquote - treat both conservatively as foreign.
      const candidate = entry.includes(" -> ") || entry.startsWith('"') ? null : entry;
      if (candidate === null || !own.has(candidate)) {
        foreign.push(entry);
      }
    }
    if (foreign.length > 0) {
      throw new GitWriteError(
        "dirty-tree",
        `work tree has uncommitted changes outside this mutation: ${foreign.join(", ")}`,
      );
    }
  }

  private async assertHeadEquals(expected: string, hasHead: boolean): Promise<void> {
    const head = hasHead ? (await this.mustGit(["rev-parse", "HEAD"])).stdout.trim() : "(unborn)";
    if (head !== expected) {
      throw new GitWriteError(
        "non-fast-forward",
        `branch head moved: expected ${expected}, found ${head}`,
      );
    }
  }

  private async writeFiles(files: readonly CommitFile[]): Promise<void> {
    for (const file of files) {
      const relative = safeRelativePath(file.path);
      const absolute = path.join(this.workTreePath, relative);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content, "utf8");
    }
  }

  private git(args: readonly string[]): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: this.workTreePath,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: this.authorName,
            GIT_AUTHOR_EMAIL: this.authorEmail,
            GIT_COMMITTER_NAME: this.authorName,
            GIT_COMMITTER_EMAIL: this.authorEmail,
          },
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(new GitWriteError("git-failure", `failed to spawn git: ${error.message}`));
            return;
          }
          resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
        },
      );
    });
  }

  private async mustGit(args: readonly string[]): Promise<GitResult> {
    const result = await this.git(args);
    if (result.code !== 0) {
      throw new GitWriteError(
        "git-failure",
        `git ${args[0] ?? ""} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result;
  }
}

/** Reject absolute paths and traversal; normalize to a repo-relative path. */
function safeRelativePath(filePath: string): string {
  if (filePath === "" || filePath.includes("\\") || filePath.includes("\0")) {
    throw new GitWriteError("git-failure", `unsafe file path: ${JSON.stringify(filePath)}`);
  }
  const normalized = path.posix.normalize(filePath);
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("./") ||
    normalized === "."
  ) {
    throw new GitWriteError("git-failure", `unsafe file path: ${JSON.stringify(filePath)}`);
  }
  return normalized;
}
