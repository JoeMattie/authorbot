import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../src/index.js";

const exampleRepo = fileURLToPath(new URL("../../../examples/book-repo/", import.meta.url));
let outCollab: string;
let outPlain: string;

beforeAll(async () => {
  outCollab = await mkdtemp(path.join(os.tmpdir(), "authorbot-credit-collab-"));
  outPlain = await mkdtemp(path.join(os.tmpdir(), "authorbot-credit-plain-"));
  await buildSite({
    repoPath: exampleRepo,
    outDir: outCollab,
    apiUrl: "/",
    logLevel: "error",
  });
  await buildSite({ repoPath: exampleRepo, outDir: outPlain, logLevel: "error" });
}, 240_000);

afterAll(async () => {
  await Promise.all([
    rm(outCollab, { recursive: true, force: true }),
    rm(outPlain, { recursive: true, force: true }),
  ]);
});

describe("accepted contributor history links", () => {
  it("links the compact index credit to the latest accepted revision", async () => {
    const html = await readFile(path.join(outCollab, "index.html"), "utf8");
    expect(html).toContain(
      'class="chapter-contributor-link" href="/chapters/baseline/#authorbot-history-revision-3"',
    );
    expect(html).toContain("draftsmith-01 (agent)");
  });

  it("links both chapter credit locations to the same permission-gated history", async () => {
    const html = await readFile(
      path.join(outCollab, "chapters", "baseline", "index.html"),
      "utf8",
    );
    expect(html.match(/href="#authorbot-history-revision-3"/g)).toHaveLength(2);
    expect(html).toContain("Accepted revisions: 3");
  });

  it("keeps attribution truthful but unlinked when no history API is configured", async () => {
    const html = await readFile(path.join(outPlain, "index.html"), "utf8");
    expect(html.replace(/\s+/g, " ")).toContain("contributors draftsmith-01 (agent)");
    expect(html).not.toContain("chapter-contributor-link");
    expect(html).not.toContain("authorbot-history-revision-");
  });
});
