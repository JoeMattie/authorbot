/**
 * `GitHubBookRepoWriter` against the deterministic fake GitHub — the §14.2
 * sequence, its retry bound, and the property that matters most: a conflict
 * never clobbers the other writer's work. Every no-clobber assertion is made
 * **by content** at the branch head, not by status code, because a status
 * code cannot tell you whose bytes survived.
 */
import { describe, expect, it } from "vitest";
import { createFakeGitHub, type FakeGitHub } from "../src/testing/index.js";
import {
  AUTHORBOT_GIT_EMAIL,
  AUTHORBOT_GIT_NAME,
  GitHubBookRepoWriter,
  GitHubWriteError,
} from "../src/writer.js";
import { OPERATION_TRAILER } from "@authorbot/repo-coordinator/writer";
import { isGitWriteError } from "@authorbot/repo-coordinator";
import { SAMPLE_BOOK } from "./helpers.js";

const OPERATION_ID = "0190f302-7045-7b2d-9d91-95b3c8228b54";

const TRAILERS = {
  "Authorbot-Actor": "github:example-editor",
  "Authorbot-Work-Item": "0190f301-7045-7b2d-9d91-95b3c8228b54",
  "Authorbot-Base-Revision": "1",
  [OPERATION_TRAILER]: OPERATION_ID,
} as const;

interface SentRequest {
  method: string;
  pathname: string;
  body: unknown;
}

interface Harness {
  fake: FakeGitHub;
  writer: GitHubBookRepoWriter;
  /** Installation tokens minted through the writer's token seam. */
  minted: () => number;
  /** The `PATCH .../git/refs/heads/*` payloads — where `force` would hide. */
  refUpdates: () => readonly SentRequest[];
}

/**
 * A writer wired to a freshly seeded fake. The token seam is the real thing
 * end to end: it mints against the fake's token endpoint with a JWT-shaped
 * bearer, so `requireAuth` stays on and every repository call is genuinely
 * authenticated.
 */
async function harness(options: {
  files?: Record<string, string>;
  maxAttempts?: number;
  operationScanDepth?: number;
} = {}): Promise<Harness> {
  const fake = await createFakeGitHub({ files: options.files ?? SAMPLE_BOOK });
  let cached: string | null = null;
  let mints = 0;
  const installationToken = async (request?: { forceRefresh?: boolean }): Promise<string> => {
    if (request?.forceRefresh === true) cached = null;
    if (cached !== null) return cached;
    mints += 1;
    const response = await fake.fetch(
      `https://api.github.com/app/installations/${fake.installationId}/access_tokens`,
      { method: "POST", headers: { authorization: "Bearer header.payload.signature" } },
    );
    const body = (await response.json()) as { token: string };
    cached = body.token;
    return cached;
  };
  // Record what the writer actually puts on the wire. The fake's own request
  // log has no bodies, and `force: true` lives in a body — so without this a
  // forced update would slip past every status-based assertion.
  const sent: SentRequest[] = [];
  const fetchImpl = async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.clone().text();
    let body: unknown;
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    sent.push({
      method: request.method.toUpperCase(),
      pathname: new URL(request.url).pathname,
      body,
    });
    return await fake.fetch(request);
  };

  const writer = new GitHubBookRepoWriter({
    repo: fake.fullName,
    tokens: { installationToken },
    fetchImpl,
    now: () => new Date("2026-07-19T12:00:00.000Z"),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.operationScanDepth === undefined
      ? {}
      : { operationScanDepth: options.operationScanDepth }),
  });
  const refUpdates = (): readonly SentRequest[] =>
    sent.filter(
      (entry) => entry.method === "PATCH" && entry.pathname.includes("/git/refs/heads/"),
    );
  return { fake, writer, minted: () => mints, refUpdates };
}

function commitInput(overrides: Partial<Parameters<GitHubBookRepoWriter["commitFiles"]>[0]> = {}) {
  return {
    branch: "main",
    files: [{ path: "chapters/001-baseline.md", content: BUMPED }],
    message: "Apply work item 0190f301-7045-7b2d-9d91-95b3c8228b54",
    trailers: TRAILERS,
    ...overrides,
  };
}

const BUMPED = "---\nid: c1\nrevision: 2\n---\n\nBaseline prose, revised.\n";

