import { describe, expect, it } from "vitest";
import type { AgentTokenRecord, AnnotationRecord, ReplyRecord } from "../src/records.js";
import { NOW, seedBasics, uuidv7 } from "./helpers.js";

function annotationFixture(
  overrides: Partial<AnnotationRecord> & Pick<AnnotationRecord, "projectId" | "chapterId" | "authorActorId">,
): AnnotationRecord {
  return {
    id: uuidv7(),
    kind: "suggestion",
    scope: "block",
    chapterRevision: 1,
    target: { blockId: uuidv7() },
    body: "Suggestion body.",
    status: "pending_git",
    gitOperationId: null,
    supersededBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("repositories", () => {
  it("round-trips legacy and canonical agent-token capability state", async () => {
    const { db, repos, project, actor } = await seedBasics();
    const token = (overrides: Partial<AgentTokenRecord> = {}): AgentTokenRecord => ({
      id: uuidv7(),
      projectId: project.id,
      actorId: actor.id,
      name: "drafting-agent",
      tokenHash: uuidv7(),
      scopes: ["chapters:read", "work:read"],
      createdBy: actor.id,
      createdAt: NOW,
      expiresAt: "2026-08-22T18:00:00Z",
      revokedAt: null,
      lastUsedAt: null,
      ...overrides,
    });

    // Existing callers omit both new fields. The repository deliberately
    // writes that input as an unconverted legacy row.
    const legacy = token();
    await repos.agentTokens.insert(legacy);
    expect(await repos.agentTokens.getById(legacy.id)).toMatchObject({
      scopes: ["chapters:read", "work:read"],
      capabilitiesV2: null,
      capabilityMode: "legacy",
    });

    const canonical = token({
      capabilitiesV2: ["chapters:read", "comments:read"],
      capabilityMode: "canonical",
    });
    await repos.agentTokens.insert(canonical);
    expect(await repos.agentTokens.getByTokenHash(canonical.tokenHash)).toMatchObject({
      scopes: ["chapters:read", "work:read"],
      capabilitiesV2: ["chapters:read", "comments:read"],
      capabilityMode: "canonical",
    });

    expect(
      await repos.agentTokens.setCapabilityState(legacy.id, {
        scopes: ["chapters:read"],
        capabilitiesV2: ["chapters:read", "suggestions:read"],
        capabilityMode: "canonical",
      }),
    ).toBe(true);
    expect(await repos.agentTokens.getById(legacy.id)).toMatchObject({
      scopes: ["chapters:read"],
      capabilitiesV2: ["chapters:read", "suggestions:read"],
      capabilityMode: "canonical",
    });
    expect(
      await repos.agentTokens.setCapabilityState(uuidv7(), {
        scopes: [],
        capabilitiesV2: [],
        capabilityMode: "canonical",
      }),
    ).toBe(false);
    db.close();
  });

  it("round-trips JSON columns: membership scopes and annotation target", async () => {
    const { db, repos, project, actor, chapter } = await seedBasics();
    await repos.projectMemberships.insert({
      id: uuidv7(),
      projectId: project.id,
      actorId: actor.id,
      role: "contributor",
      scopes: ["chapters:read", "annotations:read", "annotations:write"],
      createdAt: NOW,
      revokedAt: null,
    });
    const membership = await repos.projectMemberships.getByProjectAndActor(project.id, actor.id);
    expect(membership?.scopes).toEqual(["chapters:read", "annotations:read", "annotations:write"]);
    expect(membership?.role).toBe("contributor");

    const target = {
      blockId: uuidv7(),
      textPosition: { start: 3, end: 17 },
      textQuote: { exact: "quoted span", prefix: "a ", suffix: " b" },
    };
    const annotation = annotationFixture({
      projectId: project.id,
      chapterId: chapter.id,
      authorActorId: actor.id,
      scope: "range",
      target,
    });
    await repos.annotations.insert(annotation);
    const stored = await repos.annotations.getById(annotation.id);
    expect(stored?.target).toEqual(target);
    db.close();
  });

  it("pages annotations by UUIDv7 cursor", async () => {
    const { db, repos, project, actor, chapter } = await seedBasics();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const a = annotationFixture({
        projectId: project.id,
        chapterId: chapter.id,
        authorActorId: actor.id,
      });
      ids.push(a.id);
      await repos.annotations.insert(a);
    }
    ids.sort();
    const page1 = await repos.annotations.listByChapter(chapter.id, { limit: 2 });
    expect(page1.map((a) => a.id)).toEqual(ids.slice(0, 2));
    const page2 = await repos.annotations.listByChapter(chapter.id, {
      limit: 2,
      afterId: page1[1]?.id ?? "",
    });
    expect(page2.map((a) => a.id)).toEqual(ids.slice(2, 4));
    db.close();
  });

  it("updates annotation status when the Git mirror commits (pending_git → open)", async () => {
    const { db, repos, project, actor, chapter } = await seedBasics();
    const annotation = annotationFixture({
      projectId: project.id,
      chapterId: chapter.id,
      authorActorId: actor.id,
    });
    await repos.annotations.insert(annotation);
    expect(await repos.annotations.updateStatus(annotation.id, "open", NOW)).toBe(true);
    expect((await repos.annotations.getById(annotation.id))?.status).toBe("open");
    expect(await repos.annotations.updateStatus(uuidv7(), "open", NOW)).toBe(false);
    db.close();
  });

  it("stores replies threaded under annotations", async () => {
    const { db, repos, project, actor, chapter } = await seedBasics();
    const annotation = annotationFixture({
      projectId: project.id,
      chapterId: chapter.id,
      authorActorId: actor.id,
    });
    await repos.annotations.insert(annotation);
    const parent: ReplyRecord = {
      id: uuidv7(),
      projectId: project.id,
      annotationId: annotation.id,
      parentReplyId: null,
      authorActorId: actor.id,
      body: "First reply.",
      status: "pending_git",
      gitOperationId: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repos.replies.insert(parent);
    await repos.replies.insert({ ...parent, id: uuidv7(), parentReplyId: parent.id });
    const replies = await repos.replies.listByAnnotation(annotation.id);
    expect(replies).toHaveLength(2);
    expect(replies.some((r) => r.parentReplyId === parent.id)).toBe(true);
    db.close();
  });

  it("advances git_operations state and preserves unset fields (design §20.2)", async () => {
    const { db, repos, project } = await seedBasics();
    const id = uuidv7();
    await repos.gitOperations.insert({
      id,
      projectId: project.id,
      correlationId: uuidv7(),
      expectedHead: "abc123",
      state: "queued",
      attempts: 0,
      commitSha: null,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repos.gitOperations.updateState(id, { state: "preparing", updatedAt: NOW, attempts: 1 });
    await repos.gitOperations.updateState(id, { state: "committing", updatedAt: NOW });
    await repos.gitOperations.updateState(id, {
      state: "committed",
      updatedAt: NOW,
      commitSha: "deadbeef",
    });
    const op = await repos.gitOperations.getById(id);
    expect(op?.state).toBe("committed");
    expect(op?.attempts).toBe(1);
    expect(op?.commitSha).toBe("deadbeef");
    expect(op?.expectedHead).toBe("abc123");
    expect(await repos.gitOperations.listByProjectAndState(project.id, "committed")).toHaveLength(1);
    db.close();
  });

  it("drains the outbox serially with claim semantics", async () => {
    const { db, repos, project } = await seedBasics();
    const first = uuidv7();
    const second = uuidv7();
    for (const [id, createdAt] of [
      [first, "2026-07-19T18:00:00Z"],
      [second, "2026-07-19T18:00:01Z"],
    ] as const) {
      await repos.outbox.insert({
        id,
        projectId: project.id,
        gitOperationId: null,
        kind: "annotation.create",
        payload: { id },
        status: "pending",
        attempts: 0,
        createdAt,
        processedAt: null,
      });
    }
    const next = await repos.outbox.nextPending(project.id);
    expect(next?.id).toBe(first);
    expect(await repos.outbox.markProcessing(first)).toBe(true);
    expect(await repos.outbox.markProcessing(first)).toBe(false); // already claimed
    await repos.outbox.markDone(first, NOW);
    expect((await repos.outbox.nextPending(project.id))?.id).toBe(second);
    await repos.outbox.markProcessing(second);
    await repos.outbox.markPending(second); // retry path
    expect((await repos.outbox.nextPending(project.id))?.id).toBe(second);
    expect((await repos.outbox.getById(first))?.status).toBe("done");
    expect((await repos.outbox.getById(first))?.attempts).toBe(1);
    db.close();
  });

  it("supports idempotency replay lookups and stored responses", async () => {
    const { db, repos, project, actor } = await seedBasics();
    const id = uuidv7();
    await repos.idempotencyKeys.insert({
      id,
      projectId: project.id,
      actorId: actor.id,
      key: "key-1",
      requestHash: "hash-1",
      responseStatus: null,
      responseBody: null,
      createdAt: NOW,
    });
    await repos.idempotencyKeys.setResponse(id, 202, `{"operationId":"x"}`);
    const stored = await repos.idempotencyKeys.get(project.id, actor.id, "key-1");
    expect(stored?.requestHash).toBe("hash-1");
    expect(stored?.responseStatus).toBe(202);
    expect(stored?.responseBody).toBe(`{"operationId":"x"}`);
    db.close();
  });

  it("manages sessions and tokens: revoke-once and expiry cleanup", async () => {
    const { db, repos, project, actor } = await seedBasics();
    const sessionId = uuidv7();
    await repos.humanSessions.insert({
      id: sessionId,
      sessionHash: "a".repeat(64),
      actorId: actor.id,
      createdAt: NOW,
      expiresAt: "2026-07-10T00:00:00Z", // already expired relative to NOW
      revokedAt: null,
    });
    expect(await repos.humanSessions.deleteExpired(NOW)).toBe(1);
    expect(await repos.humanSessions.getBySessionHash("a".repeat(64))).toBeNull();

    const tokenId = uuidv7();
    await repos.agentTokens.insert({
      id: tokenId,
      projectId: project.id,
      actorId: actor.id,
      name: "bot",
      tokenHash: "b".repeat(64),
      scopes: ["chapters:read"],
      createdBy: actor.id,
      createdAt: NOW,
      expiresAt: "2026-08-18T18:00:00Z",
      revokedAt: null,
      lastUsedAt: null,
    });
    await repos.agentTokens.touchLastUsed(tokenId, NOW);
    expect((await repos.agentTokens.getByTokenHash("b".repeat(64)))?.lastUsedAt).toBe(NOW);
    expect(await repos.agentTokens.revoke(tokenId, NOW)).toBe(true);
    expect(await repos.agentTokens.revoke(tokenId, NOW)).toBe(false);
    db.close();
  });

  it("upserts chapter projections and clears them for rebuild (design §7.5)", async () => {
    const { db, repos, project, chapter } = await seedBasics();
    await repos.chapters.upsert({ ...chapter, revision: 2, title: "Signal (rev 2)" });
    const updated = await repos.chapters.getById(chapter.id);
    expect(updated?.revision).toBe(2);
    expect(updated?.title).toBe("Signal (rev 2)");
    expect(await repos.chapters.listByProject(project.id)).toHaveLength(1);
    expect((await repos.chapters.getBySlug(project.id, chapter.slug))?.id).toBe(chapter.id);
    expect(await repos.chapters.deleteByProject(project.id)).toBe(1);
    expect(await repos.chapters.listByProject(project.id)).toEqual([]);
    db.close();
  });
});
