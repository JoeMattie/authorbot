/**
 * Fakes for the `authorbot upgrade` suite.
 *
 * The command's contract with the outside world is the port set in
 * `src/upgrade/ports.ts`, so the tests implement that set and nothing else
 * escapes: no network, no git subprocess, no wrangler, no deploy. The real
 * filesystem is used deliberately - the interesting assertions are about what
 * did and did not change on disk, and an in-memory shim would let a bug in
 * path handling pass.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CommitRequest,
  D1MigrationResult,
  DeployResult,
  GitPort,
  HealthPort,
  HealthResult,
  LockfilePort,
  PullRequestRequest,
  ReleasesPort,
  UpgradeBootstrapPort,
  UpgradeDeps,
  WranglerPort,
} from "../src/upgrade/ports.js";
import { nodeFs } from "../src/upgrade/node-ports.js";
import type { BookRepoMigration, MigrationRepo } from "../src/upgrade/migrations.js";
import { validateBookRepo } from "../src/validate/index.js";
import type { ValidationReport } from "../src/validate/findings.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
export const exampleRepo = path.join(workspaceRoot, "examples", "book-repo");

const tempDirs: string[] = [];

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export interface MakeRepoOptions {
  /** The `@authorbot/cli` range written into package.json. */
  readonly pin?: string;
  /** Existing collaborative API pin. Omitted for a static-only book. */
  readonly apiPin?: string;
  /** Omit package.json entirely. */
  readonly withoutPackageJson?: boolean;
  /** Add a wrangler.jsonc with a D1 binding of this name. */
  readonly d1Database?: string;
  /** Extra files, repo-relative path to contents. */
  readonly extraFiles?: Record<string, string>;
}

