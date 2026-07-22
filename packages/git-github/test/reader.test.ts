/**
 * Tests for `GitHubBookRepoReader` (Phase 5 contract §3).
 *
 * Everything runs against the in-process fake GitHub, seeded from the real
 * `examples/book-repo` on disk - the same fixture the CLI validates and the
 * local reader projects - so "snapshot fidelity" means fidelity to content
 * that has to satisfy `@authorbot/schemas` for other suites too, not to a
 * fixture invented to fit this reader.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotationSchema,
  chapterFrontmatterSchema,
  replySchema,
} from "@authorbot/schemas";
import { beforeAll, describe, expect, it } from "vitest";
import {
  GitHubAppAuth,
  type GitHubAppCredentials,
  type SigningKey,
} from "../src/app-auth.js";
import {
  GitHubBookRepoReader,
  GitHubReadError,
  isContainedRepoPath,
  isSnapshotPath,
  MAX_BLOB_CONCURRENCY,
  stripFrontmatter,
  TruncatedTreeError,
  type BookRepoReader,
} from "../src/reader.js";
import { createFakeGitHub, type FakeGitHub } from "../src/testing/index.js";

const EXAMPLE_REPO = fileURLToPath(new URL("../../../examples/book-repo", import.meta.url));

/** Read the example book repository into the path → content map the fake seeds from. */
function readExampleRepo(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(EXAMPLE_REPO, path).split(sep).join("/")] = readFileSync(path, "utf8");
    }
  };
  walk(EXAMPLE_REPO);
  return files;
}

let exampleFiles: Record<string, string>;

beforeAll(() => {
  exampleFiles = readExampleRepo();
});

async function seededFake(
  extra: Record<string, string> = {},
  options: Parameters<typeof createFakeGitHub>[0] = {},
): Promise<FakeGitHub> {
  return createFakeGitHub({
    requireAuth: false,
    files: { ...exampleFiles, ...extra },
    ...options,
  });
}

function readerFor(fake: FakeGitHub, options: { maxConcurrency?: number; maxFiles?: number } = {}) {
  return new GitHubBookRepoReader({
    owner: fake.owner,
    repo: fake.repo,
    branch: fake.defaultBranch,
    fetch: fake.fetch,
    ...options,
  });
}

