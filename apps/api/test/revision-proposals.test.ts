import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RevisionProposalRecord } from "@authorbot/database";
import {
  BLOCK_ID_1,
  CHAPTER_ID,
  FakeReader,
  devLogin,
  fixtureSnapshot,
  jsonRequest,
  makeHarness,
  mintCanonicalToken,
  mintToken,
  type TestHarness,
} from "./helpers.js";
import { uuidv7 } from "../src/ids.js";

const CHAPTER_PATH = "chapters/001-baseline.md";
const SOURCE = `---
schema: authorbot.chapter/v1
id: ${CHAPTER_ID}
slug: baseline
title: Baseline
order: 10
status: published
revision: 3
authors:
  - actor: github:avery-cole
summary: Existing summary
---

<!-- authorbot:block id="${BLOCK_ID_1}" -->
Original paragraph.
`;
const CONTENT_HASH = `sha256:${createHash("sha256").update(SOURCE).digest("hex")}`;
const BASE_BODY = "Original paragraph.";
const OUTLINE_PATH = "story/outline.yml";
const OUTLINE_SOURCE = "schema: authorbot.story-graph/v1\nnodes: []\n";
const OUTLINE_HASH = `sha256:${createHash("sha256").update(OUTLINE_SOURCE).digest("hex")}`;

function sourceReader(): FakeReader {
  const snapshot = fixtureSnapshot();
  const chapter = snapshot.chapters[0];
  if (chapter === undefined) throw new Error("fixture chapter missing");
  snapshot.chapters[0] = { ...chapter, contentHash: CONTENT_HASH };
  const reader = new FakeReader(snapshot);
  reader.files.set(CHAPTER_PATH, SOURCE);
  reader.files.set(OUTLINE_PATH, OUTLINE_SOURCE);
  return reader;
}

function proposalPath(h: TestHarness, proposalId = ""): string {
  return `/v1/projects/${h.projectId}/revision-proposals${proposalId === "" ? "" : `/${proposalId}`}`;
}

function directCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chapterId: CHAPTER_ID,
    proposalType: "chapter_replacement",
    baseRevision: 3,
    baseContentHash: CONTENT_HASH,
    proposedContent: "Revised paragraph.\n",
    changeSummary: "Tighten the paragraph.",
    ...overrides,
  };
}

