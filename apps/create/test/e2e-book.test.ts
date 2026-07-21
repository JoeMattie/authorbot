/**
 * End-to-end (Phase 6 contract §6): runs the `book` stage **for real** in a
 * temporary directory and asserts the output passes `authorbot validate` and
 * builds.
 *
 * Real filesystem, real `git`, real toolchain binary. The only fakes are the
 * prompter (there is no terminal) and the browser/HTTP ports, which this stage
 * never uses. That is deliberate: the previous suites prove the wizard's logic
 * against fakes, and this one proves the fakes were not lying about the shape
 * of the world.
 *
 * The claim being tested is exit criterion 1 - an author gets a validated book
 * "without writing a single line of frontmatter, YAML, or Markdown" - and
 * criterion 8: a chapterless book validates, builds, and renders a welcoming
 * empty state.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  CryptoRandom,
  NodeFileSystem,
  NodeLoopbackServerFactory,
  SystemClock,
} from "../src/runtime/node-ports.js";
import { NodeProcessRunner } from "../src/runtime/process.js";
import { CollectingOutput, FakeBrowser, FakeHttpClient, ScriptedPrompter } from "./fakes.js";

const run = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cliBin = path.join(repoRoot, "apps/cli/dist/bin.js");

let workspace: string;
let bookDir: string;

/**
 * `authorbot` is resolved from `<book>/node_modules/.bin` (ADR-0022: a book
 * runs the toolchain it pins). Linking the workspace's built binary there is
 * what an author's `npm install` would have produced, and it means this test
 * exercises the same resolution path a real run uses.
 */
