/**
 * Regression tests for defects found in `GitHubBookRepoWriter` after Phase 5
 * landed. Each `it` names the defect it pins, and each fails if the
 * corresponding fix in `src/writer.ts` is reverted.
 *
 * They live apart from `writer.test.ts` because they are not a description of
 * the §14.2 sequence — they are proofs about failure modes that produced
 * repository/database divergence, and keeping them together makes it obvious
 * what must never regress.
 */
import { describe, expect, it } from "vitest";
import { isGitWriteError } from "@authorbot/repo-coordinator";
import { OPERATION_TRAILER } from "@authorbot/repo-coordinator/writer";
import { createFakeGitHub, type FakeGitHub } from "../src/testing/index.js";
import { GitHubBookRepoWriter, GitHubWriteError } from "../src/writer.js";
import { commitViaApi, getInstallationToken, SAMPLE_BOOK } from "./helpers.js";

const OPERATION_ID = "0190f302-7045-7b2d-9d91-95b3c8228b54";
const BUMPED = "---\nid: c1\nrevision: 2\n---\n\nBaseline prose, revised.\n";

interface Harness {
  fake: FakeGitHub;
  writer: GitHubBookRepoWriter;
  token: string;
}

async function harness(
  options: {
    files?: Record<string, string>;
    /** Wrap the fake's fetch — used to inject a transport-level rejection. */
    wrap?: (
      inner: (request: Request) => Promise<Response>,
    ) => (input: Request | string, init?: RequestInit) => Promise<Response>;
    operationScanDepth?: number;
  } = {},
): Promise<Harness> {
  const fake = await createFakeGitHub({ files: options.files ?? SAMPLE_BOOK });
  const token = await getInstallationToken(fake);
  const base = (request: Request): Promise<Response> => fake.fetch(request);
  const fetchImpl =
    options.wrap?.(base) ??
    ((input: Request | string, init?: RequestInit): Promise<Response> =>
      base(input instanceof Request ? input : new Request(input, init)));
  const writer = new GitHubBookRepoWriter({
    repo: fake.fullName,
    tokens: async () => token,
    fetchImpl,
    now: () => new Date("2026-07-19T12:00:00.000Z"),
    ...(options.operationScanDepth === undefined
      ? {}
      : { operationScanDepth: options.operationScanDepth }),
  });
  return { fake, writer, token };
}

function commitInput(
  overrides: Partial<Parameters<GitHubBookRepoWriter["commitFiles"]>[0]> = {},
): Parameters<GitHubBookRepoWriter["commitFiles"]>[0] {
  return {
    branch: "main",
    files: [{ path: "chapters/001-baseline.md", content: BUMPED }],
    message: "Apply work item",
    trailers: { [OPERATION_TRAILER]: OPERATION_ID },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("a rejected fetch is a RETRYABLE git failure, not a terminal one", () => {
  /**
   * The defect: `#send` awaited `this.#fetch(...)` with no try/catch and
   * `#failure` classified only HTTP statuses, so a Workers `fetch` that
   * REJECTS (connection reset, TLS error, cancelled request) escaped as a raw
   * `TypeError`. The processor's guard is
   * `isGitWriteError(error) && error.retryable`, which is false for a
   * TypeError, so it fell straight to `failOperation` — terminal, no retry,
   * attempts not even consumed.
   *
   * That is the one failure mode that leaves a commit LANDED with no local
   * record: the `PATCH /git/refs` is applied and the connection drops before
   * the response arrives. Git reaches revision N+1 while D1 records a
   * conflict and leaves the chapter at N.
   */
  it("converts a transport rejection on PATCH /git/refs into a retryable GitWriteError", async () => {
    let dropped = 0;
    const { writer } = await harness({
      wrap: (inner) => async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (
          request.method === "PATCH" &&
          new URL(request.url).pathname.includes("/git/refs/heads/")
        ) {
          dropped += 1;
          // Exactly what workerd raises when the connection dies mid-request.
          throw new TypeError("Network connection lost.");
        }
        return inner(request);
      },
    });

    const error = await writer.commitFiles(commitInput()).catch((e: unknown) => e);

    expect(dropped).toBe(1);
    expect(isGitWriteError(error)).toBe(true);
    expect((error as GitHubWriteError).retryable).toBe(true);
    expect((error as GitHubWriteError).kind).toBe("git-failure");
    // The message names where it failed without quoting anything credentialed.
    expect((error as Error).message).toContain("PATCH");
    expect((error as Error).message).not.toContain("Bearer");
  });

  it("a retry after a dropped ref update returns the LANDED sha, never a second commit", async () => {
    // The ref update is applied and then the response is lost — the exact
    // shape that made git and D1 disagree.
    let dropAfterApply = true;
    const { fake, writer } = await harness({
      wrap: (inner) => async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const response = await inner(request);
        if (
          dropAfterApply &&
          request.method === "PATCH" &&
          new URL(request.url).pathname.includes("/git/refs/heads/")
        ) {
          dropAfterApply = false;
          throw new TypeError("Network connection lost.");
        }
        return response;
      },
    });

    let landed: string | undefined;
    await writer
      .commitFiles(
        commitInput({
          onCommitCreated: (sha: string): Promise<void> => {
            landed = sha;
            return Promise.resolve();
          },
        }),
      )
      .catch(() => undefined);

    // The commit really did land, and the writer recorded the attempt.
    expect(landed).toBeDefined();
    expect(fake.state.getRef("main")).toBe(landed);
    const historyBefore = fake.state.history("main").length;

    // The replay the processor performs, carrying the recorded attempt.
    const replay = await writer.commitFiles(
      commitInput({ attemptedCommitSha: landed as string }),
    );

    expect(replay.commitSha).toBe(landed);
    expect(fake.state.history("main")).toHaveLength(historyBefore);
  });
});

