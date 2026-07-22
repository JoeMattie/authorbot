import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFs } from "../src/upgrade/node-ports.js";
import {
  CHECK_EXIT_AVAILABLE,
  CHECK_EXIT_MIGRATION,
  CHECK_EXIT_NONE,
  runUpgrade,
} from "../src/upgrade/upgrade.js";
import type { ValidationReport } from "../src/validate/findings.js";
import {
  breakingMigration,
  captureIo,
  cleanupTempDirs,
  failingReleases,
  fakeGit,
  fakeHealth,
  fakeReleases,
  fakeWrangler,
  makeBookRepo,
  makeDeps,
  markerMigration,
  nonIdempotentMigration,
  snapshot,
  snapshotsEqual,
  toolchainOverlappingMigration,
} from "./upgrade-fakes.js";

afterEach(cleanupTempDirs);

async function readPinSpec(repoPath: string): Promise<string> {
  const parsed: unknown = JSON.parse(await nodeFs.readFile(path.join(repoPath, "package.json")));
  return (parsed as { devDependencies: Record<string, string> }).devDependencies["@authorbot/cli"] ?? "";
}

describe("authorbot upgrade - usage", () => {
  it("prints help and rejects nonsense combinations with exit 2", async () => {
    const io = captureIo();
    expect(await runUpgrade(["--help"], io.io, makeDeps())).toBe(0);
    expect(io.stdout()).toContain("--check");
    expect(io.stdout()).toContain("Exit codes (--check)");

    const bad = captureIo();
    expect(await runUpgrade(["--nope"], bad.io, makeDeps())).toBe(2);
    expect(await runUpgrade(["--to"], bad.io, makeDeps())).toBe(2);
    expect(await runUpgrade(["a", "b"], bad.io, makeDeps())).toBe(2);
    expect(await runUpgrade(["--check", "--dry-run"], bad.io, makeDeps())).toBe(2);
    expect(await runUpgrade(["--finish", "--check"], bad.io, makeDeps())).toBe(2);
    expect(await runUpgrade(["--rollback", "1.0.0", "--check"], bad.io, makeDeps())).toBe(2);
  });

  it("reports a directory that is not a book repository with exit 2", async () => {
    const repoPath = await makeBookRepo({ withoutPackageJson: true });
    const io = captureIo();
    expect(await runUpgrade([repoPath, "--check"], io.io, makeDeps())).toBe(2);
    expect(io.stderr()).toContain("no package.json");
  });

  it("refuses a pin it would have to guess at", async () => {
    const repoPath = await makeBookRepo({ pin: "*" });
    const io = captureIo();
    expect(await runUpgrade([repoPath, "--check"], io.io, makeDeps())).toBe(2);
    expect(io.stderr()).toContain("will not guess");
  });

  it("surfaces a registry outage as an error, never as 'up to date'", async () => {
    const repoPath = await makeBookRepo();
    const io = captureIo();
    const deps = makeDeps({ releases: failingReleases("ENOTFOUND registry.npmjs.org") });
    expect(await runUpgrade([repoPath, "--check"], io.io, deps)).toBe(2);
    expect(io.stderr()).toContain("could not list published releases");
  });
});

