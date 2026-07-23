import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  UpgradeBootstrapPort,
  UpgradeBootstrapRequest,
} from "../src/upgrade/ports.js";
import { runUpgrade } from "../src/upgrade/upgrade.js";
import {
  captureIo,
  cleanupTempDirs,
  fakeGit,
  fakeReleases,
  makeBookRepo,
  makeDeps,
  snapshot,
  snapshotsEqual,
} from "./upgrade-fakes.js";
import { nodeFs } from "../src/upgrade/node-ports.js";

afterEach(cleanupTempDirs);

interface FakeBootstrap extends UpgradeBootstrapPort {
  readonly requests: UpgradeBootstrapRequest[];
}

function fakeBootstrap(options: {
  running: string;
  requested?: string;
  result?: number;
  warning?: string;
  error?: Error;
}): FakeBootstrap {
  const requests: UpgradeBootstrapRequest[] = [];
  return {
    runningVersion: options.running,
    ...(options.requested === undefined ? {} : { requestedVersion: options.requested }),
    requests,
    async handoff(request) {
      requests.push(request);
      if (options.error !== undefined) {
        throw options.error;
      }
      return {
        exitCode: options.result ?? 0,
        ...(options.warning === undefined ? {} : { warning: options.warning }),
      };
    },
  };
}