describe("Phase 11 revision proposal HTTP pipeline", () => {
  let h: TestHarness;
  let maintainer: string;
  let editor: string;

  beforeEach(async () => {
    h = await makeHarness({ reader: sourceReader() });
    maintainer = await devLogin(h, "revision-maintainer", "maintainer");
    editor = await devLogin(h, "revision-editor", "editor");
  });

  afterEach(() => h.close());

  async function createDirect(
    body: Record<string, unknown> = directCommand(),
    cookie = editor,
    key = uuidv7(),
  ): Promise<{ response: Response; body: Record<string, unknown> }> {
    const response = await h.app.request(
      proposalPath(h),
      jsonRequest("POST", body, { Cookie: cookie, "Idempotency-Key": key }),
    );
    return { response, body: (await response.json()) as Record<string, unknown> };
  }

  it("creates immutable published-chapter proposals, then lists, reads, and diffs them", async () => {
    const key = "create-direct-proposal";
    const created = await createDirect(directCommand(), editor, key);
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({ status: "pending_review", operationId: null });
    const proposalId = created.body["proposalId"] as string;

    const replay = await createDirect(directCommand(), editor, key);
    expect(replay.response.status).toBe(201);
    expect(replay.body).toEqual(created.body);

    const stored = await h.repos.revisionProposals.getById(proposalId);
    expect(stored).toMatchObject({
      proposalType: "chapter_replacement",
      origin: "direct_edit",
      baseContent: BASE_BODY,
      proposedContent: "Revised paragraph.\n",
      status: "pending_review",
    });

    const list = await h.app.request(proposalPath(h), { headers: { Cookie: editor } });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items: Array<Record<string, unknown>> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]).not.toHaveProperty("baseContent");
    expect(listBody.items[0]).not.toHaveProperty("proposedContent");
    expect(listBody.items[0]).toMatchObject({
      id: proposalId,
      gitOperationId: null,
      currentRevision: 3,
      currentContentHash: CONTENT_HASH,
      conflictWarning: false,
      target: {
        kind: "chapter",
        id: CHAPTER_ID,
        path: CHAPTER_PATH,
        label: "Baseline",
      },
      author: { type: "human", displayName: "revision-editor" },
      workItem: null,
      chapter: {
        id: CHAPTER_ID,
        title: "Baseline",
        slug: "baseline",
        path: CHAPTER_PATH,
        revision: 3,
      },
    });

    const get = await h.app.request(proposalPath(h, proposalId), {
      headers: { Cookie: editor },
    });
    expect(get.status).toBe(200);
    const detailBody = (await get.json()) as Record<string, unknown>;
    expect(detailBody).toMatchObject({
      id: proposalId,
      baseContent: BASE_BODY,
      proposedContent: "Revised paragraph.\n",
      conflictWarning: false,
      author: { type: "human", displayName: "revision-editor" },
    });
    expect(detailBody).not.toHaveProperty("unifiedDiff");
    expect(detailBody).not.toHaveProperty("diff");

    const diff = await h.app.request(`${proposalPath(h, proposalId)}/diff`, {
      headers: { Cookie: editor },
    });
    expect(diff.status).toBe(200);
    const diffBody = (await diff.json()) as Record<string, unknown>;
    expect(diffBody).toMatchObject({
      proposalId,
      baseContent: BASE_BODY,
      proposedContent: "Revised paragraph.\n",
      computationLimited: false,
      target: {
        kind: "chapter",
        id: CHAPTER_ID,
        path: CHAPTER_PATH,
        label: "Baseline",
      },
      proposal: {
        id: proposalId,
        conflictWarning: false,
        currentRevision: 3,
        target: { kind: "chapter", id: CHAPTER_ID, path: CHAPTER_PATH },
      },
    });
    expect(diffBody["unifiedDiff"]).toContain("-Original paragraph.");
    expect(diffBody["unifiedDiff"]).toContain("+Revised paragraph.");

    expect(await h.repos.outbox.listPending(h.projectId)).toHaveLength(0);
    const audit = await h.db
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'revision_proposal.create' AND target_id = ?`,
      )
      .bind(proposalId)
      .first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });

  it("keeps proposal text secret without revisions:read and never translates legacy scopes", async () => {
    const created = await createDirect();
    expect(created.response.status).toBe(201);
    const proposalId = created.body["proposalId"] as string;

    const noRead = await mintCanonicalToken(h, maintainer, ["chapters:read"]);
    const withRead = await mintCanonicalToken(h, maintainer, ["revisions:read"]);
    const legacy = await mintToken(h, maintainer, [
      "chapters:read",
      "annotations:read",
      "submissions:write",
    ]);
    const legacyRow = await h.repos.agentTokens.getById(legacy.tokenId);
    if (legacyRow === null) throw new Error("legacy token missing");
    await h.db
      .prepare(`UPDATE project_memberships SET role = 'maintainer' WHERE actor_id = ?`)
      .bind(legacyRow.actorId)
      .run();

    for (const token of [noRead.token, legacy.token]) {
      for (const path of [
        proposalPath(h),
        proposalPath(h, proposalId),
        `${proposalPath(h, proposalId)}/diff`,
      ]) {
        const response = await h.app.request(path, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(403);
        const deniedBody = JSON.stringify(await response.json());
        expect(deniedBody).not.toContain(BASE_BODY);
        expect(deniedBody).not.toContain("Revised paragraph");
      }
    }

    const readable = await h.app.request(`${proposalPath(h, proposalId)}/diff`, {
      headers: { Authorization: `Bearer ${withRead.token}` },
    });
    expect(readable.status).toBe(200);
    expect(await readable.json()).toMatchObject({ baseContent: BASE_BODY });
  });

  it("admits summary contributors with exact read/write grants and reserves apply for maintainers", async () => {
    const summaryBody = directCommand({
      proposalType: "chapter_summary",
      proposedContent: "A sharper summary.",
    });
    const contributor = await devLogin(h, "summary-contributor", "contributor");
    const contributorAttempt = await createDirect(summaryBody, contributor);
    expect(contributorAttempt.response.status).toBe(201);
    expect(
      await h.repos.revisionProposals.getById(
        contributorAttempt.body["proposalId"] as string,
      ),
    ).toMatchObject({
      proposalType: "chapter_summary",
      origin: "summary_proposal",
      baseContent: "Existing summary",
      proposedContent: "A sharper summary.",
    });

    const summaryOnly = await mintCanonicalToken(h, maintainer, ["summaries:write"]);
    const missingRead = await h.app.request(
      proposalPath(h),
      jsonRequest("POST", summaryBody, {
        Authorization: `Bearer ${summaryOnly.token}`,
      }),
    );
    expect(missingRead.status).toBe(403);

    const contributorAgent = await mintCanonicalToken(h, maintainer, [
      "chapters:read",
      "summaries:write",
    ]);
    await h.db
      .prepare(`UPDATE project_memberships SET role = 'contributor' WHERE actor_id = ?`)
      .bind(contributorAgent.actorId)
      .run();
    const agentAccepted = await h.app.request(
      proposalPath(h),
      jsonRequest("POST", {
        ...summaryBody,
        proposedContent: "Summary from a contributor agent.",
      }, {
        Authorization: `Bearer ${contributorAgent.token}`,
      }),
    );
    expect(agentAccepted.status).toBe(201);

    const legacyWriter = await mintToken(h, maintainer, [
      "chapters:read",
      "annotations:write",
      "submissions:write",
    ]);
    const legacyAttempt = await h.app.request(
      proposalPath(h),
      jsonRequest("POST", directCommand(), {
        Authorization: `Bearer ${legacyWriter.token}`,
      }),
    );
    expect(legacyAttempt.status).toBe(403);

    const immediateContributor = await h.app.request(
      proposalPath(h),
      jsonRequest("POST", { ...summaryBody, applyImmediately: true }, { Cookie: contributor }),
    );
    expect(immediateContributor.status).toBe(403);

    const maintainerSummaryWriter = await mintCanonicalToken(h, maintainer, [
      "chapters:read",
      "summaries:write",
      "revisions:review",
    ]);
    await h.db
      .prepare(`UPDATE project_memberships SET role = 'maintainer' WHERE actor_id = ?`)
      .bind(maintainerSummaryWriter.actorId)
      .run();
    const applied = await h.app.request(
      proposalPath(h),
      jsonRequest("POST", {
        ...summaryBody,
        proposedContent: "",
        applyImmediately: true,
      }, {
        Authorization: `Bearer ${maintainerSummaryWriter.token}`,
      }),
    );
    expect(applied.status).toBe(202);
    const appliedBody = (await applied.json()) as {
      proposalId: string;
      operationId: string;
    };
    expect(await h.repos.revisionProposals.getById(appliedBody.proposalId)).toMatchObject({
      status: "applying",
      reviewedByActorId: maintainerSummaryWriter.actorId,
      gitOperationId: appliedBody.operationId,
    });
    expect(await h.repos.outbox.getByGitOperationId(appliedBody.operationId)).toMatchObject({
      kind: "chapter.write",
      payload: {
        revisionProposalId: appliedBody.proposalId,
        intent: { baseRevision: 3, summary: null },
      },
    });
    const audit = await h.db
      .prepare(
        `SELECT action FROM audit_events
          WHERE target_type = 'revision_proposal' AND target_id = ? ORDER BY action`,
      )
      .bind(appliedBody.proposalId)
      .all<{ action: string }>();
    expect(audit.map(({ action }) => action)).toEqual([
      "revision_proposal.approve",
      "revision_proposal.create",
    ]);
  });

  it("reads, proposes, reviews, and one-click applies repository planning documents", async () => {
    const source = await h.app.request(
      `/v1/projects/${h.projectId}/repository-documents/source?kind=outline&path=${encodeURIComponent(OUTLINE_PATH)}`,
      { headers: { Cookie: editor } },
    );
    expect(source.status).toBe(200);
    expect(await source.json()).toEqual({
      target: { kind: "outline", id: "outline", path: OUTLINE_PATH, label: "Outline" },
      content: OUTLINE_SOURCE,
      contentHash: OUTLINE_HASH,
    });

    const proposedContent = [
      "schema: authorbot.story-graph/v1",
      "nodes:",
      `  - id: chapter:${CHAPTER_ID}`,
      "    type: chapter",
      "    title: Baseline",
      `    chapter_id: ${CHAPTER_ID}`,
      "    order: 10",
      "",
    ].join("\n");
    const created = await createDirect({
      proposalType: "repository_document",
      targetKind: "outline",
      targetPath: OUTLINE_PATH,
      baseContentHash: OUTLINE_HASH,
      proposedContent,
      changeSummary: "Add the baseline chapter to the outline.",
    });
    expect(created.response.status).toBe(201);
    const proposalId = created.body["proposalId"] as string;
    expect(await h.repos.revisionProposals.getById(proposalId)).toMatchObject({
      chapterId: null,
      targetKind: "outline",
      targetId: "outline",
      targetPath: OUTLINE_PATH,
      proposalType: "repository_document",
      origin: "document_edit",
      baseRevision: null,
      baseContent: OUTLINE_SOURCE,
      proposedContent,
      status: "pending_review",
    });

    const diff = await h.app.request(`${proposalPath(h, proposalId)}/diff`, {
      headers: { Cookie: editor },
    });
    expect(diff.status).toBe(200);
    expect(await diff.json()).toMatchObject({
      target: { kind: "outline", id: "outline", path: OUTLINE_PATH, label: "Outline" },
      proposal: { baseRevision: null, currentRevision: null },
    });

    const approved = await h.app.request(
      `${proposalPath(h, proposalId)}/approve`,
      jsonRequest("POST", {}, { Cookie: maintainer, "Idempotency-Key": uuidv7() }),
    );
    expect(approved.status).toBe(202);
    const approvedBody = (await approved.json()) as { operationId: string };
    expect(await h.repos.outbox.getByGitOperationId(approvedBody.operationId)).toMatchObject({
      kind: "repository_document.write",
      payload: { revisionProposalId: proposalId },
    });

    const immediate = await createDirect(
      {
        proposalType: "repository_document",
        targetKind: "outline",
        targetPath: OUTLINE_PATH,
        baseContentHash: OUTLINE_HASH,
        proposedContent: proposedContent.replace("Baseline", "Baseline revised"),
        applyImmediately: true,
      },
      maintainer,
    );
    expect(immediate.response.status).toBe(202);
    expect(await h.repos.revisionProposals.getById(immediate.body["proposalId"] as string)).toMatchObject({
      status: "applying",
      targetKind: "outline",
      reviewedByActorId: expect.any(String),
      gitOperationId: immediate.body["operationId"],
    });
  });

  it("refuses unconfigured document paths and stale repository-document bases", async () => {
    const wrongPath = await createDirect({
      proposalType: "repository_document",
      targetKind: "outline",
      targetPath: "private/outline.yml",
      baseContentHash: OUTLINE_HASH,
      proposedContent: OUTLINE_SOURCE,
    });
    expect(wrongPath.response.status).toBe(400);

    h.reader.files.set(OUTLINE_PATH, `${OUTLINE_SOURCE}# moved\n`);
    const stale = await createDirect({
      proposalType: "repository_document",
      targetKind: "outline",
      targetPath: OUTLINE_PATH,
      baseContentHash: OUTLINE_HASH,
      proposedContent: `${OUTLINE_SOURCE}# proposed\n`,
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body).toMatchObject({ type: expect.stringContaining("revision-conflict") });
  });

  it("approves direct proposals through linked chapter.write and supports audited applyImmediately", async () => {
    const created = await createDirect();
    const proposalId = created.body["proposalId"] as string;
    const reviewKey = "approve-direct-proposal";
    const approve = () =>
      h.app.request(
        `${proposalPath(h, proposalId)}/approve`,
        jsonRequest("POST", { reason: "Ready." }, {
          Cookie: maintainer,
          "Idempotency-Key": reviewKey,
        }),
      );
    const approved = await approve();
    expect(approved.status).toBe(202);
    const approvedBody = (await approved.json()) as { operationId: string };
    const replay = await approve();
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({
      proposalId,
      operationId: approvedBody.operationId,
      correlationId: expect.any(String),
      status: "applying",
    });
    const proposal = await h.repos.revisionProposals.getById(proposalId);
    expect(proposal).toMatchObject({
      status: "applying",
      gitOperationId: approvedBody.operationId,
      reviewReason: "Ready.",
    });
    const row = await h.repos.outbox.getByGitOperationId(approvedBody.operationId);
    expect(row).toMatchObject({
      kind: "chapter.write",
      payload: {
        chapterId: CHAPTER_ID,
        action: "revise",
        actorId: proposal?.authorActorId,
        revisionProposalId: proposalId,
        intent: { baseRevision: 3, body: "Revised paragraph.\n" },
      },
    });

    const immediate = await createDirect(
      directCommand({ proposedContent: "Maintainer revision.\n", applyImmediately: true }),
      maintainer,
    );
    expect(immediate.response.status).toBe(202);
    const immediateId = immediate.body["proposalId"] as string;
    expect(await h.repos.revisionProposals.getById(immediateId)).toMatchObject({
      status: "applying",
      reviewedByActorId: expect.any(String),
      reviewedAt: expect.any(String),
      gitOperationId: immediate.body["operationId"],
    });
    const immediateAudit = await h.db
      .prepare(
        `SELECT action FROM audit_events
          WHERE target_type = 'revision_proposal' AND target_id = ? ORDER BY action`,
      )
      .bind(immediateId)
      .all<{ action: string }>();
    expect(immediateAudit.map(({ action }) => action)).toEqual([
      "revision_proposal.approve",
      "revision_proposal.create",
    ]);
    const eventTypes = (await h.repos.events.listAfter(h.projectId, 0, 100)).map(
      ({ type }) => type,
    );
    expect(eventTypes.filter((type) => type === "revision_proposal_created")).toHaveLength(2);
    expect(eventTypes.filter((type) => type === "revision_proposal_approved")).toHaveLength(2);
  });

  it("atomically approves or rejects work proposals with their submission and work item", async () => {
    const author = await h.repos.actors.getByExternalIdentity("github:revision-editor");
    if (author === null) throw new Error("editor actor missing");
    const approvedSeed = await seedWorkProposal(h, author.id, "approved");
    const workList = await h.app.request(proposalPath(h), {
      headers: { Cookie: maintainer },
    });
    expect(workList.status).toBe(200);
    const workListBody = (await workList.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(
      workListBody.items.find(({ id }) => id === approvedSeed.proposal.id),
    ).toMatchObject({
      target: { kind: "chapter", id: CHAPTER_ID, path: CHAPTER_PATH },
      currentRevision: 3,
      author: { id: author.id, displayName: "revision-editor", type: "human" },
      workItem: {
        id: approvedSeed.workItemId,
        type: "revise_chapter",
        status: "submitted",
      },
      chapter: { id: CHAPTER_ID, title: "Baseline", revision: 3 },
    });
    const workDetail = await h.app.request(
      proposalPath(h, approvedSeed.proposal.id),
      { headers: { Cookie: maintainer } },
    );
    expect(workDetail.status).toBe(200);
    expect(await workDetail.json()).toMatchObject({
      workItem: {
        id: approvedSeed.workItemId,
        type: "revise_chapter",
        status: "submitted",
      },
    });
    const approved = await h.app.request(
      `${proposalPath(h, approvedSeed.proposal.id)}/approve`,
      jsonRequest("POST", {}, { Cookie: maintainer }),
    );
    expect(approved.status).toBe(202);
    const approvedBody = (await approved.json()) as { operationId: string };
    expect(await h.repos.revisionProposals.getById(approvedSeed.proposal.id)).toMatchObject({
      status: "applying",
      gitOperationId: approvedBody.operationId,
    });
    expect(await h.repos.submissions.getById(approvedSeed.submissionId)).toMatchObject({
      state: "applying",
      gitOperationId: approvedBody.operationId,
    });
    expect(await h.repos.workItems.getById(approvedSeed.workItemId)).toMatchObject({
      status: "applying",
    });
    expect(await h.repos.outbox.getByGitOperationId(approvedBody.operationId)).toMatchObject({
      kind: "submission.apply",
      payload: {
        submissionId: approvedSeed.submissionId,
        workItemId: approvedSeed.workItemId,
      },
    });

    const rejectedSeed = await seedWorkProposal(h, author.id, "rejected");
    const rejected = await h.app.request(
      `${proposalPath(h, rejectedSeed.proposal.id)}/reject`,
      jsonRequest("POST", { reason: "Needs another pass." }, { Cookie: maintainer }),
    );
    expect(rejected.status).toBe(200);
    expect(await h.repos.revisionProposals.getById(rejectedSeed.proposal.id)).toMatchObject({
      status: "rejected",
      reviewReason: "Needs another pass.",
    });
    expect(await h.repos.submissions.getById(rejectedSeed.submissionId)).toMatchObject({
      state: "rejected",
      gitOperationId: null,
    });
    expect(await h.repos.workItems.getById(rejectedSeed.workItemId)).toMatchObject({
      status: "ready",
    });
  });

  it("requires canonical review authority, fails legacy tokens closed, and resolves reviewer races once", async () => {
    const first = await createDirect();
    const proposalId = first.body["proposalId"] as string;
    const reviewer = await mintCanonicalToken(h, maintainer, ["revisions:review"]);
    await h.db
      .prepare(`UPDATE project_memberships SET role = 'maintainer' WHERE actor_id = ?`)
      .bind(reviewer.actorId)
      .run();
    const legacy = await mintToken(h, maintainer, ["submissions:write", "work:claim"]);
    const legacyRow = await h.repos.agentTokens.getById(legacy.tokenId);
    if (legacyRow === null) throw new Error("legacy token missing");
    await h.db
      .prepare(`UPDATE project_memberships SET role = 'maintainer' WHERE actor_id = ?`)
      .bind(legacyRow.actorId)
      .run();
    const denied = await h.app.request(
      `${proposalPath(h, proposalId)}/approve`,
      jsonRequest("POST", {}, { Authorization: `Bearer ${legacy.token}` }),
    );
    expect(denied.status).toBe(403);

    const accepted = await h.app.request(
      `${proposalPath(h, proposalId)}/approve`,
      jsonRequest("POST", {}, { Authorization: `Bearer ${reviewer.token}` }),
    );
    expect(accepted.status).toBe(202);

    const second = await createDirect(
      directCommand({ proposedContent: "Race winner.\n" }),
    );
    const secondId = second.body["proposalId"] as string;
    const before = (await h.repos.outbox.listPending(h.projectId)).length;
    const results = await Promise.all(
      ["review-race-a", "review-race-b"].map((key) =>
        h.app.request(
          `${proposalPath(h, secondId)}/approve`,
          jsonRequest("POST", {}, {
            Cookie: maintainer,
            "Idempotency-Key": key,
          }),
        ),
      ),
    );
    expect(results.map(({ status }) => status).sort()).toEqual([202, 409]);
    expect((await h.repos.outbox.listPending(h.projectId)).length).toBe(before + 1);
  });

  it("checks both revision and content hash, warns on drift, and leaves conflicts pending", async () => {
    const wrong = await createDirect(
      directCommand({ baseContentHash: `sha256:${"f".repeat(64)}` }),
    );
    expect(wrong.response.status).toBe(409);
    expect(await h.repos.revisionProposals.listByProject(h.projectId)).toHaveLength(0);

    const created = await createDirect();
    const proposalId = created.body["proposalId"] as string;
    await h.db
      .prepare(`UPDATE chapters SET revision = 4, content_hash = ? WHERE id = ?`)
      .bind(`sha256:${"a".repeat(64)}`, CHAPTER_ID)
      .run();
    const diff = await h.app.request(`${proposalPath(h, proposalId)}/diff`, {
      headers: { Cookie: editor },
    });
    expect(diff.status).toBe(200);
    expect(await diff.json()).toMatchObject({ proposal: { conflictWarning: true } });

    const approve = await h.app.request(
      `${proposalPath(h, proposalId)}/approve`,
      jsonRequest("POST", {}, { Cookie: maintainer }),
    );
    expect(approve.status).toBe(409);
    expect(await h.repos.revisionProposals.getById(proposalId)).toMatchObject({
      status: "pending_review",
      gitOperationId: null,
    });
    expect(await h.repos.outbox.listPending(h.projectId)).toHaveLength(0);
  });

  it("does not let the legacy direct-authoring endpoint bypass review for published chapters", async () => {
    const response = await h.app.request(
      `/v1/projects/${h.projectId}/chapter-submissions`,
      jsonRequest(
        "POST",
        { chapterId: CHAPTER_ID, baseRevision: 3, body: "Bypass attempt.\n" },
        { Cookie: editor },
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "state-conflict",
      detail: "published chapters must be changed through a revision proposal",
    });
    expect(await h.repos.outbox.listPending(h.projectId)).toHaveLength(0);
  });
});

