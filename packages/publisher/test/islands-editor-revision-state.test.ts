import { describe, expect, it } from "vitest";
import type { FeedEvent, Operation, RevisionProposalSummary } from "../site/src/islands/api.js";
import {
  acceptEditorRevision,
  beginEditorRevision,
  chapterEditorRevisionTarget,
  editorRevisionNeedsRecoveryWarning,
  publicationStateFromEvent,
  reconcileEditorRevisionEvent,
  reconcileEditorRevisionOperation,
  reconcileEditorRevisionProposal,
  reconcileEditorRevisionPublication,
  repositoryEditorRevisionTarget,
} from "../site/src/islands/editor-revision-state.js";

const event = (type: string, payload: Record<string, unknown>): FeedEvent => ({
  id: 1,
  type,
  payload,
});

describe("direct editor revision lifecycle", () => {
  it("adopts a response-racing proposal event and never regresses on the HTTP response", () => {
    const target = chapterEditorRevisionTarget("chapter-1");
    const saving = beginEditorRevision(target, "correlation-1");
    const created = reconcileEditorRevisionEvent(saving, event("revision_proposal_created", {
      proposalId: "proposal-1",
      correlationId: "correlation-1",
    }));
    const applying = reconcileEditorRevisionEvent(created, event("revision_proposal_approved", {
      proposalId: "proposal-1",
      operationId: "operation-1",
      correlationId: "correlation-1",
    }));

    expect(applying).toMatchObject({
      proposalId: "proposal-1",
      operationId: "operation-1",
      phase: "applying",
    });
    expect(acceptEditorRevision(applying, {
      proposalId: "proposal-1",
      operationId: "operation-1",
      correlationId: "correlation-1",
      status: "applying",
    }).phase).toBe("applying");

    const rejected = reconcileEditorRevisionEvent(created, event("revision_proposal_rejected", {
      proposalId: "proposal-1",
      correlationId: "correlation-1",
    }));
    expect(acceptEditorRevision(rejected, {
      proposalId: "proposal-1",
      operationId: "operation-1",
      correlationId: "correlation-1",
      status: "applying",
    })).toMatchObject({
      phase: "rejected",
      error: "The revision was rejected. The submitted draft is still available.",
    });
  });

  it("retains rejection and apply failures as recoverable draft states", () => {
    const target = repositoryEditorRevisionTarget("timeline", "story/timeline.yml");
    const pending = acceptEditorRevision(beginEditorRevision(target, "correlation-1"), {
      proposalId: "proposal-1",
      operationId: null,
      correlationId: "correlation-1",
      status: "pending_review",
    });
    const rejected = reconcileEditorRevisionProposal(pending, {
      id: "proposal-1",
      projectId: "project-1",
      chapterId: null,
      proposalType: "repository_document",
      origin: "direct_edit",
      workItemId: null,
      submissionId: null,
      authorActorId: "actor-1",
      baseRevision: null,
      changeSummary: null,
      notes: null,
      status: "rejected",
      reviewedByActorId: "maintainer-1",
      reviewedAt: "2026-07-22T00:00:00Z",
      reviewReason: "Needs another pass.",
      gitOperationId: null,
      resultingRevision: null,
      commitSha: null,
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:01:00Z",
    } satisfies RevisionProposalSummary);
    expect(rejected).toMatchObject({ phase: "rejected", error: "Needs another pass." });
    expect(editorRevisionNeedsRecoveryWarning(rejected)).toBe(true);

    const operation: Operation = {
      id: "operation-1",
      projectId: "project-1",
      correlationId: "correlation-1",
      state: "failed",
      attempts: 1,
      error: "base content changed",
      commitSha: null,
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:01:00Z",
    };
    const failed = reconcileEditorRevisionOperation(
      { ...pending, phase: "applying", operationId: operation.id },
      operation,
    );
    expect(failed).toMatchObject({ phase: "apply_failed", error: "base content changed" });
    expect(editorRevisionNeedsRecoveryWarning(failed)).toBe(true);
  });

  it("keeps published content unchanged until the matching deployment is reported", () => {
    const target = chapterEditorRevisionTarget("chapter-1");
    const pending = acceptEditorRevision(beginEditorRevision(target, "correlation-1"), {
      proposalId: "proposal-1",
      operationId: "operation-1",
      correlationId: "correlation-1",
      status: "applying",
    });
    const integrated = reconcileEditorRevisionEvent(pending, event("revision_proposal_applied", {
      revisionProposalId: "proposal-1",
      commitSha: "a".repeat(40),
    }));
    expect(integrated.phase).toBe("integrated");

    const unrelated = publicationStateFromEvent(event("publication_updated", {
      integratedCommit: "b".repeat(40),
      buildStatus: "succeeded",
      deployedCommit: "b".repeat(40),
    }));
    expect(unrelated).not.toBeNull();
    expect(reconcileEditorRevisionPublication(integrated, unrelated!).phase).toBe("integrated");

    const building = publicationStateFromEvent(event("publication_updated", {
      integratedCommit: "a".repeat(40),
      buildStatus: "building",
      deployedCommit: null,
    }));
    const publishing = reconcileEditorRevisionPublication(integrated, building!);
    expect(publishing.phase).toBe("publishing");

    const deployed = publicationStateFromEvent(event("publication_updated", {
      integratedCommit: "a".repeat(40),
      buildStatus: "succeeded",
      deployedCommit: "a".repeat(40),
    }));
    const deployedState = reconcileEditorRevisionPublication(publishing, deployed!);
    expect(deployedState).toMatchObject({
      phase: "deployed",
      commitSha: "a".repeat(40),
    });

    const staleRejection = reconcileEditorRevisionEvent(
      deployedState,
      event("revision_proposal_rejected", { proposalId: "proposal-1" }),
    );
    expect(staleRejection).toMatchObject({ phase: "deployed", error: null });
    expect(reconcileEditorRevisionPublication(staleRejection, {
      integratedCommit: "a".repeat(40),
      buildStatus: "failed",
      deployedCommit: null,
    })).toMatchObject({ phase: "deployed", error: null });
  });
});
