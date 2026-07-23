import { describe, expect, it } from "vitest";
import type {
  RevisionProposalDetail,
  RevisionProposalSummary,
} from "../site/src/islands/api.js";
import {
  isRevisionProposalDetail,
  revisionActionCopy,
  revisionDocument,
  revisionWarning,
} from "../site/src/islands/revision-review-model.js";

function proposal(
  overrides: Partial<RevisionProposalSummary> = {},
): RevisionProposalSummary {
  return {
    id: "proposal-1",
    projectId: "project-1",
    chapterId: "chapter-1",
    proposalType: "chapter_replacement",
    origin: "work_submission",
    workItemId: "work-1",
    submissionId: "submission-1",
    authorActorId: "actor-1",
    baseRevision: 4,
    changeSummary: "Tighten the ending.",
    notes: null,
    status: "pending_review",
    reviewedByActorId: null,
    reviewedAt: null,
    reviewReason: null,
    gitOperationId: null,
    resultingRevision: null,
    commitSha: null,
    createdAt: "2026-07-22T00:00:00Z",
    updatedAt: "2026-07-22T00:00:00Z",
    currentRevision: 4,
    target: {
      kind: "chapter",
      id: "chapter-1",
      path: "chapters/01-signal.md",
      label: "Signal",
    },
    author: { id: "actor-1", displayName: "Mara", type: "human" },
    workItem: { id: "work-1", type: "revise_chapter", status: "submitted" },
    chapter: { id: "chapter-1", title: "Signal", revision: 4 },
    ...overrides,
  };
}

describe("revision review presentation model", () => {
  it("uses the generic target for future repository documents", () => {
    const timeline = proposal({
      chapterId: null,
      proposalType: "repository_document",
      origin: "document_edit",
      baseRevision: null,
      currentRevision: null,
      currentContentHash: "sha256:current",
      target: {
        kind: "timeline",
        id: "story-timeline",
        path: "story/timeline.md",
        label: "Timeline",
      },
      chapter: null,
    });

    expect(revisionDocument(timeline)).toEqual({
      kind: "timeline",
      id: "story-timeline",
      path: "story/timeline.md",
      label: "Timeline",
      currentRevision: null,
    });
    expect(revisionWarning(timeline)).toBeNull();
    expect(revisionActionCopy(timeline)).toMatchObject({ approveLabel: "Apply changes" });
  });

  it("keeps chapter-only responses backward compatible", () => {
    const legacy = proposal({
      target: null,
      currentRevision: null,
      chapter: {
        id: "chapter-1",
        title: "Signal",
        path: "chapters/01-signal.md",
        revision: 4,
      },
    });

    expect(revisionDocument(legacy)).toMatchObject({
      kind: "chapter",
      label: "Signal",
      currentRevision: 4,
    });
    expect(revisionWarning(legacy)).toBeNull();
  });

  it("warns when the current revision moved and gives direct edits one-click copy", () => {
    const moved = proposal({ currentRevision: 6 });
    expect(revisionWarning(moved)).toMatchObject({ tone: "moved" });
    expect(revisionWarning(moved)?.message).toContain("will not overwrite");
    expect(revisionWarning(proposal({ conflictWarning: true }))).toMatchObject({
      tone: "moved",
    });

    const direct = proposal({ origin: "direct_edit", workItem: null, workItemId: null });
    expect(revisionActionCopy(direct)).toMatchObject({ approveLabel: "Apply changes" });
    expect(revisionActionCopy(proposal())).toMatchObject({
      approveLabel: "Approve and apply",
    });
  });

  it("recognizes detail payloads without assuming a chapter target", () => {
    const detail: RevisionProposalDetail = {
      ...proposal(),
      baseContentHash: "sha256:before",
      baseContent: "Before\n",
      proposedContent: "After\n",
      diff: { unifiedDiff: null, computationLimited: true },
    };
    expect(isRevisionProposalDetail(detail)).toBe(true);
    expect(isRevisionProposalDetail(proposal())).toBe(false);
  });
});
