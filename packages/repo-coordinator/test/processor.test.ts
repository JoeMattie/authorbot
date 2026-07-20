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
  git,
  initGitRepo,
  nowIso,
  setupDatabase,
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

  it("commits replies and withdrawals as separate logical mutations", async () => {
    const created = await enqueueAnnotationCreate(seed);
    await processor.drain(seed.projectId);

    const reply = await enqueueReplyCreate(seed, created.annotationId);
    const withdraw = await enqueueAnnotationWithdraw(seed, created.annotationId);
    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes.map((o) => o.result)).toEqual(["committed", "committed"]);
    expect(await commitCount()).toBe(4); // initial + create + reply + withdraw

    // reply artifact
    const replyContent = await readFile(
      join(repo.dir, replyFilePath(created.annotationId, reply.replyId)),
      "utf8",
    );
    const parsedReply = replySchema.parse(parseChapterMarkdown(replyContent).frontmatter);
    expect(parsedReply.id).toBe(reply.replyId);
    expect(parsedReply.annotation_id).toBe(created.annotationId);
    const replyRecord = await seed.repos.replies.getById(reply.replyId);
    expect(replyRecord?.status).toBe("open");

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
