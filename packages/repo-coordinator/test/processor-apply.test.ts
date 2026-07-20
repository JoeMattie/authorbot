/**
 * `submission.apply` processing (Phase 4 contract §5–§6): the atomic apply
 * commit (chapter bump + work item done + annotation accepted + attribution,
 * §14.3 trailers), the both-texts conflict commit (newer chapter untouched),
 * outcome persistence for crash recovery, and retry re-resolution.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attributionFilePath, parseAttributionArtifact } from "../src/attribution-artifact.js";
import { LocalGitAdapter } from "../src/local-git.js";
import {
  createProcessor,
  SYSTEM_APPLY_REF,
  type Processor,
  type SubmissionApplier,
} from "../src/processor.js";
import { annotationFilePath } from "../src/render.js";
import { parseWorkItemArtifact, workItemFilePath } from "../src/work-item-artifact.js";
import {
  GitWriteError,
  type BookRepoWriter,
  type CommitFilesInput,
  type CommitFilesResult,
} from "../src/writer.js";
import {
  chapterSourceFixture,
  enqueueSubmissionApply,
  git,
  initGitRepo,
  setupDatabase,
  uuidv7,
  type SeededDatabase,
  type TempGitRepo,
} from "./helpers.js";

const CHAPTER_PATH = "chapters/01-signal.md";

let seed: SeededDatabase;
let repo: TempGitRepo;
let writer: LocalGitAdapter;

beforeEach(async () => {
  seed = await setupDatabase();
  repo = await initGitRepo();
  writer = new LocalGitAdapter({ workTreePath: repo.dir });
});

afterEach(async () => {
  await repo.cleanup();
});

/** Commit the base chapter file into the fixture repo. */
async function commitChapterFixture(revision = 2): Promise<string> {
  const source = chapterSourceFixture(seed.chapterId, revision);
  await mkdir(join(repo.dir, "chapters"), { recursive: true });
  await writeFile(join(repo.dir, CHAPTER_PATH), source, "utf8");
  await git(repo.dir, "add", CHAPTER_PATH);
  await git(
    repo.dir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "add chapter",
  );
  return source;
}

function makeAppliedApplier(options: { newRevision?: number; priorRevision?: number } = {}): {
  applier: SubmissionApplier;
  calls: () => number;
  blockId: string;
} {
  const blockId = uuidv7();
  const priorRevision = options.priorRevision ?? 2;
  const newRevision = options.newRevision ?? 3;
  let calls = 0;
  const applier: SubmissionApplier = {
    apply: () => {
      calls += 1;
      return Promise.resolve({
        result: "applied" as const,
        chapterPath: CHAPTER_PATH,
        patchedSource: chapterSourceFixture(seed.chapterId, priorRevision, {
          body: `<!-- authorbot:block id="${blockId}" -->\nHonest from the first pass.\n`,
        }),
        newRevision,
        blockIds: [blockId],
      });
    },
  };
  return { applier, calls: () => calls, blockId };
}

function makeConflictApplier(): {
  applier: SubmissionApplier;
  calls: () => number;
  conflictWorkItemId: string;
} {
  const conflictWorkItemId = uuidv7();
  let calls = 0;
  const applier: SubmissionApplier = {
    apply: () => {
      calls += 1;
      return Promise.resolve({
        result: "conflict" as const,
        reason: "the target overlaps a newer edit",
        currentText: "The interferometer had been recalibrated twice already.",
        currentRevision: 3,
        conflictWorkItemId,
      });
    },
  };
  return { applier, calls: () => calls, conflictWorkItemId };
}

function processor(applier?: SubmissionApplier, custom?: BookRepoWriter): Processor {
  return createProcessor({
    db: seed.db,
    writer: custom ?? writer,
    ...(applier === undefined ? {} : { submissionApplier: applier }),
  });
}

async function committedFiles(): Promise<string[]> {
  const out = await git(repo.dir, "show", "--name-only", "--format=");
  return out.split("\n").filter((line) => line !== "").sort();
}

async function eventTypes(): Promise<string[]> {
  const rows = await seed.db.prepare(`SELECT type FROM events ORDER BY id`).bind().all();
  return rows.map((row) => String(row["type"]));
}