describe("authorbot upgrade --check", () => {
  it("exits 0 when there is nothing to upgrade", async () => {
    const repoPath = await makeBookRepo({ pin: "1.1.0" });
    const io = captureIo();
    const code = await runUpgrade([repoPath, "--check"], io.io, makeDeps());
    expect(code).toBe(CHECK_EXIT_NONE);
    expect(io.stdout()).toContain("up to date (1.1.0)");
  });

  it("exits 10 when an upgrade is available with no format migration", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const io = captureIo();
    const code = await runUpgrade([repoPath, "--check"], io.io, makeDeps());
    expect(code).toBe(CHECK_EXIT_AVAILABLE);
    expect(io.stdout()).toContain("upgrade available: 1.0.0 -> 1.1.0");
    expect(io.stdout()).toContain("no book-format migration needed");
  });

  it("exits 11 when the upgrade would run a format migration", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const io = captureIo();
    const deps = makeDeps({ migrations: [markerMigration("0001-a", "1.0.0", "1.1.0")] });
    expect(await runUpgrade([repoPath, "--check"], io.io, deps)).toBe(CHECK_EXIT_MIGRATION);
    expect(io.stdout()).toContain("1 book-format migration would run");
    expect(io.stdout()).toContain("0001-a (1.0.0 -> 1.1.0)");
  });

  it("emits a stable machine-readable shape for a scheduled job", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const io = captureIo();
    const deps = makeDeps({
      releases: fakeReleases(["1.0.0", "1.1.0", "2.0.0"]),
      migrations: [markerMigration("0001-a", "1.0.0", "1.1.0")],
    });
    expect(await runUpgrade([repoPath, "--check", "--json"], io.io, deps)).toBe(
      CHECK_EXIT_MIGRATION,
    );
    expect(JSON.parse(io.stdout())).toEqual({
      current: "1.0.0",
      target: "1.1.0",
      upgradeAvailable: true,
      formatMigrationRequired: true,
      migrations: [
        {
          id: "0001-a",
          from: "1.0.0",
          to: "1.1.0",
          description: "Append the 0001-a marker to README.md",
        },
      ],
      newerMajorAvailable: "2.0.0",
    });
  });

  it("never crosses a major on its own, but says one exists", async () => {
    const repoPath = await makeBookRepo({ pin: "1.1.0" });
    const io = captureIo();
    const deps = makeDeps({ releases: fakeReleases(["1.0.0", "1.1.0", "2.0.0"]) });
    // A major is where a valid book may stop being valid, so it is opt-in.
    expect(await runUpgrade([repoPath, "--check"], io.io, deps)).toBe(CHECK_EXIT_NONE);
    expect(io.stdout()).toContain("newer major exists (2.0.0)");
    expect(io.stdout()).toContain("--to 2.0.0");
  });

  it("honours the pin's channel width", async () => {
    const caret = await makeBookRepo({ pin: "^1.0.0" });
    const tilde = await makeBookRepo({ pin: "~1.0.0" });
    const deps = makeDeps({ releases: fakeReleases(["1.0.0", "1.0.5", "1.1.0"]) });

    const caretIo = captureIo();
    await runUpgrade([caret, "--check", "--json"], caretIo.io, deps);
    expect(JSON.parse(caretIo.stdout()).target).toBe("1.1.0");

    const tildeIo = captureIo();
    await runUpgrade([tilde, "--check", "--json"], tildeIo.io, deps);
    expect(JSON.parse(tildeIo.stdout()).target).toBe("1.0.5");
  });

  it("ignores prereleases when resolving a target on its own", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const io = captureIo();
    const deps = makeDeps({ releases: fakeReleases(["1.0.0", "1.1.0-rc.1"]) });
    expect(await runUpgrade([repoPath, "--check"], io.io, deps)).toBe(CHECK_EXIT_NONE);
  });

  it("rejects a --to that is not published", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const io = captureIo();
    expect(await runUpgrade([repoPath, "--check", "--to", "9.9.9"], io.io, makeDeps())).toBe(2);
    expect(io.stderr()).toContain("is not published");
  });
});

describe("authorbot upgrade - no upgrade available", () => {
  it("says so, touches nothing, and exits 0", async () => {
    const repoPath = await makeBookRepo({ pin: "1.1.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const io = captureIo();
    expect(await runUpgrade([repoPath], io.io, makeDeps({ git }))).toBe(0);
    expect(io.stdout()).toContain("already on 1.1.0");
    expect(git.calls).toEqual([]);
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
  });
});

describe("authorbot upgrade --dry-run", () => {
  it("prints the plan and changes absolutely nothing", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0", d1Database: "book-db" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const wrangler = fakeWrangler();
    const io = captureIo();
    const deps = makeDeps({
      git,
      wrangler,
      migrations: [markerMigration("0001-a", "1.0.0", "1.1.0")],
    });

    expect(await runUpgrade([repoPath, "--dry-run"], io.io, deps)).toBe(0);

    // The assertion that matters: the repository on disk is byte-identical.
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
    expect(git.calls).toEqual([]);
    expect(wrangler.calls).toEqual([]);

    const out = io.stdout();
    expect(out).toContain("1.0.0 -> 1.1.0");
    expect(out).toContain("Plan (nothing below has been done)");
    expect(out).toContain("align direct Authorbot packages: 1.0.0 -> 1.1.0");
    expect(out).toContain("regenerate package-lock.json");
    expect(out).toContain("README.md");
    expect(out).toContain("0 error(s) before, 0 after, 0 new");
    expect(out).toContain("apply pending D1 migrations to book-db");
  });

  it("reports a static book's missing database as a skip with a reason", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const io = captureIo();
    expect(await runUpgrade([repoPath, "--dry-run"], io.io, makeDeps())).toBe(0);
    expect(io.stdout()).toContain("skipped, no d1_databases binding");
  });

  it("reports that a breaking upgrade would be refused, and exits 1", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const before = await snapshot(repoPath);
    const io = captureIo();
    const deps = makeDeps({ migrations: [breakingMigration()] });
    expect(await runUpgrade([repoPath, "--dry-run"], io.io, deps)).toBe(1);
    expect(io.stderr()).toContain("WOULD BE REFUSED");
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
  });
});

