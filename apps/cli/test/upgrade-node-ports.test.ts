import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandError,
  createNodeLockfile,
  createNodeUpgradeBootstrap,
  createNpmReleases,
  createWranglerCli,
  nodeLockfile,
  resolveExecutableInvocation,
} from "../src/upgrade/node-ports.js";

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

describe("Windows package-manager executable resolution", () => {
  const env = {
    npm_node_execpath: "C:\\Attacker\\node.exe",
    npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
  };

  it("runs npm's JavaScript entry point through node.exe without a shell", () => {
    expect(
      resolveExecutableInvocation(
        "npm",
        ["install", "name with spaces", "value&still-one-argument"],
        env,
        "win32",
        "C:\\Trusted\\node.exe",
        () => true,
      ),
    ).toEqual({
      file: "C:\\Trusted\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "install",
        "name with spaces",
        "value&still-one-argument",
      ],
    });
  });

  it("maps npx to the sibling npx CLI and keeps every argument discrete", () => {
    expect(
      resolveExecutableInvocation(
        "npx.cmd",
        ["--no-install", "wrangler", "d1", "apply", "db & not syntax"],
        env,
        "win32",
        "C:\\Trusted\\node.exe",
        () => true,
      ),
    ).toEqual({
      file: "C:\\Trusted\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
        "--no-install",
        "wrangler",
        "d1",
        "apply",
        "db & not syntax",
      ],
    });
  });

  it("uses an existence-checked bundled npm fallback without trusting npm_node_execpath", () => {
    expect(
      resolveExecutableInvocation(
        "npm",
        ["install"],
        { npm_node_execpath: "D:\\Attacker\\node.exe" },
        "win32",
        "D:\\Trusted\\node.exe",
        (target) =>
          target ===
          "D:\\Trusted\\node_modules\\npm\\bin\\npm-cli.js",
      ),
    ).toEqual({
      file: "D:\\Trusted\\node.exe",
      args: [
        "D:\\Trusted\\node_modules\\npm\\bin\\npm-cli.js",
        "install",
      ],
    });
  });

  it("rejects missing or untrusted launchers instead of enabling a shell", () => {
    expect(() =>
      resolveExecutableInvocation(
        "npm",
        ["install"],
        { npm_execpath: "D:\\Node\\node_modules\\npm\\bin\\npm-cli.js" },
        "win32",
        "D:\\Trusted\\node.exe",
        () => false,
      ),
    ).toThrow(/will not enable a command shell/);
  });

  it("leaves non-Windows commands unchanged", () => {
    expect(
      resolveExecutableInvocation(
        "npm",
        ["install"],
        env,
        "linux",
        "/usr/bin/node",
      ),
    ).toEqual({ file: "npm", args: ["install"] });
  });
});

