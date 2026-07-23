import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseChapterMarkdown } from "@authorbot/markdown";
import { annotationSchema, replySchema } from "@authorbot/schemas";
import {
  GitWriteError,
  LocalGitAdapter,
  annotationFilePath,
  createProcessor,
  replyFilePath,
  type BookRepoWriter,
  type CommitFilesInput,
  type Processor,
} from "../src/index.js";
import {
  enqueueAnnotationCreate,
  enqueueAnnotationWithdraw,
  enqueueReplyCreate,
  enqueueReplyWithdraw,
  git,
  initGitRepo,
  nowIso,
  setupDatabase,
  uuidv7,
  type SeededDatabase,
  type TempGitRepo,
} from "./helpers.js";

let seed: SeededDatabase;
let repo: TempGitRepo;
let processor: Processor;

beforeEach(async () => {
  seed = await setupDatabase();
  repo = await initGitRepo();
  processor = createProcessor({
    db: seed.db,
    writer: new LocalGitAdapter({ workTreePath: repo.dir }),
  });
});

afterEach(async () => {
  seed.db.close();
  await repo.cleanup();
});

async function commitCount(): Promise<number> {
  return Number(await git(repo.dir, "rev-list", "--count", "HEAD"));
}

describe("processor happy path", () => {
  it("renders, commits, marks the operation committed and the record synced", async () => {
    const { annotationId, operationId, outboxId } = await enqueueAnnotationCreate(seed);

    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result).toBe("committed");

    // git operation walked queued → … → committed with the commit SHA
    const op = await seed.repos.gitOperations.getById(operationId);
    expect(op?.state).toBe("committed");
    expect(op?.attempts).toBe(1);
    expect(op?.commitSha).toBe(await git(repo.dir, "rev-parse", "HEAD"));
    expect(outcomes[0]?.commitSha).toBe(op?.commitSha);

    // mirrored record left pending_git
    const annotation = await seed.repos.annotations.getById(annotationId);
    expect(annotation?.status).toBe("open");

    // outbox row done
    const outbox = await seed.repos.outbox.getById(outboxId);
    expect(outbox?.status).toBe("done");
    expect(outbox?.processedAt).not.toBeNull();

    // artifact exists in the work tree with correct frontmatter
    const content = await readFile(join(repo.dir, annotationFilePath(annotationId)), "utf8");
    const parsed = annotationSchema.parse(parseChapterMarkdown(content).frontmatter);
    expect(parsed.id).toBe(annotationId);
    expect(parsed.status).toBe("open");
    expect(parsed.author).toBe(seed.actorRef);
    expect(parsed.chapter_id).toBe(seed.chapterId);

    // design §14.3 trailers on the commit
    const message = await git(repo.dir, "log", "-1", "--format=%B");
    expect(message).toContain(`Authorbot-Actor: ${seed.actorRef}`);
    expect(message).toContain(`Authorbot-Annotation: ${annotationId}`);
    expect(message).toContain(`Authorbot-Operation: ${operationId}`);
    const author = await git(repo.dir, "log", "-1", "--format=%an <%ae>");
    expect(author).toBe("Authorbot <authorbot@localhost>");

    const completion = (await seed.repos.events.listAfter(seed.projectId, 0)).find(
      (event) =>
        event.type === "operation_completed" &&
        (event.payload as { operationId?: string }).operationId === operationId,
    );
    expect(completion?.payload).toEqual({
      operationId,
      kind: "annotation.create",
      annotationKind: "suggestion",
    });
  });

  it("drains two annotations in insertion order as two commits", async () => {
    const first = await enqueueAnnotationCreate(seed, { body: "first" });
    const second = await enqueueAnnotationCreate(seed, { body: "second" });

    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes.map((o) => o.result)).toEqual(["committed", "committed"]);
    expect(await commitCount()).toBe(3); // initial + two mutations

    // newest first: HEAD is the second annotation, HEAD~1 the first
    const headOp = await git(
      repo.dir,
      "log",
      "-1",
      "--format=%(trailers:key=Authorbot-Annotation,valueonly)",
      "HEAD",
    );
    const parentOp = await git(
      repo.dir,
      "log",
      "-1",
      "--format=%(trailers:key=Authorbot-Annotation,valueonly)",
      "HEAD~1",
    );
    expect(headOp.trim()).toBe(second.annotationId);
    expect(parentOp.trim()).toBe(first.annotationId);

    const opFirst = await seed.repos.gitOperations.getById(first.operationId);
    const opSecond = await seed.repos.gitOperations.getById(second.operationId);
    expect(opFirst?.commitSha).toBe(await git(repo.dir, "rev-parse", "HEAD~1"));
    expect(opSecond?.commitSha).toBe(await git(repo.dir, "rev-parse", "HEAD"));
  });

  it("commits reply and annotation withdrawals as separate logical mutations", async () => {
    const created = await enqueueAnnotationCreate(seed);
    await processor.drain(seed.projectId);

    const reply = await enqueueReplyCreate(seed, created.annotationId);
    const replyCreate = await processor.drain(seed.projectId);
    expect(replyCreate.outcomes.map((o) => o.result)).toEqual(["committed"]);

    const replyWithdraw = await enqueueReplyWithdraw(seed, reply.replyId);
    const withdraw = await enqueueAnnotationWithdraw(seed, created.annotationId);
    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes.map((o) => o.result)).toEqual(["committed", "committed"]);
    expect(await commitCount()).toBe(5); // initial + annotation + reply + two withdrawals

    // reply artifact
    const replyContent = await readFile(
      join(repo.dir, replyFilePath(created.annotationId, reply.replyId)),
      "utf8",
    );
    const parsedReply = replySchema.parse(parseChapterMarkdown(replyContent).frontmatter);
    expect(parsedReply.id).toBe(reply.replyId);
    expect(parsedReply.annotation_id).toBe(created.annotationId);
    expect(parsedReply.status).toBe("withdrawn");
    const replyRecord = await seed.repos.replies.getById(reply.replyId);
    expect(replyRecord?.status).toBe("withdrawn");
    expect((await seed.repos.gitOperations.getById(replyWithdraw.operationId))?.state).toBe(
      "committed",
    );

    // withdraw = frontmatter status update on the same annotation file
    const annotationContent = await readFile(
      join(repo.dir, annotationFilePath(created.annotationId)),
      "utf8",
    );
    const parsedAnnotation = annotationSchema.parse(
      parseChapterMarkdown(annotationContent).frontmatter,
    );
    expect(parsedAnnotation.status).toBe("withdrawn");
    const annotationRecord = await seed.repos.annotations.getById(created.annotationId);
    expect(annotationRecord?.status).toBe("withdrawn");
    const withdrawOp = await seed.repos.gitOperations.getById(withdraw.operationId);
    expect(withdrawOp?.state).toBe("committed");
    const completions = (await seed.repos.events.listAfter(seed.projectId, 0))
      .filter((event) => event.type === "operation_completed")
      .map((event) => event.payload as Record<string, unknown>);
    expect(completions).toContainEqual({
      operationId: reply.operationId,
      kind: "reply.create",
      annotationKind: "suggestion",
    });
    expect(completions).toContainEqual({
      operationId: replyWithdraw.operationId,
      kind: "reply.withdraw",
      annotationKind: "suggestion",
    });
  });
});