async function linkToolchain(directory: string): Promise<void> {
  const binDir = path.join(directory, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  await symlink(cliBin, path.join(binDir, "authorbot"));
}

/**
 * The real runner, minus the one command that would reach the network.
 *
 * `book` installs the toolchain its package.json pins, which is right in a
 * real book and wrong here twice over: `linkToolchain` has already put the
 * binary in place, and a suite that shells out to the registry stops being a
 * test of this repository and starts being a test of npm's availability. It
 * took this file from 7.8s to 26s and made an npm outage a red build.
 *
 * Everything else - git, the toolchain binary itself - runs for real, which is
 * the point of an end-to-end test. Only the install is answered locally, and
 * the lockfile it would have produced is written here so the assertions about
 * a committed lockfile still mean something.
 */
class OfflineInstallRunner extends NodeProcessRunner {
  readonly installs: string[] = [];

  override async run(
    command: string,
    args: readonly string[],
    options?: Parameters<NodeProcessRunner["run"]>[2],
  ): ReturnType<NodeProcessRunner["run"]> {
    if (command === "npm" && args[0] === "install") {
      const cwd = options?.cwd ?? process.cwd();
      this.installs.push(cwd);
      await writeFile(
        path.join(cwd, "package-lock.json"),
        `${JSON.stringify({ name: "book", lockfileVersion: 3, requires: true, packages: {} }, null, 2)}\n`,
        "utf8",
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    return super.run(command, args, options);
  }
}

const toolchainBuilt = existsSync(cliBin);

describe.skipIf(!toolchainBuilt)("a real book on a real disk", () => {
  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "create-authorbot-e2e-"));
    bookDir = path.join(workspace, "the-hollow-creek-anomaly");
    await mkdir(bookDir, { recursive: true });
    await linkToolchain(bookDir);

    const out = new CollectingOutput();
    const code = await runCli(["book", "--dir", bookDir], {
      runner: new OfflineInstallRunner({
        ...process.env,
        // Isolate from the developer's own Git identity and config, so the
        // commit works the same on a laptop and in CI.
        GIT_AUTHOR_NAME: "Authorbot Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Authorbot Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      }),
      prompter: new ScriptedPrompter({
        "book.title": "The Hollow Creek Anomaly",
        "book.slug": "hollow-creek-anomaly",
        "book.visibility": "private",
        // No network, no GitHub account, no repository. A local book is a
        // real book.
        "book.createRemote": false,
      }),
      fs: new NodeFileSystem(),
      http: new FakeHttpClient(),
      browser: new FakeBrowser(),
      loopback: new NodeLoopbackServerFactory(),
      clock: new SystemClock(),
      random: new CryptoRandom(),
      env: {
        cwd: workspace,
        env: { ...process.env, NO_COLOR: "1" },
        columns: 80,
        isTty: false,
        nodeVersion: process.version,
        invocation: "create-authorbot",
      },
      out,
    });

    if (code !== 0) {
      throw new Error(`the book stage failed:\n${out.all()}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes `authorbot validate`", async () => {
    const { stdout } = await run(process.execPath, [cliBin, "validate", "."], { cwd: bookDir });
    expect(stdout).toContain("valid");
    expect(stdout).not.toContain("invalid");
  }, 60_000);

  it("builds a site", async () => {
    const outDir = path.join(workspace, "site");
    await run(process.execPath, [cliBin, "build", ".", "--out", outDir], { cwd: bookDir });
    const entries = await readdir(outDir);
    expect(entries).toContain("index.html");
    expect(entries).toContain("authorbot-build.json");
  }, 120_000);

  it("renders a welcoming empty state rather than a broken index", async () => {
    const outDir = path.join(workspace, "site-empty");
    await run(process.execPath, [cliBin, "build", ".", "--out", outDir], { cwd: bookDir });
    const index = await readFile(path.join(outDir, "index.html"), "utf8");
    expect(index).toContain("The Hollow Creek Anomaly");
    expect(index.toLowerCase()).toContain("no chapters");
  }, 120_000);

  it("wrote a real UUIDv7 that the schema accepts", async () => {
    const bookYml = await readFile(path.join(bookDir, "book.yml"), "utf8");
    const id = /^id:\s*(\S+)$/m.exec(bookYml)?.[1] ?? "";
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("contains no chapters and no prose the author did not write", async () => {
    const chapters = await readdir(path.join(bookDir, "chapters"));
    expect(chapters.filter((name) => name.endsWith(".md"))).toEqual([]);
    const characters = await readdir(path.join(bookDir, "story/characters"));
    expect(characters.filter((name) => name.endsWith(".md"))).toEqual([]);
  });

  it("made a git repository with one commit and a clean tree", async () => {
    const { stdout: log } = await run("git", ["log", "--oneline"], { cwd: bookDir });
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(log).toContain("The Hollow Creek Anomaly");

    const { stdout: status } = await run("git", ["status", "--porcelain"], { cwd: bookDir });
    // node_modules and the journal are gitignored, so a fresh book is clean.
    expect(status.trim()).toBe("");
  }, 60_000);

  it("keeps the setup journal out of Git and free of secrets", async () => {
    const journal = await readFile(path.join(bookDir, ".authorbot-setup.json"), "utf8");
    const parsed = JSON.parse(journal) as { secretsSet: string[]; stages: Record<string, unknown> };
    expect(parsed.secretsSet).toEqual([]);
    const { stdout } = await run("git", ["check-ignore", ".authorbot-setup.json"], {
      cwd: bookDir,
    });
    expect(stdout.trim()).toBe(".authorbot-setup.json");
  }, 60_000);

  it("is re-runnable: a second `book` run changes nothing", async () => {
    const { stdout: before } = await run("git", ["rev-parse", "HEAD"], { cwd: bookDir });
    const out = new CollectingOutput();
    const code = await runCli(["book", "--dir", bookDir], {
      runner: new OfflineInstallRunner({
        ...process.env,
        GIT_AUTHOR_NAME: "Authorbot Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Authorbot Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      }),
      prompter: new ScriptedPrompter({
        "book.title": "The Hollow Creek Anomaly",
        "book.slug": "hollow-creek-anomaly",
        "book.visibility": "private",
        "book.createRemote": false,
      }),
      fs: new NodeFileSystem(),
      http: new FakeHttpClient(),
      browser: new FakeBrowser(),
      loopback: new NodeLoopbackServerFactory(),
      clock: new SystemClock(),
      random: new CryptoRandom(),
      env: {
        cwd: workspace,
        env: { ...process.env, NO_COLOR: "1" },
        columns: 80,
        isTty: false,
        nodeVersion: process.version,
        invocation: "create-authorbot",
      },
      out,
    });

    expect(code).toBe(0);
    const { stdout: after } = await run("git", ["rev-parse", "HEAD"], { cwd: bookDir });
    // No second commit, and no prompt to overwrite the wizard's own files.
    expect(after).toBe(before);
    expect(out.all()).not.toMatch(/already exists and is different/);
  }, 120_000);

  it("keeps the book's id stable across a re-run", async () => {
    const bookYml = await readFile(path.join(bookDir, "book.yml"), "utf8");
    const id = /^id:\s*(\S+)$/m.exec(bookYml)?.[1] ?? "";
    const journal = JSON.parse(
      await readFile(path.join(bookDir, ".authorbot-setup.json"), "utf8"),
    ) as { book?: { id?: string } };
    // Contract §3.2: ids are permanent. A re-run that minted a fresh one would
    // orphan every record that referred to the old one.
    expect(journal.book?.id).toBe(id);
  });
});
