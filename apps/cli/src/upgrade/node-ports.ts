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
import { constants, existsSync } from "node:fs";
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
  UpgradeBootstrapResult,
  UpgradeFs,
  WranglerPort,
} from "./ports.js";

const execFileAsync = promisify(execFile);
const BOOTSTRAP_REQUEST_ENV = "AUTHORBOT_UPGRADE_BOOTSTRAP_VERSION";

/** Directories a book-repo migration must never see or copy. */
const EXCLUDED_DIRS = new Set([".git", "node_modules"]);

/**
 * Preserve the caller's environment, except for known-invalid configuration
 * inherited from an outer npm/npx invocation when the child is npm or npx.
 *
 * `npx authorbot upgrade` runs the CLI beneath npm. npm exports its active
 * configuration as `npm_config_*` environment variables. Most of it is
 * intentional and necessary: offline mode, cache and registry locations,
 * userconfig, and authentication must survive. The outer npm's
 * `allow_scripts` value is different: npm rejects it when inherited by a
 * nested project-scoped install, before reading package.json.
 *
 * Other commands and all other npm settings remain byte-for-byte. Additions to
 * this denylist need a concrete nested-npm failure and a regression test.
 */
function childEnvironment(env: NodeJS.ProcessEnv, command: string): NodeJS.ProcessEnv {
  const base = path.basename(command).replace(/\.(cmd|exe)$/i, "");
  if (base !== "npm" && base !== "npx") {
    return { ...env };
  }

  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_allow_scripts$/i.test(key)) {
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

export interface ExecutableInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * Resolve npm's JavaScript entry point on Windows instead of asking
 * `execFile` to launch npm.cmd or npx.cmd. Node deliberately does not execute
 * command scripts without a shell, and enabling `shell: true` here would turn
 * repository-derived arguments into command-line syntax.
 *
 * `npm_execpath` is supplied by npm and npx. Only an absolute path to npm's
 * documented JavaScript launcher is accepted. The launcher always runs under
 * this process's own Node executable; environment-provided executable paths
 * are not trusted. Arguments remain an array.
 */
export function resolveExecutableInvocation(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  defaultNodeExecutable: string = process.execPath,
  fileExists: (target: string) => boolean = existsSync,
): ExecutableInvocation {
  const commandPath = platform === "win32" ? path.win32 : path;
  const base = commandPath.basename(file).replace(/\.(cmd|exe)$/i, "").toLowerCase();
  if (platform !== "win32" || (base !== "npm" && base !== "npx")) {
    return { file, args };
  }

  const suppliedExecPath = env["npm_execpath"]?.trim();
  const npmCliPattern = /^(?:npm|npx)-cli\.(?:c?js|mjs)$/i;
  // A leading slash is absolute on the POSIX host used by the simulated
  // Windows process tests, but is only drive-relative under Windows. Real
  // Windows npm launchers are drive-qualified or UNC paths.
  const suppliedLooksWindows =
    suppliedExecPath !== undefined &&
    (/^[A-Za-z]:[\\/]/.test(suppliedExecPath) || /^\\\\/.test(suppliedExecPath));
  const suppliedPath =
    suppliedLooksWindows ? path.win32 : path;
  const suppliedDirectory =
    suppliedExecPath !== undefined &&
    suppliedPath.isAbsolute(suppliedExecPath) &&
    npmCliPattern.test(suppliedPath.basename(suppliedExecPath))
      ? suppliedPath.dirname(suppliedExecPath)
      : undefined;
  const suppliedScript =
    suppliedDirectory === undefined
      ? undefined
      : suppliedPath.join(
          suppliedDirectory,
          `${base}-cli${suppliedPath.extname(suppliedExecPath ?? "")}`,
        );
  const bundledScript = path.win32.join(
    path.win32.dirname(defaultNodeExecutable),
    "node_modules",
    "npm",
    "bin",
    `${base}-cli.js`,
  );
  const script =
    suppliedScript !== undefined && fileExists(suppliedScript)
      ? suppliedScript
      : fileExists(bundledScript)
        ? bundledScript
        : undefined;
  if (script === undefined) {
    throw new Error(
      `cannot run ${base} safely on Windows: npm_execpath did not identify an existing ` +
        `${base} JavaScript launcher, and ${bundledScript} was not found beside node.exe. ` +
        "Authorbot will not enable a command shell.",
    );
  }
  return {
    file: defaultNodeExecutable,
    args: [script, ...args],
  };
}

async function run(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const invocation = resolveExecutableInvocation(file, args, env, platform);
    const result = await execFileAsync(invocation.file, invocation.args, {
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

export function createNodeLockfile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LockfilePort {
  return {
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
        env,
        platform,
      );
    },
  };
}

export const nodeLockfile: LockfilePort = createNodeLockfile();

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
): Promise<UpgradeBootstrapResult> {
  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const child = spawn(file, [...args], {
      cwd,
      env,
      stdio: "inherit",
    });
    child.once("spawn", () => {
      started = true;
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (!started) {
        reject(error);
        return;
      }
      resolve({
        exitCode: 1,
        warning:
          `the target helper started, then its process failed: ${error.message}. ` +
          "It may have changed the repository; inspect `git status` before retrying.",
      });
    });
    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code !== null) {
        resolve({ exitCode: code });
        return;
      }
      resolve({
        exitCode: 1,
        warning:
          `the target helper exited from signal ${signal ?? "unknown"} after execution began. ` +
          "It may have changed the repository; inspect `git status` before retrying.",
      });
    });
  });
}