describe("crash-recovery idempotency", () => {
  it("resumes a row that crashed before the commit (outbox processing, op preparing)", async () => {
    const { annotationId, operationId, outboxId } = await enqueueAnnotationCreate(seed);
    // Simulate: previous drain claimed the row and moved the operation to
    // `preparing`, then the process died.
    await seed.repos.outbox.markProcessing(outboxId);
    await seed.repos.gitOperations.updateState(operationId, {
      state: "preparing",
      attempts: 1,
      updatedAt: nowIso(),
    });

    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result).toBe("committed");
    expect(await commitCount()).toBe(2);
    expect((await seed.repos.annotations.getById(annotationId))?.status).toBe("open");
    expect((await seed.repos.outbox.getById(outboxId))?.status).toBe("done");
  });

  it("does not duplicate the commit when the crash hit between git commit and DB update", async () => {
    const { annotationId, operationId, outboxId } = await enqueueAnnotationCreate(seed);
    await processor.drain(seed.projectId);
    const sha = await git(repo.dir, "rev-parse", "HEAD");
    const countAfterFirst = await commitCount();

    // Rewind the database to the instant just before the post-commit batch:
    // op back to `committing`, record back to `pending_git`, row `processing`.
    await seed.repos.gitOperations.updateState(operationId, {
      state: "committing",
      updatedAt: nowIso(),
    });
    await seed.repos.annotations.updateStatus(annotationId, "pending_git", nowIso());
    await seed.db
      .prepare(`UPDATE outbox SET status = 'processing', processed_at = NULL WHERE id = ?`)
      .bind(outboxId)
      .run();

    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result).toBe("committed");
    expect(outcomes[0]?.commitSha).toBe(sha); // found via Authorbot-Operation trailer
    expect(await commitCount()).toBe(countAfterFirst); // no duplicate commit
    expect((await seed.repos.gitOperations.getById(operationId))?.commitSha).toBe(sha);
    expect((await seed.repos.annotations.getById(annotationId))?.status).toBe("open");
    expect((await seed.repos.outbox.getById(outboxId))?.status).toBe("done");
  });

  it("finalizes a row whose operation already reached committed", async () => {
    const { annotationId, operationId, outboxId } = await enqueueAnnotationCreate(seed);
    await processor.drain(seed.projectId);

    // Crash after the operation row was committed but before record/outbox
    // were finalized cannot happen with the atomic batch, but a Phase 5
    // queue consumer may retry a delivered message: replaying must be safe.
    await seed.repos.annotations.updateStatus(annotationId, "pending_git", nowIso());
    await seed.db
      .prepare(`UPDATE outbox SET status = 'processing', processed_at = NULL WHERE id = ?`)
      .bind(outboxId)
      .run();

    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("committed");
    expect(await commitCount()).toBe(2);
    expect((await seed.repos.gitOperations.getById(operationId))?.state).toBe("committed");
    expect((await seed.repos.annotations.getById(annotationId))?.status).toBe("open");
    expect((await seed.repos.outbox.getById(outboxId))?.status).toBe("done");
  });
});