// --------------------------------------------------------------- happy path

describe("commitFiles — the §14.2 sequence", () => {
  it("lands the file, the message and the §14.3 trailers in one commit", async () => {
    const { fake, writer } = await harness();
    const before = fake.state.getRef("main");

    const result = await writer.commitFiles(commitInput());

    expect(fake.state.getRef("main")).toBe(result.commitSha);
    expect(fake.fileAtHead("chapters/001-baseline.md")).toBe(BUMPED);

    const commit = fake.state.getCommit(result.commitSha);
    expect(commit.parents).toEqual([before]);
    expect(commit.message).toBe(
      [
        "Apply work item 0190f301-7045-7b2d-9d91-95b3c8228b54",
        "",
        "Authorbot-Actor: github:example-editor",
        "Authorbot-Work-Item: 0190f301-7045-7b2d-9d91-95b3c8228b54",
        "Authorbot-Base-Revision: 1",
        `${OPERATION_TRAILER}: ${OPERATION_ID}`,
        "",
      ].join("\n"),
    );
  });

  it("commits as the Authorbot service identity, not the acting human", async () => {
    const { fake, writer } = await harness();
    const result = await writer.commitFiles(commitInput());
    const commit = fake.state.getCommit(result.commitSha);

    // Design §14.3: the Git identity is the service; the human is credited in
    // the attribution artifacts inside the commit, never by forging a Git author.
    for (const identity of [commit.author, commit.committer]) {
      expect(identity.name).toBe(AUTHORBOT_GIT_NAME);
      expect(identity.email).toBe(AUTHORBOT_GIT_EMAIL);
    }
    expect(commit.message).toContain("Authorbot-Actor: github:example-editor");
  });

  it("issues exactly one commit per mutation and never forces the ref", async () => {
    const { fake, writer, refUpdates } = await harness();
    await writer.commitFiles(commitInput());

    expect(fake.countRequests("POST", (p) => p.endsWith("/git/commits"))).toBe(1);
    expect(refUpdates()).toHaveLength(1);
    expect(refUpdates()[0]?.body).toMatchObject({ force: false });
    expect(fake.state.history("main")).toHaveLength(2);
  });

  it("writes multiple files of one mutation into a single commit", async () => {
    const { fake, writer } = await harness();
    const result = await writer.commitFiles(
      commitInput({
        files: [
          { path: "chapters/001-baseline.md", content: BUMPED },
          { path: ".authorbot/attribution/c1.md", content: "# Attribution\n" },
          { path: ".authorbot/work-items/wi-1.md", content: "status: completed\n" },
        ],
      }),
    );
    expect(fake.state.history("main")).toHaveLength(2);
    const files = fake.state.readFiles(result.commitSha);
    expect(files[".authorbot/attribution/c1.md"]).toBe("# Attribution\n");
    expect(files[".authorbot/work-items/wi-1.md"]).toBe("status: completed\n");
    expect(files["chapters/001-baseline.md"]).toBe(BUMPED);
  });
});

// ------------------------------------------------------------- base_tree

describe("base_tree", () => {
  it("preserves every file the mutation does not mention", async () => {
    const { fake, writer } = await harness();
    const result = await writer.commitFiles(commitInput());

    // The untouched files must still *resolve* at the new head — the failure
    // mode `base_tree` guards against is a commit that quietly deletes the
    // rest of the book.
    expect(fake.state.readFile(result.commitSha, "chapters/002-null-results.md")).toBe(
      SAMPLE_BOOK["chapters/002-null-results.md"],
    );
    expect(fake.state.readFile(result.commitSha, "story/outline.yml")).toBe(
      SAMPLE_BOOK["story/outline.yml"],
    );
    expect(fake.state.readFile(result.commitSha, "book.yml")).toBe(SAMPLE_BOOK["book.yml"]);
    expect(Object.keys(fake.state.readFiles(result.commitSha)).sort()).toEqual(
      Object.keys(SAMPLE_BOOK).sort(),
    );
  });

  it("keeps the blob identity of untouched files (a true tree layer)", async () => {
    const { fake, writer } = await harness();
    const head = fake.state.getRef("main") as string;
    const beforeTree = fake.state.getCommit(head).tree;
    const untouchedBefore = fake.state.resolvePath(beforeTree, "story/outline.yml");

    const result = await writer.commitFiles(commitInput());
    const afterTree = fake.state.getCommit(result.commitSha).tree;
    const untouchedAfter = fake.state.resolvePath(afterTree, "story/outline.yml");

    expect(untouchedAfter?.sha).toBe(untouchedBefore?.sha);
    expect(afterTree).not.toBe(beforeTree);
  });
});

