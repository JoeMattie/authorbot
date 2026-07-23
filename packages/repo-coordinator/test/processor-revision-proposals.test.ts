import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GitOperationRecord,
  OutboxRecord,
  RevisionProposalRecord,
} from "@authorbot/database";
import {
  createProcessor,
  type BookRepoWriter,
  type ChapterComposer,
  type CommitFilesInput,
  type SubmissionApplier,
} from "../src/index.js";
import {
  chapterSourceFixture,
  enqueueSubmissionApply,
  nowIso,
  setupDatabase,
  uuidv7,
  type EnqueuedApply,
  type SeededDatabase,
} from "./helpers.js";

const COMMIT_SHA = "c".repeat(40);
const HEAD_SHA = "a".repeat(40);

let seed: SeededDatabase;

beforeEach(async () => {
  seed = await setupDatabase();
});

afterEach(() => {
  seed.db.close();
});

class MemoryWriter implements BookRepoWriter {
  readonly commits: CommitFilesInput[] = [];

  commitFiles(input: CommitFilesInput): Promise<{ commitSha: string }> {
    this.commits.push(input);
    return Promise.resolve({ commitSha: COMMIT_SHA });
  }

  readFile(): Promise<null> {
    return Promise.resolve(null);
  }

  resolveHead(): Promise<string> {
    return Promise.resolve(HEAD_SHA);
  }
}