describe("submission.apply — applied path", () => {
  it("stages chapter + work item + annotation + attribution in ONE commit with §14.3 trailers", async () => {
    await commitChapterFixture();
    const { applier, blockId } = makeAppliedApplier();
    const { annotationId, workItemId, submissionId, operationId } =
      await enqueueSubmissionApply(seed);
    const before = Number(await git(repo.dir, "rev-list", "--count", "HEAD"));

    const { outcomes } = await processor(applier).drain(seed.projectId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result).toBe("committed");
    const sha = outcomes[0]?.commitSha ?? "";
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // Exactly one commit, exactly the four files of the logical mutation.
    expect(Number(await git(repo.dir, "rev-list", "--count", "HEAD"))).toBe(before + 1);
    expect(await committedFiles()).toEqual(
      [
        CHAPTER_PATH,
        annotationFilePath(annotationId),
        attributionFilePath(seed.chapterId),
        workItemFilePath(workItemId),
      ].sort(),
    );

    // Commit message: subject + full trailer set.
    const message = await git(repo.dir, "log", "-1", "--format=%B");
    expect(message).toContain(`Apply work item ${workItemId}`);
    expect(message).toContain("Authorbot-Actor: github:jparish");
    expect(message).toContain(`Authorbot-Work-Item: ${workItemId}`);
    expect(message).toContain(`Authorbot-Annotation: ${annotationId}`);
    expect(message).toContain("Authorbot-Base-Revision: 2");
    expect(message).toContain(`Authorbot-Operation: ${operationId}`);

    // Chapter: revision bumped, submitter credited, patched body committed.
    const chapter = await git(repo.dir, "show", `HEAD:${CHAPTER_PATH}`);
    expect(chapter).toContain("revision: 3");
    expect(chapter).toContain("- actor: github:original-author");
    expect(chapter).toContain("- actor: github:jparish");
    expect(chapter).toContain("Honest from the first pass.");

    // Work item: status completed + Completion metadata, §13 body intact.
    const workItemArtifact = parseWorkItemArtifact(
      await git(repo.dir, "show", `HEAD:${workItemFilePath(workItemId)}`),
    );
    expect(workItemArtifact.record.status).toBe("completed");
    expect(workItemArtifact.sections.completion).toMatchObject({
      submissionId,
      appliedRevision: 3,
      completedBy: "github:jparish",
    });
    expect(workItemArtifact.sections.originalText).toBe(
      "the interferometer was telling the truth",
    );

    // Annotation: accepted.
    expect(await git(repo.dir, "show", `HEAD:${annotationFilePath(annotationId)}`)).toContain(
      "status: accepted",
    );

    // Attribution: one entry, no commit field (same-commit convention).
    const attribution = parseAttributionArtifact(
      await git(repo.dir, "show", `HEAD:${attributionFilePath(seed.chapterId)}`),
    );
    expect(attribution.entries).toEqual([
      { revision: 3, actor: "github:jparish", work_item_id: workItemId },
    ]);

    // Database finalize batch.
    expect((await seed.repos.workItems.getById(workItemId))?.status).toBe("completed");
    expect((await seed.repos.annotations.getById(annotationId))?.status).toBe("accepted");
    expect((await seed.repos.submissions.getById(submissionId))?.state).toBe("applied");
    const chapterRow = await seed.repos.chapters.getById(seed.chapterId);
    expect(chapterRow?.revision).toBe(3);
    expect(chapterRow?.headCommit).toBe(sha);
    expect(chapterRow?.blockIds).toEqual([blockId]);
    const committedBytes = Buffer.from(
      await git(repo.dir, "show", `HEAD:${CHAPTER_PATH}`),
      "utf8",
    );
    // git() trims the trailing newline; hash the on-disk bytes instead.
    expect(chapterRow?.contentHash).toBe(
      `sha256:${createHash("sha256").update(`${committedBytes.toString("utf8")}\n`).digest("hex")}`,
    );
    expect(await eventTypes()).toEqual(["work_item_completed", "operation_completed"]);

    // Post-commit: the outbox row is done and the operation carries the SHA.
    expect((await seed.repos.outbox.getById(outcomes[0]?.outboxId ?? ""))?.status).toBe("done");
    expect((await seed.repos.gitOperations.getById(operationId))?.commitSha).toBe(sha);
  });

  it("appends to the attribution artifact on a second apply of the same chapter", async () => {
    await commitChapterFixture();
    const first = await enqueueSubmissionApply(seed);
    await processor(makeAppliedApplier().applier).drain(seed.projectId);
    const second = await enqueueSubmissionApply(seed, { baseRevision: 3 });
    await processor(makeAppliedApplier({ priorRevision: 3, newRevision: 4 }).applier).drain(
      seed.projectId,
    );

    const attribution = parseAttributionArtifact(
      await git(repo.dir, "show", `HEAD:${attributionFilePath(seed.chapterId)}`),
    );
    expect(attribution.entries.map((entry) => entry.revision)).toEqual([3, 4]);
    expect(attribution.entries.map((entry) => entry.work_item_id)).toEqual([
      first.workItemId,
      second.workItemId,
    ]);
    expect((await seed.repos.chapters.getById(seed.chapterId))?.revision).toBe(4);
  });

  it("re-invokes the applier on a non-fast-forward retry and then commits", async () => {
    await commitChapterFixture();
    const { applier, calls } = makeAppliedApplier();
    await enqueueSubmissionApply(seed);
    let failures = 1;
    const flaky: BookRepoWriter = {
      commitFiles: (input: CommitFilesInput): Promise<CommitFilesResult> => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new GitWriteError("non-fast-forward", "simulated stale head"));
        }
        return writer.commitFiles(input);
      },
      readFile: (branch, filePath) => writer.readFile(branch, filePath),
    };

    const { outcomes } = await processor(applier, flaky).drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("committed");
    // One resolution per attempt: stale results are never committed.
    expect(calls()).toBe(2);
  });

  it("fails the row with a clear error when no applier is configured", async () => {
    await commitChapterFixture();
    const { operationId } = await enqueueSubmissionApply(seed);
    const { outcomes } = await processor().drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("failed");
    expect(outcomes[0]?.error).toMatch(/SubmissionApplier/);
    expect((await seed.repos.gitOperations.getById(operationId))?.state).toBe("failed");
  });

  it("fails the row when the writer cannot read the prior attribution", async () => {
    await commitChapterFixture();
    await enqueueSubmissionApply(seed);
    const writeOnly: BookRepoWriter = {
      commitFiles: (input) => writer.commitFiles(input),
    };
    const { outcomes } = await processor(makeAppliedApplier().applier, writeOnly).drain(
      seed.projectId,
    );
    expect(outcomes[0]?.result).toBe("failed");
    expect(outcomes[0]?.error).toMatch(/readFile/);
  });
});