// ------------------------------------------------------------ moved head

describe("moved head", () => {
  it("retries after a concurrent push and lands on top of it", async () => {
    const { fake, writer } = await harness();
    // A real race: the fake commits out of band *after* the writer's ref read,
    // so the 422 comes from genuine ancestry, not a synthesized status.
    fake.injectFault("movedHead", {
      branch: "main",
      times: 1,
      files: { "chapters/002-null-results.md": "---\nid: c2\nrevision: 9\n---\n\nOther writer.\n" },
      message: "Concurrent external push",
    });

    const result = await writer.commitFiles(commitInput());

    fake.assertAllFaultsFired();
    expect(fake.state.getRef("main")).toBe(result.commitSha);
    // Both writers' work survives: ours on top, theirs preserved underneath.
    expect(fake.fileAtHead("chapters/001-baseline.md")).toBe(BUMPED);
    expect(fake.fileAtHead("chapters/002-null-results.md")).toContain("Other writer.");
    expect(fake.state.getCommit(result.commitSha).message).toContain("Apply work item");
    // Two ref reads and two ref updates: the first attempt, then the retry.
    expect(fake.countRequests("GET", (p) => p.includes("/git/ref/heads/"))).toBe(2);
    expect(fake.countRequests("PATCH", (p) => p.includes("/git/refs/heads/"))).toBe(2);
  });

  it("rebuilds the tree from the new head rather than replaying the stale one", async () => {
    const { fake, writer } = await harness();
    fake.injectFault("movedHead", {
      branch: "main",
      times: 1,
      files: { "story/outline.yml": "beats: [one]\n" },
    });

    const result = await writer.commitFiles(commitInput());

    // The concurrent commit is the parent, so its content is inherited rather
    // than reverted to the tree the first attempt was built on.
    const parent = fake.state.getCommit(result.commitSha).parents[0] as string;
    expect(fake.state.readFile(parent, "story/outline.yml")).toBe("beats: [one]\n");
    expect(fake.state.readFile(result.commitSha, "story/outline.yml")).toBe("beats: [one]\n");
  });
});

// ------------------------------------------------------- retry exhaustion

describe("retry exhaustion", () => {
  it("conflicts after 3 attempts and leaves the other writer's commit at the head", async () => {
    const { fake, writer, refUpdates } = await harness();
    const rival = await fake.externalCommit(
      { "chapters/001-baseline.md": "---\nid: c1\nrevision: 5\n---\n\nRival prose.\n" },
      { message: "Rival commit" },
    );
    // Every ref update is refused, so the writer can never fast-forward.
    fake.injectFault("nonFastForward", { branch: "main", times: 10 });

    const error = await writer.commitFiles(commitInput()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubWriteError);
    const failure = error as GitHubWriteError;
    expect(failure.kind).toBe("non-fast-forward");
    expect(failure.attempts).toBe(3);
    // The processor's retry classification (`isGitWriteError && retryable`)
    // must see this, or a transient contention becomes a permanent failure.
    expect(isGitWriteError(failure)).toBe(true);
    expect(failure.retryable).toBe(true);

    // NO CLOBBER — asserted by content, not by status. And no force was even
    // attempted: every ref update on the wire carried `force: false`.
    expect(refUpdates()).toHaveLength(3);
    for (const update of refUpdates()) {
      expect(update.body).toMatchObject({ force: false });
    }
    expect(fake.state.getRef("main")).toBe(rival);
    expect(fake.fileAtHead("chapters/001-baseline.md")).toBe(
      "---\nid: c1\nrevision: 5\n---\n\nRival prose.\n",
    );
    expect(fake.state.getCommit(rival).message).toBe("Rival commit");
  });

  it("bounds itself at exactly maxAttempts and never sends force: true", async () => {
    const { fake, writer, refUpdates } = await harness({ maxAttempts: 3 });
    fake.injectFault("nonFastForward", { branch: "main", times: 10 });

    await expect(writer.commitFiles(commitInput())).rejects.toBeInstanceOf(GitHubWriteError);

    expect(refUpdates().map((update) => update.body)).toEqual([
      expect.objectContaining({ force: false }),
      expect.objectContaining({ force: false }),
      expect.objectContaining({ force: false }),
    ]);
    expect(fake.state.history("main")).toHaveLength(1);
  });

  it("honours a lower attempt bound", async () => {
    const { fake, writer } = await harness({ maxAttempts: 1 });
    fake.injectFault("nonFastForward", { branch: "main", times: 10 });

    await expect(writer.commitFiles(commitInput())).rejects.toMatchObject({ attempts: 1 });
    expect(fake.countRequests("PATCH", (p) => p.includes("/git/refs/heads/"))).toBe(1);
  });
});

