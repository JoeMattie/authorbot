import { describe, expect, it } from "vitest";
import type { EventRecord } from "@authorbot/database";
import type { EditorialCapability } from "@authorbot/domain";
import { createTokenEventProjector } from "../src/token-event-visibility.js";

function event(type: string, payload: Record<string, unknown>): EventRecord {
  return {
    id: 1,
    projectId: "project-one",
    type,
    payload,
    createdAt: "2026-07-22T12:00:00Z",
  };
}

function project(
  capabilities: EditorialCapability[],
  type: string,
  payload: Record<string, unknown>,
): EventRecord | null {
  return createTokenEventProjector(capabilities)(event(type, payload));
}

function votes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvals: 1,
    rejections: 0,
    abstentions: 0,
    netScore: 1,
    distinctVoters: 1,
    humanApprovals: 1,
    agentApprovals: 0,
    maintainerApprovals: 0,
    humanMaintainerApprovals: 0,
    ...overrides,
  };
}

describe("canonical token event projection", () => {
  it("fails closed for empty grants, unknown event types, and non-object payloads", () => {
    expect(project([], "annotation_created", { kind: "comment" })).toBeNull();
    expect(project(["chapters:read"], "future_control_event", { chapterId: "one" }))
      .toBeNull();
    expect(createTokenEventProjector(["chapters:read"])(
      { ...event("chapter_revised", {}), payload: "not-an-object" },
    )).toBeNull();
    expect(createTokenEventProjector(["chapters:read"])(
      { ...event("chapter_revised", {}), payload: [] },
    )).toBeNull();
    expect(project(["chapters:read"], "chapter_revised", {})).toBeNull();
    expect(project(["work:read"], "work_item_leased", {})).toBeNull();
    expect(project(
      ["comments:read", "suggestions:read"],
      "annotation_created",
      { annotationId: "future", kind: "future-private-kind" },
    )).toBeNull();
    expect(project(
      ["comments:read", "suggestions:read"],
      "annotation_created",
      { annotationId: "conflict", kind: "comment", annotationKind: "suggestion" },
    )).toBeNull();
    expect(project(
      ["comments:read"],
      "vote_aggregate",
      { annotationId: "malformed-votes", annotationKind: "comment", votes: [] },
    )).toBeNull();
    expect(project(
      ["revisions:read"],
      "revision_proposal_created",
      { proposalId: "missing-target-kind" },
    )).toBeNull();
    expect(project(
      ["revisions:read"],
      "revision_proposal_created",
      {
        proposalId: "future-target-kind",
        targetKind: "private-document",
        proposalType: "repository_document",
        targetId: "private",
        targetPath: "private.md",
      },
    )).toBeNull();
    expect(project(
      ["revisions:read"],
      "revision_proposal_created",
      {
        proposalId: "incompatible-type",
        targetKind: "outline",
        proposalType: "chapter_replacement",
        targetId: "outline",
        targetPath: "story/outline.md",
      },
    )).toBeNull();
    expect(project(
      ["comments:read"],
      "decision_support_changed",
      {
        decisionId: "comment-decision",
        annotationId: "comment",
        annotationKind: "comment",
        supportChanged: true,
        transition: "marked",
      },
    )).toBeNull();
    expect(project(
      ["suggestions:read"],
      "decision_support_changed",
      {
        decisionId: "missing-state",
        annotationId: "suggestion",
        annotationKind: "suggestion",
        transition: "marked",
      },
    )).toBeNull();
    expect(project(
      ["suggestions:read"],
      "decision_support_changed",
      {
        decisionId: "inconsistent-state",
        annotationId: "suggestion",
        annotationKind: "suggestion",
        supportChanged: false,
        transition: "marked",
      },
    )).toBeNull();
    expect(project(
      ["comments:read", "work:read"],
      "decision_created",
      {
        decisionId: "conflicting-action",
        annotationId: "comment",
        annotationKind: "comment",
        decisionActionType: "reject_suggestion",
        result: "rejected",
        override: "cancel",
        workItemId: "work",
      },
    )).toBeNull();
    expect(project(
      ["suggestions:read", "work:read"],
      "decision_created",
      {
        decisionId: "not-genuinely-legacy",
        annotationId: "suggestion",
        annotationKind: "suggestion",
        result: "overridden",
        override: "cancel",
        workItemId: "work",
      },
    )).toBeNull();
  });

  it("keeps comment and suggestion reads independent", () => {
    const payload = {
      annotationId: "annotation-one",
      chapterId: "chapter-one",
      scope: "block",
      internalSecret: "do-not-copy",
    };
    expect(project(["comments:read"], "annotation_created", {
      ...payload,
      kind: "comment",
    })?.payload).toEqual({
      annotationId: "annotation-one",
      kind: "comment",
      scope: "block",
    });
    expect(project(["comments:read", "chapters:read"], "annotation_created", {
      ...payload,
      kind: "comment",
    })?.payload).toEqual({
      annotationId: "annotation-one",
      chapterId: "chapter-one",
      kind: "comment",
      scope: "block",
    });
    expect(project(["comments:read"], "annotation_created", {
      ...payload,
      kind: "suggestion",
    })).toBeNull();
    expect(project(["suggestions:read"], "vote_aggregate", {
      annotationId: "annotation-two",
      annotationKind: "suggestion",
      votes: votes({ approvals: 2, netScore: 2, internalSecret: 99 }),
    })?.payload).toEqual({
      annotationId: "annotation-two",
      kind: "suggestion",
      votes: votes({ approvals: 2, netScore: 2 }),
    });
  });

  it("requires both feedback reads for legacy rows whose kind is unavailable", () => {
    const payload = { annotationId: "old-annotation", votes: votes() };
    expect(project(["comments:read"], "vote_aggregate", payload)).toBeNull();
    expect(project(["suggestions:read"], "vote_aggregate", payload)).toBeNull();
    expect(project(
      ["comments:read", "suggestions:read"],
      "vote_aggregate",
      payload,
    )).not.toBeNull();
  });

  it("does not carry cross-domain identifiers without both read capabilities", () => {
    const workPayload = {
      workItemId: "work-one",
      submissionId: "submission-one",
      chapterId: "chapter-one",
      revision: 8,
      revisionProposalId: "proposal-one",
      internalSecret: "do-not-copy",
    };
    expect(project(["work:read"], "work_item_completed", workPayload)?.payload)
      .toEqual({ workItemId: "work-one", submissionId: "submission-one" });
    expect(project(
      ["work:read", "chapters:read", "revisions:read"],
      "work_item_completed",
      workPayload,
    )?.payload).toEqual({
      workItemId: "work-one",
      submissionId: "submission-one",
      chapterId: "chapter-one",
      revision: 8,
      revisionProposalId: "proposal-one",
    });

    const createdPayload = {
      workItemId: "work-two",
      annotationId: "comment-two",
      annotationKind: "comment",
      chapterId: "chapter-two",
      type: "revise_block",
      baseRevision: 3,
    };
    expect(project(["work:read"], "work_item_created", createdPayload)?.payload)
      .toEqual({ workItemId: "work-two", type: "revise_block" });
    expect(project(
      ["work:read", "suggestions:read"],
      "work_item_created",
      createdPayload,
    )?.payload).not.toHaveProperty("annotationId");
    expect(project(
      ["work:read", "comments:read", "chapters:read"],
      "work_item_created",
      createdPayload,
    )?.payload).toEqual({
      workItemId: "work-two",
      annotationId: "comment-two",
      chapterId: "chapter-two",
      type: "revise_block",
      baseRevision: 3,
    });

    const revisionPayload = {
      proposalId: "proposal-two",
      workItemId: "work-three",
      submissionId: "submission-three",
      chapterId: "chapter-three",
      targetKind: "chapter",
      targetId: "chapter-three",
      targetPath: "chapters/003-three.md",
      proposalType: "chapter_replacement",
    };
    expect(project(
      ["revisions:read"],
      "revision_proposal_created",
      revisionPayload,
    )?.payload).toEqual({
      proposalId: "proposal-two",
      targetKind: "chapter",
      proposalType: "chapter_replacement",
    });
    expect(project(
      ["revisions:read", "work:read"],
      "revision_proposal_created",
      revisionPayload,
    )?.payload).toEqual({
      proposalId: "proposal-two",
      workItemId: "work-three",
      submissionId: "submission-three",
      targetKind: "chapter",
      proposalType: "chapter_replacement",
    });
    expect(project(
      ["revisions:read", "work:read", "chapters:read"],
      "revision_proposal_created",
      revisionPayload,
    )?.payload).toEqual(revisionPayload);

    const terminalRevision = {
      revisionProposalId: "proposal-terminal",
      workItemId: "work-terminal",
      submissionId: "submission-terminal",
      chapterId: "chapter-terminal",
      targetKind: "chapter",
      proposalType: "chapter_replacement",
      commitSha: "abc123",
    };
    expect(project(
      ["revisions:read"],
      "revision_proposal_applied",
      terminalRevision,
    )?.payload).toEqual({
      revisionProposalId: "proposal-terminal",
      targetKind: "chapter",
      proposalType: "chapter_replacement",
      commitSha: "abc123",
    });

    const planningRevisionPayload = {
      proposalId: "proposal-outline",
      targetKind: "outline",
      targetId: "outline",
      targetPath: "story/outline.md",
      proposalType: "repository_document",
    };
    expect(project(
      ["revisions:read"],
      "revision_proposal_created",
      planningRevisionPayload,
    )?.payload).toEqual(planningRevisionPayload);

    const decisionPayload = {
      decisionId: "decision-one",
      annotationId: "comment-one",
      annotationKind: "comment",
      decisionActionType: "create_work_item",
      workItemId: "work-four",
      result: "create_work_item",
      rule: "default",
    };
    expect(project(["work:read"], "decision_created", decisionPayload)?.payload)
      .toEqual({ workItemId: "work-four" });
    expect(project(
      ["work:read", "comments:read"],
      "decision_created",
      decisionPayload,
    )?.payload).toEqual({
      decisionId: "decision-one",
      annotationId: "comment-one",
      kind: "comment",
      workItemId: "work-four",
      result: "create_work_item",
      rule: "default",
    });

    const cancelPayload = {
      decisionId: "decision-cancel",
      annotationId: "comment-cancel",
      annotationKind: "comment",
      decisionActionType: "cancel_work_item",
      workItemId: "work-cancel",
      result: "overridden",
      override: "cancel",
    };
    expect(project(
      ["comments:read", "suggestions:read"],
      "decision_created",
      cancelPayload,
    )).toBeNull();
    expect(project(["work:read"], "decision_created", cancelPayload)?.payload).toEqual({
      decisionId: "decision-cancel",
      workItemId: "work-cancel",
      result: "overridden",
      override: "cancel",
    });
    expect(project(
      ["work:read", "comments:read"],
      "decision_created",
      cancelPayload,
    )?.payload).toEqual({
      decisionId: "decision-cancel",
      annotationId: "comment-cancel",
      kind: "comment",
      workItemId: "work-cancel",
      result: "overridden",
      override: "cancel",
    });
  });

  it("never projects control-plane or unknown operation completions", () => {
    expect(project(
      ["comments:read"],
      "operation_completed",
      { operationId: "feedback-op", kind: "annotation.create" },
    )).toBeNull();
    expect(project(
      ["comments:read", "suggestions:read"],
      "operation_completed",
      { operationId: "feedback-op", kind: "annotation.create" },
    )?.payload).toEqual({ operationId: "feedback-op", kind: "annotation.create" });
    expect(project(
      ["comments:read"],
      "operation_completed",
      {
        operationId: "comment-op",
        kind: "annotation.create",
        annotationKind: "comment",
      },
    )?.payload).toEqual({ operationId: "comment-op", kind: "annotation.create" });
    expect(project(
      ["suggestions:read"],
      "operation_completed",
      {
        operationId: "comment-op",
        kind: "annotation.create",
        annotationKind: "comment",
      },
    )).toBeNull();
    expect(project(
      ["suggestions:read"],
      "operation_completed",
      {
        operationId: "suggestion-decision-op",
        kind: "decision.create",
        annotationKind: "suggestion",
        decisionActionType: "reject_suggestion",
      },
    )?.payload).toEqual({
      operationId: "suggestion-decision-op",
      kind: "decision.create",
    });
    expect(project(
      ["work:read"],
      "operation_completed",
      {
        operationId: "invalid-decision-update-op",
        kind: "decision.update",
        annotationKind: "comment",
        decisionActionType: "cancel_work_item",
      },
    )).toBeNull();
    expect(project(
      ["comments:read", "suggestions:read", "work:read"],
      "operation_completed",
      { operationId: "decision-op", kind: "decision.create" },
    )).toBeNull();
    expect(project(
      ["chapters:read"],
      "operation_completed",
      { operationId: "ambiguous-chapter-op", kind: "chapter.write" },
    )).toBeNull();
    expect(project(
      ["chapters:read", "revisions:read"],
      "operation_completed",
      {
        operationId: "conflicting-chapter-op",
        kind: "chapter.write",
        directChapterWrite: true,
        revisionProposalId: "proposal",
      },
    )).toBeNull();
    expect(project(
      ["chapters:read", "work:read", "revisions:read"],
      "agents_paused",
      { affectedTokens: 4 },
    )).toBeNull();
    expect(project(
      ["chapters:read"],
      "publication_updated",
      { publicationId: "publication-one", buildStatus: "succeeded" },
    )).toBeNull();
    expect(project(
      ["chapters:read", "work:read", "revisions:read"],
      "operation_completed",
      { operationId: "settings-op", kind: "book_config.update" },
    )).toBeNull();
    expect(project(
      ["chapters:read", "work:read", "revisions:read"],
      "operation_completed",
      { operationId: "future-op", kind: "future.write" },
    )).toBeNull();
  });

  it("rebuilds every visible event family without additive payload fields", () => {
    const secret = "must-never-be-projected";
    const cases: Array<{
      capabilities: EditorialCapability[];
      type: string;
      payload: Record<string, unknown>;
    }> = [
      {
        capabilities: ["comments:read"],
        type: "annotation_needs_reanchor",
        payload: { annotationKind: "comment", annotationId: "a", revision: 4 },
      },
      {
        capabilities: ["comments:read"],
        type: "vote_aggregate",
        payload: { annotationKind: "comment", annotationId: "a", votes: votes() },
      },
      {
        capabilities: ["suggestions:read"],
        type: "decision_created",
        payload: {
          annotationKind: "suggestion",
          annotationId: "a",
          decisionId: "d",
          decisionActionType: "reject_suggestion",
          result: "rejected",
          override: "reject",
        },
      },
      {
        capabilities: ["suggestions:read"],
        type: "decision_support_changed",
        payload: {
          annotationKind: "suggestion",
          annotationId: "a",
          decisionId: "d",
          supportChanged: true,
          transition: "marked",
        },
      },
      {
        capabilities: ["work:read"],
        type: "work_item_created",
        payload: { workItemId: "w", type: "revise_chapter" },
      },
      {
        capabilities: ["work:read"],
        type: "work_item_leased",
        payload: { workItemId: "w", leaseId: "l" },
      },
      {
        capabilities: ["work:read"],
        type: "lease_recovered",
        payload: { workItemId: "w", leaseId: "l" },
      },
      {
        capabilities: ["work:read"],
        type: "lease_released",
        payload: { workItemId: "w", leaseId: "l", correlationId: secret },
      },
      {
        capabilities: ["work:read"],
        type: "lease_expired",
        payload: { workItemId: "w", leaseId: "l", correlationId: secret },
      },
      {
        capabilities: ["work:read"],
        type: "lease_revoked",
        payload: { workItemId: "w", leaseId: "l", correlationId: secret, reason: secret },
      },
      {
        capabilities: ["work:read"],
        type: "lease_renewed",
        payload: { workItemId: "w", leaseId: "l", renewalCount: 2 },
      },
      {
        capabilities: ["work:read"],
        type: "work_item_completed",
        payload: { workItemId: "w", submissionId: "s" },
      },
      {
        capabilities: ["work:read"],
        type: "work_item_conflict",
        payload: {
          workItemId: "w",
          submissionId: "s",
          conflictWorkItemId: "wc",
          reason: secret,
        },
      },
      {
        capabilities: ["work:read"],
        type: "submission_received",
        payload: { workItemId: "w", submissionId: "s", type: "range_replacement" },
      },
      {
        capabilities: ["revisions:read"],
        type: "revision_proposal_created",
        payload: {
          proposalId: "p",
          chapterId: "c",
          targetKind: "chapter",
          proposalType: "chapter_replacement",
        },
      },
      {
        capabilities: ["revisions:read"],
        type: "revision_proposal_approved",
        payload: {
          proposalId: "p",
          chapterId: "c",
          targetKind: "chapter",
          proposalType: "chapter_summary",
        },
      },
      {
        capabilities: ["revisions:read"],
        type: "revision_proposal_rejected",
        payload: {
          proposalId: "p",
          targetKind: "outline",
          targetId: "outline",
          targetPath: "story/outline.md",
          proposalType: "repository_document",
        },
      },
      {
        capabilities: ["revisions:read"],
        type: "revision_proposal_applied",
        payload: {
          revisionProposalId: "p",
          targetKind: "timeline",
          targetId: "timeline",
          targetPath: "story/timeline.md",
          proposalType: "repository_document",
        },
      },
      {
        capabilities: ["revisions:read"],
        type: "revision_proposal_conflicted",
        payload: {
          revisionProposalId: "p",
          targetKind: "character",
          targetId: "ada",
          targetPath: "story/characters/ada.md",
          proposalType: "repository_document",
        },
      },
      {
        capabilities: ["chapters:read"],
        type: "chapter_created",
        payload: { chapterId: "c", revision: 1 },
      },
      {
        capabilities: ["chapters:read"],
        type: "chapter_revised",
        payload: { chapterId: "c", revision: 2 },
      },
      {
        capabilities: ["chapters:read"],
        type: "chapter_published",
        payload: { chapterId: "c", revision: 2 },
      },
      {
        capabilities: ["chapters:read"],
        type: "chapter_unpublished",
        payload: { chapterId: "c", revision: 2 },
      },
      {
        capabilities: ["chapters:read"],
        type: "operation_completed",
        payload: { operationId: "op", kind: "chapter.write", directChapterWrite: true },
      },
    ];

    for (const candidate of cases) {
      const result = project(candidate.capabilities, candidate.type, {
        ...candidate.payload,
        internalSecret: secret,
      });
      expect(result, candidate.type).not.toBeNull();
      expect(JSON.stringify(result), candidate.type).not.toContain(secret);
      expect(result?.payload, candidate.type).not.toHaveProperty("internalSecret");
      if (
        candidate.type === "lease_released" ||
        candidate.type === "lease_expired" ||
        candidate.type === "lease_revoked"
      ) {
        expect(result?.payload, candidate.type).not.toHaveProperty("correlationId");
      }
    }
  });
});