describe("authorbot upgrade - the validate gate (ADR-0021 §2)", () => {
  it("aborts the whole upgrade when a migration introduces a new error", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const io = captureIo();
    const deps = makeDeps({ git, migrations: [breakingMigration()] });

    expect(await runUpgrade([repoPath], io.io, deps)).toBe(1);

    expect(io.stderr()).toContain("UPGRADE ABORTED");
    expect(io.stderr()).toContain("must keep validating");
    // No branch, no commit, no byte changed.
    expect(git.branches).toEqual([]);
    expect(git.commits).toEqual([]);
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
  });

  it("tolerates errors that were already there", async () => {
    // A book that is already invalid may still be upgraded: the promise is
    // "no NEW errors", not "the book is perfect".
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const existing: ValidationReport = {
      valid: false,
      errors: [
        {
          code: "BLOCK_ID_MISSING",
          severity: "error",
          path: "chapters/001.md",
          message: "pre-existing",
        },
      ],
      warnings: [],
    };
    const git = fakeGit();
    const io = captureIo();
    const deps = makeDeps({ git, validate: async () => existing });
    expect(await runUpgrade([repoPath], io.io, deps)).toBe(0);
    expect(io.stdout()).toContain("1 error(s) before, 1 after, 0 new");
    expect(git.commits).toHaveLength(1);
  });

  it("survives a migration that throws, without touching the repository", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const io = captureIo();
    const deps = makeDeps({
      git,
      migrations: [
        {
          id: "0001-explodes",
          from: "1.0.0",
          to: "1.1.0",
          description: "throws",
          async apply() {
            throw new Error("boom");
          },
        },
      ],
    });
    expect(await runUpgrade([repoPath], io.io, deps)).toBe(2);
    expect(io.stderr()).toContain("0001-explodes failed: boom");
    expect(io.stderr()).toContain("your repository was not modified");
    expect(git.branches).toEqual([]);
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
  });

  it("refuses a migration that is not idempotent, and blames itself", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const io = captureIo();
    const deps = makeDeps({ git, migrations: [nonIdempotentMigration()] });
    expect(await runUpgrade([repoPath], io.io, deps)).toBe(2);
    expect(io.stderr()).toContain("not idempotent");
    expect(io.stderr()).toContain("bug in the toolchain, not in your book");
    expect(git.branches).toEqual([]);
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
  });

  it("refuses a book migration that overlaps the toolchain commit", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const io = captureIo();
    const deps = makeDeps({ git, migrations: [toolchainOverlappingMigration()] });

    expect(await runUpgrade([repoPath], io.io, deps)).toBe(2);

    expect(io.stderr()).toContain("must not change package.json");
    expect(io.stderr()).toContain("upgrade helper owns those files");
    expect(git.branches).toEqual([]);
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
  });
});