// --------------------------------------------------- expectedHeadOverride

describe("expectedHeadOverride", () => {
  it("commits when the pin still matches the branch head", async () => {
    const { fake, writer } = await harness();
    const head = fake.state.getRef("main") as string;

    const result = await writer.commitFiles(commitInput({ expectedHeadOverride: head }));

    expect(fake.state.getCommit(result.commitSha).parents).toEqual([head]);
  });

  it("conflicts instead of silently rebasing when the pin is stale", async () => {
    const { fake, writer } = await harness();
    const stale = fake.state.getRef("main") as string;
    const rival = await fake.externalCommit(
      { "chapters/001-baseline.md": "---\nid: c1\nrevision: 5\n---\n\nRival prose.\n" },
      { message: "Rival commit" },
    );
    expect(rival).not.toBe(stale);

    const error = await writer
      .commitFiles(commitInput({ expectedHeadOverride: stale }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubWriteError);
    expect((error as GitHubWriteError).kind).toBe("non-fast-forward");
    // Retryable so the operation requeues and re-resolves against the real
    // head — the Phase 4 processor depends on exactly that.
    expect((error as GitHubWriteError).retryable).toBe(true);

    // The stale plan is NOT replayed onto the newer head: nothing was
    // committed at all, and the rival's bytes are untouched.
    expect(fake.state.getRef("main")).toBe(rival);
    expect(fake.fileAtHead("chapters/001-baseline.md")).toBe(
      "---\nid: c1\nrevision: 5\n---\n\nRival prose.\n",
    );
    expect(fake.countRequests("POST", (p) => p.endsWith("/git/commits"))).toBe(0);
    expect(fake.countRequests("PATCH", (p) => p.includes("/git/refs/heads/"))).toBe(0);
  });

  it("does not retry-rebase a pinned commit when the head moves mid-sequence", async () => {
    const { fake, writer } = await harness();
    const head = fake.state.getRef("main") as string;
    fake.injectFault("movedHead", {
      branch: "main",
      times: 1,
      files: { "chapters/002-null-results.md": "---\nid: c2\nrevision: 9\n---\n\nRace.\n" },
      message: "Raced in",
    });

    const error = await writer
      .commitFiles(commitInput({ expectedHeadOverride: head }))
      .catch((caught: unknown) => caught);

    fake.assertAllFaultsFired();
    expect(error).toBeInstanceOf(GitHubWriteError);
    expect((error as GitHubWriteError).kind).toBe("non-fast-forward");
    // One attempt only: a pinned plan cannot be rebased by the writer.
    expect(fake.countRequests("PATCH", (p) => p.includes("/git/refs/heads/"))).toBe(1);
    expect(fake.fileAtHead("chapters/002-null-results.md")).toContain("Race.");
    expect(fake.fileAtHead("chapters/001-baseline.md")).toBe(
      SAMPLE_BOOK["chapters/001-baseline.md"],
    );
  });
});

// ------------------------------------------------------------ idempotency

describe("operation idempotency", () => {
  it("returns the landed SHA instead of committing the same operation twice", async () => {
    const { fake, writer } = await harness();
    const first = await writer.commitFiles(commitInput());
    const commitPosts = fake.countRequests("POST", (p) => p.endsWith("/git/commits"));

    const second = await writer.commitFiles(commitInput());

    expect(second.commitSha).toBe(first.commitSha);
    expect(fake.countRequests("POST", (p) => p.endsWith("/git/commits"))).toBe(commitPosts);
    expect(fake.state.history("main")).toHaveLength(2);
  });

  it("dedupes before the head check, so a crash replay with a stale pin still finalizes", async () => {
    const { fake, writer } = await harness();
    const stale = fake.state.getRef("main") as string;
    const first = await writer.commitFiles(commitInput({ expectedHeadOverride: stale }));
    // Someone else commits after ours landed; the replay still carries the
    // pin from the original plan.
    await fake.externalCommit({ "story/outline.yml": "beats: [later]\n" });

    const replay = await writer.commitFiles(commitInput({ expectedHeadOverride: stale }));

    expect(replay.commitSha).toBe(first.commitSha);
  });

  it("commits a different operation even when the files are identical", async () => {
    const { fake, writer } = await harness();
    await writer.commitFiles(commitInput());
    await writer.commitFiles(
      commitInput({
        trailers: { ...TRAILERS, [OPERATION_TRAILER]: "0190f309-0000-7000-8000-000000000000" },
      }),
    );
    expect(fake.state.history("main")).toHaveLength(3);
  });

  it("does not scan when no operation trailer is present", async () => {
    const { fake, writer } = await harness();
    await writer.commitFiles(
      commitInput({ trailers: { "Authorbot-Actor": "github:example-editor" } }),
    );
    await writer.commitFiles(
      commitInput({ trailers: { "Authorbot-Actor": "github:example-editor" } }),
    );
    expect(fake.state.history("main")).toHaveLength(3);
  });
});

// ------------------------------------------------------------- rate limits

describe("rate limiting and transport failures", () => {
  it("surfaces a 403 rate limit as a typed retryable error", async () => {
    const { fake, writer } = await harness();
    fake.injectFault("rateLimited", { times: 1, retryAfterSeconds: 42, secondary: true });

    const error = await writer.commitFiles(commitInput()).catch((caught: unknown) => caught);

    fake.assertAllFaultsFired();
    expect(error).toBeInstanceOf(GitHubWriteError);
    const failure = error as GitHubWriteError;
    expect(isGitWriteError(failure)).toBe(true);
    expect(failure.retryable).toBe(true);
    expect(failure.rateLimited).toBe(true);
    expect(failure.status).toBe(403);
    expect(failure.retryAfterSeconds).toBe(42);
    expect(failure.rateLimitResetEpochSeconds).toEqual(expect.any(Number));
    expect(failure.message).toMatch(/rate limit/i);
    // Nothing was committed.
    expect(fake.state.history("main")).toHaveLength(1);
  });

  it("distinguishes a permissions 403 from a rate-limit 403", async () => {
    const fake = await createFakeGitHub({ files: SAMPLE_BOOK, requireAuth: true });
    const writer = new GitHubBookRepoWriter({
      repo: fake.fullName,
      // A token the fake never issued: every repo call is 401, and the retry
      // with a "refreshed" token is 401 too.
      tokens: async () => "ghs_not_a_real_token",
      fetchImpl: fake.fetch,
    });

    const error = await writer.commitFiles(commitInput()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitHubWriteError);
    const failure = error as GitHubWriteError;
    expect(failure.status).toBe(401);
    expect(failure.rateLimited).toBe(false);
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("contents:write");
  });

  it("refreshes the installation token once on a 401 and completes", async () => {
    const { fake, writer, minted } = await harness();
    // The fake answers the next repository request with 401 even though the
    // token is valid — contract §2's "refreshed on 401".
    fake.injectFault("unauthorized", { times: 1 });

    const result = await writer.commitFiles(commitInput());

    fake.assertAllFaultsFired();
    expect(minted()).toBe(2);
    expect(fake.state.getRef("main")).toBe(result.commitSha);
  });

  it("never puts a credential in an error message", async () => {
    const fake = await createFakeGitHub({ files: SAMPLE_BOOK });
    const writer = new GitHubBookRepoWriter({
      repo: fake.fullName,
      tokens: async () => "ghs_supersecret_token_value",
      fetchImpl: fake.fetch,
    });

    const error = await writer.commitFiles(commitInput()).catch((caught: unknown) => caught);

    expect(String((error as Error).message)).not.toContain("ghs_supersecret_token_value");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
      "ghs_supersecret_token_value",
    );
  });
});

