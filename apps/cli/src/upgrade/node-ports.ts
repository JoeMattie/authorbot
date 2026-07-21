/**
 * Real implementations of the upgrade ports: node:fs, git, gh, wrangler, and
 * the npm registry over HTTPS.
 *
 * This is the only file in the upgrade command that touches the outside
 * world. Nothing here is imported by the default test suite - the tests drive
 * `runUpgrade` through fakes - so `pnpm test` never opens a socket, never
 * shells out to git, and never deploys anything.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  D1MigrationResult,
  DeployResult,
  GitPort,
  HealthPort,
  LockfilePort,
  HealthResult,
  ReleasesPort,
  UpgradeFs,
  WranglerPort,
} from "./ports.js";

const execFileAsync = promisify(execFile);

/** Directories a book-repo migration must never see or copy. */
const EXCLUDED_DIRS = new Set([".git", "node_modules"]);

export class CommandError extends Error {
  readonly command: string;
  readonly stderr: string;
  constructor(command: string, stderr: string, cause: unknown) {
    const detail = stderr.trim() !== "" ? stderr.trim() : cause instanceof Error ? cause.message : String(cause);
    super(`${command} failed: ${detail}`);
    this.name = "CommandError";
    this.command = command;
    this.stderr = stderr;
  }
}

async function run(
  file: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : "";
    throw new CommandError(`${file} ${args.join(" ")}`, stderr, error);
  }
}

export const nodeFs: UpgradeFs = {
  async exists(target) {
    try {
      await access(target, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(target) {
    return readFile(target, "utf8");
  },
  async writeFile(target, content) {
    return writeFile(target, content, "utf8");
  },
  async removeFile(target) {
    await rm(target, { force: true });
  },
  async listFiles(dir) {
    const found: string[] = [];
    const walk = async (absolute: string, relative: string): Promise<void> => {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry.name)) {
            continue;
          }
          await walk(path.join(absolute, entry.name), relative === "" ? entry.name : `${relative}/${entry.name}`);
        } else if (entry.isFile()) {
          found.push(relative === "" ? entry.name : `${relative}/${entry.name}`);
        }
      }
    };
    await walk(dir, "");
    return found.sort();
  },
  async copyTree(source, destination) {
    await cp(source, destination, {
      recursive: true,
      filter: (from) => {
        const name = path.basename(from);
        return !EXCLUDED_DIRS.has(name);
      },
    });
  },
  async makeTempDir(prefix) {
    return mkdtemp(path.join(os.tmpdir(), prefix));
  },
  async removeTree(target) {
    await rm(target, { recursive: true, force: true });
  },
};

export const nodeLockfile: LockfilePort = {
  async relock(repoPath) {
    // `--package-lock-only` rewrites the lockfile from package.json without
    // touching node_modules: this runs inside a temporary working copy, and
    // installing there would be minutes of work thrown away. It still needs
    // the registry to resolve the new versions, so it can fail offline -
    // hence the boolean rather than a throw. An upgrade that is otherwise
    // good should not be abandoned because a lockfile could not be refreshed;
    // it should say so.
    try {
      await run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], repoPath);
      return true;
    } catch {
      return false;
    }
  },
};

export const nodeGit: GitPort = {
  async isClean(repo) {
    const { stdout } = await run("git", ["status", "--porcelain"], repo);
    return stdout.trim() === "";
  },
  async currentBranch(repo) {
    const { stdout } = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo);
    return stdout.trim();
  },
  async createBranch(repo, name) {
    await run("git", ["checkout", "-b", name], repo);
  },
  async checkout(repo, name) {
    await run("git", ["checkout", name], repo);
  },
  async deleteBranch(repo, name) {
    await run("git", ["branch", "-D", name], repo);
  },
  async commit(repo, request) {
    await run("git", ["add", "--", ...request.paths], repo);
    await run("git", ["commit", "-m", request.message], repo);
    const { stdout } = await run("git", ["rev-parse", "HEAD"], repo);
    return stdout.trim();
  },
  async push(repo, branch) {
    await run("git", ["push", "--set-upstream", "origin", branch], repo);
  },
  async openPullRequest(repo, request) {
    const { stdout } = await run(
      "gh",
      [
        "pr",
        "create",
        "--base",
        request.base,
        "--head",
        request.branch,
        "--title",
        request.title,
        "--body",
        request.body,
      ],
      repo,
    );
    const url = /https:\/\/\S+/.exec(stdout);
    if (url === null) {
      // The PR may well have been created; we simply cannot prove it or say
      // where it is. Never report a URL we did not read.
      throw new CommandError("gh pr create", stdout, new Error("no pull request URL in output"));
    }
    return url[0];
  },
};

export const npmReleases: ReleasesPort = {
  async listVersions(packageName) {
    const url = `https://registry.npmjs.org/${packageName.replace("/", "%2f")}`;
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`npm registry returned ${response.status} for ${packageName}`);
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("versions" in body)) {
      throw new Error(`npm registry returned no versions for ${packageName}`);
    }
    const versions = (body as { versions: unknown }).versions;
    if (typeof versions !== "object" || versions === null) {
      throw new Error(`npm registry returned no versions for ${packageName}`);
    }
    return Object.keys(versions as Record<string, unknown>);
  },
};

const D1_MIGRATION_RE = /\b(\d{4}_[\w.-]+\.sql)\b/g;

export const wranglerCli: WranglerPort = {
  async applyD1Migrations(repo, databaseName) {
    const { stdout, stderr } = await run(
      "npx",
      ["--no-install", "wrangler", "d1", "migrations", "apply", databaseName, "--remote"],
      repo,
    );
    const applied = new Set<string>();
    for (const match of `${stdout}\n${stderr}`.matchAll(D1_MIGRATION_RE)) {
      const name = match[1];
      if (name !== undefined) {
        applied.add(name);
      }
    }
    const result: D1MigrationResult = { applied: [...applied].sort() };
    return result;
  },
  async deploy(repo) {
    const { stdout, stderr } = await run("npx", ["--no-install", "wrangler", "deploy"], repo);
    const url = /https:\/\/[\w.-]+\.workers\.dev\S*|https:\/\/\S+/.exec(`${stdout}\n${stderr}`);
    const result: DeployResult = url === null ? {} : { url: url[0].replace(/[).,]+$/, "") };
    return result;
  },
};

export const httpHealth: HealthPort = {
  async check(url) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      const result: HealthResult = response.ok
        ? { ok: true, status: response.status }
        : { ok: false, status: response.status, detail: `HTTP ${response.status}` };
      return result;
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
};