describe("bounded retries", () => {
  class AlwaysConflictingWriter implements BookRepoWriter {
    calls = 0;
    commitFiles(_input: CommitFilesInput): Promise<never> {
      this.calls += 1;
      return Promise.reject(
        new GitWriteError("non-fast-forward", "branch head moved: simulated"),
      );
    }
  }

  it("retries a conflicting operation 3 times, then fails and surfaces the record", async () => {
    const writer = new AlwaysConflictingWriter();
    const failing = createProcessor({ db: seed.db, writer });
    const { annotationId, operationId, outboxId } = await enqueueAnnotationCreate(seed);

    const { outcomes } = await failing.drain(seed.projectId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result).toBe("failed");
    expect(writer.calls).toBe(3); // bounded retries (contract §5)

    const op = await seed.repos.gitOperations.getById(operationId);
    expect(op?.state).toBe("failed");
    expect(op?.attempts).toBe(3);
    expect(op?.error).toContain("simulated");

    // record surfaced: still pending_git, pointing at the failed operation
    const annotation = await seed.repos.annotations.getById(annotationId);
    expect(annotation?.status).toBe("pending_git");
    expect(annotation?.gitOperationId).toBe(operationId);

    const outbox = await seed.repos.outbox.getById(outboxId);
    expect(outbox?.status).toBe("failed");
  });

  it("a retry that succeeds clears the stored conflict error (no stale error on committed)", async () => {
    class ConflictOnceWriter implements BookRepoWriter {
      calls = 0;
      commitFiles(_input: CommitFilesInput): Promise<{ commitSha: string }> {
        this.calls += 1;
        if (this.calls === 1) {
          return Promise.reject(
            new GitWriteError("non-fast-forward", "branch head moved: expected X, found Y"),
          );
        }
        return Promise.resolve({ commitSha: "a".repeat(40) });
      }
    }
    const writer = new ConflictOnceWriter();
    const retrying = createProcessor({ db: seed.db, writer });
    const { operationId } = await enqueueAnnotationCreate(seed);

    const { outcomes } = await retrying.drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("committed");
    expect(writer.calls).toBe(2);

    const op = await seed.repos.gitOperations.getById(operationId);
    expect(op?.state).toBe("committed");
    expect(op?.commitSha).toBe("a".repeat(40));
    // Regression: COALESCE-based updates could never null `error`, so the
    // committed row still reported "branch head moved..." to the 202 poller.
    expect(op?.error).toBeNull();
  });

  it("fails non-retryable git errors immediately", async () => {
    class DirtyTreeWriter implements BookRepoWriter {
      calls = 0;
      commitFiles(_input: CommitFilesInput): Promise<never> {
        this.calls += 1;
        return Promise.reject(new GitWriteError("dirty-tree", "foreign changes"));
      }
    }
    const writer = new DirtyTreeWriter();
    const failing = createProcessor({ db: seed.db, writer });
    const { operationId } = await enqueueAnnotationCreate(seed);

    const { outcomes } = await failing.drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("failed");
    expect(writer.calls).toBe(1);
    const op = await seed.repos.gitOperations.getById(operationId);
    expect(op?.state).toBe("failed");
    expect(op?.error).toContain("foreign changes");
  });
});