// ---------------------------------------------------------------------------

describe("replay idempotency is bounded by operation identity, not commit count", () => {
  /**
   * The defect: dedup rested entirely on `#findOperationCommit`, a first-parent
   * walk bounded at `operationScanDepth` (default 5). A maintainer pushing six
   * commits between the crash and the replay hid the landed commit, so an
   * unpinned operation committed a SECOND time (two audit commits for one
   * logical mutation, against contract §4/§8.2's "one auditable commit") and a
   * pinned one raised non-fast-forward and ended as a spurious conflict record
   * for work that had applied cleanly.
   */
  it("dedupes across more intervening commits than the trailer scan can see", async () => {
    const { fake, writer, token } = await harness();

    let landed: string | undefined;
    const first = await writer.commitFiles(
      commitInput({
        onCommitCreated: (sha: string): Promise<void> => {
          landed = sha;
          return Promise.resolve();
        },
      }),
    );
    expect(landed).toBe(first.commitSha);

    // A third party pushes well past the scan depth (default 5).
    for (let index = 0; index < 6; index += 1) {
      const pushed = await commitViaApi(fake, {
        files: { "chapters/002-null-results.md": `Outside edit ${String(index)}.\n` },
        message: `External ${String(index)}`,
        token,
      });
      expect(pushed.ok).toBe(true);
    }
    const historyBefore = fake.state.history("main").length;

    const replay = await writer.commitFiles(
      commitInput({ attemptedCommitSha: first.commitSha }),
    );

    expect(replay.commitSha).toBe(first.commitSha);
    expect(fake.state.history("main")).toHaveLength(historyBefore);
    // And exactly one commit on the branch carries this operation id.
    const carrying = fake.state
      .history("main")
      .filter((sha) => fake.state.getCommit(sha).message.includes(OPERATION_ID));
    expect(carrying).toHaveLength(1);
  });

  it("does not mistake a commit that never landed for a landed one", async () => {
    const { fake, writer } = await harness();
    // A commit object that exists but is not on the branch: the writer must
    // still do the work rather than reporting a phantom success.
    const orphanParent = fake.state.getRef("main") as string;
    const orphanTree = fake.state.getCommit(orphanParent).tree;
    const orphan = await fake.state.putCommit({
      tree: orphanTree,
      parents: [orphanParent],
      message: "Never referenced",
      author: { name: "x", email: "x@example.test", date: "2026-07-19T12:00:00Z" },
      committer: { name: "x", email: "x@example.test", date: "2026-07-19T12:00:00Z" },
    });

    const result = await writer.commitFiles(commitInput({ attemptedCommitSha: orphan }));

    expect(result.commitSha).not.toBe(orphan);
    expect(fake.state.getRef("main")).toBe(result.commitSha);
    expect(fake.state.readFile(result.commitSha, "chapters/001-baseline.md")).toBe(BUMPED);
  });
});

// ---------------------------------------------------------------------------

