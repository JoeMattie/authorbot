import { beforeEach, describe, expect, it } from "vitest";
import type {
  Me,
  RevisionProposalDetail,
  RevisionProposalSummary,
} from "../site/src/islands/api.js";
import {
  chapterEditorRevisionTarget,
  repositoryEditorRevisionTarget,
} from "../site/src/islands/editor-revision-state.js";
import {
  createProjectStore,
  resetProjectStoresForTests,
  type ProjectStoreApi,
} from "../site/src/islands/project-store.js";

const PROJECT = "hollow-creek-anomaly";
const PROPOSAL = "proposal-1";

const me: Me = {
  actor: { id: "maintainer-1", displayName: "Mara", externalIdentity: "github:mara" },
  memberships: [{ role: "maintainer" }],
  scopes: ["revisions:read", "revisions:review"],
};

const summary = (): RevisionProposalSummary => ({
  id: PROPOSAL,
  projectId: PROJECT,
  chapterId: "chapter-1",
  proposalType: "chapter_replacement",
  origin: "work_submission",
  workItemId: "work-1",
  submissionId: "submission-1",
  authorActorId: "actor-1",
  baseRevision: 3,
  changeSummary: "Revise the chapter.",
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
  currentRevision: 3,
  target: { kind: "chapter", id: "chapter-1", path: "chapters/1.md", label: "One" },
  author: { id: "actor-1", displayName: "Writer", type: "agent" },
  workItem: { id: "work-1", type: "revise_chapter", status: "submitted" },
  chapter: { id: "chapter-1", title: "One", revision: 3 },
});

const detail = (): RevisionProposalDetail => ({
  ...summary(),
  baseContentHash: "sha256:before",
  baseContent: "Before\n",
  proposedContent: "After\n",
  diff: { unifiedDiff: null, computationLimited: false },
});

function api(overrides: Partial<ProjectStoreApi> = {}): ProjectStoreApi {
  return {
    async meResult() {
      return { ok: true, value: me };
    },
    async chapters() {
      return { ok: true, value: [] };
    },
    async revisionProposals() {
      return { ok: true, value: { items: [summary()], nextCursor: null } };
    },
    async revisionProposal() {
      return { ok: true, value: detail() };
    },
    ...overrides,
  };
}

beforeEach(() => resetProjectStoresForTests());