async function installBootstrapCli(
  targetVersion: string,
  repoPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
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
    // npm loads project configuration from the install prefix, so acquisition
    // needs the book's `.npmrc` in this private throwaway project. Keep npm's
    // cwd at the book and select only the throwaway install prefix below:
    // relative settings such as cache=.npm-cache and cafile=./ca.pem then keep
    // the same meaning they had during target selection. Copy the bytes
    // unchanged, retain caller userconfig/environment precedence, and never
    // inspect or render the credential-bearing contents.
    try {
      const projectNpmrc = await readFile(path.join(repoPath, ".npmrc"));
      await writeFile(path.join(root, ".npmrc"), projectNpmrc, { mode: 0o600 });
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const commonArgs = [
      "install",
      "--prefix",
      root,
      "--global=false",
      "--location=project",
      "--workspaces=false",
      "--package-lock=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
    ];
    // Outer `npm --workspace ... exec` selectors describe the author's
    // project, not this isolated manifest. npm rejects a workspace selector
    // together with --workspaces=false, so remove only that invocation
    // context. CLI flags likewise prevent an inherited global/location mode
    // from redirecting installation outside the private prefix.
    const acquisitionEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !/^npm_config_(?:workspace|workspaces|include_workspace_root)$/i.test(
            key,
          ),
      ),
    );
    await run("npm", commonArgs, repoPath, acquisitionEnv, platform);
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
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` +
          `temporary bootstrap cleanup also failed for ${root}: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

/**
 * The real self-bootstrap port.
 *
 * It never installs into the book. An exact local target is used directly;
 * otherwise npm resolves it into a throwaway directory with lifecycle scripts
 * disabled. Source, package.json, package-lock.json, and node_modules stay
 * untouched before the target CLI starts. npm-managed cache and log paths
 * still follow the caller's configuration and may be read or updated.
 */
export async function createNodeUpgradeBootstrap(
  env: NodeJS.ProcessEnv = process.env,
  removeTemporary: (target: string) => Promise<void> = async (target) =>
    rm(target, { recursive: true, force: true }),
  platform: NodeJS.Platform = process.platform,
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
        const installed = await installBootstrapCli(
          request.targetVersion,
          request.repoPath,
          env,
          platform,
        );
        temporaryRoot = installed.root;
        bin = installed.bin;
      }
      let result: UpgradeBootstrapResult;
      try {
        result = await runInherited(
          process.execPath,
          [bin, "upgrade", ...request.args],
          request.cwd,
          {
            ...env,
            [BOOTSTRAP_REQUEST_ENV]: request.targetVersion,
          },
        );
      } catch (error) {
        if (temporaryRoot !== undefined) {
          try {
            await removeTemporary(temporaryRoot);
          } catch (cleanupError) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}; ` +
                `temporary bootstrap cleanup also failed for ${temporaryRoot}: ` +
                `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
          }
        }
        throw error;
      }
      if (temporaryRoot === undefined) {
        return result;
      }
      try {
        await removeTemporary(temporaryRoot);
        return result;
      } catch (cleanupError) {
        const cleanupWarning =
          `the target helper exited with status ${result.exitCode}, but temporary bootstrap ` +
          `cleanup failed for ${temporaryRoot}: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. ` +
          "The helper's exit status is preserved.";
        return {
          exitCode: result.exitCode,
          warning:
            result.warning === undefined
              ? cleanupWarning
              : `${result.warning} ${cleanupWarning}`,
        };
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
  async head(repo) {
    const { stdout } = await run("git", ["rev-parse", "HEAD"], repo);
    return stdout.trim();
  },
  async createBranch(repo, name, startPoint) {
    await run(
      "git",
      startPoint === undefined
        ? ["checkout", "-b", name]
        : ["checkout", "-b", name, startPoint],
      repo,
    );
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

type NodeCommandRunner = (
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Resolve implicit upgrade targets through npm itself.
 *
 * A direct fetch to registry.npmjs.org silently ignored npm's offline cache,
 * custom registry, userconfig, and authentication. Running `npm view` through
 * the same shell-free adapter as relocking and bootstrap acquisition makes
 * those settings authoritative and keeps project `.npmrc` lookup rooted in
 * the book repository.
 */
export function createNpmReleases(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execute: NodeCommandRunner = run,
): ReleasesPort {
  return {
    async listVersions(packageName, repoPath) {
      const { stdout } = await execute(
        "npm",
        ["view", packageName, "versions", "--json"],
        repoPath,
        env,
        platform,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        throw new Error(
          `npm returned invalid release metadata for ${packageName}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const values = typeof parsed === "string" ? [parsed] : parsed;
      if (
        !Array.isArray(values) ||
        values.some((version) => typeof version !== "string")
      ) {
        throw new Error(`npm returned invalid release metadata for ${packageName}`);
      }
      return values as string[];
    },
  };
}

export const npmReleases: ReleasesPort = createNpmReleases();

const D1_MIGRATION_RE = /\b(\d{4}_[\w.-]+\.sql)\b/g;

export function createWranglerCli(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): WranglerPort {
  return {
    async applyD1Migrations(repo, databaseName) {
      const { stdout, stderr } = await run(
        "npx",
        ["--no-install", "wrangler", "d1", "migrations", "apply", databaseName, "--remote"],
        repo,
        env,
        platform,
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
      const { stdout, stderr } = await run(
        "npx",
        ["--no-install", "wrangler", "deploy"],
        repo,
        env,
        platform,
      );
      const url = /https:\/\/[\w.-]+\.workers\.dev\S*|https:\/\/\S+/.exec(`${stdout}\n${stderr}`);
      const result: DeployResult = url === null ? {} : { url: url[0].replace(/[).,]+$/, "") };
      return result;
    },
  };
}

export const wranglerCli: WranglerPort = createWranglerCli();

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