function proposalFixture(
  operationId: string,
  overrides: Partial<RevisionProposalRecord> = {},
): RevisionProposalRecord {
  const ts = nowIso();
  return {
    id: uuidv7(),
    projectId: seed.projectId,
    chapterId: seed.chapterId,
    targetKind: "chapter",
    targetId: seed.chapterId,
    targetPath: "chapters/01-signal.md",
    proposalType: "chapter_replacement",
    origin: "direct_edit",
    workItemId: null,
    submissionId: null,
    authorActorId: seed.actorId,
    baseRevision: 2,
    baseContentHash: "sha256:before",
    baseContent: "Before.\n",
    proposedContent: "After.\n",
    changeSummary: "Revise the chapter.",
    notes: null,
    status: "applying",
    reviewedByActorId: seed.actorId,
    reviewedAt: ts,
    reviewReason: null,
    gitOperationId: operationId,
    resultingRevision: null,
    commitSha: null,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

async function insertSubmissionProposal(apply: EnqueuedApply): Promise<RevisionProposalRecord> {
  const proposal = proposalFixture(apply.operationId, {
    origin: "work_submission",
    workItemId: apply.workItemId,
    submissionId: apply.submissionId,
  });
  await seed.repos.revisionProposals.insert(proposal);
  return proposal;
}

function appliedApplier(): SubmissionApplier {
  return {
    apply: () =>
      Promise.resolve({
        result: "applied" as const,
        chapterPath: "chapters/01-signal.md",
        patchedSource: chapterSourceFixture(seed.chapterId, 2),
        newRevision: 3,
        blockIds: [],
      }),
  };
}

function conflictApplier(): SubmissionApplier {
  return {
    apply: () =>
      Promise.resolve({
        result: "conflict" as const,
        reason: "the chapter changed while the proposal was under review",
        currentText: "Newer chapter text.",
        currentRevision: 3,
        conflictWorkItemId: uuidv7(),
      }),
  };
}

async function eventPayload(type: string): Promise<Record<string, unknown> | null> {
  const event = (await seed.repos.events.listAfter(seed.projectId, 0)).find(
    (candidate) => candidate.type === type,
  );
  return (event?.payload as Record<string, unknown> | undefined) ?? null;
}

describe("reviewed work-submission proposals", () => {
  it("finalizes an applied proposal with the landed revision and commit", async () => {
    const apply = await enqueueSubmissionApply(seed);
    const proposal = await insertSubmissionProposal(apply);
    const writer = new MemoryWriter();

    const result = await createProcessor({
      db: seed.db,
      writer,
      submissionApplier: appliedApplier(),
    }).drain(seed.projectId);

    expect(result.outcomes[0]).toMatchObject({ result: "committed", commitSha: COMMIT_SHA });
    expect(await seed.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "approved",
      resultingRevision: 3,
      commitSha: COMMIT_SHA,
      reviewedByActorId: seed.actorId,
    });
    expect(await eventPayload("work_item_completed")).toMatchObject({
      workItemId: apply.workItemId,
      submissionId: apply.submissionId,
      revisionProposalId: proposal.id,
      revision: 3,
    });
    expect(await eventPayload("revision_proposal_applied")).toMatchObject({
      revisionProposalId: proposal.id,
      chapterId: seed.chapterId,
      targetKind: "chapter",
      proposalType: "chapter_replacement",
      workItemId: apply.workItemId,
      submissionId: apply.submissionId,
      commitSha: COMMIT_SHA,
    });
  });

  it("finalizes a committed conflict and exposes the proposal id in the conflict event", async () => {
    const apply = await enqueueSubmissionApply(seed);
    const proposal = await insertSubmissionProposal(apply);

    const result = await createProcessor({
      db: seed.db,
      writer: new MemoryWriter(),
      submissionApplier: conflictApplier(),
    }).drain(seed.projectId);

    expect(result.outcomes[0]?.result).toBe("committed");
    expect(await seed.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "conflicted",
      resultingRevision: null,
      commitSha: null,
    });
    expect(await eventPayload("work_item_conflict")).toMatchObject({
      submissionId: apply.submissionId,
      revisionProposalId: proposal.id,
    });
    expect(await eventPayload("revision_proposal_conflicted")).toMatchObject({
      revisionProposalId: proposal.id,
      chapterId: seed.chapterId,
      targetKind: "chapter",
      proposalType: "chapter_replacement",
      workItemId: apply.workItemId,
      submissionId: apply.submissionId,
    });
  });

  it("marks the proposal conflicted when the apply operation fails terminally", async () => {
    const apply = await enqueueSubmissionApply(seed);
    const proposal = await insertSubmissionProposal(apply);

    // No SubmissionApplier: the operation fails before any Git write.
    const result = await createProcessor({ db: seed.db, writer: new MemoryWriter() }).drain(
      seed.projectId,
    );

    expect(result.outcomes[0]?.result).toBe("failed");
    expect(await seed.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "conflicted",
      resultingRevision: null,
      commitSha: null,
    });
    expect(await eventPayload("work_item_conflict")).toMatchObject({
      submissionId: apply.submissionId,
      revisionProposalId: proposal.id,
    });
    expect(await eventPayload("revision_proposal_conflicted")).toMatchObject({
      revisionProposalId: proposal.id,
      chapterId: seed.chapterId,
      targetKind: "chapter",
      proposalType: "chapter_replacement",
      workItemId: apply.workItemId,
      submissionId: apply.submissionId,
    });
  });

  it("releases a proposal when a resumed operation is already terminally failed", async () => {
    const apply = await enqueueSubmissionApply(seed);
    const proposal = await insertSubmissionProposal(apply);
    await seed.repos.gitOperations.updateState(apply.operationId, {
      state: "failed",
      error: "worker stopped after persisting failure",
      updatedAt: nowIso(),
    });

    const result = await createProcessor({ db: seed.db, writer: new MemoryWriter() }).drain(
      seed.projectId,
    );

    expect(result.outcomes[0]).toMatchObject({
      result: "failed",
      error: "worker stopped after persisting failure",
    });
    expect((await seed.repos.revisionProposals.getById(proposal.id))?.status).toBe("conflicted");
    expect((await seed.repos.submissions.getById(apply.submissionId))?.state).toBe("conflicted");
  });

  it("refuses a proposal without the exact apply operation before writing Git", async () => {
    const apply = await enqueueSubmissionApply(seed);
    const proposal = await insertSubmissionProposal(apply);
    await seed.db
      .prepare(`UPDATE revision_proposals SET git_operation_id = NULL WHERE id = ?`)
      .bind(proposal.id)
      .run();
    const writer = new MemoryWriter();

    const result = await createProcessor({
      db: seed.db,
      writer,
      submissionApplier: appliedApplier(),
    }).drain(seed.projectId);

    expect(result.outcomes[0]).toMatchObject({ result: "failed" });
    expect(result.outcomes[0]?.error).toContain("belongs to git operation null");
    expect(writer.commits).toHaveLength(0);
    expect(await seed.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "applying",
      gitOperationId: null,
      resultingRevision: null,
      commitSha: null,
    });
  });
});

