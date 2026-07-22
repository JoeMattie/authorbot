import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandError, nodeLockfile } from "../src/upgrade/node-ports.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "authorbot-upgrade-node-ports-"));
  tempDirs.push(directory);
  return directory;
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

describe("nodeLockfile", () => {
  it("relocks beneath npx without inheriting the outer npm allow-scripts config", async () => {
    const repo = await tempDirectory();
    await writeFile(
      path.join(repo, "package.json"),
      `${JSON.stringify({ name: "offline-book", version: "1.0.0", private: true }, null, 2)}\n`,
    );
    // The fixture is dependency-free, and npm is explicitly offline. This is
    // a process-environment regression test, not a registry integration test.
    await writeFile(path.join(repo, ".npmrc"), "offline=true\npackage-lock=false\n");

    const previous = process.env["npm_config_allow_scripts"];
    process.env["npm_config_allow_scripts"] = "poison-from-outer-npx";
    try {
      await nodeLockfile.relock(repo);
    } finally {
      restoreEnvironment("npm_config_allow_scripts", previous);
    }

    const lockfile = JSON.parse(await readFile(path.join(repo, "package-lock.json"), "utf8")) as {
      lockfileVersion?: number;
      packages?: Record<string, { name?: string; version?: string }>;
    };
    expect(lockfile.lockfileVersion).toBe(3);
    expect(lockfile.packages?.[""]).toMatchObject({ name: "offline-book", version: "1.0.0" });
  });

  it.runIf(process.platform !== "win32")(
    "preserves ordinary environment variables and the exact npm diagnostic",
    async () => {
      const repo = await tempDirectory();
      const bin = path.join(repo, "bin");
      await mkdir(bin);
      await writeFile(
        path.join(bin, "npm"),
        `#!/bin/sh
if [ -n "$npm_config_allow_scripts" ] || [ -n "$NPM_CONFIG_ALLOW_SCRIPTS" ]; then
  printf '%s\n' 'npm config leaked' >&2
  exit 24
fi
case " $* " in
  *" --package-lock=true "*) ;;
  *) printf '%s\n' 'package-lock was not forced on' >&2; exit 25 ;;
esac
case " $* " in
  *" --ignore-scripts "*) ;;
  *) printf '%s\n' 'lifecycle scripts were not disabled' >&2; exit 26 ;;
esac
printf 'exact diagnostic: %s\nsecond line\n' "$AUTHORBOT_NODE_PORTS_SENTINEL" >&2
exit 23
`,
      );
      await chmod(path.join(bin, "npm"), 0o755);

      const previousPath = process.env["PATH"];
      const previousSentinel = process.env["AUTHORBOT_NODE_PORTS_SENTINEL"];
      const previousPoison = process.env["npm_config_allow_scripts"];
      process.env["PATH"] = `${bin}${path.delimiter}${previousPath ?? ""}`;
      process.env["AUTHORBOT_NODE_PORTS_SENTINEL"] = "ordinary env survives";
      process.env["npm_config_allow_scripts"] = "poison-from-outer-npx";

      let caught: unknown;
      try {
        await nodeLockfile.relock(repo);
      } catch (error) {
        caught = error;
      } finally {
        restoreEnvironment("PATH", previousPath);
        restoreEnvironment("AUTHORBOT_NODE_PORTS_SENTINEL", previousSentinel);
        restoreEnvironment("npm_config_allow_scripts", previousPoison);
      }

      expect(caught).toBeInstanceOf(CommandError);
      const commandError = caught as CommandError;
      expect(commandError.command).toBe(
        "npm install --package-lock-only --package-lock=true --ignore-scripts --no-audit --no-fund",
      );
      expect(commandError.stderr).toBe(
        "exact diagnostic: ordinary env survives\nsecond line\n",
      );
      expect(commandError.message).toBe(
        "npm install --package-lock-only --package-lock=true --ignore-scripts --no-audit " +
          "--no-fund failed: " +
          "exact diagnostic: ordinary env survives\nsecond line",
      );
    },
  );
});
