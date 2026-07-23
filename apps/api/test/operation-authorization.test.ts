import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAPTER_ID,
  devLogin,
  jsonRequest,
  makeHarness,
  mintCanonicalToken,
  mintToken,
  validAnnotationPayload,
  type TestHarness,
} from "./helpers.js";
import { uuidv7 } from "../src/ids.js";

const AT = "2026-07-22T22:00:00.000Z";

describe("operation read authorization", () => {
  let h: TestHarness;
  let maintainer: string;
  let maintainerActorId: string;

  beforeEach(async () => {
    h = await makeHarness();
    maintainer = await devLogin(h, "operation-auth-maintainer", "maintainer");
    const actor = await h.repos.actors.getByExternalIdentity(
      "github:operation-auth-maintainer",
    );
    if (actor === null) throw new Error("maintainer actor is missing");
    maintainerActorId = actor.id;
  });

  afterEach(() => h.close());

  const operationUrl = (operationId: string): string =>
    `/v1/projects/${h.projectId}/operations/${operationId}`;

  const readOperation = (operationId: string, token: string): Promise<Response> =>
    Promise.resolve(
      h.app.request(operationUrl(operationId), {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

  const insertAnnotation = async (
    kind: "comment" | "suggestion",
  ): Promise<string> => {
    const id = uuidv7();
    await h.repos.annotations.insert({
      id,
      projectId: h.projectId,
      chapterId: CHAPTER_ID,
      kind,
      scope: "chapter",
      chapterRevision: 3,
      target: null,
      authorActorId: maintainerActorId,
      body: `${kind} used by operation authorization tests`,
      status: "open",
      gitOperationId: null,
      supersededBy: null,
      createdAt: AT,
      updatedAt: AT,
    });
    return id;
  };

  const insertOperation = async (input: {
    actorId: string;
    kind: string;
    payload: unknown;
    action?: string;
    targetType?: string;
    targetId?: string;
  }): Promise<{ operationId: string; correlationId: string }> => {
    const operationId = uuidv7();
    const correlationId = uuidv7();
    await h.db.batch([
      h.repos.gitOperations.insertStatement({
        id: operationId,
        projectId: h.projectId,
        correlationId,
        expectedHead: null,
        state: "queued",
        attempts: 0,
        commitSha: null,
        error: null,
        createdAt: AT,
        updatedAt: AT,
      }),
      h.repos.outbox.insertStatement({
        id: uuidv7(),
        projectId: h.projectId,
        gitOperationId: operationId,
        kind: input.kind,
        payload: input.payload,
        status: "pending",
        attempts: 0,
        createdAt: AT,
        processedAt: null,
      }),
      h.repos.auditEvents.insertStatement({
        id: uuidv7(),
        projectId: h.projectId,
        actorId: input.actorId,
        action: input.action ?? input.kind,
        targetType: input.targetType ?? "test",
        targetId: input.targetId ?? null,
        correlationId,
        metadata: null,
        createdAt: AT,
      }),
    ]);
    return { operationId, correlationId };
  };

  it("keeps human-member reads and lets canonical owners or exact-kind readers poll", async () => {
    const owner = await mintCanonicalToken(h, maintainer, [
      "chapters:read",
      "comments:write",
    ]);
    const created = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest(
        "POST",
        { ...validAnnotationPayload(), kind: "comment" },
        { Authorization: `Bearer ${owner.token}` },
      ),
    );
    expect(created.status).toBe(202);
    const { operationId } = (await created.json()) as { operationId: string };

    // The actor that received the 202 can poll even without comments:read.
    expect((await readOperation(operationId, owner.token)).status).toBe(200);

    const commentReader = await mintCanonicalToken(h, maintainer, ["comments:read"]);
    expect((await readOperation(operationId, commentReader.token)).status).toBe(200);

    const adjacentReader = await mintCanonicalToken(h, maintainer, [
      "chapters:read",
      "suggestions:read",
    ]);
    expect((await readOperation(operationId, adjacentReader.token)).status).toBe(403);

    const readerCookie = await devLogin(h, "operation-auth-reader", "reader");
    const humanRead = await h.app.request(operationUrl(operationId), {
      headers: { Cookie: readerCookie },
    });
    expect(humanRead.status).toBe(200);
  });

  it("resolves reply and decision operations through their exact parent feedback kind", async () => {
    const annotationId = await insertAnnotation("comment");
    const replyId = uuidv7();
    await h.repos.replies.insert({
      id: replyId,
      projectId: h.projectId,
      annotationId,
      parentReplyId: null,
      authorActorId: maintainerActorId,
      body: "A reply on the comment.",
      status: "open",
      gitOperationId: null,
      createdAt: AT,
      updatedAt: AT,
    });
    const replyOperation = await insertOperation({
      actorId: maintainerActorId,
      kind: "reply.create",
      payload: { replyId, annotationId },
      targetType: "reply",
      targetId: replyId,
    });
    const decisionId = uuidv7();
    await h.repos.decisions.insert({
      id: decisionId,
      projectId: h.projectId,
      sourceAnnotationId: annotationId,
      actionType: "reject_suggestion",
      rule: "test-rule",
      ruleVersion: 1,
      metrics: { net: 1 },
      result: "rejected",
      supportChanged: false,
      overrideReason: null,
      workItemId: null,
      createdAt: AT,
      updatedAt: AT,
    });
    const { operationId } = await insertOperation({
      actorId: maintainerActorId,
      kind: "decision.create",
      payload: { decisionId },
      targetType: "decision",
      targetId: decisionId,
    });

    const commentReader = await mintCanonicalToken(h, maintainer, ["comments:read"]);
    const suggestionReader = await mintCanonicalToken(h, maintainer, ["suggestions:read"]);
    const workReader = await mintCanonicalToken(h, maintainer, ["work:read"]);

    expect((await readOperation(replyOperation.operationId, commentReader.token)).status).toBe(
      200,
    );
    expect((await readOperation(replyOperation.operationId, suggestionReader.token)).status).toBe(
      403,
    );
    expect((await readOperation(operationId, commentReader.token)).status).toBe(200);
    expect((await readOperation(operationId, suggestionReader.token)).status).toBe(403);
    expect((await readOperation(operationId, workReader.token)).status).toBe(403);
  });

  it("classifies Work creation and cancellation decisions by their linked domain", async () => {
    const annotationId = await insertAnnotation("comment");
    const workItemId = uuidv7();
    await h.repos.workItems.insert({
      id: workItemId,
      projectId: h.projectId,
      type: "revise_chapter",
      status: "ready",
      sourceAnnotationId: annotationId,
      chapterId: CHAPTER_ID,
      baseRevision: 3,
      target: null,
      priority: "normal",
      createdAt: AT,
      updatedAt: AT,
    });

    const createDecisionId = uuidv7();
    await h.repos.decisions.insert({
      id: createDecisionId,
      projectId: h.projectId,
      sourceAnnotationId: annotationId,
      actionType: "create_work_item",
      rule: "test-rule",
      ruleVersion: 1,
      metrics: { net: 1 },
      result: "create_work_item",
      supportChanged: false,
      overrideReason: null,
      workItemId,
      createdAt: AT,
      updatedAt: AT,
    });
    const createOperation = await insertOperation({
      actorId: maintainerActorId,
      kind: "decision.create",
      payload: { decisionId: createDecisionId },
      targetType: "decision",
      targetId: createDecisionId,
    });

    const cancelDecisionId = uuidv7();
    await h.repos.decisions.insert({
      id: cancelDecisionId,
      projectId: h.projectId,
      sourceAnnotationId: annotationId,
      actionType: "cancel_work_item",
      rule: "maintainer-override",
      ruleVersion: 0,
      metrics: { net: 1 },
      result: "overridden",
      supportChanged: false,
      overrideReason: "No longer needed.",
      workItemId,
      createdAt: AT,
      updatedAt: AT,
    });
    const cancelOperation = await insertOperation({
      actorId: maintainerActorId,
      kind: "decision.create",
      payload: { decisionId: cancelDecisionId },
      targetType: "decision",
      targetId: cancelDecisionId,
    });

    const commentReader = await mintCanonicalToken(h, maintainer, ["comments:read"]);
    const allFeedbackReader = await mintCanonicalToken(h, maintainer, [
      "comments:read",
      "suggestions:read",
    ]);
    const workReader = await mintCanonicalToken(h, maintainer, ["work:read"]);

    expect((await readOperation(createOperation.operationId, commentReader.token)).status).toBe(
      200,
    );
    expect((await readOperation(createOperation.operationId, workReader.token)).status).toBe(200);
    expect((await readOperation(cancelOperation.operationId, commentReader.token)).status).toBe(
      403,
    );
    expect(
      (await readOperation(cancelOperation.operationId, allFeedbackReader.token)).status,
    ).toBe(403);
    expect((await readOperation(cancelOperation.operationId, workReader.token)).status).toBe(200);
  });

  it("uses safe legacy domain translation while preserving owner polling", async () => {
    const legacyWriter = await mintToken(
      h,
      maintainer,
      ["annotations:write"],
      "legacy-operation-writer",
    );
    const created = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", validAnnotationPayload(), {
        Authorization: `Bearer ${legacyWriter.token}`,
      }),
    );
    expect(created.status).toBe(202);
    const { operationId } = (await created.json()) as { operationId: string };

    expect((await readOperation(operationId, legacyWriter.token)).status).toBe(200);

    const chapterReader = await mintToken(
      h,
      maintainer,
      ["chapters:read"],
      "legacy-chapter-reader",
    );
    expect((await readOperation(operationId, chapterReader.token)).status).toBe(403);

    const feedbackReader = await mintToken(
      h,
      maintainer,
      ["annotations:read"],
      "legacy-feedback-reader",
    );
    expect((await readOperation(operationId, feedbackReader.token)).status).toBe(200);

    const chapterOperation = await insertOperation({
      actorId: maintainerActorId,
      kind: "chapter.write",
      payload: { chapterId: CHAPTER_ID, action: "revise" },
      action: "chapter.revise",
      targetType: "chapter",
      targetId: CHAPTER_ID,
    });
    expect((await readOperation(chapterOperation.operationId, chapterReader.token)).status).toBe(
      200,
    );

    const control = await insertOperation({
      actorId: maintainerActorId,
      kind: "book_config.update",
      payload: { actorId: maintainerActorId },
      action: "book_config.update",
      targetType: "project",
      targetId: h.projectId,
    });
    expect((await readOperation(control.operationId, chapterReader.token)).status).toBe(403);
  });

  it("maps chapter, work-submission, and repository-document operations exactly", async () => {
    const chapterReader = await mintCanonicalToken(h, maintainer, ["chapters:read"]);
    const workReader = await mintCanonicalToken(h, maintainer, ["work:read"]);
    const revisionReader = await mintCanonicalToken(h, maintainer, ["revisions:read"]);

    const chapterOperation = await insertOperation({
      actorId: maintainerActorId,
      kind: "chapter.write",
      payload: { chapterId: CHAPTER_ID, action: "revise" },
      action: "chapter.revise",
      targetType: "chapter",
      targetId: CHAPTER_ID,
    });
    expect((await readOperation(chapterOperation.operationId, chapterReader.token)).status).toBe(
      200,
    );
    expect((await readOperation(chapterOperation.operationId, revisionReader.token)).status).toBe(
      403,
    );

    const pendingCreate = await insertOperation({
      actorId: maintainerActorId,
      kind: "chapter.write",
      payload: { chapterId: uuidv7(), action: "create" },
      action: "chapter.create",
      targetType: "chapter",
    });
    expect((await readOperation(pendingCreate.operationId, chapterReader.token)).status).toBe(200);

    const chapterProposalId = uuidv7();
    const chapterProposalOperation = await insertOperation({
      actorId: maintainerActorId,
      kind: "chapter.write",
      payload: {
        chapterId: CHAPTER_ID,
        action: "revise",
        revisionProposalId: chapterProposalId,
      },
      action: "revision_proposal.approve",
      targetType: "revision_proposal",
      targetId: chapterProposalId,
    });
    await h.repos.revisionProposals.insert({
      id: chapterProposalId,
      projectId: h.projectId,
      chapterId: CHAPTER_ID,
      targetKind: "chapter",
      targetId: CHAPTER_ID,
      targetPath: "chapters/001-baseline.md",
      proposalType: "chapter_replacement",
      origin: "direct_edit",
      workItemId: null,
      submissionId: null,
      authorActorId: maintainerActorId,
      baseRevision: 3,
      baseContentHash: `sha256:${"2".repeat(64)}`,
      baseContent: "Before.\n",
      proposedContent: "After.\n",
      changeSummary: null,
      notes: null,
      status: "applying",
      reviewedByActorId: maintainerActorId,
      reviewedAt: AT,
      reviewReason: null,
      gitOperationId: chapterProposalOperation.operationId,
      resultingRevision: null,
      commitSha: null,
      createdAt: AT,
      updatedAt: AT,
    });
    expect(
      (await readOperation(chapterProposalOperation.operationId, revisionReader.token)).status,
    ).toBe(200);
    expect(
      (await readOperation(chapterProposalOperation.operationId, chapterReader.token)).status,
    ).toBe(403);

    const annotationId = await insertAnnotation("suggestion");
    const workItemId = uuidv7();
    const submissionId = uuidv7();
    const workOperation = await insertOperation({
      actorId: maintainerActorId,
      kind: "submission.apply",
      payload: { submissionId, workItemId },
      action: "submission.create",
      targetType: "submission",
      targetId: submissionId,
    });
    await h.repos.workItems.insert({
      id: workItemId,
      projectId: h.projectId,
      type: "revise_chapter",
      status: "applying",
      sourceAnnotationId: annotationId,
      chapterId: CHAPTER_ID,
      baseRevision: 3,
      target: null,
      priority: "normal",
      createdAt: AT,
      updatedAt: AT,
    });
    await h.repos.submissions.insert({
      id: submissionId,
      projectId: h.projectId,
      workItemId,
      leaseId: uuidv7(),
      actorId: maintainerActorId,
      type: "chapter_replacement",
      baseRevision: 3,
      baseContentHash: `sha256:${"0".repeat(64)}`,
      content: "Replacement manuscript text.",
      summary: null,
      notes: null,
      state: "applying",
      gitOperationId: workOperation.operationId,
      createdAt: AT,
      updatedAt: AT,
    });
    expect((await readOperation(workOperation.operationId, workReader.token)).status).toBe(200);
    expect((await readOperation(workOperation.operationId, chapterReader.token)).status).toBe(403);

    const proposalId = uuidv7();
    const documentOperation = await insertOperation({
      actorId: maintainerActorId,
      kind: "repository_document.write",
      payload: { revisionProposalId: proposalId },
      action: "revision_proposal.approve",
      targetType: "revision_proposal",
      targetId: proposalId,
    });
    await h.repos.revisionProposals.insert({
      id: proposalId,
      projectId: h.projectId,
      chapterId: null,
      targetKind: "outline",
      targetId: "outline",
      targetPath: "story/outline.md",
      proposalType: "repository_document",
      origin: "document_edit",
      workItemId: null,
      submissionId: null,
      authorActorId: maintainerActorId,
      baseRevision: null,
      baseContentHash: `sha256:${"1".repeat(64)}`,
      baseContent: "# Before\n",
      proposedContent: "# After\n",
      changeSummary: null,
      notes: null,
      status: "applying",
      reviewedByActorId: maintainerActorId,
      reviewedAt: AT,
      reviewReason: null,
      gitOperationId: documentOperation.operationId,
      resultingRevision: null,
      commitSha: null,
      createdAt: AT,
      updatedAt: AT,
    });
    expect((await readOperation(documentOperation.operationId, revisionReader.token)).status).toBe(
      200,
    );
    expect((await readOperation(documentOperation.operationId, chapterReader.token)).status).toBe(
      403,
    );
  });

  it("fails closed for control, duplicate-domain, and ambiguous-owner linkage", async () => {
    const owner = await mintCanonicalToken(h, maintainer, [], "operation-owner-no-reads");
    const commentReader = await mintCanonicalToken(h, maintainer, ["comments:read"]);
    const chapterReader = await mintCanonicalToken(h, maintainer, ["chapters:read"]);

    const control = await insertOperation({
      actorId: owner.actorId,
      kind: "book_config.update",
      payload: { actorId: owner.actorId },
      action: "book_config.update",
      targetType: "project",
      targetId: h.projectId,
    });
    expect((await readOperation(control.operationId, owner.token)).status).toBe(403);

    const malformedChapter = await insertOperation({
      actorId: owner.actorId,
      kind: "chapter.write",
      payload: { chapterId: CHAPTER_ID, action: "future-private-action" },
      action: "chapter.future",
      targetType: "chapter",
      targetId: CHAPTER_ID,
    });
    expect((await readOperation(malformedChapter.operationId, owner.token)).status).toBe(403);
    expect((await readOperation(malformedChapter.operationId, chapterReader.token)).status).toBe(
      403,
    );

    const danglingChapter = await insertOperation({
      actorId: maintainerActorId,
      kind: "chapter.write",
      payload: { chapterId: uuidv7(), action: "revise" },
      action: "chapter.revise",
      targetType: "chapter",
    });
    expect((await readOperation(danglingChapter.operationId, chapterReader.token)).status).toBe(
      403,
    );

    const annotationId = await insertAnnotation("comment");
    const duplicate = await insertOperation({
      actorId: maintainerActorId,
      kind: "annotation.create",
      payload: { annotationId },
      targetType: "annotation",
      targetId: annotationId,
    });
    await h.repos.outbox.insert({
      id: uuidv7(),
      projectId: h.projectId,
      gitOperationId: duplicate.operationId,
      kind: "annotation.create",
      payload: { annotationId },
      status: "pending",
      attempts: 0,
      createdAt: AT,
      processedAt: null,
    });
    expect((await readOperation(duplicate.operationId, commentReader.token)).status).toBe(403);

    const ambiguous = await insertOperation({
      actorId: owner.actorId,
      kind: "annotation.create",
      payload: { annotationId },
      targetType: "annotation",
      targetId: annotationId,
    });
    await h.repos.auditEvents.insert({
      id: uuidv7(),
      projectId: h.projectId,
      actorId: maintainerActorId,
      action: "test.correlation.reused",
      targetType: "operation",
      targetId: ambiguous.operationId,
      correlationId: ambiguous.correlationId,
      metadata: null,
      createdAt: AT,
    });
    expect((await readOperation(ambiguous.operationId, owner.token)).status).toBe(403);
    // Ambiguous ownership does not defeat independently sufficient authority.
    expect((await readOperation(ambiguous.operationId, commentReader.token)).status).toBe(200);
  });
});