interface EnqueuedChapterWrite {
  operationId: string;
  outboxId: string;
  proposal: RevisionProposalRecord | null;
}

async function enqueueChapterWrite(
  withProposal: boolean,
  proposalOverrides: Partial<RevisionProposalRecord> = {},
): Promise<EnqueuedChapterWrite> {
  const ts = nowIso();
  const operationId = uuidv7();
  const outboxId = uuidv7();
  const proposal = withProposal ? proposalFixture(operationId, proposalOverrides) : null;
  const operation: GitOperationRecord = {
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
  };
  const outbox: OutboxRecord = {
    id: outboxId,
    projectId: seed.projectId,
    gitOperationId: operationId,
    kind: "chapter.write",
    payload: {
      chapterId: seed.chapterId,
      action: "revise",
      actorId: seed.actorId,
      ...(proposal === null ? {} : { revisionProposalId: proposal.id }),
      intent: { baseRevision: 2, body: "After.\n" },
    },
    status: "pending",
    attempts: 0,
    createdAt: ts,
    processedAt: null,
  };
  await seed.db.batch([
    seed.repos.gitOperations.insertStatement(operation),
    ...(proposal === null ? [] : [seed.repos.revisionProposals.insertStatement(proposal)]),
    seed.repos.outbox.insertStatement(outbox),
  ]);
  return { operationId, outboxId, proposal };
}

function chapterComposer(): ChapterComposer {
  return {
    compose: () =>
      Promise.resolve({
        chapterPath: "chapters/01-signal.md",
        content: chapterSourceFixture(seed.chapterId, 3),
        slug: "signal",
        title: "Signal",
        summary: "Current signal summary.",
        order: 10,
        status: "draft" as const,
        revision: 3,
        contentHash: "sha256:after",
        blockIds: [],
        message: "Apply approved chapter revision",
      }),
  };
}