describe("submission.apply — conflict path", () => {
  it("commits the both-texts conflict artifact and never touches the newer chapter", async () => {
    const newerChapter = await commitChapterFixture(3);
    const { applier, conflictWorkItemId } = makeConflictApplier();
    const { annotationId, workItemId, submissionId } = await enqueueSubmissionApply(seed);

    const { outcomes } = await processor(applier).drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("committed");

    // Exactly two files: original re-render + the new conflict artifact.
    expect(await committedFiles()).toEqual(
      [workItemFilePath(workItemId), workItemFilePath(conflictWorkItemId)].sort(),
    );
    const message = await git(repo.dir, "log", "-1", "--format=%B");
    expect(message).toContain(`Record conflict on work item ${workItemId}`);
    expect(message).toContain("Authorbot-Base-Revision: 2");

    // The newer chapter revision is byte-intact (exit criterion 4).
    expect(`${await git(repo.dir, "show", `HEAD:${CHAPTER_PATH}`)}\n`).toBe(newerChapter);

    // Original work item re-rendered as conflict.
    const original = parseWorkItemArtifact(
      await git(repo.dir, "show", `HEAD:${workItemFilePath(workItemId)}`),
    );
    expect(original.record.status).toBe("conflict");

    // Conflict artifact carries BOTH texts between distinct delimiters.
    const conflict = parseWorkItemArtifact(
      await git(repo.dir, "show", `HEAD:${workItemFilePath(conflictWorkItemId)}`),
    );
    expect(conflict.record).toMatchObject({
      id: conflictWorkItemId,
      type: "resolve_conflict",
      status: "ready",
      base_revision: 3,
      chapter_id: seed.chapterId,
      source_annotation_id: annotationId,
      created_by: SYSTEM_APPLY_REF,
    });
    expect(conflict.sections.originalText).toBe(
      "The interferometer had been recalibrated twice already.",
    );
    expect(conflict.sections.submittedText).toBe("honest from the first pass");
    expect(conflict.sections.context).toContain("the target overlaps a newer edit");
    expect(conflict.sections.submissionContract).toContain("`chapter_replacement`");

    // Database: statuses, the inserted conflict row, and the event.
    expect((await seed.repos.workItems.getById(workItemId))?.status).toBe("conflict");
    expect((await seed.repos.submissions.getById(submissionId))?.state).toBe("conflicted");
    const conflictRow = await seed.repos.workItems.getById(conflictWorkItemId);
    expect(conflictRow).toMatchObject({
      type: "resolve_conflict",
      status: "ready",
      baseRevision: 3,
      sourceAnnotationId: annotationId,
    });
    // The chapter projection row is untouched.
    expect((await seed.repos.chapters.getById(seed.chapterId))?.revision).toBe(2);
    expect(await eventTypes()).toEqual(["work_item_conflict", "operation_completed"]);
  });

  it("recovers from a crash after commit without re-running the applier or re-inserting", async () => {
    await commitChapterFixture(3);
    const { applier, calls, conflictWorkItemId } = makeConflictApplier();
    const { outboxId } = await enqueueSubmissionApply(seed);
    await processor(applier).drain(seed.projectId);
    expect(calls()).toBe(1);
    const commits = await git(repo.dir, "rev-list", "--count", "HEAD");

    // Simulate a crash between the commit and the finalize batch: the row is
    // back in `processing` while the operation is already `committed`.
    await seed.db
      .prepare(`UPDATE outbox SET status = 'processing', processed_at = NULL WHERE id = ?`)
      .bind(outboxId)
      .run();

    const { outcomes } = await processor(applier).drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("committed");
    // Finalized from the persisted outcome: no new applier run, no new
    // commit, no duplicate conflict work-item insert.
    expect(calls()).toBe(1);
    expect(await git(repo.dir, "rev-list", "--count", "HEAD")).toBe(commits);
    expect((await seed.repos.workItems.getById(conflictWorkItemId))?.status).toBe("ready");
    expect((await seed.repos.outbox.getById(outboxId))?.status).toBe("done");
  });
});