/** A throwaway copy of the example book, pinned to a version. */
export async function makeBookRepo(options: MakeRepoOptions = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "authorbot-upgrade-test-"));
  tempDirs.push(dir);
  const repo = path.join(dir, "book");
  await cp(exampleRepo, repo, { recursive: true });
  if (options.withoutPackageJson !== true) {
    const cliPin = options.pin ?? "1.0.0";
    const devDependencies = {
      ...(options.apiPin === undefined ? {} : { "@authorbot/api": options.apiPin }),
      "@authorbot/cli": cliPin,
      wrangler: "^4.0.0",
    };
    await writeFile(
      path.join(repo, "package.json"),
      `${JSON.stringify(
        {
          name: "my-book",
          version: "0.0.0",
          private: true,
          scripts: { validate: "authorbot validate .", upgrade: "authorbot upgrade" },
          devDependencies,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const packages: Record<string, unknown> = {
      "": {
        name: "my-book",
        version: "0.0.0",
        devDependencies,
      },
      "node_modules/@authorbot/cli": { version: cliPin.replace(/^[~^]/, "") },
    };
    if (options.apiPin !== undefined) {
      packages["node_modules/@authorbot/api"] = {
        version: options.apiPin.replace(/^[~^]/, ""),
      };
    }
    await writeFile(
      path.join(repo, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "my-book",
          version: "0.0.0",
          lockfileVersion: 3,
          requires: true,
          packages,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  if (options.d1Database !== undefined) {
    await writeFile(
      path.join(repo, "wrangler.jsonc"),
      `// A book with collaboration turned on.\n${JSON.stringify(
        {
          name: "my-book",
          compatibility_date: "2026-06-01",
          d1_databases: [{ binding: "DB", database_name: options.d1Database }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  for (const [relative, contents] of Object.entries(options.extraFiles ?? {})) {
    await writeFile(path.join(repo, relative), contents, "utf8");
  }
  return repo;
}

/** Every file under `dir` with its contents - the basis of "changed nothing". */
export async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = await nodeFs.listFiles(dir);
  const entries = new Map<string, string>();
  for (const file of files) {
    entries.set(file, await readFile(path.join(dir, file), "utf8"));
  }
  return entries;
}

export function snapshotsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export type GitStep = "createBranch" | "commit" | "push" | "openPullRequest";

export interface FakeGit extends GitPort {
  readonly calls: string[];
  readonly commits: { message: string; paths: readonly string[] }[];
  readonly branches: string[];
  pullRequest?: PullRequestRequest;
  clean: boolean;
  failAt?: GitStep;
}

export function fakeGit(overrides: Partial<Pick<FakeGit, "clean" | "failAt">> = {}): FakeGit {
  const calls: string[] = [];
  const commits: { message: string; paths: readonly string[] }[] = [];
  const branches: string[] = [];
  const git: FakeGit = {
    calls,
    commits,
    branches,
    clean: overrides.clean ?? true,
    ...(overrides.failAt === undefined ? {} : { failAt: overrides.failAt }),
    async isClean() {
      calls.push("isClean");
      return git.clean;
    },
    async currentBranch() {
      calls.push("currentBranch");
      return "main";
    },
    async createBranch(_repo: string, name: string) {
      calls.push(`createBranch ${name}`);
      maybeFail(git, "createBranch");
      branches.push(name);
    },
    async checkout(_repo: string, name: string) {
      calls.push(`checkout ${name}`);
    },
    async deleteBranch(_repo: string, name: string) {
      calls.push(`deleteBranch ${name}`);
    },
    async commit(repo: string, request: CommitRequest) {
      calls.push(`commit ${request.paths.join(",")}`);
      maybeFail(git, "commit");
      for (const relative of request.paths) {
        if (!(await nodeFs.exists(path.join(repo, relative)))) {
          throw new Error(`fake git: cannot stage missing path ${relative}`);
        }
      }
      commits.push({ message: request.message, paths: request.paths });
      return `sha${commits.length}`;
    },
    async push(_repo: string, branch: string) {
      calls.push(`push ${branch}`);
      maybeFail(git, "push");
    },
    async openPullRequest(_repo: string, request: PullRequestRequest) {
      calls.push(`openPullRequest ${request.branch}`);
      maybeFail(git, "openPullRequest");
      git.pullRequest = request;
      return "https://github.com/example/book/pull/7";
    },
  };
  return git;
}

function maybeFail(git: FakeGit, step: GitStep): void {
  if (git.failAt === step) {
    throw new Error(`fake git: ${step} failed`);
  }
}

export function fakeReleases(versions: string[]): ReleasesPort {
  return {
    async listVersions() {
      return versions;
    },
  };
}

export function failingReleases(message: string): ReleasesPort {
  return {
    async listVersions() {
      throw new Error(message);
    },
  };
}

export interface FakeWrangler extends WranglerPort {
  readonly calls: string[];
  applied: string[];
  deployUrl?: string;
  failD1?: boolean;
  failDeploy?: boolean;
}

export function fakeWrangler(
  overrides: Partial<Pick<FakeWrangler, "applied" | "deployUrl" | "failD1" | "failDeploy">> = {},
): FakeWrangler {
  const calls: string[] = [];
  const wrangler: FakeWrangler = {
    calls,
    applied: overrides.applied ?? [],
    ...(overrides.deployUrl === undefined ? {} : { deployUrl: overrides.deployUrl }),
    ...(overrides.failD1 === undefined ? {} : { failD1: overrides.failD1 }),
    ...(overrides.failDeploy === undefined ? {} : { failDeploy: overrides.failDeploy }),
    async applyD1Migrations(_repo: string, databaseName: string) {
      calls.push(`d1 ${databaseName}`);
      if (wrangler.failD1 === true) {
        throw new Error("fake wrangler: d1 migrations apply failed");
      }
      const result: D1MigrationResult = { applied: wrangler.applied };
      return result;
    },
    async deploy() {
      calls.push("deploy");
      if (wrangler.failDeploy === true) {
        throw new Error("fake wrangler: deploy failed");
      }
      const result: DeployResult =
        wrangler.deployUrl === undefined ? {} : { url: wrangler.deployUrl };
      return result;
    },
  };
  return wrangler;
}

export function fakeHealth(result: HealthResult): HealthPort {
  return {
    async check() {
      return result;
    },
  };
}

export interface DepsOverrides {
  lockfile?: LockfilePort;
  releases?: ReleasesPort;
  git?: GitPort;
  wrangler?: WranglerPort;
  health?: HealthPort;
  migrations?: readonly BookRepoMigration[];
  validate?: (repoPath: string) => Promise<ValidationReport>;
  bootstrap?: UpgradeBootstrapPort;
}

export function makeDeps(overrides: DepsOverrides = {}): UpgradeDeps {
  return {
    lockfile:
      overrides.lockfile ??
      {
        async relock(repoPath) {
          const manifest = JSON.parse(await nodeFs.readFile(path.join(repoPath, "package.json"))) as {
            name?: string;
            version?: string;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          const direct = {
            ...(manifest.dependencies ?? {}),
            ...(manifest.devDependencies ?? {}),
          };
          const packages: Record<string, unknown> = {
            "": {
              name: manifest.name ?? "book",
              version: manifest.version ?? "0.0.0",
              ...(manifest.dependencies === undefined
                ? {}
                : { dependencies: manifest.dependencies }),
              ...(manifest.devDependencies === undefined
                ? {}
                : { devDependencies: manifest.devDependencies }),
            },
          };
          for (const packageName of ["@authorbot/cli", "@authorbot/api"] as const) {
            const spec = direct[packageName];
            if (spec !== undefined) {
              packages[`node_modules/${packageName}`] = {
                version: spec.replace(/^[~^]/, ""),
              };
            }
          }
          await nodeFs.writeFile(
            path.join(repoPath, "package-lock.json"),
            `${JSON.stringify(
              {
                name: manifest.name ?? "book",
                version: manifest.version ?? "0.0.0",
                lockfileVersion: 3,
                requires: true,
                packages,
              },
              null,
              2,
            )}\n`,
          );
        },
      },
    fs: nodeFs,
    git: overrides.git ?? fakeGit(),
    releases: overrides.releases ?? fakeReleases(["1.0.0", "1.1.0"]),
    wrangler: overrides.wrangler ?? fakeWrangler(),
    health: overrides.health ?? fakeHealth({ ok: true, status: 200 }),
    validate: overrides.validate ?? validateBookRepo,
    migrations: overrides.migrations ?? [],
    now: () => new Date("2026-07-20T09:30:00.000Z"),
    ...(overrides.bootstrap === undefined ? {} : { bootstrap: overrides.bootstrap }),
  };
}

export interface CapturedIo {
  readonly out: string[];
  readonly err: string[];
  readonly io: { out: (line: string) => void; err: (line: string) => void };
  stdout(): string;
  stderr(): string;
}

export function captureIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line) => {
        out.push(line);
      },
      err: (line) => {
        err.push(line);
      },
    },
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
  };
}