describe("reviewed direct chapter writes", () => {
  it("finalizes a linked proposal in the chapter projection/event batch", async () => {
    const queued = await enqueueChapterWrite(true);
    const writer = new MemoryWriter();

    const result = await createProcessor({
      db: seed.db,
      writer,
      chapterComposer: chapterComposer(),
    }).drain(seed.projectId);

    expect(result.outcomes[0]).toMatchObject({ result: "committed", commitSha: COMMIT_SHA });
    expect(await seed.repos.revisionProposals.getById(queued.proposal?.id ?? "")).toMatchObject({
      status: "approved",
      resultingRevision: 3,
      commitSha: COMMIT_SHA,
    });
    expect(await eventPayload("chapter_revised")).toMatchObject({
      chapterId: seed.chapterId,
      revisionProposalId: queued.proposal?.id,
      revision: 3,
    });
    expect(await eventPayload("revision_proposal_applied")).toMatchObject({
      revisionProposalId: queued.proposal?.id,
      chapterId: seed.chapterId,
      targetKind: "chapter",
      proposalType: "chapter_replacement",
      commitSha: COMMIT_SHA,
    });
    expect(await eventPayload("operation_completed")).toMatchObject({
      operationId: queued.operationId,
      kind: "chapter.write",
      revisionProposalId: queued.proposal?.id,
    });
  });

  it("keeps legacy chapter.write payloads and event shapes unchanged", async () => {
    await enqueueChapterWrite(false);

    const result = await createProcessor({
      db: seed.db,
      writer: new MemoryWriter(),
      chapterComposer: chapterComposer(),
    }).drain(seed.projectId);

    expect(result.outcomes[0]?.result).toBe("committed");
    expect(await eventPayload("chapter_revised")).toEqual({
      chapterId: seed.chapterId,
      slug: "signal",
      title: "Signal",
      status: "draft",
      revision: 3,
      path: "chapters/01-signal.md",
    });
    expect(await eventPayload("operation_completed")).toMatchObject({
      directChapterWrite: true,
      kind: "chapter.write",
    });
  });

  it("marks the linked proposal conflicted when composition fails", async () => {
    const queued = await enqueueChapterWrite(true);
    const writer = new MemoryWriter();
    const failingComposer: ChapterComposer = {
      compose: () => Promise.reject(new Error("base revision is stale")),
    };

    const result = await createProcessor({
      db: seed.db,
      writer,
      chapterComposer: failingComposer,
    }).drain(seed.projectId);

    expect(result.outcomes[0]).toMatchObject({
      result: "failed",
      error: "base revision is stale",
    });
    expect(writer.commits).toHaveLength(0);
    expect(await seed.repos.revisionProposals.getById(queued.proposal?.id ?? "")).toMatchObject({
      status: "conflicted",
      resultingRevision: null,
      commitSha: null,
    });
    expect(await eventPayload("revision_proposal_conflicted")).toMatchObject({
      revisionProposalId: queued.proposal?.id,
      chapterId: seed.chapterId,
      targetKind: "chapter",
      proposalType: "chapter_replacement",
      reason: "base revision is stale",
    });
  });

  it.each([
    {
      label: "pending",
      overrides: {
        status: "pending_review" as const,
        reviewedByActorId: null,
        reviewedAt: null,
        gitOperationId: null,
      },
      expectedStatus: "pending_review",
    },
    {
      label: "rejected",
      overrides: { status: "rejected" as const },
      expectedStatus: "rejected",
    },
  ])("refuses a $label proposal before writing Git", async ({ overrides, expectedStatus }) => {
    const queued = await enqueueChapterWrite(true, overrides);
    const writer = new MemoryWriter();

    const result = await createProcessor({
      db: seed.db,
      writer,
      chapterComposer: chapterComposer(),
    }).drain(seed.projectId);

    expect(result.outcomes[0]).toMatchObject({ result: "failed" });
    expect(result.outcomes[0]?.error).toContain(`is ${expectedStatus}, not applying`);
    expect(writer.commits).toHaveLength(0);
    expect(await seed.repos.revisionProposals.getById(queued.proposal?.id ?? "")).toMatchObject({
      status: expectedStatus,
      resultingRevision: null,
      commitSha: null,
    });
  });

  it("refuses a proposal belonging to another Git operation before writing Git", async () => {
    const queued = await enqueueChapterWrite(true);
    const otherOperationId = uuidv7();
    const ts = nowIso();
    await seed.repos.gitOperations.insert({
      id: otherOperationId,
      projectId: seed.projectId,
      correlationId: uuidv7(),
      expectedHead: null,
      state: "queued",
      attempts: 0,
      commitSha: null,
      error: null,
      createdAt: ts,
      updatedAt: ts,
    });
    await seed.db
      .prepare(`UPDATE revision_proposals SET git_operation_id = ? WHERE id = ?`)
      .bind(otherOperationId, queued.proposal?.id ?? "")
      .run();
    const writer = new MemoryWriter();

    const result = await createProcessor({
      db: seed.db,
      writer,
      chapterComposer: chapterComposer(),
    }).drain(seed.projectId);

    expect(result.outcomes[0]).toMatchObject({ result: "failed" });
    expect(result.outcomes[0]?.error).toContain(
      `belongs to git operation ${otherOperationId}`,
    );
    expect(writer.commits).toHaveLength(0);
    expect(await seed.repos.revisionProposals.getById(queued.proposal?.id ?? "")).toMatchObject({
      status: "applying",
      gitOperationId: otherOperationId,
      resultingRevision: null,
      commitSha: null,
    });
  });
});
