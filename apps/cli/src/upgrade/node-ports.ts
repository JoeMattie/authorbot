/**
 * Real implementations of the upgrade ports: node:fs, git, gh, wrangler, and
 * the npm registry over HTTPS.
 *
 * This is the only file in the upgrade command that touches the outside
 * world. Nothing here is imported by the default test suite - the tests drive
 * `runUpgrade` through fakes - so `pnpm test` never opens a socket, never
 * shells out to git, and never deploys anything.
 */

import { execFile, spawn } from "node:child_process";
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
  UpgradeBootstrapPort,
  UpgradeBootstrapRequest,
  UpgradeFs,
  WranglerPort,
} from "./ports.js";

const execFileAsync = promisify(execFile);
const BOOTSTRAP_REQUEST_ENV = "AUTHORBOT_UPGRADE_BOOTSTRAP_VERSION";

/** Directories a book-repo migration must never see or copy. */
const EXCLUDED_DIRS = new Set([".git", "node_modules"]);

/**
 * Preserve the caller's environment, except for npm configuration inherited
 * from an outer npm/npx invocation when the child is itself npm or npx.
 *
 * `npx authorbot upgrade` runs the CLI beneath npm. npm exports its active
 * configuration as `npm_config_*` environment variables, but those settings
 * belong to the outer invocation. Passing them into the nested lockfile npm
 * can make an otherwise valid book fail before it reads package.json. In
 * particular, npm rejects an inherited `npm_config_allow_scripts` during a
 * project-scoped install.
 *
 * Other commands keep the environment byte-for-byte: this is an npm nesting
 * boundary, not a general environment scrubber.
 */
function childEnvironment(env: NodeJS.ProcessEnv, command: string): NodeJS.ProcessEnv {
  const base = path.basename(command).replace(/\.(cmd|exe)$/i, "");
  if (base !== "npm" && base !== "npx") {
    return { ...env };
  }

  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_/i.test(key) || /^NPM_CONFIG_/.test(key)) {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

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
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(file, args, {
      cwd,
      encoding: "utf8",
      env: childEnvironment(env, file),
      maxBuffer: 32 * 1024 * 1024,
    });
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
    // the registry to resolve new versions. Failure is fatal: opening an
    // upgrade pull request with a stale lockfile would knowingly break its
    // `npm ci`. Let CommandError propagate so npm's exact diagnostic reaches
    // the author.
    await run(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--package-lock=true",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      repoPath,
    );
  },
};

interface CliPackage {
  readonly version: string;
  readonly bin: string | Record<string, string>;
}

function parseCliPackage(contents: string): CliPackage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const version = record["version"];
  const bin = record["bin"];
  if (
    typeof version !== "string" ||
    (typeof bin !== "string" &&
      (typeof bin !== "object" || bin === null || Array.isArray(bin)))
  ) {
    return undefined;
  }
  if (typeof bin === "string") {
    return { version, bin };
  }
  const entries = Object.entries(bin as Record<string, unknown>);
  if (entries.some((entry): entry is [string, string] => typeof entry[1] === "string")) {
    return {
      version,
      bin: Object.fromEntries(
        entries.filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    };
  }
  return undefined;
}

async function exactInstalledCliBin(
  packageRoot: string,
  targetVersion: string,
): Promise<string | undefined> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  let metadata: CliPackage | undefined;
  try {
    metadata = parseCliPackage(await readFile(packageJsonPath, "utf8"));
  } catch {
    return undefined;
  }
  if (metadata === undefined || metadata.version !== targetVersion) {
    return undefined;
  }
  const relativeBin =
    typeof metadata.bin === "string"
      ? metadata.bin
      : metadata.bin["authorbot"] ?? Object.values(metadata.bin)[0];
  if (relativeBin === undefined) {
    return undefined;
  }
  const absoluteRoot = path.resolve(packageRoot);
  const absoluteBin = path.resolve(absoluteRoot, relativeBin);
  if (
    absoluteBin !== absoluteRoot &&
    !absoluteBin.startsWith(`${absoluteRoot}${path.sep}`)
  ) {
    return undefined;
  }
  try {
    await access(absoluteBin, constants.F_OK);
    return absoluteBin;
  } catch {
    return undefined;
  }
}

async function runInherited(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      reject(new Error(`child process exited from signal ${signal ?? "unknown"}`));
    });
  });
}

async function installBootstrapCli(
  targetVersion: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  readonly root: string;
  readonly bin: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "authorbot-cli-bootstrap-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "authorbot-upgrade-bootstrap",
          private: true,
          dependencies: { "@authorbot/cli": targetVersion },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const commonArgs = [
      "install",
      "--package-lock=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
    ];
    await run("npm", commonArgs, root, env);
    const bin = await exactInstalledCliBin(
      path.join(root, "node_modules", "@authorbot", "cli"),
      targetVersion,
    );
    if (bin === undefined) {
      throw new Error(
        `npm completed without installing an exact, runnable @authorbot/cli@${targetVersion}`,
      );
    }
    return { root, bin };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The real self-bootstrap port.
 *
 * It never installs into the book. An exact local target is used directly;
 * otherwise npm resolves it into a throwaway directory with lifecycle scripts
 * disabled. If npm is offline and has no usable cache, the acquisition fails
 * before the target CLI starts and the book stays byte-identical.
 */
export async function createNodeUpgradeBootstrap(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpgradeBootstrapPort> {
  const ownPackage = parseCliPackage(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (ownPackage === undefined) {
    throw new Error("could not read the running @authorbot/cli package version");
  }
  return {
    runningVersion: ownPackage.version,
    ...(env[BOOTSTRAP_REQUEST_ENV] === undefined
      ? {}
      : { requestedVersion: env[BOOTSTRAP_REQUEST_ENV] }),
    async handoff(request: UpgradeBootstrapRequest) {
      const localRoot = path.join(
        request.repoPath,
        "node_modules",
        "@authorbot",
        "cli",
      );
      const localBin = await exactInstalledCliBin(localRoot, request.targetVersion);
      let temporaryRoot: string | undefined;
      let bin = localBin;
      if (bin === undefined) {
        const installed = await installBootstrapCli(request.targetVersion, env);
        temporaryRoot = installed.root;
        bin = installed.bin;
      }
      try {
        return await runInherited(
          process.execPath,
          [bin, "upgrade", ...request.args],
          request.cwd,
          {
            ...env,
            [BOOTSTRAP_REQUEST_ENV]: request.targetVersion,
          },
        );
      } finally {
        if (temporaryRoot !== undefined) {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      }
    },
  };
}

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