describe("a truncated tree is an error, never a missing file", () => {
  /**
   * The defect: `readFile` walked the path a directory at a time and never
   * inspected `truncated`, so a truncated listing made an existing file read
   * back as `null` — indistinguishable from "absent". The Phase 4 attribution
   * append treats `null` as "no prior file" and re-renders a fresh
   * single-entry artifact, so one truncated `.authorbot/attribution/` listing
   * would commit away a chapter's entire attribution history inside a commit
   * that looks like an ordinary apply.
   */
  const ATTRIBUTION = ".authorbot/attribution/c1.yml";
  const files = {
    ...SAMPLE_BOOK,
    [ATTRIBUTION]: "chapter: c1\nentries:\n  - revision: 1\n    actor: github:a\n",
  };

  it("readFile throws instead of reporting an existing file as absent", async () => {
    const { fake, writer } = await harness({ files });

    // Sanity: without the fault the file reads back.
    expect(await writer.readFile("main", ATTRIBUTION)).toContain("revision: 1");

    fake.injectFault("truncatedTree", { keepEntries: 0, times: 10 });
    const error = await writer.readFile("main", ATTRIBUTION).catch((e: unknown) => e);

    expect(isGitWriteError(error)).toBe(true);
    expect((error as Error).message).toContain("truncated");
    // Not retryable: the same tree truncates identically next time.
    expect((error as GitHubWriteError).retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("committed tree entries keep the mode the path already carries", () => {
  /**
   * The defect: `#createTree` emitted `mode: "100644"` for every file with no
   * reference to `base_tree`. GitHub lets a supplied entry override the base
   * entry wholesale, mode included, so any apply touching an executable
   * chapter silently cleared its exec bit — inside a commit whose message and
   * §14.3 trailers describe only a prose edit, and which no trailer records.
   * `LocalGitAdapter` preserves the bit, so the two `BookRepoWriter`
   * implementations disagreed on identical input.
   */
  it("preserves 100755 on a path the commit rewrites", async () => {
    const fake = await createFakeGitHub();
    const token = await getInstallationToken(fake);
    // Seed the chapter as an executable file through the real object model.
    const blob = await fake.state.putBlob(SAMPLE_BOOK["chapters/001-baseline.md"] as string);
    const tree = await fake.state.createTree(null, [
      { path: "chapters/001-baseline.md", sha: blob, mode: "100755", type: "blob" },
    ]);
    const commit = await fake.state.putCommit({
      tree,
      parents: [],
      message: "Seed",
      author: { name: "x", email: "x@example.test", date: "2026-07-19T12:00:00Z" },
      committer: { name: "x", email: "x@example.test", date: "2026-07-19T12:00:00Z" },
    });
    fake.state.setRefUnchecked("main", commit);
    const modeOf = (sha: string, path: string): string | undefined =>
      fake.state
        .listTree(fake.state.getCommit(sha).tree, true)
        .find((entry) => entry.path === path)?.mode;
    expect(modeOf(commit, "chapters/001-baseline.md")).toBe("100755");

    const writer = new GitHubBookRepoWriter({
      repo: fake.fullName,
      tokens: async () => token,
      fetchImpl: (input, init) =>
        fake.fetch(input instanceof Request ? input : new Request(input, init)),
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    });
    const result = await writer.commitFiles(commitInput());

    expect(modeOf(result.commitSha, "chapters/001-baseline.md")).toBe("100755");
  });

  it("gives a genuinely new path the default 100644", async () => {
    const { fake, writer } = await harness();
    const result = await writer.commitFiles(
      commitInput({ files: [{ path: ".authorbot/annotations/a/annotation.md", content: "x\n" }] }),
    );
    const mode = fake.state
      .listTree(fake.state.getCommit(result.commitSha).tree, true)
      .find((entry) => entry.path === ".authorbot/annotations/a/annotation.md")?.mode;
    expect(mode).toBe("100644");
  });

  it("refuses to overwrite a symlink with a regular blob", async () => {
    const fake = await createFakeGitHub({ files: SAMPLE_BOOK });
    const token = await getInstallationToken(fake);
    const target = await fake.state.putBlob("chapters/002-null-results.md");
    const head = fake.state.getRef("main") as string;
    const tree = await fake.state.createTree(fake.state.getCommit(head).tree, [
      { path: "chapters/001-baseline.md", sha: target, mode: "120000", type: "blob" },
    ]);
    const commit = await fake.state.putCommit({
      tree,
      parents: [head],
      message: "Make it a symlink",
      author: { name: "x", email: "x@example.test", date: "2026-07-19T12:00:00Z" },
      committer: { name: "x", email: "x@example.test", date: "2026-07-19T12:00:00Z" },
    });
    fake.state.setRefUnchecked("main", commit);

    const writer = new GitHubBookRepoWriter({
      repo: fake.fullName,
      tokens: async () => token,
      fetchImpl: (input, init) =>
        fake.fetch(input instanceof Request ? input : new Request(input, init)),
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    });
    const error = await writer.commitFiles(commitInput()).catch((e: unknown) => e);

    expect(isGitWriteError(error)).toBe(true);
    expect((error as Error).message).toContain("symlink");
    // Nothing was committed over it.
    expect(fake.state.getRef("main")).toBe(commit);
  });
});

// ---------------------------------------------------------------------------

describe("error messages are scrubbed before they escape", () => {
  /**
   * The defect: `GitHubWriteError` passed its message straight to `Error`,
   * while `scrubSecrets` was applied only inside `GitHubAuthError`. That
   * message is persisted to `git_operations.error` and served to any member by
   * `GET /v1/projects/{id}/operations/{operationId}` — a durable, readable
   * sink. GitHub does not echo our token, but `apiOrigin` means api.github.com
   * is not the only endpoint the writer can be pointed at, and a token written
   * into D1 would be a retroactive, unrecoverable leak (contract §2:
   * installation tokens are never persisted).
   */
  it("redacts a token an upstream error body echoed back", async () => {
    const leaked = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";
    const { writer } = await harness({
      wrap: (inner) => async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/git/blobs")) {
          return new Response(
            JSON.stringify({ message: `Bad credentials for Bearer ${leaked}` }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return inner(request);
      },
    });

    const error = await writer.commitFiles(commitInput()).catch((e: unknown) => e);

    expect(isGitWriteError(error)).toBe(true);
    expect((error as Error).message).not.toContain(leaked);
    expect((error as Error).message).toContain("[redacted-token]");
  });
});