describe("malformed work", () => {
  it("fails rows with an unknown kind without touching the repository", async () => {
    const { outboxId, operationId } = await enqueueAnnotationCreate(seed);
    await seed.db
      .prepare(`UPDATE outbox SET kind = 'unknown.kind' WHERE id = ?`)
      .bind(outboxId)
      .run();

    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("failed");
    expect(outcomes[0]?.error).toContain("unknown outbox kind");
    expect(await commitCount()).toBe(1); // only the fixture's initial commit
    expect((await seed.repos.gitOperations.getById(operationId))?.state).toBe("failed");
    expect((await seed.repos.outbox.getById(outboxId))?.status).toBe("failed");
  });

  it("only drains the requested project", async () => {
    await enqueueAnnotationCreate(seed);
    const { outcomes } = await processor.drain("00000000-0000-7000-8000-000000000000");
    expect(outcomes).toHaveLength(0);
    expect(await commitCount()).toBe(1);
  });
});

/**
 * Regression (Phase 6 §3.6). Every other pending-state owner has a release
 * path - `submission.apply` via `releaseFailedApplyStatements`, pending
 * annotations and replies via the rebuild sweep - and `book_config` was the
 * one that did not.
 *
 * A settings PATCH writes the new config to `book_configs` as `pending_git` in
 * the same batch as the outbox row, and ONLY a successful commit cleared it. So
 * when a settings commit dead-lettered, the row was terminal: the PATCH route
 * refuses further writes on that status, `projectBookConfig` short-circuits on
 * it so Git could never re-assert the committed `book.yml`, and
 * `resolveRuleEntries` kept reading - and therefore ENFORCING - governance
 * rules from a document no commit contains. That is exactly the "second
 * configuration store" §3.6 forbids, failing silently and permanently.
 */