describe("snapshot fidelity", () => {
  it("round trips the example book repository", async () => {
    const fake = await seededFake();
    const reader = readerFor(fake);

    const snapshot = await reader.readSnapshot();

    expect(snapshot.chapters.map((chapter) => chapter.path)).toEqual([
      "chapters/001-baseline.md",
      "chapters/002-null-results.md",
      "chapters/003-the-window.md",
    ]);
    expect(snapshot.annotations).toHaveLength(1);
    expect(snapshot.replies).toHaveLength(1);
    expect(snapshot.decisions).toHaveLength(1);
    expect(snapshot.workItems).toHaveLength(1);
  });

  it("records the commit sha the snapshot was taken at", async () => {
    const fake = await seededFake();
    const snapshot = await readerFor(fake).readSnapshot();

    expect(snapshot.headCommit).toBe(fake.state.getRef(fake.defaultBranch));
    expect(snapshot.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.treeSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("produces content parsing cleanly through @authorbot/schemas", async () => {
    const fake = await seededFake();
    const snapshot = await readerFor(fake).readSnapshot();

    for (const chapter of snapshot.chapters) {
      expect(chapterFrontmatterSchema.safeParse(chapter.frontmatter).success).toBe(true);
      expect(chapter.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    for (const annotation of snapshot.annotations) {
      expect(annotationSchema.safeParse(annotation.record).success).toBe(true);
    }
    for (const reply of snapshot.replies) {
      expect(replySchema.safeParse(reply.record).success).toBe(true);
    }
  });

  it("hashes chapter content the way sha256sum does over the file bytes", async () => {
    const fake = await seededFake();
    const snapshot = await readerFor(fake).readSnapshot();

    const source = exampleFiles["chapters/001-baseline.md"] as string;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

    expect(snapshot.chapters[0]?.contentHash).toBe(`sha256:${hex}`);
  });

  it("extracts valid block ids in document order", async () => {
    const fake = await seededFake();
    const snapshot = await readerFor(fake).readSnapshot();

    const first = snapshot.chapters[0];
    expect(first?.blockIds.length).toBeGreaterThan(0);
    // Every id must actually occur in the source, in the order reported.
    const source = exampleFiles["chapters/001-baseline.md"] as string;
    let cursor = -1;
    for (const id of first?.blockIds ?? []) {
      const at = source.indexOf(id, cursor + 1);
      expect(at, `block id ${id} not found after position ${cursor}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("strips frontmatter from annotation and reply bodies", async () => {
    const fake = await seededFake();
    const snapshot = await readerFor(fake).readSnapshot();

    const body = snapshot.annotations[0]?.body ?? "";
    expect(body).not.toContain("---");
    expect(body.length).toBeGreaterThan(0);
    expect(body).toBe(body.trim());
  });

  it("exposes every matched file so later projections need no second read", async () => {
    const fake = await seededFake();
    const snapshot = await readerFor(fake).readSnapshot();

    expect(snapshot.files.get("book.yml")).toBe(exampleFiles["book.yml"]);
    expect(snapshot.files.get("story/outline.yml")).toBe(exampleFiles["story/outline.yml"]);
  });

  it("reflects a later commit on a second read through the same instance", async () => {
    const fake = await seededFake();
    const reader = readerFor(fake);
    const before = await reader.readSnapshot();

    await fake.externalCommit({
      "chapters/004-new.md": (exampleFiles["chapters/001-baseline.md"] as string).replace(
        /^title: .*/m,
        "title: Fourth",
      ),
    });
    const after = await reader.readSnapshot();

    // The per-commit tree cache must not pin the reader to a stale head.
    expect(after.headCommit).not.toBe(before.headCommit);
    expect(after.chapters).toHaveLength(4);
  });
});

describe("path containment", () => {
  const refused = [
    ["absolute POSIX path", "/etc/passwd"],
    ["absolute path into the repo", "/srv/book/chapters/001-baseline.md"],
    ["parent traversal", "../secrets.env"],
    ["parent traversal mid-path", "chapters/../../secrets.env"],
    // The case that defeats a naive `startsWith(root)` check on a filesystem:
    // `/srv/book` + this normalizes to the SIBLING `/srv/book-secrets`.
    ["sibling-prefix escape", "../book-secrets/creds.env"],
    ["backslash traversal", "chapters\\..\\..\\secrets.env"],
    ["windows drive", "C:\\secrets.env"],
    ["UNC path", "\\\\server\\share\\secrets.env"],
    ["empty path", ""],
    ["bare parent", ".."],
  ] as const;

  it.each(refused)("refuses a %s", (_label, path) => {
    expect(isContainedRepoPath(path)).toBe(false);
  });

  it("accepts ordinary repo-relative paths", () => {
    expect(isContainedRepoPath("book.yml")).toBe(true);
    expect(isContainedRepoPath("chapters/001-baseline.md")).toBe(true);
    expect(isContainedRepoPath(".authorbot/annotations/x/annotation.md")).toBe(true);
    // A file whose NAME merely starts with dots is not traversal.
    expect(isContainedRepoPath("chapters/..hidden.md")).toBe(true);
  });

  it.each(refused)("makes no request for a %s", async (_label, path) => {
    const fake = await seededFake();
    const reader = readerFor(fake);
    const before = fake.requests.length;

    await expect(reader.readTextFile(path)).resolves.toBeNull();

    // Refused BEFORE any request - the guard cannot be probed for existence
    // or timing, and a traversal never reaches GitHub.
    expect(fake.requests.length).toBe(before);
  });
});

describe("readTextFile", () => {
  it("returns the committed text", async () => {
    const fake = await seededFake();
    const reader = readerFor(fake);

    await expect(reader.readTextFile("chapters/001-baseline.md")).resolves.toBe(
      exampleFiles["chapters/001-baseline.md"],
    );
  });

  it("returns null for a path that does not exist", async () => {
    const fake = await seededFake();
    await expect(readerFor(fake).readTextFile("chapters/nope.md")).resolves.toBeNull();
  });

  it("normalizes '.' segments and backslash separators", async () => {
    const fake = await seededFake();
    const reader = readerFor(fake);
    await expect(reader.readTextFile("./chapters/001-baseline.md")).resolves.toBe(
      exampleFiles["chapters/001-baseline.md"],
    );
    await expect(reader.readTextFile("chapters\\001-baseline.md")).resolves.toBe(
      exampleFiles["chapters/001-baseline.md"],
    );
  });

  it("reuses the tree of an unchanged head instead of re-reading it", async () => {
    const fake = await seededFake();
    const reader = readerFor(fake);

    await reader.readTextFile("chapters/001-baseline.md");
    const treeReads = fake.countRequests("GET", (path) => path.includes("/git/trees/"));
    await reader.readTextFile("chapters/002-null-results.md");

    expect(fake.countRequests("GET", (path) => path.includes("/git/trees/"))).toBe(treeReads);
    // The ref is still re-read, so a moved head is never missed.
    expect(fake.countRequests("GET", (path) => path.includes("/git/ref/heads/"))).toBe(2);
  });

  it("reports a missing branch as a typed error", async () => {
    const fake = await seededFake();
    const reader = new GitHubBookRepoReader({
      owner: fake.owner,
      repo: fake.repo,
      branch: "does-not-exist",
      fetch: fake.fetch,
    });

    await expect(reader.readTextFile("book.yml")).rejects.toMatchObject({ code: "missing-ref" });
  });
});

describe("bounded file history", () => {
  it("lists only commits that changed the path and pages newest first", async () => {
    const fake = await seededFake();
    const path = "chapters/001-baseline.md";
    const original = fake.state.getRef(fake.defaultBranch) as string;
    const secondText = `${exampleFiles[path]}\nSecond version.\n`;
    const second = await fake.state.commitFiles({
      branch: fake.defaultBranch,
      files: { [path]: secondText },
      message: "Revise baseline once",
    });
    await fake.state.commitFiles({
      branch: fake.defaultBranch,
      files: { "README.md": "Unrelated.\n" },
      message: "Unrelated change",
    });
    const thirdText = `${secondText}\nThird version.\n`;
    const third = await fake.state.commitFiles({
      branch: fake.defaultBranch,
      files: { [path]: thirdText },
      message: "Revise baseline twice",
    });
    const reader = readerFor(fake);

    const first = await reader.listFileHistory(path, { limit: 2 });
    expect(first).toMatchObject({ page: 1, hasMore: true });
    expect(first.entries.map((entry) => entry.commitSha)).toEqual([third, second]);
    expect(first.entries.map((entry) => entry.message)).toEqual([
      "Revise baseline twice",
      "Revise baseline once",
    ]);

    const next = await reader.listFileHistory(path, { page: 2, limit: 2 });
    expect(next.entries.map((entry) => entry.commitSha)).toEqual([original]);
    expect(next.hasMore).toBe(false);
    expect(fake.countRequests("GET", (requestPath) => requestPath.endsWith("/commits"))).toBe(2);
  });

  it("reads one selected historical snapshot through the immutable tree cache", async () => {
    const fake = await seededFake();
    const path = "chapters/001-baseline.md";
    const original = fake.state.getRef(fake.defaultBranch) as string;
    const current = `${exampleFiles[path]}\nA later ending.\n`;
    const latest = await fake.state.commitFiles({
      branch: fake.defaultBranch,
      files: { [path]: current },
      message: "Revise baseline",
    });
    const reader = readerFor(fake);

    await expect(reader.readTextFileAtCommit(path, original)).resolves.toBe(exampleFiles[path]);
    await expect(reader.readTextFileAtCommit(path, latest)).resolves.toBe(current);
    const treeReads = fake.countRequests("GET", (requestPath) => requestPath.includes("/git/trees/"));
    await expect(reader.readTextFileAtCommit(path, original)).resolves.toBe(exampleFiles[path]);
    expect(fake.countRequests("GET", (requestPath) => requestPath.includes("/git/trees/"))).toBe(
      treeReads,
    );
  });

  it("rejects traversal and non-SHA snapshot selectors before making a request", async () => {
    const fake = await seededFake();
    const reader = readerFor(fake);
    const before = fake.requests.length;

    await expect(reader.listFileHistory("../secret.md")).resolves.toEqual({
      entries: [],
      page: 1,
      hasMore: false,
    });
    await expect(reader.readTextFileAtCommit("book.yml", "main")).resolves.toBeNull();
    expect(fake.requests.length).toBe(before);
  });
});

describe("truncated trees", () => {
  it("throws rather than returning a partial snapshot", async () => {
    const fake = await seededFake();
    fake.injectFault("truncatedTree", { keepEntries: 2 });
    const reader = readerFor(fake);

    await expect(reader.readSnapshot()).rejects.toThrowError(TruncatedTreeError);
    fake.assertAllFaultsFired();
  });

  it("carries the tree sha and the entry count it refused to trust", async () => {
    const fake = await seededFake();
    fake.injectFault("truncatedTree", { keepEntries: 3 });

    let error: unknown;
    try {
      await readerFor(fake).readSnapshot();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TruncatedTreeError);
    const truncated = error as TruncatedTreeError;
    expect(truncated.code).toBe("truncated-tree");
    expect(truncated.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(truncated.returnedEntries).toBe(3);
  });

  it("fetches no blobs once it sees the truncation", async () => {
    const fake = await seededFake();
    fake.injectFault("truncatedTree", { keepEntries: 1 });

    await readerFor(fake).readSnapshot().catch(() => undefined);

    expect(fake.countRequests("GET", (path) => path.includes("/git/blobs/"))).toBe(0);
  });

  it("is a GitHubReadError, so one catch handles every read failure", async () => {
    const fake = await seededFake();
    fake.injectFault("truncatedTree", { keepEntries: 1 });
    await expect(readerFor(fake).readSnapshot()).rejects.toBeInstanceOf(GitHubReadError);
  });
});

describe("blob selection and budget", () => {
  it("matches the §3 path set and nothing else", () => {
    expect(isSnapshotPath("chapters/001-baseline.md")).toBe(true);
    expect(isSnapshotPath("book.yml")).toBe(true);
    expect(isSnapshotPath("story/characters/mara-voss.md")).toBe(true);
    expect(isSnapshotPath(".authorbot/decisions/x.yml")).toBe(true);

    expect(isSnapshotPath("README.md")).toBe(false);
    expect(isSnapshotPath("chapters/drafts/001.md")).toBe(false); // not `chapters/*.md`
    expect(isSnapshotPath("chapters/notes.txt")).toBe(false);
    expect(isSnapshotPath("bookkeeping.yml")).toBe(false);
  });

  it("fetches blobs for matching paths only", async () => {
    const fake = await seededFake({ "assets/cover.svg": "<svg/>", "LICENSE": "MIT" });
    const reader = readerFor(fake);

    const snapshot = await reader.readSnapshot();

    expect(snapshot.files.has("README.md")).toBe(false);
    expect(snapshot.files.has("assets/cover.svg")).toBe(false);
    expect(snapshot.files.has("LICENSE")).toBe(false);
    // One blob request per matched file, no more.
    expect(fake.countRequests("GET", (path) => path.includes("/git/blobs/"))).toBe(
      snapshot.files.size,
    );
  });

  it("refuses a snapshot above the file budget", async () => {
    const fake = await seededFake();
    const reader = readerFor(fake, { maxFiles: 3 });

    await expect(reader.readSnapshot()).rejects.toMatchObject({
      code: "file-budget-exceeded",
    });
    expect(fake.countRequests("GET", (path) => path.includes("/git/blobs/"))).toBe(0);
  });
});

describe("concurrency bound", () => {
  /** Wrap a fake's fetch to record peak simultaneous blob requests. */
  function instrument(fake: FakeGitHub): { fetch: typeof fake.fetch; peak: () => number } {
    let inFlight = 0;
    let peak = 0;
    const wrapped: typeof fake.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const isBlob = url.includes("/git/blobs/");
      if (isBlob) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
      }
      try {
        // Yield to the event loop so overlap is observable at all.
        await new Promise((resolve) => setTimeout(resolve, 1));
        return await fake.fetch(input, init);
      } finally {
        if (isBlob) inFlight -= 1;
      }
    };
    return { fetch: wrapped, peak: () => peak };
  }

  it("never exceeds 8 blob fetches in flight, and reaches the bound", async () => {
    const fake = await seededFake();
    const probe = instrument(fake);
    const reader = new GitHubBookRepoReader({
      owner: fake.owner,
      repo: fake.repo,
      fetch: probe.fetch,
    });

    const snapshot = await reader.readSnapshot();

    expect(snapshot.files.size).toBeGreaterThan(MAX_BLOB_CONCURRENCY);
    expect(probe.peak()).toBeLessThanOrEqual(MAX_BLOB_CONCURRENCY);
    // Asserting only the ceiling would pass for a serial reader; the bound
    // must actually be used.
    expect(probe.peak()).toBe(MAX_BLOB_CONCURRENCY);
  });

  it("honours a lower configured bound", async () => {
    const fake = await seededFake();
    const probe = instrument(fake);
    const reader = new GitHubBookRepoReader({
      owner: fake.owner,
      repo: fake.repo,
      fetch: probe.fetch,
      maxConcurrency: 2,
    });

    await reader.readSnapshot();

    expect(probe.peak()).toBe(2);
  });

  it("clamps a request for more than the contract's ceiling", async () => {
    const fake = await seededFake();
    const probe = instrument(fake);
    const reader = new GitHubBookRepoReader({
      owner: fake.owner,
      repo: fake.repo,
      fetch: probe.fetch,
      maxConcurrency: 64,
    });

    expect(reader.maxConcurrency).toBe(MAX_BLOB_CONCURRENCY);
    await reader.readSnapshot();
    expect(probe.peak()).toBeLessThanOrEqual(MAX_BLOB_CONCURRENCY);
  });
});

describe("invalid committed artifacts", () => {
  it("refuses a chapter with unparseable frontmatter", async () => {
    const fake = await seededFake({ "chapters/900-broken.md": "---\ntitle: [unclosed\n---\n\nBody\n" });

    await expect(readerFor(fake).readSnapshot()).rejects.toMatchObject({
      code: "invalid-artifact",
    });
  });

  it("refuses a chapter whose frontmatter fails the schema", async () => {
    const fake = await seededFake({ "chapters/901-bad.md": "---\ntitle: Only a title\n---\n\nBody\n" });

    await expect(readerFor(fake).readSnapshot()).rejects.toThrowError(
      /chapters\/901-bad\.md: invalid chapter frontmatter/,
    );
  });

  it("names the offending decision artifact", async () => {
    const fake = await seededFake({ ".authorbot/decisions/919f4102-bad.yml": "not: [valid\n" });

    await expect(readerFor(fake).readSnapshot()).rejects.toThrowError(
      /\.authorbot\/decisions\/919f4102-bad\.yml/,
    );
  });

  it("names the offending work-item artifact", async () => {
    const fake = await seededFake({ ".authorbot/work-items/919f4102-bad.md": "no frontmatter\n" });

    await expect(readerFor(fake).readSnapshot()).rejects.toThrowError(
      /\.authorbot\/work-items\/919f4102-bad\.md/,
    );
  });

  it("ignores a replies directory with no annotation.md beside it", async () => {
    const fake = await seededFake({
      ".authorbot/annotations/orphan/replies/019f36b1-0a40-7da6-b2af-504a917ff686.md":
        "---\nnot: an annotation\n---\n",
    });

    const snapshot = await readerFor(fake).readSnapshot();

    // Matches the local reader, which skips directories without annotation.md
    // rather than failing the whole rebuild on a stray file.
    expect(snapshot.annotations).toHaveLength(1);
    expect(snapshot.replies).toHaveLength(1);
  });
});

describe("authenticated reads", () => {
  const APP_ID = "1000001";
  const INSTALLATION_ID = "12345678";
  let privateKeyPem: string;

  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as { privateKey: SigningKey };
    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    let binary = "";
    for (const byte of new Uint8Array(der)) binary += String.fromCharCode(byte);
    const base64 = btoa(binary);
    const lines: string[] = [];
    for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
    privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  });

  function credentials(): GitHubAppCredentials {
    return { appId: APP_ID, privateKeyPem, installationId: INSTALLATION_ID };
  }

  async function authenticatedFake(): Promise<FakeGitHub> {
    return createFakeGitHub({
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      files: exampleFiles,
      // requireAuth defaults to true: every repo request needs a live token.
    });
  }

  it("reads a snapshot through a real installation token", async () => {
    const fake = await authenticatedFake();
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch });
    const reader = new GitHubBookRepoReader({
      owner: fake.owner,
      repo: fake.repo,
      fetch: auth.authorizedFetch,
    });

    const snapshot = await reader.readSnapshot();

    expect(snapshot.chapters).toHaveLength(3);
    // One token for the whole snapshot, despite 8 parallel blob fetches.
    expect(fake.issuedTokenCount()).toBe(1);
  });

  it("refreshes the token on a 401 and completes the read", async () => {
    const fake = await authenticatedFake();
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch });
    const reader = new GitHubBookRepoReader({
      owner: fake.owner,
      repo: fake.repo,
      fetch: auth.authorizedFetch,
    });

    await reader.readTextFile("book.yml");
    expect(fake.issuedTokenCount()).toBe(1);

    // The installation token is rotated out from under the reader.
    fake.revokeAllTokens();

    await expect(reader.readTextFile("chapters/001-baseline.md")).resolves.toBe(
      exampleFiles["chapters/001-baseline.md"],
    );
    expect(fake.issuedTokenCount()).toBe(2);
  });

  it("fails the read when credentials are rejected outright", async () => {
    const fake = await authenticatedFake();
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch });
    const reader = new GitHubBookRepoReader({
      owner: fake.owner,
      repo: fake.repo,
      fetch: auth.authorizedFetch,
    });
    fake.injectFault("unauthorized", { times: 4 });

    await expect(reader.readSnapshot()).rejects.toBeInstanceOf(GitHubReadError);
  });
});