describe("authorbot upgrade - the pull request (ADR-0021 §3 step 4)", () => {
  it("commits the pin and the migration separately, then opens a PR", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const git = fakeGit();
    const io = captureIo();
    const deps = makeDeps({ git, migrations: [markerMigration("0001-a", "1.0.0", "1.1.0")] });

    expect(await runUpgrade([repoPath], io.io, deps)).toBe(0);

    // Never a push to the default branch: a branch is created first.
    expect(git.branches).toHaveLength(1);
    expect(git.branches[0]).toMatch(/^authorbot\/upgrade-1\.1\.0-/);

    // Two commits, in this order, so `git revert` can undo either alone.
    expect(git.commits).toHaveLength(2);
    // The lockfile rides with the pin: `npm ci` refuses a lockfile that
    // disagrees with its manifest, so committing package.json alone opened a
    // pull request whose own CI could not pass.
    expect(git.commits[0]?.paths).toEqual(["package.json", "package-lock.json"]);
    expect(git.commits[0]?.message).toContain("upgrade toolchain 1.0.0 -> 1.1.0");
    expect(git.commits[1]?.paths).toEqual(["README.md"]);
    expect(git.commits[1]?.message).toContain("book-format migrations for 1.1.0");
    expect(git.commits[1]?.message).toContain("undoes the format migration only");

    expect(git.calls).toContain(`push ${git.branches[0]}`);
    expect(git.pullRequest?.base).toBe("main");
    expect(git.pullRequest?.title).toBe("Upgrade Authorbot 1.0.0 -> 1.1.0");
    expect(git.pullRequest?.body).toContain("Book-format migrations");
    expect(git.pullRequest?.body).toContain("**0 new**");
    expect(io.stdout()).toContain("pull request opened: https://github.com/example/book/pull/7");

    // The working copy really was written back.
    expect(await readPinSpec(repoPath)).toBe("1.1.0");
    expect(await nodeFs.readFile(path.join(repoPath, "package-lock.json"))).toContain('"@authorbot/cli": "1.1.0"');
    expect(await nodeFs.readFile(path.join(repoPath, "README.md"))).toContain(
      "<!-- migrated by 0001-a -->",
    );
  });

  it("fails closed before branching when the lockfile cannot be refreshed", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const io = captureIo();
    const failed = makeDeps({
      git,
      lockfile: {
        async relock() {
          throw new Error("npm install failed: EALLOWSCRIPTS inherited config is forbidden");
        },
      },
    });

    expect(await runUpgrade([repoPath], io.io, failed)).toBe(1);

    expect(git.branches).toEqual([]);
    expect(git.commits).toEqual([]);
    expect(git.pullRequest).toBeUndefined();
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
    expect(io.stderr()).toContain("EALLOWSCRIPTS inherited config is forbidden");
    expect(io.stderr()).toContain("before creating a branch");
    expect(io.stderr()).toContain("npm ci");
  });

  it("rejects a stale lockfile even when the relocker exits successfully", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0", apiPin: "1.0.0" });
    await nodeFs.writeFile(
      path.join(repoPath, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "my-book",
          version: "0.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              devDependencies: {
                "@authorbot/api": "1.0.0",
                "@authorbot/cli": "1.0.0",
              },
            },
            "node_modules/@authorbot/api": { version: "1.0.0" },
            "node_modules/@authorbot/cli": { version: "1.0.0" },
          },
        },
        null,
        2,
      )}\n`,
    );
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const io = captureIo();
    const deps = makeDeps({
      git,
      lockfile: {
        async relock() {
          // Models npm exiting zero without touching an existing lockfile.
        },
      },
    });

    expect(await runUpgrade([repoPath], io.io, deps)).toBe(1);

    expect(git.branches).toEqual([]);
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
    expect(io.stderr()).toContain("kept a stale @authorbot/cli root spec");
  });

  it("rejects a lockfile that resolves past the selected release", async () => {
    const repoPath = await makeBookRepo({ pin: "^1.0.0", apiPin: "^1.0.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const io = captureIo();
    const deps = makeDeps({
      git,
      lockfile: {
        async relock(workingCopy) {
          const manifest = JSON.parse(
            await nodeFs.readFile(path.join(workingCopy, "package.json")),
          ) as { devDependencies: Record<string, string> };
          await nodeFs.writeFile(
            path.join(workingCopy, "package-lock.json"),
            `${JSON.stringify(
              {
                lockfileVersion: 3,
                packages: {
                  "": { devDependencies: manifest.devDependencies },
                  "node_modules/@authorbot/api": { version: "1.2.0" },
                  "node_modules/@authorbot/cli": { version: "1.2.0" },
                },
              },
              null,
              2,
            )}\n`,
          );
        },
      },
    });

    expect(await runUpgrade([repoPath], io.io, deps)).toBe(1);

    expect(git.branches).toEqual([]);
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
    expect(io.stderr()).toContain("resolved @authorbot/cli to 1.2.0");
    expect(io.stderr()).toContain("not the selected release 1.1.0");
  });

  it("keeps an existing API package aligned and does not add it to a static book", async () => {
    const collaborative = await makeBookRepo({ pin: "1.0.0", apiPin: "0.9.7" });
    expect(await runUpgrade([collaborative], captureIo().io, makeDeps())).toBe(0);
    const collaborativeManifest = JSON.parse(
      await nodeFs.readFile(path.join(collaborative, "package.json")),
    ) as { devDependencies: Record<string, string> };
    expect(collaborativeManifest.devDependencies["@authorbot/cli"]).toBe("1.1.0");
    expect(collaborativeManifest.devDependencies["@authorbot/api"]).toBe("1.1.0");
    const lock = await nodeFs.readFile(path.join(collaborative, "package-lock.json"));
    expect(lock).toContain('"@authorbot/api": "1.1.0"');
    expect(lock).toContain('"@authorbot/cli": "1.1.0"');

    const staticBook = await makeBookRepo({ pin: "1.0.0" });
    expect(await runUpgrade([staticBook], captureIo().io, makeDeps())).toBe(0);
    const staticManifest = JSON.parse(
      await nodeFs.readFile(path.join(staticBook, "package.json")),
    ) as { devDependencies: Record<string, string> };
    expect(staticManifest.devDependencies["@authorbot/api"]).toBeUndefined();
  });

  it("makes a single commit when only the pin moves", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const git = fakeGit();
    const io = captureIo();
    expect(await runUpgrade([repoPath], io.io, makeDeps({ git }))).toBe(0);
    expect(git.commits).toHaveLength(1);
    expect(git.pullRequest?.body).toContain("only the pin changed");
  });

  it("keeps a channel pin a channel and aligns an existing API package", async () => {
    const repoPath = await makeBookRepo({ pin: "^1.0.0", apiPin: "0.9.7" });
    const io = captureIo();
    expect(await runUpgrade([repoPath], io.io, makeDeps())).toBe(0);
    expect(await readPinSpec(repoPath)).toBe("^1.1.0");
    const manifest = JSON.parse(await nodeFs.readFile(path.join(repoPath, "package.json"))) as {
      devDependencies: Record<string, string>;
    };
    expect(manifest.devDependencies["@authorbot/api"]).toBe("^1.1.0");
  });

  it("pins an explicit --to target exactly even when the book used a channel", async () => {
    const repoPath = await makeBookRepo({ pin: "^1.0.0", apiPin: "^1.0.0" });
    const io = captureIo();

    expect(await runUpgrade([repoPath, "--to", "1.1.0"], io.io, makeDeps())).toBe(0);

    const manifest = JSON.parse(await nodeFs.readFile(path.join(repoPath, "package.json"))) as {
      devDependencies: Record<string, string>;
    };
    expect(manifest.devDependencies["@authorbot/cli"]).toBe("1.1.0");
    expect(manifest.devDependencies["@authorbot/api"]).toBe("1.1.0");
    const lock = JSON.parse(await nodeFs.readFile(path.join(repoPath, "package-lock.json"))) as {
      packages: Record<string, { version?: string }>;
    };
    expect(lock.packages["node_modules/@authorbot/cli"]?.version).toBe("1.1.0");
    expect(lock.packages["node_modules/@authorbot/api"]?.version).toBe("1.1.0");
  });

  it("preserves the author's package.json formatting outside the pin", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const before = await nodeFs.readFile(path.join(repoPath, "package.json"));
    await runUpgrade([repoPath], captureIo().io, makeDeps());
    const after = await nodeFs.readFile(path.join(repoPath, "package.json"));
    expect(after).toBe(before.replace('"@authorbot/cli": "1.0.0"', '"@authorbot/cli": "1.1.0"'));
  });

  it("targets the branch named in book.yml", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const bookPath = path.join(repoPath, "book.yml");
    const book = await nodeFs.readFile(bookPath);
    await nodeFs.writeFile(bookPath, book.replace("default_branch: main", "default_branch: trunk"));
    const git = fakeGit();
    await runUpgrade([repoPath], captureIo().io, makeDeps({ git }));
    expect(git.pullRequest?.base).toBe("trunk");
  });

  it("refuses to start on a dirty working tree", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const git = fakeGit({ clean: false });
    const io = captureIo();
    expect(await runUpgrade([repoPath], io.io, makeDeps({ git }))).toBe(2);
    expect(io.stderr()).toContain("uncommitted changes");
    expect(git.branches).toEqual([]);
  });
});

describe("authorbot upgrade - failure mid-sequence", () => {
  it("leaves a recoverable state and says exactly how to recover", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const git = fakeGit({ failAt: "push" });
    const io = captureIo();
    const deps = makeDeps({ git, migrations: [markerMigration("0001-a", "1.0.0", "1.1.0")] });

    expect(await runUpgrade([repoPath], io.io, deps)).toBe(1);

    const err = io.stderr();
    expect(err).toContain("upgrade did not complete: fake git: push failed");
    expect(err).toContain("completed before the failure:");
    expect(err).toContain("committed the toolchain pin");
    expect(err).toContain("committed 1 migrated file(s)");
    expect(err).toContain("your default branch was not touched");
    expect(err).toMatch(/git checkout main && git branch -D authorbot\/upgrade-1\.1\.0-/);
    // The work is genuinely on the branch, not lost.
    expect(git.commits).toHaveLength(2);
    expect(git.pullRequest).toBeUndefined();
  });

  it("reports a pull-request failure without claiming a PR exists", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const git = fakeGit({ failAt: "openPullRequest" });
    const io = captureIo();
    expect(await runUpgrade([repoPath], io.io, makeDeps({ git }))).toBe(1);
    expect(io.stdout()).not.toContain("pull request opened");
    expect(io.stderr()).toContain("pushed authorbot/upgrade-1.1.0-");
  });
});

describe("authorbot upgrade - steps 5 and 6", () => {
  it("applies D1 migrations before deploying, then verifies health", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0", d1Database: "book-db" });
    const wrangler = fakeWrangler({
      applied: ["0006_phase6_settings.sql"],
      deployUrl: "https://my-book.example.workers.dev",
    });
    const io = captureIo();
    expect(await runUpgrade([repoPath, "--deploy"], io.io, makeDeps({ wrangler }))).toBe(0);
    // Ordering is the whole point of ADR-0021 §4.
    expect(wrangler.calls).toEqual(["d1 book-db", "deploy"]);
    expect(io.stdout()).toContain("applied 1 D1 migration(s) to book-db");
    expect(io.stdout()).toContain("is healthy (HTTP 200). Upgrade complete.");
  });

  it("stops before deploying when the migrations fail", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0", d1Database: "book-db" });
    const wrangler = fakeWrangler({ failD1: true });
    const io = captureIo();
    expect(await runUpgrade([repoPath, "--deploy"], io.io, makeDeps({ wrangler }))).toBe(1);
    expect(wrangler.calls).toEqual(["d1 book-db"]);
    expect(io.stderr()).toContain("NOT deploying");
  });

  it("will not call a deploy healthy when it cannot check", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const wrangler = fakeWrangler();
    const io = captureIo();
    // Deployed, but wrangler reported no URL and none was given: unverifiable
    // is a failure, not a success.
    expect(await runUpgrade([repoPath, "--finish"], io.io, makeDeps({ wrangler }))).toBe(1);
    expect(io.stderr()).toContain("health could NOT be verified");
    expect(io.stderr()).toContain("would be a guess");
  });

  it("uses --url when wrangler reports nothing", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const io = captureIo();
    const deps = makeDeps({ wrangler: fakeWrangler(), health: fakeHealth({ ok: true, status: 200 }) });
    expect(
      await runUpgrade([repoPath, "--finish", "--url", "https://book.example"], io.io, deps),
    ).toBe(0);
    expect(io.stdout()).toContain("https://book.example is healthy");
  });

  it("fails when the deployed site is unhealthy, and points at rollback", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const io = captureIo();
    const deps = makeDeps({
      wrangler: fakeWrangler({ deployUrl: "https://book.example" }),
      health: fakeHealth({ ok: false, status: 503, detail: "HTTP 503" }),
    });
    expect(await runUpgrade([repoPath, "--finish"], io.io, deps)).toBe(1);
    expect(io.stderr()).toContain("is not healthy (HTTP 503)");
    expect(io.stderr()).toContain("--rollback");
  });

  it("stops after the pull request unless --deploy is given", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0", d1Database: "book-db" });
    const wrangler = fakeWrangler();
    const io = captureIo();
    expect(await runUpgrade([repoPath], io.io, makeDeps({ wrangler }))).toBe(0);
    expect(wrangler.calls).toEqual([]);
    expect(io.stdout()).toContain("review and merge the pull request");
  });
});

describe("authorbot upgrade --rollback (ADR-0021 §5)", () => {
  it("rolls the pin back as a pull request and re-validates", async () => {
    const repoPath = await makeBookRepo({ pin: "^1.1.0", apiPin: "^1.1.0" });
    const git = fakeGit();
    const io = captureIo();
    expect(await runUpgrade([repoPath, "--rollback", "1.0.0"], io.io, makeDeps({ git }))).toBe(0);
    expect(await readPinSpec(repoPath)).toBe("1.0.0");
    const manifest = JSON.parse(await nodeFs.readFile(path.join(repoPath, "package.json"))) as {
      devDependencies: Record<string, string>;
    };
    expect(manifest.devDependencies["@authorbot/api"]).toBe("1.0.0");
    expect(manifest.devDependencies["@authorbot/cli"]).toBe("1.0.0");
    expect(git.branches[0]).toMatch(/^authorbot\/rollback-1\.0\.0-/);
    expect(git.commits).toHaveLength(1);
    expect(git.commits[0]?.message).toContain("roll back toolchain 1.1.0 -> 1.0.0");
    expect(io.stdout()).toContain("re-validated after the rollback");
  });

  it("distinguishes a toolchain rollback from a format rollback", async () => {
    const repoPath = await makeBookRepo({ pin: "1.1.0" });
    const io = captureIo();
    const deps = makeDeps({ migrations: [markerMigration("0001-a", "1.0.0", "1.1.0")] });
    expect(await runUpgrade([repoPath, "--rollback", "1.0.0"], io.io, deps)).toBe(0);
    const out = io.stdout();
    expect(out).toContain("rolling the TOOLCHAIN back");
    expect(out).toContain("does NOT undo 1 book-format migration");
    expect(out).toContain("git revert <that commit>");
    expect(out).toContain("ADR-0021 §5");
  });

  it("says plainly when there is no format migration to worry about", async () => {
    const repoPath = await makeBookRepo({ pin: "1.1.0" });
    const io = captureIo();
    expect(await runUpgrade([repoPath, "--rollback", "1.0.0"], io.io, makeDeps())).toBe(0);
    expect(io.stdout()).toContain("no book-format migration ran between these versions");
  });

  it("fails closed before branching when the rollback lockfile cannot be refreshed", async () => {
    const repoPath = await makeBookRepo({ pin: "1.1.0", apiPin: "1.1.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const io = captureIo();
    const deps = makeDeps({
      git,
      lockfile: {
        async relock() {
          throw new Error("npm rollback relock failed while offline");
        },
      },
    });

    expect(await runUpgrade([repoPath, "--rollback", "1.0.0"], io.io, deps)).toBe(1);

    expect(git.branches).toEqual([]);
    expect(git.commits).toEqual([]);
    expect(git.pullRequest).toBeUndefined();
    expect(snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
    expect(io.stderr()).toContain("npm rollback relock failed while offline");
    expect(io.stderr()).toContain("before creating a branch");
  });

  it("reports a book left invalid by the rollback and exits 1", async () => {
    const repoPath = await makeBookRepo({ pin: "1.1.0" });
    const io = captureIo();
    const deps = makeDeps({
      validate: async () => ({
        valid: false,
        errors: [
          {
            code: "CHAPTER_FRONTMATTER_INVALID" as const,
            severity: "error" as const,
            path: "chapters/001.md",
            message: "unknown schema authorbot.chapter/v2",
          },
        ],
        warnings: [],
      }),
    });
    expect(await runUpgrade([repoPath, "--rollback", "1.0.0"], io.io, deps)).toBe(1);
    expect(io.stderr()).toContain("older toolchain against migrated files");
  });

  it("refuses to roll 'back' to something newer, and changes nothing on --dry-run", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const forward = captureIo();
    expect(await runUpgrade([repoPath, "--rollback", "1.1.0"], forward.io, makeDeps())).toBe(2);
    expect(forward.stderr()).toContain("is not older than the current pin");

    const newer = await makeBookRepo({ pin: "1.1.0" });
    const before = await snapshot(newer);
    const git = fakeGit();
    const io = captureIo();
    expect(
      await runUpgrade([newer, "--rollback", "1.0.0", "--dry-run"], io.io, makeDeps({ git })),
    ).toBe(0);
    expect(git.calls).toEqual([]);
    expect(snapshotsEqual(before, await snapshot(newer))).toBe(true);
  });
});