/**
 * Crash and terminal-failure regressions: a replayed apply must never commit
 * bytes computed from a head the branch has since left, and a `submission.apply`
 * row that dies must hand its work item back instead of holding it forever.
 */
describe("submission.apply — crash and failure recovery", () => {
  /** Put the row/operation back in the pre-commit `committing` window. */
  async function rewindToCommitting(outboxId: string, operationId: string): Promise<void> {
    await seed.db
      .prepare(`UPDATE outbox SET status = 'processing', processed_at = NULL WHERE id = ?`)
      .bind(outboxId)
      .run();
    await seed.db
      .prepare(
        `UPDATE git_operations SET state = 'committing', commit_sha = NULL, error = NULL WHERE id = ?`,
      )
      .bind(operationId)
      .run();
  }

  /**
   * A realistic applier: like the production one it reads the CURRENT branch
   * head and derives its result from it, so re-resolution genuinely sees a
   * moved chapter (a stub that ignores the head would clobber either way and
   * prove nothing).
   */
  function makeHeadAwareApplier(): { applier: SubmissionApplier; calls: () => number } {
    let calls = 0;
    const applier: SubmissionApplier = {
      apply: async ({ branch }) => {
        calls += 1;
        const current = await writer.readFile(branch, CHAPTER_PATH);
        if (current === null) throw new Error("chapter missing at head");
        const revision = Number(/^revision: (\d+)$/m.exec(current)?.[1] ?? 0);
        return {
          result: "applied" as const,
          chapterPath: CHAPTER_PATH,
          // Body preserved verbatim: whatever is at the head stays there.
          patchedSource: current,
          newRevision: revision + 1,
          blockIds: [...current.matchAll(/id="([^"]+)"/g)].map((m) => m[1] as string),
        };
      },
    };
    return { applier, calls: () => calls };
  }

  it("a replay whose branch head moved does NOT clobber the newer chapter", async () => {
    await commitChapterFixture(2);
    const { applier, calls } = makeHeadAwareApplier();
    const { outboxId, operationId } = await enqueueSubmissionApply(seed);

    // Attempt 1 resolves against head H1 and persists the full patched
    // chapter, then the process dies before the commit lands.
    const crashing: BookRepoWriter = {
      commitFiles: () => Promise.reject(new Error("simulated crash before commit")),
      readFile: (branch, filePath) => writer.readFile(branch, filePath),
      resolveHead: (branch) => writer.resolveHead(branch),
    };
    await processor(applier, crashing).drain(seed.projectId);
    expect(calls()).toBe(1);

    // Meanwhile a human commits revision 4 straight into the checkout.
    const humanSource = chapterSourceFixture(seed.chapterId, 4, {
      body: `<!-- authorbot:block id="${uuidv7()}" -->\nHUMAN REVISION FOUR MARKER.\n`,
    });
    await writeFile(join(repo.dir, CHAPTER_PATH), humanSource, "utf8");
    await git(repo.dir, "add", CHAPTER_PATH);
    await git(
      repo.dir,
      "-c",
      "user.name=Human",
      "-c",
      "user.email=human@example.com",
      "commit",
      "--quiet",
      "-m",
      "human edit",
    );

    // Crash recovery: the SAME attempt replays, so the persisted outcome is
    // reused. It was computed against H1 and must not land on H2.
    await rewindToCommitting(outboxId, operationId);
    await processor(applier, writer).drain(seed.projectId);

    const head = await writer.readFile("main", CHAPTER_PATH);
    // The newer revision is byte-intact (contract §8.4, design §12.6 rule 5).
    expect(head).toContain("HUMAN REVISION FOUR MARKER.");
    // And the revision never went backwards.
    expect(head).not.toMatch(/^revision: 3$/m);
    // The stale plan was refused, so the applier re-resolved on a new attempt.
    expect(calls()).toBeGreaterThan(1);
  });

  it("a still-current head replays the persisted outcome without re-resolving", async () => {
    await commitChapterFixture(2);
    const { applier, calls } = makeAppliedApplier();
    const { outboxId, operationId } = await enqueueSubmissionApply(seed);
    await processor(applier).drain(seed.projectId);
    expect(calls()).toBe(1);

    // Crash between the commit and the finalize batch, head unchanged: the
    // operation-trailer dedup returns the landed commit and nothing re-runs.
    const commits = await git(repo.dir, "rev-list", "--count", "HEAD");
    await rewindToCommitting(outboxId, operationId);
    const { outcomes } = await processor(applier).drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("committed");
    expect(calls()).toBe(1);
    expect(await git(repo.dir, "rev-list", "--count", "HEAD")).toBe(commits);
  });

  it("a terminally failed apply hands the work item back instead of stranding it", async () => {
    await commitChapterFixture();
    const { workItemId, submissionId } = await enqueueSubmissionApply(seed);
    // A writer without `readFile` fails every apply row (the GitHub adapter
    // gains it only in Phase 5) — an ordinary, non-exotic failure.
    const writeOnly: BookRepoWriter = { commitFiles: (input) => writer.commitFiles(input) };

    const { outcomes } = await processor(makeAppliedApplier().applier, writeOnly).drain(
      seed.projectId,
    );
    expect(outcomes[0]?.result).toBe("failed");

    // The submit command already released the lease and moved the item to
    // `applying`. Leaving it there made it unclaimable, unreleasable,
    // un-resubmittable and uncancellable — dead, and silently so.
    const workItem = await seed.repos.workItems.getById(workItemId);
    expect(workItem?.status).toBe("conflict");
    expect(workItem?.status).not.toBe("applying");
    // `conflict → ready` keeps it recoverable (design §9.5).
    expect((await seed.repos.submissions.getById(submissionId))?.state).toBe("conflicted");
    // And a client watching the feed is told.
    const events = await eventTypes();
    expect(events).toContain("work_item_conflict");
  });
});