// --------------------------------------------------------------------------
// Fixture migrations
// --------------------------------------------------------------------------

/**
 * A well-behaved migration: appends a marker line to the book README exactly
 * once, so re-running is a genuine no-op rather than an accident of ordering.
 */
export function markerMigration(
  id: string,
  from: string,
  to: string,
  marker = `<!-- migrated by ${id} -->`,
): BookRepoMigration {
  return {
    id,
    from,
    to,
    description: `Append the ${id} marker to README.md`,
    async apply(repo: MigrationRepo) {
      const file = "README.md";
      if (!(await repo.exists(file))) {
        return [];
      }
      const before = await repo.read(file);
      if (before.includes(marker)) {
        return [];
      }
      await repo.write(file, `${before.trimEnd()}\n\n${marker}\n`);
      return [file];
    },
  };
}

/** A migration that violates the toolchain/migration commit boundary. */
export function toolchainOverlappingMigration(
  file: "package.json" | "package-lock.json" = "package.json",
): BookRepoMigration {
  return {
    id: "9997-overlaps-toolchain",
    from: "1.0.0",
    to: "1.1.0",
    description: `Illegally rewrite ${file}`,
    async apply(repo: MigrationRepo) {
      await repo.write(file, `${await repo.read(file)}\n`);
      return [file];
    },
  };
}

/** A migration that corrupts book.yml, so validation must refuse the upgrade. */
export function breakingMigration(id = "9999-breaks-the-book"): BookRepoMigration {
  return {
    id,
    from: "1.0.0",
    to: "1.1.0",
    description: "Rewrite book.yml into something that cannot be parsed",
    async apply(repo: MigrationRepo) {
      // Idempotent on purpose: this fixture exists to trip the validation
      // gate, and a fixture that also failed the idempotency check would not
      // prove which gate caught it.
      const broken = "schema: authorbot.book/v1\n: : not yaml : :\n";
      if ((await repo.read("book.yml")) === broken) {
        return [];
      }
      await repo.write("book.yml", broken);
      return ["book.yml"];
    },
  };
}

/** A migration that changes something every time it runs - a toolchain bug. */
export function nonIdempotentMigration(id = "9998-not-idempotent"): BookRepoMigration {
  return {
    id,
    from: "1.0.0",
    to: "1.1.0",
    description: "Append to README.md unconditionally",
    async apply(repo: MigrationRepo) {
      const file = "README.md";
      await repo.write(file, `${await repo.read(file)}\nagain\n`);
      return [file];
    },
  };
}