// ----------------------------------------------------------- resolveHead

describe("resolveHead", () => {
  it("reports the branch head so callers can pin it", async () => {
    const { fake, writer } = await harness();
    expect(await writer.resolveHead("main")).toBe(fake.state.getRef("main"));
  });

  it("tracks the head across a commit", async () => {
    const { writer } = await harness();
    const before = await writer.resolveHead("main");
    const result = await writer.commitFiles(commitInput());
    expect(await writer.resolveHead("main")).toBe(result.commitSha);
    expect(await writer.resolveHead("main")).not.toBe(before);
  });

  it("answers null for a branch that does not exist", async () => {
    const { writer } = await harness();
    expect(await writer.resolveHead("no-such-branch")).toBeNull();
  });

  it("pins a head that a commit then lands on", async () => {
    const { fake, writer } = await harness();
    const pinned = (await writer.resolveHead("main")) as string;
    const result = await writer.commitFiles(commitInput({ expectedHeadOverride: pinned }));
    expect(fake.state.getCommit(result.commitSha).parents).toEqual([pinned]);
  });
});

// -------------------------------------------------------------- readFile

describe("readFile", () => {
  it("reads a committed file at the branch head", async () => {
    const { writer } = await harness();
    expect(await writer.readFile("main", "chapters/001-baseline.md")).toBe(
      SAMPLE_BOOK["chapters/001-baseline.md"],
    );
  });

  it("sees the writer's own commit", async () => {
    const { writer } = await harness();
    await writer.commitFiles(commitInput());
    expect(await writer.readFile("main", "chapters/001-baseline.md")).toBe(BUMPED);
  });

  it("answers null for an absent path, and for an absent directory", async () => {
    const { writer } = await harness();
    expect(await writer.readFile("main", "chapters/999-missing.md")).toBeNull();
    expect(await writer.readFile("main", "nowhere/at/all.md")).toBeNull();
  });

  it("throws rather than answering null for an unknown branch", async () => {
    const { writer } = await harness();
    // A null here would let an attribution append silently drop history.
    await expect(writer.readFile("no-such-branch", "book.yml")).rejects.toBeInstanceOf(
      GitHubWriteError,
    );
  });

  it("round-trips non-ASCII content through base64", async () => {
    const { writer } = await harness();
    const content = "---\nid: c1\nrevision: 2\n---\n\nEm—dash, naïve, 日本語, 🌍.\n";
    await writer.commitFiles(commitInput({ files: [{ path: "chapters/001-baseline.md", content }] }));
    expect(await writer.readFile("main", "chapters/001-baseline.md")).toBe(content);
  });
});

