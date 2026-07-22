import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_ORIGIN,
  CHAPTER_ID,
  devLogin,
  jsonRequest,
  makeHarness,
  mintToken,
  validAnnotationPayload,
  type TestHarness,
} from "./helpers.js";
import { uuidv7 } from "../src/ids.js";

const AT = "2026-07-22T20:00:00.000Z";

describe("Phase 11 exact editorial endpoint authorization", () => {
  let h: TestHarness;
  let maintainer: string;
  let maintainerActorId: string;

  beforeEach(async () => {
    h = await makeHarness();
    maintainer = await devLogin(h, "phase11-route-maintainer", "maintainer");
    const actor = await h.repos.actors.getByExternalIdentity(
      "github:phase11-route-maintainer",
    );
    if (actor === null) throw new Error("maintainer actor is missing");
    maintainerActorId = actor.id;
  });

  afterEach(() => h.close());

  const mintCanonical = async (
    capabilities: string[],
    name = `agent-${uuidv7()}`,
  ): Promise<{ token: string; tokenId: string; actorId: string }> => {
    const response = await h.app.request(
      `/v1/projects/${h.projectId}/agent-tokens`,
      jsonRequest("POST", { name, capabilities }, { Cookie: maintainer }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      token: string;
      id: string;
      actorId: string;
    };
    return { token: body.token, tokenId: body.id, actorId: body.actorId };
  };

  const promoteAgent = async (actorId: string): Promise<void> => {
    await h.db
      .prepare(`UPDATE project_memberships SET role = 'maintainer' WHERE actor_id = ?`)
      .bind(actorId)
      .run();
  };

  const insertAnnotation = async (input: {
    id: string;
    kind: "comment" | "suggestion";
    authorActorId?: string;
    scope?: "range" | "block" | "chapter";
  }): Promise<void> => {
    await h.repos.annotations.insert({
      id: input.id,
      projectId: h.projectId,
      chapterId: CHAPTER_ID,
      kind: input.kind,
      scope: input.scope ?? "chapter",
      chapterRevision: 3,
      target: null,
      authorActorId: input.authorActorId ?? maintainerActorId,
      body: `${input.kind} ${input.id}`,
      status: "open",
      gitOperationId: null,
      supersededBy: null,
      createdAt: AT,
      updatedAt: AT,
    });
  };

  it("filters mixed feedback and chapter badges by exact kind before pagination", async () => {
    const suggestionId = "01900000-0000-7000-8000-000000000201";
    const commentId = "01900000-0000-7000-8000-000000000202";
    await insertAnnotation({ id: suggestionId, kind: "suggestion" });
    await insertAnnotation({ id: commentId, kind: "comment" });
    await h.repos.replies.insert({
      id: "01900000-0000-7000-8000-000000000211",
      projectId: h.projectId,
      annotationId: suggestionId,
      parentReplyId: null,
      authorActorId: maintainerActorId,
      body: "suggestion reply",
      status: "open",
      gitOperationId: null,
      createdAt: AT,
      updatedAt: AT,
    });
    await h.repos.replies.insert({
      id: "01900000-0000-7000-8000-000000000212",
      projectId: h.projectId,
      annotationId: commentId,
      parentReplyId: null,
      authorActorId: maintainerActorId,
      body: "comment reply",
      status: "open",
      gitOperationId: null,
      createdAt: AT,
      updatedAt: AT,
    });

    const comments = await mintCanonical(["chapters:read", "comments:read"]);
    const commentList = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations?limit=1`,
      { headers: { Authorization: `Bearer ${comments.token}` } },
    );
    expect(commentList.status).toBe(200);
    expect(await commentList.json()).toMatchObject({
      items: [{ id: commentId, kind: "comment" }],
      nextCursor: commentId,
    });
    expect(
      (
        await h.app.request(
          `/v1/projects/${h.projectId}/annotations/${suggestionId}`,
          { headers: { Authorization: `Bearer ${comments.token}` } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.app.request(
          `/v1/projects/${h.projectId}/annotations/${suggestionId}/replies`,
          { headers: { Authorization: `Bearer ${comments.token}` } },
        )
      ).status,
    ).toBe(403);

    const chapterList = await h.app.request(`/v1/projects/${h.projectId}/chapters`, {
      headers: { Authorization: `Bearer ${comments.token}` },
    });
    const commentActivity = (
      (await chapterList.json()) as { items: Array<{ activity: Record<string, unknown> }> }
    ).items[0]?.activity;
    expect(commentActivity).toMatchObject({
      openChapterComments: 1,
      openReplies: 1,
    });
    expect(commentActivity).not.toHaveProperty("openSuggestions");

    const suggestions = await mintCanonical(["chapters:read", "suggestions:read"]);
    const suggestionList = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      { headers: { Authorization: `Bearer ${suggestions.token}` } },
    );
    expect(await suggestionList.json()).toMatchObject({
      items: [{ id: suggestionId, kind: "suggestion" }],
    });
    const suggestionChapters = await h.app.request(
      `/v1/projects/${h.projectId}/chapters`,
      { headers: { Authorization: `Bearer ${suggestions.token}` } },
    );
    const suggestionActivity = (
      (await suggestionChapters.json()) as {
        items: Array<{ activity: Record<string, unknown> }>;
      }
    ).items[0]?.activity;
    expect(suggestionActivity).toMatchObject({ openSuggestions: 1, openReplies: 1 });
    expect(suggestionActivity).not.toHaveProperty("openChapterComments");
  });

  it("requires the exact kind write and chapters:read to create feedback", async () => {
    const comments = await mintCanonical(["chapters:read", "comments:write"]);
    const comment = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest(
        "POST",
        { ...validAnnotationPayload(), kind: "comment" },
        { Authorization: `Bearer ${comments.token}` },
      ),
    );
    expect(comment.status).toBe(202);

    const beforeDenied = await h.db
      .prepare(`SELECT COUNT(*) AS count FROM annotations`)
      .first<{ count: number }>();
    const adjacent = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest(
        "POST",
        validAnnotationPayload(),
        { Authorization: `Bearer ${comments.token}` },
      ),
    );
    expect(adjacent.status).toBe(403);
    const afterDenied = await h.db
      .prepare(`SELECT COUNT(*) AS count FROM annotations`)
      .first<{ count: number }>();
    expect(afterDenied?.count).toBe(beforeDenied?.count);

    const noChapterRead = await mintCanonical(["comments:write"]);
    const missingPrerequisite = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest(
        "POST",
        { ...validAnnotationPayload(), kind: "comment" },
        { Authorization: `Bearer ${noChapterRead.token}` },
      ),
    );
    expect(missingPrerequisite.status).toBe(403);

    const suggestions = await mintCanonical(["chapters:read", "suggestions:write"]);
    const suggestion = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", validAnnotationPayload(), {
        Authorization: `Bearer ${suggestions.token}`,
      }),
    );
    expect(suggestion.status).toBe(202);
  });

  it("requires replies:write plus read access to the parent kind", async () => {
    const commentId = "01900000-0000-7000-8000-000000000221";
    const suggestionId = "01900000-0000-7000-8000-000000000222";
    await insertAnnotation({ id: commentId, kind: "comment" });
    await insertAnnotation({ id: suggestionId, kind: "suggestion" });
    const replier = await mintCanonical(["comments:read", "replies:write"]);

    const allowed = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${commentId}/replies`,
      jsonRequest("POST", { body: "A comment reply." }, {
        Authorization: `Bearer ${replier.token}`,
      }),
    );
    expect(allowed.status).toBe(202);
    const wrongKind = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${suggestionId}/replies`,
      jsonRequest("POST", { body: "Must not cross kind authority." }, {
        Authorization: `Bearer ${replier.token}`,
      }),
    );
    expect(wrongKind.status).toBe(403);

    const readerOnly = await mintCanonical(["comments:read"]);
    const missingWrite = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${commentId}/replies`,
      jsonRequest("POST", { body: "No reply grant." }, {
        Authorization: `Bearer ${readerOnly.token}`,
      }),
    );
    expect(missingWrite.status).toBe(403);
  });

  it("separates own withdrawal from maintainer moderation", async () => {
    const owner = await mintCanonical(["feedback:withdraw-own"]);
    const ownId = "01900000-0000-7000-8000-000000000231";
    const otherId = "01900000-0000-7000-8000-000000000232";
    await insertAnnotation({ id: ownId, kind: "comment", authorActorId: owner.actorId });
    await insertAnnotation({ id: otherId, kind: "comment" });

    const own = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${ownId}/withdraw`,
      jsonRequest("POST", undefined, { Authorization: `Bearer ${owner.token}` }),
    );
    expect(own.status).toBe(202);
    const cannotModerate = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${otherId}/withdraw`,
      jsonRequest("POST", undefined, { Authorization: `Bearer ${owner.token}` }),
    );
    expect(cannotModerate.status).toBe(403);

    const moderator = await mintCanonical(["feedback:moderate"]);
    await promoteAgent(moderator.actorId);
    const moderated = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${otherId}/withdraw`,
      jsonRequest("POST", undefined, { Authorization: `Bearer ${moderator.token}` }),
    );
    expect(moderated.status).toBe(202);
  });

  it("admits exact and legacy-source moderation, but not adjacent grants", async () => {
    const pendingId = "01900000-0000-7000-8000-000000000241";
    await h.repos.pendingAnnotations.insert({
      id: pendingId,
      projectId: h.projectId,
      chapterId: CHAPTER_ID,
      kind: "comment",
      scope: "chapter",
      chapterRevision: 3,
      target: null,
      authorActorId: maintainerActorId,
      body: "Queued for exact moderation.",
      status: "pending",
      reviewedByActorId: null,
      reviewedAt: null,
      rejectionReason: null,
      approvedAnnotationId: null,
      createdAt: AT,
      updatedAt: AT,
    });

    const adjacent = await mintCanonical(["comments:read"]);
    await promoteAgent(adjacent.actorId);
    const denied = await h.app.request(
      `/v1/projects/${h.projectId}/moderation/queue`,
      { headers: { Authorization: `Bearer ${adjacent.token}` } },
    );
    expect(denied.status).toBe(403);

    const moderator = await mintCanonical(["feedback:moderate"]);
    await promoteAgent(moderator.actorId);
    const queue = await h.app.request(`/v1/projects/${h.projectId}/moderation/queue`, {
      headers: { Authorization: `Bearer ${moderator.token}` },
    });
    expect(queue.status).toBe(200);
    expect(await queue.json()).toMatchObject({ items: [{ id: pendingId }] });
    const approved = await h.app.request(
      `/v1/projects/${h.projectId}/moderation/${pendingId}/approve`,
      jsonRequest("POST", undefined, { Authorization: `Bearer ${moderator.token}` }),
    );
    expect(approved.status).toBe(202);

    const legacy = await mintToken(h, maintainer, ["annotations:write"]);
    const legacyRecord = await h.repos.agentTokens.getById(legacy.tokenId);
    if (legacyRecord === null) throw new Error("legacy token record is missing");
    await promoteAgent(legacyRecord.actorId);
    const legacyQueue = await h.app.request(
      `/v1/projects/${h.projectId}/moderation/queue?status=all`,
      { headers: { Authorization: `Bearer ${legacy.token}` } },
    );
    expect(legacyQueue.status).toBe(200);
  });

  it("rejects bearer credentials across app and Phase 7 control routes", async () => {
    const legacy = await mintToken(h, maintainer, [
      "chapters:read",
      "members:manage",
      "tokens:manage",
    ]);
    const tokenRecord = await h.repos.agentTokens.getById(legacy.tokenId);
    if (tokenRecord === null) throw new Error("legacy token record is missing");
    await promoteAgent(tokenRecord.actorId);
    const bearer = { Authorization: `Bearer ${legacy.token}` };
    const target = tokenRecord.actorId;
    const attempts = [
      h.app.request(`/v1/projects/${h.projectId}/members`, { headers: bearer }),
      h.app.request(`/v1/projects/${h.projectId}/collaborators`, { headers: bearer }),
      h.app.request(`/v1/projects/${h.projectId}/audit`, { headers: bearer }),
      h.app.request(`/v1/projects/${h.projectId}/access`, { headers: bearer }),
      h.app.request(`/v1/projects/${h.projectId}/settings`, { headers: bearer }),
      h.app.request(`/v1/projects/${h.projectId}/publications`, { headers: bearer }),
      h.app.request(
        `/v1/projects/${h.projectId}/settings`,
        jsonRequest("PATCH", { settings: { title: "Bearer must not edit" } }, bearer),
      ),
      h.app.request(
        `/v1/projects/${h.projectId}/divergence/clear`,
        jsonRequest("POST", { reason: "must be a human" }, bearer),
      ),
      h.app.request(
        `/v1/projects/${h.projectId}/access/freeze`,
        jsonRequest("POST", { reason: "must be a human" }, bearer),
      ),
      h.app.request(
        `/v1/projects/${h.projectId}/access/pause-agents`,
        jsonRequest("POST", { reason: "must be a human" }, bearer),
      ),
      h.app.request(
        `/v1/projects/${h.projectId}/collaborators/${target}`,
        jsonRequest("PATCH", { role: "editor" }, bearer),
      ),
      h.app.request(`/v1/projects/${h.projectId}/collaborators/${target}`, {
        method: "DELETE",
        headers: { ...bearer, Origin: API_ORIGIN, "Idempotency-Key": uuidv7() },
      }),
      h.app.request(
        `/v1/projects/${h.projectId}/operations/01900000-0000-7000-8000-00000000f00d/retry`,
        jsonRequest("POST", undefined, bearer),
      ),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "forbidden" });
    }

    const rateLimits = await h.app.request(
      `/v1/projects/${h.projectId}/rate-limits`,
      { headers: bearer },
    );
    expect(rateLimits.status).toBe(200);
  });
});