async function writeLockedVersion(
  repoPath: string,
  spec: string,
  version: string,
): Promise<void> {
  await nodeFs.writeFile(
    path.join(repoPath, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": { devDependencies: { "@authorbot/cli": spec } },
          "node_modules/@authorbot/cli": { version },
        },
      },
      null,
      2,
    )}\n`,
  );
}

describe("authorbot upgrade self-bootstrap", () => {
  it("hands a forward upgrade to the exact target before the stale helper can mutate", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0", apiPin: "0.9.7" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const bootstrap = fakeBootstrap({ running: "0.9.0", result: 17 });
    const io = captureIo();

    expect(
      await runUpgrade(
        [repoPath, "--to", "1.1.0"],
        io.io,
        makeDeps({
          git,
          bootstrap,
          releases: fakeReleases(["1.0.0", "1.1.0"]),
        }),
      ),
    ).toBe(17);

    expect(bootstrap.requests).toEqual([
      {
        targetVersion: "1.1.0",
        repoPath,
        cwd: process.cwd(),
        args: [repoPath, "--to", "1.1.0"],
      },
    ]);
    expect(git.calls).toEqual([]);
    expect(await snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
    expect(io.stdout()).toContain("handing off to @authorbot/cli@1.1.0 before changing anything");
  });

  it("uses the target helper's migration and package-alignment behavior once bootstrapped", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0", apiPin: "0.9.7" });
    const bootstrap = fakeBootstrap({ running: "1.1.0" });

    expect(
      await runUpgrade(
        [repoPath, "--to", "1.1.0"],
        captureIo().io,
        makeDeps({ bootstrap }),
      ),
    ).toBe(0);

    expect(bootstrap.requests).toEqual([]);
    const manifest = JSON.parse(
      await nodeFs.readFile(path.join(repoPath, "package.json")),
    ) as { devDependencies: Record<string, string> };
    expect(manifest.devDependencies["@authorbot/cli"]).toBe("1.1.0");
    expect(manifest.devDependencies["@authorbot/api"]).toBe("1.1.0");
    const lock = JSON.parse(
      await nodeFs.readFile(path.join(repoPath, "package-lock.json")),
    ) as {
      packages: Record<string, { version?: string }>;
    };
    expect(lock.packages["node_modules/@authorbot/cli"]?.version).toBe("1.1.0");
    expect(lock.packages["node_modules/@authorbot/api"]?.version).toBe("1.1.0");
  });

  it("fails closed instead of recursing when npm starts a version other than the request", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const bootstrap = fakeBootstrap({
      running: "1.0.0",
      requested: "1.1.0",
    });
    const io = captureIo();

    expect(
      await runUpgrade(
        [repoPath, "--to", "1.1.0"],
        io.io,
        makeDeps({ git, bootstrap }),
      ),
    ).toBe(2);

    expect(bootstrap.requests).toEqual([]);
    expect(git.calls).toEqual([]);
    expect(await snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
    expect(io.stderr()).toContain("bootstrap requested @authorbot/cli@1.1.0");
    expect(io.stderr()).toContain("Refusing to recurse or change the repository");
  });

  it("permits only one handoff even if target selection changes in the child", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const git = fakeGit();
    const bootstrap = fakeBootstrap({
      running: "1.0.0",
      requested: "1.0.0",
    });
    const io = captureIo();

    expect(
      await runUpgrade(
        [repoPath, "--to", "1.1.0"],
        io.io,
        makeDeps({ git, bootstrap }),
      ),
    ).toBe(2);

    expect(bootstrap.requests).toEqual([]);
    expect(git.calls).toEqual([]);
    expect(io.stderr()).toContain("Refusing a second handoff");
  });

  it("leaves the book untouched when the selected helper is unavailable offline", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const before = await snapshot(repoPath);
    const git = fakeGit();
    const bootstrap = fakeBootstrap({
      running: "0.9.0",
      error: new Error("npm could not resolve packages in offline mode"),
    });
    const io = captureIo();

    expect(
      await runUpgrade(
        [repoPath, "--to", "1.1.0"],
        io.io,
        makeDeps({ git, bootstrap }),
      ),
    ).toBe(1);

    expect(git.calls).toEqual([]);
    expect(await snapshotsEqual(before, await snapshot(repoPath))).toBe(true);
    expect(io.stderr()).toContain("could not start @authorbot/cli@1.1.0");
    expect(io.stderr()).toContain("target-helper execution never began");
    expect(io.stderr()).toContain("repository was not changed");
    expect(io.stderr()).toContain(
      `npx --yes @authorbot/cli@1.1.0 upgrade ${repoPath} --to 1.1.0`,
    );
    expect(io.stderr()).not.toContain("npm install --save-dev");
  });

  it("preserves a successful child exit while reporting post-start cleanup uncertainty", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const bootstrap = fakeBootstrap({
      running: "0.9.0",
      result: 0,
      warning:
        "the target helper exited with status 0, but temporary cleanup failed. " +
        "The helper's exit status is preserved.",
    });
    const io = captureIo();

    expect(
      await runUpgrade(
        [repoPath, "--to", "1.1.0"],
        io.io,
        makeDeps({ bootstrap }),
      ),
    ).toBe(0);

    expect(io.stderr()).toContain("bootstrap warning");
    expect(io.stderr()).toContain("exit status is preserved");
    expect(io.stderr()).not.toContain("repository was not changed");
  });

  it("uses the locked current helper for finish and rollback, not the rollback target", async () => {
    const repoPath = await makeBookRepo({ pin: "^1.0.0" });
    await writeLockedVersion(repoPath, "^1.0.0", "1.0.7");

    const finishBootstrap = fakeBootstrap({ running: "0.9.0", result: 19 });
    expect(
      await runUpgrade(
        [repoPath, "--finish"],
        captureIo().io,
        makeDeps({ bootstrap: finishBootstrap }),
      ),
    ).toBe(19);
    expect(finishBootstrap.requests[0]?.targetVersion).toBe("1.0.7");

    const rollbackBootstrap = fakeBootstrap({ running: "0.9.0", result: 21 });
    expect(
      await runUpgrade(
        [repoPath, "--rollback", "0.9.0"],
        captureIo().io,
        makeDeps({
          bootstrap: rollbackBootstrap,
          releases: fakeReleases(["0.9.0", "1.0.0", "1.0.7"]),
        }),
      ),
    ).toBe(21);
    expect(rollbackBootstrap.requests[0]?.targetVersion).toBe("1.0.7");
  });

  it("keeps JSON stdout machine-readable and forwards --check's child exit code", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const bootstrap = fakeBootstrap({ running: "0.9.0", result: 11 });
    const io = captureIo();

    expect(
      await runUpgrade(
        [repoPath, "--check", "--json"],
        io.io,
        makeDeps({ bootstrap }),
      ),
    ).toBe(11);

    expect(io.stdout()).toBe("");
    expect(io.stderr()).toContain("handing off to @authorbot/cli@1.1.0");
    expect(bootstrap.requests[0]?.args).toEqual([repoPath, "--check", "--json"]);
  });

  it("repairs a stale local helper even when the manifest is already current", async () => {
    const repoPath = await makeBookRepo({ pin: "1.0.0" });
    const bootstrap = fakeBootstrap({ running: "0.9.0", result: 0 });

    expect(
      await runUpgrade(
        [repoPath, "--check"],
        captureIo().io,
        makeDeps({
          bootstrap,
          releases: fakeReleases(["1.0.0"]),
        }),
      ),
    ).toBe(0);

    expect(bootstrap.requests[0]?.targetVersion).toBe("1.0.0");
  });
});
