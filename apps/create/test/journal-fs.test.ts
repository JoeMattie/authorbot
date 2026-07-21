/**
 * The journal against a real filesystem.
 *
 * `.authorbot-setup.json` lives inside the book directory, but the first write
 * happens when the wizard marks a stage started — which is before the stage
 * that creates that directory. Pointing the wizard at a path that did not
 * exist yet therefore died with a bare ENOENT naming the wizard's own
 * bookkeeping file, and `--example-config` suggested exactly such a path
 * (`directory: ./my-book`), so following the documented example failed.
 *
 * These run against the real `NodeFileSystem` on a real temp directory on
 * purpose: an in-memory fake happily writes into a directory that does not
 * exist, so it cannot reproduce the bug this covers.
 */
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal } from "../src/journal.js";
import { NodeFileSystem } from "../src/runtime/node-ports.js";
import { SecretVault } from "../src/secrets.js";

const NOW = "2026-07-21T00:00:00.000Z";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "authorbot-journal-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function journalIn(directory: string): Promise<Journal> {
  return await Journal.open({
    fs: new NodeFileSystem(),
    vault: new SecretVault(),
    directory,
    now: NOW,
    readOnly: false,
  });
}

describe("Journal.save", () => {
  it("creates the book directory rather than failing on ENOENT", async () => {
    // Never created — the wizard is pointed at where the book *will* live.
    const directory = path.join(root, "the-causal-projector");

    const journal = await journalIn(directory);
    await journal.markStage("book", "started", NOW);

    const written = await readFile(path.join(directory, ".authorbot-setup.json"), "utf8");
    expect(JSON.parse(written).stages.book.status).toBe("started");
  });

  it("creates intermediate directories too", async () => {
    const directory = path.join(root, "books", "2026", "the-causal-projector");

    const journal = await journalIn(directory);
    await journal.markStage("book", "started", NOW);

    await expect(stat(directory)).resolves.toBeTruthy();
  });

  it("leaves an existing directory and its contents alone", async () => {
    const directory = path.join(root, "existing");
    const fs = new NodeFileSystem();
    await fs.mkdirp(directory);
    await fs.writeFile(path.join(directory, "book.yml"), "title: keep me\n");

    const journal = await journalIn(directory);
    await journal.markStage("book", "started", NOW);

    await expect(readFile(path.join(directory, "book.yml"), "utf8")).resolves.toBe(
      "title: keep me\n",
    );
  });

  it("writes nothing at all in a dry run", async () => {
    const directory = path.join(root, "never-created");

    const journal = await Journal.open({
      fs: new NodeFileSystem(),
      vault: new SecretVault(),
      directory,
      now: NOW,
      readOnly: true,
    });
    await journal.markStage("book", "started", NOW);

    // A dry run promises to change nothing — including not conjuring the
    // directory it was only ever asked to describe.
    await expect(stat(directory)).rejects.toThrow();
  });
});