describe("project store revision review", () => {
  it("normalizes bounded summaries and loads complete snapshots only on detail", async () => {
    const store = createProjectStore({ apiBase: "", project: PROJECT }, api());
    await store.getState().ensureRevisionProposals();

    expect(store.getState().revisionProposalIds).toEqual([PROPOSAL]);
    expect("baseContent" in store.getState().revisionProposalsById[PROPOSAL]!).toBe(false);

    await store.getState().ensureRevisionProposal(PROPOSAL);
    expect(store.getState().revisionProposalsById[PROPOSAL]).toMatchObject({
      baseContent: "Before\n",
      proposedContent: "After\n",
    });
  });

  it("fails a repeated or unbounded pagination chain inside ten reads", async () => {
    let reads = 0;
    const repeated = createProjectStore(
      { apiBase: "", project: `${PROJECT}-repeat` },
      api({
        async revisionProposals() {
          reads += 1;
          return { ok: true, value: { items: [], nextCursor: "same" } };
        },
      }),
    );
    await repeated.getState().ensureRevisionProposals();
    expect(reads).toBe(2);
    expect(repeated.getState().revisionProposalsError).toContain("repeated cursor");

    reads = 0;
    const unbounded = createProjectStore(
      { apiBase: "", project: `${PROJECT}-long` },
      api({
        async revisionProposals() {
          reads += 1;
          return { ok: true, value: { items: [], nextCursor: `next-${reads}` } };
        },
      }),
    );
    await unbounded.getState().ensureRevisionProposals();
    expect(reads).toBe(10);
    expect(unbounded.getState().revisionProposalsError).toContain("exceeded 10 pages");
  });

  it("optimistically settles review and rolls back a rejected command", async () => {
    let decision: string | null = null;
    let resolve!: (value: Awaited<ReturnType<NonNullable<ProjectStoreApi["reviewRevisionProposal"]>>>) => void;
    const pending = new Promise<
      Awaited<ReturnType<NonNullable<ProjectStoreApi["reviewRevisionProposal"]>>>
    >((done) => {
      resolve = done;
    });
    const store = createProjectStore(
      { apiBase: "", project: PROJECT },
      api({
        reviewRevisionProposal: async (_proposalId, nextDecision) => {
          decision = nextDecision;
          return pending;
        },
      }),
    );
    await store.getState().ensureRevisionProposals();
    const command = store.getState().reviewRevision(PROPOSAL, "approve");
    expect(store.getState().revisionProposalsById[PROPOSAL]?.status).toBe("applying");
    expect(decision).toBe("approve");

    resolve({ ok: false, status: 403, message: "review permission was revoked" });
    expect(await command).toMatchObject({ ok: false, kind: "rejected", status: 403 });
    expect(store.getState().revisionProposalsById[PROPOSAL]?.status).toBe("pending_review");
  });

  it("owns direct-editor saving through matching events even when HTTP loses its response", async () => {
    let resolve!: (
      value: Awaited<ReturnType<NonNullable<ProjectStoreApi["createRevisionProposal"]>>>,
    ) => void;
    const response = new Promise<
      Awaited<ReturnType<NonNullable<ProjectStoreApi["createRevisionProposal"]>>>
    >((done) => {
      resolve = done;
    });
    let correlationId = "";
    const store = createProjectStore(
      { apiBase: "", project: PROJECT },
      api({
        async meResult() {
          return {
            ok: true,
            value: { ...me, scopes: ["revisions:write"] },
          };
        },
        async createRevisionProposal(_command, options) {
          correlationId = options?.correlationId ?? "";
          return response;
        },
      }),
    );
    await store.getState().ensureSession();
    const target = chapterEditorRevisionTarget("chapter-1");
    const submitting = store.getState().proposeChapterRevision({
      proposalType: "chapter_replacement",
      chapterId: "chapter-1",
      baseRevision: 3,
      baseContentHash: "sha256:before",
      proposedContent: "After\n",
    });
    expect(store.getState().editorRevisionsByTargetKey[target.key]).toMatchObject({
      phase: "saving",
      proposalId: null,
    });
    expect(correlationId).not.toBe("");

    store.getState().reconcileEvent({
      id: 10,
      type: "revision_proposal_created",
      payload: { proposalId: PROPOSAL, correlationId },
    });
    store.getState().reconcileEvent({
      id: 11,
      type: "revision_proposal_approved",
      payload: { proposalId: PROPOSAL, operationId: "operation-1", correlationId },
    });
    expect(store.getState().editorRevisionsByTargetKey[target.key]).toMatchObject({
      phase: "applying",
      proposalId: PROPOSAL,
      operationId: "operation-1",
    });

    resolve({ ok: false, status: 503, message: "the response was lost" });
    await expect(submitting).resolves.toMatchObject({ ok: true });
    expect(store.getState().editorRevisionsByTargetKey[target.key]?.phase).toBe("applying");

    store.getState().reconcileEvent({
      id: 12,
      type: "revision_proposal_applied",
      payload: { revisionProposalId: PROPOSAL, commitSha: "a".repeat(40) },
    });
    expect(store.getState().editorRevisionsByTargetKey[target.key]?.phase).toBe("integrated");
    store.getState().reconcileEvent({
      id: 13,
      type: "publication_updated",
      payload: {
        integratedCommit: "a".repeat(40),
        buildStatus: "building",
        deployedCommit: null,
      },
    });
    expect(store.getState().editorRevisionsByTargetKey[target.key]).toMatchObject({
      phase: "publishing",
      publication: { buildStatus: "building" },
    });
    store.getState().reconcileEvent({
      id: 14,
      type: "publication_updated",
      payload: {
        integratedCommit: "a".repeat(40),
        buildStatus: "succeeded",
        deployedCommit: "a".repeat(40),
      },
    });
    expect(store.getState().editorRevisionsByTargetKey[target.key]?.phase).toBe("deployed");
  });

  it("restores planning-editor state from proposal and bounded publication API data", async () => {
    const approved = {
      ...summary(),
      id: "proposal-planning",
      chapterId: null,
      proposalType: "repository_document",
      origin: "direct_edit",
      workItemId: null,
      submissionId: null,
      status: "approved",
      gitOperationId: "operation-planning",
      commitSha: "c".repeat(40),
      target: {
        kind: "outline",
        id: "outline",
        path: "story/outline.yml",
        label: "Outline",
      },
      chapter: null,
      workItem: null,
    } satisfies RevisionProposalSummary;
    const store = createProjectStore(
      { apiBase: "", project: PROJECT },
      api({
        async revisionProposal() {
          return {
            ok: true,
            value: {
              ...approved,
              baseContentHash: "sha256:before",
              baseContent: "Before\n",
              proposedContent: "After\n",
              diff: { unifiedDiff: null, computationLimited: false },
            },
          };
        },
        async publications() {
          return {
            ok: true,
            value: {
              items: [{
                id: "publication-1",
                integratedCommit: "c".repeat(40),
                buildStatus: "succeeded",
                deployedCommit: "c".repeat(40),
              }],
            },
          };
        },
      }),
    );
    await store.getState().ensureSession();
    const target = repositoryEditorRevisionTarget("outline", "story/outline.yml");
    store.getState().trackEditorRevision(target, { proposalId: approved.id });

    await expect.poll(() => store.getState().editorRevisionsByTargetKey[target.key]?.phase)
      .toBe("deployed");
    expect(store.getState().editorRevisionsByTargetKey[target.key]).toMatchObject({
      proposalId: approved.id,
      commitSha: "c".repeat(40),
      publication: { deployedCommit: "c".repeat(40) },
    });
  });
});
