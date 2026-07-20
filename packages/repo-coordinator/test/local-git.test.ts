import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitHubAdapter,
  GitWriteError,
  LocalGitAdapter,
  formatCommitMessage,
  isGitWriteError,
  type CommitFilesInput,
} from "../src/index.js";
import { git, initGitRepo, uuidv7, type TempGitRepo } from "./helpers.js";

let repo: TempGitRepo;
let adapter: LocalGitAdapter;

beforeEach(async () => {
  repo = await initGitRepo();
  adapter = new LocalGitAdapter({ workTreePath: repo.dir });
});

afterEach(async () => {
  await repo.cleanup();
});

function input(operationId: string, overrides: Partial<CommitFilesInput> = {}): CommitFilesInput {
  return {
    branch: "main",
    files: [{ path: ".authorbot/annotations/a1/annotation.md", content: "hello\n" }],
    message: "Create annotation a1",
    trailers: {
      "Authorbot-Actor": "github:jparish",
      "Authorbot-Annotation": "a1",
      "Authorbot-Operation": operationId,
    },
    ...overrides,
  };
}

describe("LocalGitAdapter.commitFiles", () => {
  it("writes, stages exactly the files, and commits with trailers and the Authorbot author", async () => {
    const operationId = uuidv7();
    const { commitSha } = await adapter.commitFiles(input(operationId));

    expect(commitSha).toBe(await git(repo.dir, "rev-parse", "HEAD"));
    const content = await readFile(
      join(repo.dir, ".authorbot/annotations/a1/annotation.md"),
      "utf8",
    );
    expect(content).toBe("hello\n");

    const message = await git(repo.dir, "log", "-1", "--format=%B");
    expect(message).toContain("Create annotation a1");
    expect(message).toContain("Authorbot-Actor: github:jparish");
    expect(message).toContain("Authorbot-Annotation: a1");
    expect(message).toContain(`Authorbot-Operation: ${operationId}`);

    const trailerValue = await git(
      repo.dir,
      "log",
      "-1",
      "--format=%(trailers:key=Authorbot-Operation,valueonly)",
    );
    expect(trailerValue.trim()).toBe(operationId);

    const author = await git(repo.dir, "log", "-1", "--format=%an <%ae>");
    expect(author).toBe("Authorbot <authorbot@localhost>");
    const committer = await git(repo.dir, "log", "-1", "--format=%cn <%ce>");
    expect(committer).toBe("Authorbot <authorbot@localhost>");
  });

  it("is idempotent per Authorbot-Operation trailer", async () => {
    const operationId = uuidv7();
    const first = await adapter.commitFiles(input(operationId));
    const before = await git(repo.dir, "rev-list", "--count", "HEAD");
    const second = await adapter.commitFiles(input(operationId));
    const after = await git(repo.dir, "rev-list", "--count", "HEAD");

    expect(second.commitSha).toBe(first.commitSha);
    expect(after).toBe(before);
  });

  it("surfaces foreign uncommitted changes distinctly as dirty-tree", async () => {
    await writeFile(join(repo.dir, "README.md"), "tampered\n", "utf8");
    const error = await adapter.commitFiles(input(uuidv7())).catch((e: unknown) => e);
    expect(isGitWriteError(error)).toBe(true);
    expect((error as GitWriteError).kind).toBe("dirty-tree");
    expect((error as GitWriteError).retryable).toBe(false);
  });

  it("tolerates leftover writes of exactly this mutation's files", async () => {
    // Simulates a crash between file write and commit on a previous run.
    const target = join(repo.dir, ".authorbot/annotations/a1");
    await adapter.commitFiles(input(uuidv7())); // first commit creates the path
    await writeFile(join(target, "annotation.md"), "leftover partial write\n", "utf8");
    const { commitSha } = await adapter.commitFiles(input(uuidv7(), { message: "retry" }));
    expect(commitSha).toBe(await git(repo.dir, "rev-parse", "HEAD"));
  });

  it("tolerates an UNTRACKED leftover of this mutation (crash before the first commit)", async () => {
    // Regression: a create always writes into a brand-new directory; a crash
    // between writeFiles and commit leaves an untracked file that the default
    // `git status --porcelain` reports as its directory ("?? .authorbot/"),
    // never as the exact path in the own set — which wedged every retry (and
    // every later commit) with a non-retryable dirty-tree error.
    await mkdir(join(repo.dir, ".authorbot/annotations/a1"), { recursive: true });
    await writeFile(
      join(repo.dir, ".authorbot/annotations/a1/annotation.md"),
      "leftover partial write\n",
      "utf8",
    );
    const { commitSha } = await adapter.commitFiles(input(uuidv7(), { message: "resume" }));
    expect(commitSha).toBe(await git(repo.dir, "rev-parse", "HEAD"));
    // and the tree is clean afterwards — nothing foreign was swallowed
    expect(await git(repo.dir, "status", "--porcelain")).toBe("");
  });

  it("still rejects a foreign UNTRACKED file in a new directory as dirty-tree", async () => {
    await mkdir(join(repo.dir, "notes"), { recursive: true });
    await writeFile(join(repo.dir, "notes/scratch.md"), "foreign\n", "utf8");
    const error = await adapter.commitFiles(input(uuidv7())).catch((e: unknown) => e);
    expect(isGitWriteError(error)).toBe(true);
    expect((error as GitWriteError).kind).toBe("dirty-tree");
    expect((error as GitWriteError).message).toContain("notes/scratch.md");
  });

  it("surfaces a moved head distinctly as non-fast-forward (retryable)", async () => {
    const staleHead = "0123456789012345678901234567890123456789";
    const error = await adapter
      .commitFiles(input(uuidv7(), { expectedHeadOverride: staleHead }))
      .catch((e: unknown) => e);
    expect(isGitWriteError(error)).toBe(true);
    expect((error as GitWriteError).kind).toBe("non-fast-forward");
    expect((error as GitWriteError).retryable).toBe(true);
  });

  it("commits when the expected head matches", async () => {
    const head = await git(repo.dir, "rev-parse", "HEAD");
    const { commitSha } = await adapter.commitFiles(
      input(uuidv7(), { expectedHeadOverride: head }),
    );
    expect(commitSha).not.toBe(head);
    expect(commitSha).toBe(await git(repo.dir, "rev-parse", "HEAD"));
  });

  it("refuses to commit on the wrong branch", async () => {
    await git(repo.dir, "checkout", "--quiet", "-b", "other");
    const error = await adapter.commitFiles(input(uuidv7())).catch((e: unknown) => e);
    expect(isGitWriteError(error)).toBe(true);
    expect((error as GitWriteError).kind).toBe("wrong-branch");
  });

  it("rejects unsafe file paths", async () => {
    for (const path of ["../escape.md", "/abs.md", "a/../../b.md", ""]) {
      const error = await adapter
        .commitFiles(input(uuidv7(), { files: [{ path, content: "x" }] }))
        .catch((e: unknown) => e);
      expect(isGitWriteError(error), path).toBe(true);
    }
  });
});

describe("formatCommitMessage", () => {
  it("emits subject, blank line, then trailers in insertion order", () => {
    expect(
      formatCommitMessage("Subject", { "A-One": "1", "B-Two": "2" }),
    ).toBe("Subject\n\nA-One: 1\nB-Two: 2\n");
    expect(formatCommitMessage("Subject", {})).toBe("Subject\n");
  });

  it("rejects newline-bearing trailer values and bad keys", () => {
    expect(() => formatCommitMessage("s", { "Bad Key": "v" })).toThrow();
    expect(() => formatCommitMessage("s", { Key: "line1\nline2" })).toThrow();
    expect(() => formatCommitMessage("", {})).toThrow();
  });
});

describe("GitHubAdapter", () => {
  it("is a typed stub that throws not-implemented", async () => {
    const adapter = new GitHubAdapter({ repo: "JoeMattie/causal-projector" });
    const error = await adapter.commitFiles(input(uuidv7())).catch((e: unknown) => e);
    expect(isGitWriteError(error)).toBe(true);
    expect((error as GitWriteError).kind).toBe("not-implemented");
  });
});