async function seedWorkProposal(
  h: TestHarness,
  authorActorId: string,
  label: string,
): Promise<{
  proposal: RevisionProposalRecord;
  workItemId: string;
  submissionId: string;
}> {
  const timestamp = "2026-07-22T20:00:00.000Z";
  const annotationId = uuidv7();
  const workItemId = uuidv7();
  const leaseId = uuidv7();
  const submissionId = uuidv7();
  const proposalId = uuidv7();
  await h.repos.annotations.insert({
    id: annotationId,
    projectId: h.projectId,
    chapterId: CHAPTER_ID,
    kind: "suggestion",
    scope: "chapter",
    chapterRevision: 3,
    target: null,
    authorActorId,
    body: `Revise the chapter (${label}).`,
    status: "work_item_created",
    gitOperationId: null,
    supersededBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await h.repos.workItems.insert({
    id: workItemId,
    projectId: h.projectId,
    type: "revise_chapter",
    status: "submitted",
    sourceAnnotationId: annotationId,
    chapterId: CHAPTER_ID,
    baseRevision: 3,
    target: null,
    priority: "normal",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await h.repos.leases.claim({
    id: leaseId,
    projectId: h.projectId,
    workItemId,
    actorId: authorActorId,
    tokenHash: createHash("sha256").update(leaseId).digest("hex"),
    issuedAt: timestamp,
    expiresAt: "2026-07-22T21:00:00.000Z",
    maxExpiresAt: "2026-07-23T00:00:00.000Z",
    renewalCount: 0,
    releasedAt: timestamp,
    revokedAt: null,
  });
  await h.repos.submissions.insert({
    id: submissionId,
    projectId: h.projectId,
    workItemId,
    leaseId,
    actorId: authorActorId,
    type: "chapter_replacement",
    baseRevision: 3,
    baseContentHash: CONTENT_HASH,
    content: `Work revision ${label}.\n`,
    summary: label,
    notes: null,
    state: "received",
    gitOperationId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const proposal: RevisionProposalRecord = {
    id: proposalId,
    projectId: h.projectId,
    chapterId: CHAPTER_ID,
    targetKind: "chapter",
    targetId: CHAPTER_ID,
    targetPath: "chapters/001-baseline.md",
    proposalType: "chapter_replacement",
    origin: "work_submission",
    workItemId,
    submissionId,
    authorActorId,
    baseRevision: 3,
    baseContentHash: CONTENT_HASH,
    baseContent: BASE_BODY,
    proposedContent: `Work revision ${label}.\n`,
    changeSummary: label,
    notes: null,
    status: "pending_review",
    reviewedByActorId: null,
    reviewedAt: null,
    reviewReason: null,
    gitOperationId: null,
    resultingRevision: null,
    commitSha: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await h.repos.revisionProposals.insert(proposal);
  return { proposal, workItemId, submissionId };
}
