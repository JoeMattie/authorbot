import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "../src/sql.js";
import type {
  ActorRecord,
  GitOperationRecord,
  ProjectRecord,
  RevisionProposalRecord,
} from "../src/records.js";
import { NOW, seedBasics, uuidv7, type Seeded } from "./helpers.js";

const REVIEWED_AT = "2026-07-19T18:05:00Z";
const APPLIED_AT = "2026-07-19T18:06:00Z";

function makeProposal(
  seeded: Seeded,
  overrides?: Partial<RevisionProposalRecord>,
): RevisionProposalRecord {
  return {
    id: uuidv7(),
    projectId: seeded.project.id,
    chapterId: seeded.chapter.id,
    proposalType: "chapter_replacement",
    origin: "direct_edit",
    workItemId: null,
    submissionId: null,
    authorActorId: seeded.actor.id,
    baseRevision: seeded.chapter.revision,
    baseContentHash: "sha256:before",
    baseContent: "# Signal\n\nBefore.\n",
    proposedContent: "# Signal\n\nAfter.\n",
    changeSummary: "Tighten the opening.",
    notes: "Preserve the beat at the end.",
    status: "pending_review",
    reviewedByActorId: null,
    reviewedAt: null,
    reviewReason: null,
    gitOperationId: null,
    resultingRevision: null,
    commitSha: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeGitOperation(seeded: Seeded): GitOperationRecord {
  return {
    id: uuidv7(),
    projectId: seeded.project.id,
    correlationId: uuidv7(),
    expectedHead: "base-commit",
    state: "queued",
    attempts: 0,
    commitSha: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("revision proposal persistence", () => {
  it("inserts, reads, filters, pages, and resolves work/submission identities", async () => {
    const s = await seedBasics();
    const workItemId = uuidv7();
    const submissionId = uuidv7();
    const workProposal = makeProposal(s, {
      origin: "work_submission",
      workItemId,
      submissionId,
    });
    const directProposal = makeProposal(s);
    const otherChapterProposal = makeProposal(s, {
      chapterId: uuidv7(),
      proposalType: "chapter_summary",
      origin: "summary_proposal",
    });
    for (const proposal of [workProposal, directProposal, otherChapterProposal]) {
      await s.repos.revisionProposals.insert(proposal);
    }
    await s.repos.revisionProposals.transitionStatus(
      directProposal.id,
      "pending_review",
      "withdrawn",
      REVIEWED_AT,
    );

    expect(await s.repos.revisionProposals.getById(workProposal.id)).toEqual(workProposal);
    expect(await s.repos.revisionProposals.getBySubmissionId(submissionId)).toEqual(workProposal);
    expect(await s.repos.revisionProposals.getBySubmissionId(uuidv7())).toBeNull();
    expect(await s.repos.revisionProposals.listByWorkItem(workItemId)).toEqual([workProposal]);

    const expectedIds = [workProposal.id, directProposal.id, otherChapterProposal.id].sort();
    const firstPage = await s.repos.revisionProposals.listByProject(s.project.id, { limit: 2 });
    expect(firstPage.map(({ id }) => id)).toEqual(expectedIds.slice(0, 2));
    const secondPage = await s.repos.revisionProposals.listByProject(s.project.id, {
      afterId: expectedIds[1] ?? "",
      limit: 2,
    });
    expect(secondPage.map(({ id }) => id)).toEqual(expectedIds.slice(2));
    expect(
      await s.repos.revisionProposals.listByProject(s.project.id, {
        status: "pending_review",
        chapterId: s.chapter.id,
      }),
    ).toEqual([workProposal]);
    s.db.close();
  });

  it("enforces work-backed identity, unique submissions, and a clean pending review envelope", async () => {
    const s = await seedBasics();
    await expect(
      s.repos.revisionProposals.insert(
        makeProposal(s, { origin: "work_submission", workItemId: uuidv7() }),
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      s.repos.revisionProposals.insert(makeProposal(s, { reviewReason: "Already reviewed." })),
    ).rejects.toThrow(/CHECK constraint failed/);

    const submissionId = uuidv7();
    const first = makeProposal(s, {
      origin: "work_submission",
      workItemId: uuidv7(),
      submissionId,
    });
    await s.repos.revisionProposals.insert(first);
    let duplicateError: unknown;
    try {
      await s.repos.revisionProposals.insert(
        makeProposal(s, {
          origin: "work_submission",
          workItemId: uuidv7(),
          submissionId,
        }),
      );
    } catch (error) {
      duplicateError = error;
    }
    expect(isUniqueConstraintError(duplicateError)).toBe(true);
    s.db.close();
  });

  it("keeps every proposal payload and identity field immutable after insertion", async () => {
    const s = await seedBasics();
    const otherProject: ProjectRecord = {
      ...s.project,
      id: uuidv7(),
      slug: "other-book",
      repo: "JoeMattie/other-book",
    };
    const otherActor: ActorRecord = {
      ...s.actor,
      id: uuidv7(),
      externalIdentity: "github:other-maintainer",
    };
    await s.repos.projects.insert(otherProject);
    await s.repos.actors.insert(otherActor);
    const proposal = makeProposal(s, {
      origin: "work_submission",
      workItemId: uuidv7(),
      submissionId: uuidv7(),
    });
    await s.repos.revisionProposals.insert(proposal);

    const changes: Array<{ sql: string; values: Array<string | number | null> }> = [
      { sql: "project_id = ?", values: [otherProject.id] },
      { sql: "chapter_id = ?", values: [uuidv7()] },
      { sql: "proposal_type = ?", values: ["chapter_summary"] },
      {
        sql: "origin = ?, work_item_id = ?, submission_id = ?",
        values: ["direct_edit", null, null],
      },
      { sql: "work_item_id = ?", values: [uuidv7()] },
      { sql: "submission_id = ?", values: [uuidv7()] },
      { sql: "author_actor_id = ?", values: [otherActor.id] },
      { sql: "base_revision = ?", values: [2] },
      { sql: "base_content_hash = ?", values: ["sha256:different"] },
      { sql: "base_content = ?", values: ["Different base."] },
      { sql: "proposed_content = ?", values: ["Different proposal."] },
      { sql: "change_summary = ?", values: ["Different summary."] },
      { sql: "notes = ?", values: ["Different notes."] },
      { sql: "created_at = ?", values: [REVIEWED_AT] },
    ];
    for (const change of changes) {
      await expect(
        s.db
          .prepare(`UPDATE revision_proposals SET ${change.sql} WHERE id = ?`)
          .bind(...change.values, proposal.id)
          .run(),
      ).rejects.toThrow("revision proposal payload is immutable");
    }
    expect(await s.repos.revisionProposals.getById(proposal.id)).toEqual(proposal);
    s.db.close();
  });
});

describe("revision proposal review lifecycle", () => {
  it("guards simple status transitions with the expected current status", async () => {
    const s = await seedBasics();
    const proposal = makeProposal(s);
    await s.repos.revisionProposals.insert(proposal);
    expect(
      await s.repos.revisionProposals.transitionStatus(
        proposal.id,
        "applying",
        "withdrawn",
        REVIEWED_AT,
      ),
    ).toBe(0);
    expect(
      await s.repos.revisionProposals.transitionStatus(
        proposal.id,
        "pending_review",
        "withdrawn",
        REVIEWED_AT,
      ),
    ).toBe(1);
    expect(
      await s.repos.revisionProposals.transitionStatus(
        proposal.id,
        "pending_review",
        "withdrawn",
        REVIEWED_AT,
      ),
    ).toBe(0);
    expect(await s.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "withdrawn",
      updatedAt: REVIEWED_AT,
    });
    s.db.close();
  });

  it("records rejection metadata atomically and cannot review a stale proposal", async () => {
    const s = await seedBasics();
    const proposal = makeProposal(s);
    await s.repos.revisionProposals.insert(proposal);
    const review = {
      status: "rejected" as const,
      reviewedByActorId: s.actor.id,
      reviewedAt: REVIEWED_AT,
      reviewReason: "The revision drops a required continuity beat.",
      updatedAt: REVIEWED_AT,
    };
    expect(
      await s.repos.revisionProposals.transitionReview(
        proposal.id,
        "pending_review",
        review,
      ),
    ).toBe(1);
    expect(
      await s.repos.revisionProposals.transitionReview(
        proposal.id,
        "pending_review",
        review,
      ),
    ).toBe(0);
    expect(await s.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "rejected",
      reviewedByActorId: s.actor.id,
      reviewedAt: REVIEWED_AT,
      reviewReason: review.reviewReason,
      gitOperationId: null,
    });
    s.db.close();
  });

  it("links approval to Git, then finalizes its revision without losing review metadata", async () => {
    const s = await seedBasics();
    const proposal = makeProposal(s);
    const operation = makeGitOperation(s);
    await s.repos.revisionProposals.insert(proposal);
    await s.repos.gitOperations.insert(operation);
    expect(
      await s.repos.revisionProposals.transitionReview(proposal.id, "pending_review", {
        status: "applying",
        reviewedByActorId: s.actor.id,
        reviewedAt: REVIEWED_AT,
        reviewReason: null,
        gitOperationId: operation.id,
        updatedAt: REVIEWED_AT,
      }),
    ).toBe(1);
    expect(
      await s.repos.revisionProposals.finalize(proposal.id, "pending_review", {
        status: "approved",
        resultingRevision: 2,
        commitSha: "deadbeef",
        updatedAt: APPLIED_AT,
      }),
    ).toBe(0);
    expect(
      await s.repos.revisionProposals.finalize(proposal.id, "applying", {
        status: "approved",
        resultingRevision: 2,
        commitSha: "deadbeef",
        updatedAt: APPLIED_AT,
      }),
    ).toBe(1);
    expect(await s.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "approved",
      reviewedByActorId: s.actor.id,
      reviewedAt: REVIEWED_AT,
      gitOperationId: operation.id,
      resultingRevision: 2,
      commitSha: "deadbeef",
      updatedAt: APPLIED_AT,
    });
    s.db.close();
  });

  it("finalizes conflicts without inventing a commit or resulting revision", async () => {
    const s = await seedBasics();
    const proposal = makeProposal(s);
    const operation = makeGitOperation(s);
    await s.repos.revisionProposals.insert(proposal);
    await s.repos.gitOperations.insert(operation);
    await s.repos.revisionProposals.transitionReview(proposal.id, "pending_review", {
      status: "applying",
      reviewedByActorId: s.actor.id,
      reviewedAt: REVIEWED_AT,
      reviewReason: null,
      gitOperationId: operation.id,
      updatedAt: REVIEWED_AT,
    });
    expect(
      await s.repos.revisionProposals.finalize(proposal.id, "applying", {
        status: "conflicted",
        updatedAt: APPLIED_AT,
      }),
    ).toBe(1);
    expect(await s.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "conflicted",
      gitOperationId: operation.id,
      resultingRevision: null,
      commitSha: null,
    });
    s.db.close();
  });
});