describe("BookRepoReader compatibility", () => {
  it("satisfies the Phase 2 interface structurally", async () => {
    const fake = await seededFake();
    // If the shape ever drifts from apps/api's `BookRepoReader`, this stops
    // compiling - which is the whole point of rebuildProjection working
    // unchanged over GitHub.
    const reader: BookRepoReader = readerFor(fake);

    const snapshot = await reader.readSnapshot();
    expect(Object.keys(snapshot)).toEqual(
      expect.arrayContaining(["chapters", "annotations", "replies", "decisions", "workItems"]),
    );
    expect(typeof reader.readTextFile).toBe("function");
  });
});

describe("stripFrontmatter", () => {
  it("matches the local reader's behaviour", () => {
    expect(stripFrontmatter("---\ntitle: x\n---\n\nBody\n")).toBe("Body");
    expect(stripFrontmatter("---\r\ntitle: x\r\n---\r\n\r\nBody\r\n")).toBe("Body");
    expect(stripFrontmatter("No frontmatter\n")).toBe("No frontmatter");
    // An unterminated block is returned whole rather than swallowed.
    expect(stripFrontmatter("---\ntitle: x\n")).toBe("---\ntitle: x");
    expect(stripFrontmatter("---\ntitle: x\n---\n")).toBe("");
  });
});