describe("a dead-lettered book_config.update releases its projection row", () => {
  const CONFIG = {
    schema: "authorbot.book/v1",
    id: "01900000-0000-7000-8000-0000000000bb",
    title: "Committed Title",
    slug: "a-book",
    language: "en",
  } as const;

  /** Enqueue a settings write whose commit is guaranteed to fail. */
  async function enqueueDoomedSettingsWrite(previous: unknown): Promise<{
    operationId: string;
    outboxId: string;
  }> {
    const ts = nowIso();
    const operationId = uuidv7();
    const outboxId = uuidv7();
    await seed.db.batch([
      seed.repos.gitOperations.insertStatement({
        id: operationId,
        projectId: seed.projectId,
        correlationId: uuidv7(),
        expectedHead: null,
        state: "queued",
        attempts: 0,
        commitSha: null,
        error: null,
        createdAt: ts,
        updatedAt: ts,
      }),
      seed.repos.bookConfigs.upsertStatement({
        projectId: seed.projectId,
        config: { ...CONFIG, title: "Uncommitted Title" },
        status: "pending_git",
        gitOperationId: operationId,
        sourceCommit: null,
        createdAt: ts,
        updatedAt: ts,
      }),
      seed.repos.outbox.insertStatement({
        id: outboxId,
        projectId: seed.projectId,
        gitOperationId: operationId,
        kind: "book_config.update",
        payload: {
          // An actor id with no external identity: a failure mode
          // `failOperation`'s own doc comment names.
          actorId: "01900000-0000-7000-8000-00000000dead",
          config: { ...CONFIG, title: "Uncommitted Title" },
          changed: ["title"],
          ...(previous === undefined ? {} : { previousConfig: previous }),
        },
        status: "pending",
        attempts: 0,
        createdAt: ts,
        processedAt: null,
      }),
    ]);
    return { operationId, outboxId };
  }

  it("restores the last committed config so settings and governance recover", async () => {
    await enqueueDoomedSettingsWrite(CONFIG);

    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("failed");

    const row = await seed.repos.bookConfigs.get(seed.projectId);
    // Not stranded in `pending_git`: the PATCH route and `projectBookConfig`
    // both key off this status, so leaving it would brick both permanently.
    expect(row?.status).toBe("committed");
    expect(row?.gitOperationId).toBeNull();
    // And the config in force is the one that actually reached Git - not the
    // one whose commit failed.
    expect((row?.config as { title: string }).title).toBe("Committed Title");
  });

  it("drops the row when there is no committed config to fall back to", async () => {
    // A book's FIRST settings write has no predecessor. Dropping the row is
    // the honest state: the projection re-reads book.yml from Git, and
    // governance falls back to the deployment's bootstrap rules - the
    // stricter direction, so a failed commit can never leave a weakened rule
    // in force.
    await enqueueDoomedSettingsWrite(undefined);

    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("failed");
    expect(await seed.repos.bookConfigs.get(seed.projectId)).toBeNull();
  });

  it("does not revert a later settings write that already replaced the row", async () => {
    const { operationId } = await enqueueDoomedSettingsWrite(CONFIG);

    // A second PATCH lands on the row before the first one's failure is
    // processed - the compare-and-swap `markCommittedStatement` also relies on.
    const later = uuidv7();
    await seed.repos.gitOperations.insertStatement({
      id: later,
      projectId: seed.projectId,
      correlationId: uuidv7(),
      expectedHead: null,
      state: "queued",
      attempts: 0,
      commitSha: null,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }).run();
    await seed.repos.bookConfigs.upsert({
      projectId: seed.projectId,
      config: { ...CONFIG, title: "Newer Title" },
      status: "pending_git",
      gitOperationId: later,
      sourceCommit: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    await processor.drain(seed.projectId);

    const row = await seed.repos.bookConfigs.get(seed.projectId);
    expect(row?.gitOperationId).toBe(later);
    expect((row?.config as { title: string }).title).toBe("Newer Title");
    expect(operationId).not.toBe(later);
  });
});