// ------------------------------------------------------------- validation

describe("input validation", () => {
  it("refuses paths that escape the repository, before any request", async () => {
    const { fake, writer } = await harness();
    for (const path of ["../outside.md", "/etc/passwd", "chapters/../../x.md", "a\\b.md", ""]) {
      await expect(
        writer.commitFiles(commitInput({ files: [{ path, content: "x" }] })),
      ).rejects.toBeInstanceOf(GitHubWriteError);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses an empty file list and duplicate paths", async () => {
    const { writer } = await harness();
    await expect(writer.commitFiles(commitInput({ files: [] }))).rejects.toThrow(/at least one/);
    await expect(
      writer.commitFiles(
        commitInput({
          files: [
            { path: "chapters/001-baseline.md", content: "a" },
            { path: "./chapters/001-baseline.md", content: "b" },
          ],
        }),
      ),
    ).rejects.toThrow(/duplicate file path/);
  });

  it("refuses a repository that is not owner/name", async () => {
    expect(
      () => new GitHubBookRepoWriter({ repo: "not-a-repo", tokens: async () => "t" }),
    ).toThrow(/owner\/name/);
  });

  it("fails clearly when the branch does not exist", async () => {
    const { writer } = await harness();
    await expect(writer.commitFiles(commitInput({ branch: "missing" }))).rejects.toThrow(
      /does not exist/,
    );
  });
});