describe("nodeLockfile", () => {
  it("relocks through npm's JS entry point under simulated Windows", async () => {
    const repo = await tempDirectory();
    const npmCli = path.join(repo, "npm-cli.cjs");
    const marker = path.join(repo, "windows-npm.json");
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "windows-book", version: "1.0.0", private: true }),
    );
    await writeFile(
      npmCli,
      `const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(process.env.AUTHORBOT_WINDOWS_NPM_MARKER, JSON.stringify({
  args: process.argv.slice(2),
  poison: process.env.npm_config_allow_scripts,
  offline: process.env.npm_config_offline
}));
fs.writeFileSync(path.join(process.cwd(), "package-lock.json"), JSON.stringify({
  lockfileVersion: 3,
  packages: { "": { name: "windows-book", version: "1.0.0" } }
}));
`,
    );
    const lockfile = createNodeLockfile(
      {
        ...process.env,
        npm_node_execpath: process.execPath,
        npm_execpath: npmCli,
        npm_config_allow_scripts: "outer-poison",
        npm_config_offline: "true",
        AUTHORBOT_WINDOWS_NPM_MARKER: marker,
      },
      "win32",
    );

    await lockfile.relock(repo);

    const invocation = JSON.parse(await readFile(marker, "utf8")) as {
      args: string[];
      poison?: string;
      offline?: string;
    };
    expect(invocation.args).toEqual([
      "install",
      "--package-lock-only",
      "--package-lock=true",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    expect(invocation.poison).toBeUndefined();
    expect(invocation.offline).toBe("true");
  });

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
if [ "$npm_config_offline" != "true" ] ||
   [ "$npm_config_cache" != "/intentional/npm-cache" ] ||
   [ "$npm_config_registry" != "https://registry.example.test/" ] ||
   [ "$npm_config_userconfig" != "/intentional/npmrc" ] ||
   [ "$npm_config__authToken" != "intentional-auth" ]; then
  printf '%s\n' 'intentional npm config was stripped' >&2
  exit 27
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
      const intentionalConfig = {
        npm_config_offline: "true",
        npm_config_cache: "/intentional/npm-cache",
        npm_config_registry: "https://registry.example.test/",
        npm_config_userconfig: "/intentional/npmrc",
        npm_config__authToken: "intentional-auth",
      };
      const previousIntentional = new Map(
        Object.keys(intentionalConfig).map((key) => [key, process.env[key]]),
      );
      process.env["PATH"] = `${bin}${path.delimiter}${previousPath ?? ""}`;
      process.env["AUTHORBOT_NODE_PORTS_SENTINEL"] = "ordinary env survives";
      process.env["npm_config_allow_scripts"] = "poison-from-outer-npx";
      Object.assign(process.env, intentionalConfig);

      let caught: unknown;
      try {
        await nodeLockfile.relock(repo);
      } catch (error) {
        caught = error;
      } finally {
        restoreEnvironment("PATH", previousPath);
        restoreEnvironment("AUTHORBOT_NODE_PORTS_SENTINEL", previousSentinel);
        restoreEnvironment("npm_config_allow_scripts", previousPoison);
        for (const [key, value] of previousIntentional) {
          restoreEnvironment(key, value);
        }
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

describe("npm release resolution", () => {
  it("uses npm in the book repository with offline, cache, and custom-registry settings intact", async () => {
    const repo = await tempDirectory();
    const env = {
      npm_config_offline: "true",
      npm_config_cache: "D:\\npm-cache",
      npm_config_registry: "https://registry.example.test/",
      npm_config_userconfig: "D:\\author\\.npmrc",
      npm_config__authToken: "registry-token",
    };
    const calls: {
      file: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      platform: NodeJS.Platform;
    }[] = [];
    const releases = createNpmReleases(
      env,
      "win32",
      async (file, args, cwd, receivedEnv, platform) => {
        calls.push({ file, args, cwd, env: receivedEnv, platform });
        return {
          stdout: JSON.stringify(["1.0.0", "1.1.0"]),
          stderr: "",
        };
      },
    );

    await expect(releases.listVersions("@authorbot/cli", repo)).resolves.toEqual([
      "1.0.0",
      "1.1.0",
    ]);
    expect(calls).toEqual([
      {
        file: "npm",
        args: ["view", "@authorbot/cli", "versions", "--json"],
        cwd: repo,
        env,
        platform: "win32",
      },
    ]);
  });

  it("fails closed when npm does not return version metadata", async () => {
    const releases = createNpmReleases(
      {},
      "linux",
      async () => ({ stdout: "not-json", stderr: "" }),
    );
    await expect(
      releases.listVersions("@authorbot/cli", await tempDirectory()),
    ).rejects.toThrow(/npm returned invalid release metadata/);
  });
});

describe("node upgrade bootstrap", () => {
  it("runs an exact book-local target without invoking npm", async () => {
    const repo = await tempDirectory();
    const packageRoot = path.join(repo, "node_modules", "@authorbot", "cli");
    const dist = path.join(packageRoot, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@authorbot/cli",
          version: "9.8.7",
          type: "module",
          bin: { authorbot: "./dist/bin.mjs" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(dist, "bin.mjs"),
      `import { writeFileSync } from "node:fs";
writeFileSync(process.env.AUTHORBOT_BOOTSTRAP_TEST_MARKER, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  requested: process.env.AUTHORBOT_UPGRADE_BOOTSTRAP_VERSION
}));
process.exitCode = 11;
`,
    );
    const marker = path.join(repo, "child.json");
    const bootstrap = await createNodeUpgradeBootstrap({
      ...process.env,
      AUTHORBOT_BOOTSTRAP_TEST_MARKER: marker,
      npm_config_offline: "true",
      npm_config_cache: path.join(repo, "offline-cache"),
      PATH: "",
    });

    expect(
      (
        await bootstrap.handoff({
          targetVersion: "9.8.7",
          repoPath: repo,
          cwd: repo,
          args: [".", "--check", "--json"],
        })
      ).exitCode,
    ).toBe(11);

    const child = JSON.parse(await readFile(marker, "utf8")) as {
      args: string[];
      cwd: string;
      requested: string;
    };
    expect(child).toEqual({
      args: ["upgrade", ".", "--check", "--json"],
      cwd: repo,
      requested: "9.8.7",
    });
  });

  it("rejects a real pre-spawn failure so the caller can make the unchanged guarantee", async () => {
    const repo = await tempDirectory();
    const packageRoot = path.join(repo, "node_modules", "@authorbot", "cli");
    const dist = path.join(packageRoot, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@authorbot/cli",
        version: "9.8.7",
        type: "module",
        bin: { authorbot: "./dist/bin.mjs" },
      }),
    );
    await writeFile(path.join(dist, "bin.mjs"), "process.exitCode = 0;\n");
    const bootstrap = await createNodeUpgradeBootstrap(process.env);

    await expect(
      bootstrap.handoff({
        targetVersion: "9.8.7",
        repoPath: repo,
        cwd: path.join(repo, "does-not-exist"),
        args: [".", "--to", "9.8.7"],
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")(
    "reports signal exits as post-start uncertainty instead of a clean-repository claim",
    async () => {
      const repo = await tempDirectory();
      const packageRoot = path.join(repo, "node_modules", "@authorbot", "cli");
      const dist = path.join(packageRoot, "dist");
      await mkdir(dist, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@authorbot/cli",
          version: "9.8.7",
          type: "module",
          bin: { authorbot: "./dist/bin.mjs" },
        }),
      );
      await writeFile(
        path.join(dist, "bin.mjs"),
        'process.kill(process.pid, "SIGTERM");\n',
      );
      const bootstrap = await createNodeUpgradeBootstrap(process.env);

      const result = await bootstrap.handoff({
        targetVersion: "9.8.7",
        repoPath: repo,
        cwd: repo,
        args: [".", "--to", "9.8.7"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.warning).toContain("after execution began");
      expect(result.warning).toContain("may have changed the repository");
      expect(result.warning).not.toContain("repository was not changed");
    },
  );

  it(
    "acquires an exact target from npm's configured offline cache under simulated Windows",
    async () => {
      const repo = await tempDirectory();
      const fakeBin = path.join(repo, "fake-bin");
      await mkdir(fakeBin);
      const npmCli = path.join(fakeBin, "npm-cli.cjs");
      const npmMarker = path.join(repo, "npm.json");
      const childMarker = path.join(repo, "child.json");
      await writeFile(
        npmCli,
        `const fs = require("node:fs");
const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = manifest.dependencies["@authorbot/cli"];
fs.writeFileSync(process.env.AUTHORBOT_BOOTSTRAP_NPM_MARKER, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  poison: process.env.npm_config_allow_scripts,
  offline: process.env.npm_config_offline,
  cache: process.env.npm_config_cache,
  registry: process.env.npm_config_registry,
  userconfig: process.env.npm_config_userconfig,
  auth: process.env.npm_config__authToken
}));
const root = path.join(process.cwd(), "node_modules", "@authorbot", "cli");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
  name: "@authorbot/cli",
  version,
  type: "module",
  bin: { authorbot: "./dist/bin.mjs" }
}));
fs.writeFileSync(path.join(root, "dist", "bin.mjs"), [
  'import { writeFileSync } from "node:fs";',
  'writeFileSync(process.env.AUTHORBOT_BOOTSTRAP_CHILD_MARKER, JSON.stringify({',
  '  args: process.argv.slice(2),',
  '  cwd: process.cwd(),',
  '  requested: process.env.AUTHORBOT_UPGRADE_BOOTSTRAP_VERSION',
  '}));',
  'process.exitCode = 0;'
].join("\\n"));
`,
      );

      const staleRoot = path.join(repo, "node_modules", "@authorbot", "cli");
      await mkdir(path.join(staleRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(staleRoot, "package.json"),
        JSON.stringify({
          name: "@authorbot/cli",
          version: "0.1.29",
          bin: { authorbot: "./dist/bin.js" },
        }),
      );
      await writeFile(path.join(staleRoot, "dist", "bin.js"), "process.exitCode = 99;\n");

      const bootstrap = await createNodeUpgradeBootstrap(
        {
          ...process.env,
          npm_node_execpath: process.execPath,
          npm_execpath: npmCli,
          npm_config_allow_scripts: "poison-from-outer-npx",
          npm_config_offline: "true",
          npm_config_cache: "/intentional/bootstrap-cache",
          npm_config_registry: "https://registry.example.test/",
          npm_config_userconfig: "/intentional/bootstrap-npmrc",
          npm_config__authToken: "bootstrap-auth",
          AUTHORBOT_BOOTSTRAP_NPM_MARKER: npmMarker,
          AUTHORBOT_BOOTSTRAP_CHILD_MARKER: childMarker,
        },
        async () => {
          throw new Error("simulated cleanup denial");
        },
        "win32",
      );
      const result = await bootstrap.handoff({
        targetVersion: "0.1.34",
        repoPath: repo,
        cwd: repo,
        args: [".", "--to", "0.1.34"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.warning).toContain("temporary bootstrap cleanup failed");
      expect(result.warning).toContain("simulated cleanup denial");
      expect(result.warning).toContain("exit status is preserved");

      const npm = JSON.parse(await readFile(npmMarker, "utf8")) as {
        args: string[];
        cwd: string;
        poison?: string;
        offline?: string;
        cache?: string;
        registry?: string;
        userconfig?: string;
        auth?: string;
      };
      tempDirs.push(npm.cwd);
      expect(npm.args).toEqual([
        "install",
        "--package-lock=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ]);
      expect(npm.cwd).toContain("authorbot-cli-bootstrap-");
      expect(npm.poison).toBeUndefined();
      expect(npm).toMatchObject({
        offline: "true",
        cache: "/intentional/bootstrap-cache",
        registry: "https://registry.example.test/",
        userconfig: "/intentional/bootstrap-npmrc",
        auth: "bootstrap-auth",
      });

      const child = JSON.parse(await readFile(childMarker, "utf8")) as {
        args: string[];
        cwd: string;
        requested: string;
      };
      expect(child).toEqual({
        args: ["upgrade", ".", "--to", "0.1.34"],
        cwd: repo,
        requested: "0.1.34",
      });
      const stale = JSON.parse(
        await readFile(path.join(staleRoot, "package.json"), "utf8"),
      ) as { version: string };
      expect(stale.version).toBe("0.1.29");
    },
  );
});

describe("Windows npx Wrangler execution", () => {
  it("runs migrations and deploy through npx-cli.js without a shell", async () => {
    const repo = await tempDirectory();
    const npmCli = path.join(repo, "npm-cli.cjs");
    const npxCli = path.join(repo, "npx-cli.cjs");
    const marker = path.join(repo, "npx-calls.json");
    await writeFile(npmCli, "throw new Error('npm entry point should not run');\n");
    await writeFile(
      npxCli,
      `const fs = require("node:fs");
const calls = fs.existsSync(process.env.AUTHORBOT_WINDOWS_NPX_MARKER)
  ? JSON.parse(fs.readFileSync(process.env.AUTHORBOT_WINDOWS_NPX_MARKER, "utf8"))
  : [];
const args = process.argv.slice(2);
calls.push(args);
fs.writeFileSync(process.env.AUTHORBOT_WINDOWS_NPX_MARKER, JSON.stringify(calls));
if (args.includes("deploy")) {
  console.log("https://windows-book.example.workers.dev");
} else {
  process.stderr.write("0012_windows_test.sql\\n");
}
`,
    );
    const wrangler = createWranglerCli(
      {
        ...process.env,
        npm_node_execpath: process.execPath,
        npm_execpath: npmCli,
        AUTHORBOT_WINDOWS_NPX_MARKER: marker,
      },
      "win32",
    );

    // The adapter's responsibility is shell-free launcher selection and
    // discrete argv. Assert those through a durable child-process side effect;
    // Wrangler output parsing is unchanged by the adapter.
    await wrangler.applyD1Migrations(repo, "book db & still one arg");
    await wrangler.deploy(repo);
    const calls = JSON.parse(await readFile(marker, "utf8")) as string[][];
    expect(calls).toEqual([
      [
        "--no-install",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "book db & still one arg",
        "--remote",
      ],
      ["--no-install", "wrangler", "deploy"],
    ]);
  });
});
