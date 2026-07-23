/**
 * Phase 3 contract §5: the event feed. SSE framing + Last-Event-ID / ?after
 * resume, the ?poll=1 JSON fallback, heartbeats, and read-auth parity with
 * annotation reads (anonymous on public books).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BookConfig } from "@authorbot/schemas";
import {
  createOpenSuggestion,
  devLogin,
  jsonRequest,
  makeHarness,
  mintCanonicalToken,
  type TestHarness,
} from "./helpers.js";

const eventsPath = (h: TestHarness): string => `/v1/projects/${h.projectId}/events`;
const BOOK_ID = "01900000-0000-7000-8000-0000000000bb";

async function allowSignedInNonMembers(h: TestHarness): Promise<void> {
  const config: BookConfig = {
    schema: "authorbot.book/v1",
    id: BOOK_ID,
    title: "Hollow Creek Anomaly",
    slug: "hollow-creek-anomaly",
    language: "en",
    collaboration: { annotation_policy: "open" },
  };
  await h.repos.bookConfigs.upsert({
    projectId: h.projectId,
    config,
    status: "committed",
    gitOperationId: null,
    sourceCommit: null,
    createdAt: "2026-07-22T12:00:00Z",
    updatedAt: "2026-07-22T12:00:00Z",
  });
}

async function signedInNonMember(h: TestHarness, login: string): Promise<string> {
  const cookie = await devLogin(h, login, "contributor");
  const actor = await h.repos.actors.getByExternalIdentity(`github:${login}`);
  const membership = await h.repos.projectMemberships.getByProjectAndActor(
    h.projectId,
    actor?.id ?? "missing",
  );
  await h.repos.projectMemberships.revoke(
    membership?.id ?? "missing",
    "2026-07-22T12:00:00Z",
  );
  return cookie;
}

async function seedEvents(h: TestHarness, cookie: string): Promise<string> {
  const id = await createOpenSuggestion(h, cookie);
  await h.app.request(
    `/v1/projects/${h.projectId}/annotations/${id}/vote`,
    jsonRequest("PUT", { value: "approve" }, { Cookie: cookie }),
  );
  return id;
}

/** Read an SSE stream for up to `ms`, then cancel and return the raw text. */
async function readStream(res: Response, ms: number): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done) break;
      if (chunk.value !== undefined) text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

describe("event feed", () => {
  let h: TestHarness;
  let cookie: string;

  beforeEach(async () => {
    h = await makeHarness({ config: { ssePollMs: 20, sseHeartbeatMs: 30 } });
    cookie = await devLogin(h, "eve", "contributor");
  });
  afterEach(() => h.close());

  it("poll fallback returns events as JSON after a cursor", async () => {
    await seedEvents(h, cookie);
    const res = await h.app.request(`${eventsPath(h)}?after=0&poll=1`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: number; type: string }[]; latestId: number };
    expect(body.items.length).toBeGreaterThan(0);
    // Creating the suggestion emits annotation_created (contract §5); the vote
    // then emits vote_aggregate.
    expect(body.items[0]?.type).toBe("annotation_created");
    expect(body.items.map((e) => e.type)).toContain("vote_aggregate");
    expect(body.latestId).toBe(body.items.at(-1)?.id);

    // Resume from latest → no more rows.
    const resume = await h.app.request(
      `${eventsPath(h)}?after=${body.latestId}&poll=1`,
      { headers: { Cookie: cookie } },
    );
    expect(((await resume.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("gives Last-Event-ID precedence over the original after query", async () => {
    await seedEvents(h, cookie);
    const latest = await h.repos.events.latestId(h.projectId);

    // Native EventSource reconnects reuse the original URL but add a newer
    // Last-Event-ID header. The stale URL cursor must not replay old rows.
    const resumed = await h.app.request(
      `${eventsPath(h)}?after=0&poll=1`,
      { headers: { Cookie: cookie, "Last-Event-ID": String(latest) } },
    );
    expect(((await resumed.json()) as { items: unknown[] }).items).toHaveLength(0);

    // Header precedence applies in both directions and ignores an obsolete,
    // malformed query value once the reconnect cursor is present.
    const fromHeader = await h.app.request(
      `${eventsPath(h)}?after=not-a-cursor&poll=1`,
      { headers: { Cookie: cookie, "Last-Event-ID": "0" } },
    );
    expect(fromHeader.status).toBe(200);
    const body = (await fromHeader.json()) as { items: { id: number }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((event) => event.id > 0)).toBe(true);
  });

  it("SSE streams framed events from a resume cursor", async () => {
    await seedEvents(h, cookie);
    const res = await h.app.request(eventsPath(h), {
      headers: { Cookie: cookie, "Last-Event-ID": "0" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await readStream(res, 200);
    expect(text).toContain("event: vote_aggregate");
    expect(text).toMatch(/id: \d+/);
    expect(text).toContain("data: ");
  });

  it("SSE resumes without replaying already-seen rows and delivers live events", async () => {
    await seedEvents(h, cookie);
    const latest = await h.repos.events.latestId(h.projectId);
    const res = await h.app.request(eventsPath(h), {
      headers: { Cookie: cookie, "Last-Event-ID": String(latest) },
    });
    // No backlog after the cursor yet; produce one live event mid-stream.
    const streamPromise = readStream(res, 250);
    const id2 = await createOpenSuggestion(h, cookie);
    await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id2}/vote`,
      jsonRequest("PUT", { value: "reject" }, { Cookie: cookie }),
    );
    const text = await streamPromise;
    // Only the live vote_aggregate (id > cursor) is delivered.
    expect(text).toContain("event: vote_aggregate");
    for (const frame of text.split("\n\n")) {
      const idMatch = frame.match(/^id: (\d+)/m);
      if (idMatch?.[1] !== undefined) {
        expect(Number(idMatch[1])).toBeGreaterThan(latest);
      }
    }
  });

  it("emits heartbeat comments", async () => {
    const res = await h.app.request(eventsPath(h), { headers: { Cookie: cookie } });
    const text = await readStream(res, 120);
    expect(text).toContain(": heartbeat");
  });

  it("keeps anonymous polling readable on public books and 401s private books", async () => {
    const priv = await h.app.request(`${eventsPath(h)}?poll=1`);
    expect(priv.status).toBe(401);

    const pub = await makeHarness({ config: { publicAnnotations: true } });
    const res = await pub.app.request(`/v1/projects/${pub.projectId}/events?poll=1`);
    expect(res.status).toBe(200);
    pub.close();
  });

  it("filters member-only rows from anonymous polling while advancing its cursor", async () => {
    const pub = await makeHarness({ config: { publicAnnotations: true } });
    const path = `/v1/projects/${pub.projectId}/events`;
    const after = await pub.repos.events.latestId(pub.projectId);
    const hiddenOne = await pub.repos.events.append({
      projectId: pub.projectId,
      type: "project_divergence_cleared",
      payload: { reason: "private maintainer prose" },
      createdAt: "2026-07-22T12:00:00.000Z",
    });
    const hiddenTwo = await pub.repos.events.append({
      projectId: pub.projectId,
      type: "work_item_conflict",
      payload: { reason: "private integration failure", workItemId: "work-private" },
      createdAt: "2026-07-22T12:00:01.000Z",
    });
    const hiddenOperation = await pub.repos.events.append({
      projectId: pub.projectId,
      type: "operation_completed",
      payload: { operationId: "operation-private", kind: "chapter.write" },
      createdAt: "2026-07-22T12:00:02.000Z",
    });
    const publicOperation = await pub.repos.events.append({
      projectId: pub.projectId,
      type: "operation_completed",
      payload: { operationId: "operation-public", kind: "annotation.create" },
      createdAt: "2026-07-22T12:00:03.000Z",
    });
    const visible = await pub.repos.events.append({
      projectId: pub.projectId,
      type: "annotation_created",
      payload: { annotationId: "annotation-public", chapterId: "chapter-public" },
      createdAt: "2026-07-22T12:00:04.000Z",
    });

    // A page containing only a hidden row is still consumed. Returning the
    // filtered item's cursor would otherwise fetch it forever.
    const first = await pub.app.request(`${path}?poll=1&after=${after}&limit=1`);
    const firstBody = (await first.json()) as {
      items: { id: number; type: string; payload: unknown }[];
      latestId: number;
    };
    expect(firstBody.items).toEqual([]);
    expect(firstBody.latestId).toBe(hiddenOne.id);

    const second = await pub.app.request(
      `${path}?poll=1&after=${firstBody.latestId}&limit=4`,
    );
    const secondBody = (await second.json()) as {
      items: { id: number; type: string; payload: unknown }[];
      latestId: number;
    };
    expect(secondBody.items.map((event) => event.type)).toEqual([
      "operation_completed",
      "annotation_created",
    ]);
    expect(secondBody.items[0]?.id).toBe(publicOperation.id);
    expect(secondBody.items[1]?.id).toBe(visible.id);
    expect(secondBody.latestId).toBe(visible.id);
    expect(JSON.stringify(secondBody)).not.toContain("private integration failure");
    expect(JSON.stringify(secondBody)).not.toContain("work-private");
    expect(JSON.stringify(secondBody)).not.toContain("operation-private");
    expect(JSON.stringify(secondBody)).not.toContain("chapter.write");

    // Members retain the complete operational feed.
    const member = await devLogin(pub, "event-member", "contributor");
    const memberResponse = await pub.app.request(`${path}?poll=1&after=${after}&limit=10`, {
      headers: { Cookie: member },
    });
    const memberBody = (await memberResponse.json()) as { items: { type: string }[] };
    expect(memberBody.items.map((event) => event.type)).toEqual([
      hiddenOne.type,
      hiddenTwo.type,
      hiddenOperation.type,
      publicOperation.type,
      visible.type,
    ]);
    pub.close();
  });

  it("filters signed-in non-members like public readers and refuses their SSE", async () => {
    const pub = await makeHarness();
    await allowSignedInNonMembers(pub);
    const stranger = await signedInNonMember(pub, "event-stranger");
    const path = `/v1/projects/${pub.projectId}/events`;
    const after = await pub.repos.events.latestId(pub.projectId);
    await pub.repos.events.append({
      projectId: pub.projectId,
      type: "project_divergence_cleared",
      payload: { reason: "private incident response prose" },
      createdAt: "2026-07-22T12:00:01Z",
    });
    const visible = await pub.repos.events.append({
      projectId: pub.projectId,
      type: "annotation_created",
      payload: { annotationId: "annotation-public", chapterId: "chapter-public" },
      createdAt: "2026-07-22T12:00:02Z",
    });

    const poll = await pub.app.request(`${path}?poll=1&after=${after}`, {
      headers: { Cookie: stranger },
    });
    expect(poll.status).toBe(200);
    const body = (await poll.json()) as {
      items: { id: number; type: string; payload: unknown }[];
    };
    expect(body.items.map((event) => event.id)).toEqual([visible.id]);
    expect(JSON.stringify(body)).not.toContain("private incident response prose");

    const stream = await pub.app.request(path, { headers: { Cookie: stranger } });
    expect(stream.status).toBe(403);
    expect(((await stream.json()) as { code: string }).code).toBe("forbidden");
    pub.close();
  });

  it("filters private work and decision subtypes while preserving public variants", async () => {
    const pub = await makeHarness({ config: { publicAnnotations: true } });
    const path = `/v1/projects/${pub.projectId}/events`;
    const after = await pub.repos.events.latestId(pub.projectId);
    await pub.repos.events.append({
      projectId: pub.projectId,
      type: "work_item_created",
      payload: {
        workItemId: "conflict-private",
        chapterId: "chapter-private",
        type: "resolve_conflict",
        baseRevision: 7,
      },
      createdAt: "2026-07-22T12:00:01Z",
    });
    await pub.repos.events.append({
      projectId: pub.projectId,
      type: "decision_created",
      payload: {
        decisionId: "cancel-private",
        workItemId: "work-private",
        result: "overridden",
        override: "cancel",
      },
      createdAt: "2026-07-22T12:00:02Z",
    });
    const publicWork = await pub.repos.events.append({
      projectId: pub.projectId,
      type: "work_item_created",
      payload: {
        workItemId: "work-public",
        annotationId: "annotation-public",
        chapterId: "chapter-public",
        type: "revise_range",
        baseRevision: 3,
        internalLeaseToken: "must-not-cross-public-boundary",
      },
      createdAt: "2026-07-22T12:00:03Z",
    });
    const publicDecision = await pub.repos.events.append({
      projectId: pub.projectId,
      type: "decision_created",
      payload: {
        decisionId: "decision-public",
        annotationId: "annotation-public",
        result: "rejected",
        override: "reject",
      },
      createdAt: "2026-07-22T12:00:04Z",
    });

    const response = await pub.app.request(`${path}?poll=1&after=${after}`);
    const body = (await response.json()) as {
      items: { id: number; type: string; payload: unknown }[];
    };
    expect(body.items.map((event) => event.id)).toEqual([
      publicWork.id,
      publicDecision.id,
    ]);
    expect(JSON.stringify(body)).not.toContain("conflict-private");
    expect(JSON.stringify(body)).not.toContain("cancel-private");
    expect(JSON.stringify(body)).not.toContain("must-not-cross-public-boundary");
    expect(body.items[0]?.payload).toEqual({
      workItemId: "work-public",
      annotationId: "annotation-public",
      chapterId: "chapter-public",
      type: "revise_range",
      baseRevision: 3,
    });

    // The member feed remains the lossless operational feed. This proves the
    // secret was stripped at the public serialization boundary rather than
    // mutating or rejecting the stored event row.
    const member = await devLogin(pub, "event-payload-member", "contributor");
    const memberResponse = await pub.app.request(`${path}?poll=1&after=${after}`, {
      headers: { Cookie: member },
    });
    const memberBody = (await memberResponse.json()) as {
      items: { id: number; payload: Record<string, unknown> }[];
    };
    expect(memberBody.items.find((event) => event.id === publicWork.id)?.payload).toMatchObject({
      internalLeaseToken: "must-not-cross-public-boundary",
    });
    pub.close();
  });

  it("gives zero-capability tokens an empty projected poll page and advances the cursor", async () => {
    const owner = await devLogin(h, "event-zero-owner", "maintainer");
    const agent = await mintCanonicalToken(h, owner, [], "event-zero-agent");
    const after = await h.repos.events.latestId(h.projectId);
    await h.repos.events.append({
      projectId: h.projectId,
      type: "annotation_created",
      payload: {
        annotationId: "comment-hidden",
        chapterId: "chapter-hidden",
        kind: "comment",
        internalSecret: "must-not-cross-token-boundary",
      },
      createdAt: "2026-07-22T12:00:01Z",
    });
    await h.repos.events.append({
      projectId: h.projectId,
      type: "revision_proposal_created",
      payload: { proposalId: "proposal-hidden", chapterId: "chapter-hidden" },
      createdAt: "2026-07-22T12:00:02Z",
    });
    const last = await h.repos.events.append({
      projectId: h.projectId,
      type: "agents_paused",
      payload: { affectedTokens: 7, internalSecret: "control-plane-secret" },
      createdAt: "2026-07-22T12:00:03Z",
    });

    const response = await h.app.request(`${eventsPath(h)}?poll=1&after=${after}`, {
      headers: { Authorization: `Bearer ${agent.token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: unknown[];
      latestId: number;
    };
    expect(body.items).toEqual([]);
    expect(body.latestId).toBe(last.id);
    expect(JSON.stringify(body)).not.toContain("must-not-cross-token-boundary");
    expect(JSON.stringify(body)).not.toContain("control-plane-secret");
  });

  it("projects token polling by adjacent read capability and strips additive fields", async () => {
    const owner = await devLogin(h, "event-adjacent-owner", "maintainer");
    const commentAgent = await mintCanonicalToken(
      h,
      owner,
      ["comments:read"],
      "event-comment-reader",
    );
    const workAgent = await mintCanonicalToken(
      h,
      owner,
      ["work:read"],
      "event-work-reader",
    );
    const revisionAgent = await mintCanonicalToken(
      h,
      owner,
      ["revisions:read"],
      "event-revision-reader",
    );
    const after = await h.repos.events.latestId(h.projectId);
    const comment = await h.repos.events.append({
      projectId: h.projectId,
      type: "annotation_created",
      payload: {
        annotationId: "comment-visible",
        chapterId: "chapter-one",
        kind: "comment",
        scope: "block",
        internalSecret: "comment-private-field",
      },
      createdAt: "2026-07-22T12:00:01Z",
    });
    const suggestion = await h.repos.events.append({
      projectId: h.projectId,
      type: "annotation_created",
      payload: {
        annotationId: "suggestion-visible",
        chapterId: "chapter-one",
        kind: "suggestion",
        scope: "range",
        internalSecret: "suggestion-private-field",
      },
      createdAt: "2026-07-22T12:00:02Z",
    });
    const work = await h.repos.events.append({
      projectId: h.projectId,
      type: "work_item_completed",
      payload: {
        workItemId: "work-visible",
        submissionId: "submission-visible",
        chapterId: "chapter-one",
        revision: 4,
        revisionProposalId: "proposal-cross-domain",
        internalSecret: "work-private-field",
      },
      createdAt: "2026-07-22T12:00:03Z",
    });
    const revision = await h.repos.events.append({
      projectId: h.projectId,
      type: "revision_proposal_created",
      payload: {
        proposalId: "proposal-visible",
        chapterId: "chapter-one",
        targetKind: "chapter",
        proposalType: "chapter_replacement",
        internalSecret: "revision-private-field",
      },
      createdAt: "2026-07-22T12:00:04Z",
    });
    await h.repos.events.append({
      projectId: h.projectId,
      type: "project_frozen",
      payload: { internalSecret: "control-private-field" },
      createdAt: "2026-07-22T12:00:05Z",
    });

    const poll = async (token: string) => {
      const response = await h.app.request(`${eventsPath(h)}?poll=1&after=${after}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        items: { id: number; type: string; payload: Record<string, unknown> }[];
      };
    };

    const comments = await poll(commentAgent.token);
    expect(comments.items.map((event) => event.id)).toEqual([comment.id]);
    expect(comments.items[0]?.payload).toEqual({
      annotationId: "comment-visible",
      kind: "comment",
      scope: "block",
    });

    const workOnly = await poll(workAgent.token);
    expect(workOnly.items.map((event) => event.id)).toEqual([work.id]);
    expect(workOnly.items[0]?.payload).toEqual({
      workItemId: "work-visible",
      submissionId: "submission-visible",
    });

    const revisions = await poll(revisionAgent.token);
    expect(revisions.items.map((event) => event.id)).toEqual([revision.id]);
    expect(revisions.items[0]?.payload).toEqual({
      proposalId: "proposal-visible",
      targetKind: "chapter",
      proposalType: "chapter_replacement",
    });
    const serialized = JSON.stringify({ comments, workOnly, revisions });
    expect([
      ...comments.items.map((event) => event.id),
      ...workOnly.items.map((event) => event.id),
      ...revisions.items.map((event) => event.id),
    ]).not.toContain(suggestion.id);
    expect(serialized).not.toContain("private-field");
    expect(serialized).not.toContain("proposal-cross-domain");
  });

  it("projects production Work promotion and cancellation by exact token domain", async () => {
    const maintainer = await devLogin(h, "event-work-maintainer", "maintainer");
    const workToken = await mintCanonicalToken(
      h,
      maintainer,
      ["work:read"],
      "event-work-reader",
    );
    const feedbackToken = await mintCanonicalToken(h, maintainer, [
      "comments:read",
      "suggestions:read",
    ], "event-feedback-reader");
    const combinedToken = await mintCanonicalToken(h, maintainer, [
      "suggestions:read",
      "work:read",
    ], "event-combined-reader");

    const annotationId = await createOpenSuggestion(h, cookie);
    const beforePromotion = await h.repos.events.latestId(h.projectId);
    const promoted = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${annotationId}/force-create-work-item`,
      jsonRequest("POST", {}, { Cookie: maintainer }),
    );
    expect(promoted.status).toBe(201);
    const promotion = (await promoted.json()) as {
      workItemId: string;
      operationIds: string[];
    };

    const poll = async (token: string, after: number) => {
      const response = await h.app.request(`${eventsPath(h)}?poll=1&after=${after}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        items: { type: string; payload: Record<string, unknown> }[];
        latestId: number;
      };
    };

    const workPromotion = await poll(workToken.token, beforePromotion);
    expect(workPromotion.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "decision_created",
          payload: { workItemId: promotion.workItemId },
        }),
        expect.objectContaining({
          type: "work_item_created",
          payload: expect.objectContaining({ workItemId: promotion.workItemId }),
        }),
      ]),
    );
    const workCreated = workPromotion.items.find((event) => event.type === "work_item_created");
    expect(workCreated?.payload).not.toHaveProperty("annotationId");
    expect(workCreated?.payload).not.toHaveProperty("chapterId");
    expect(workCreated?.payload).not.toHaveProperty("baseRevision");

    const combinedPromotion = await poll(combinedToken.token, beforePromotion);
    expect(
      combinedPromotion.items.find((event) => event.type === "work_item_created")?.payload,
    ).toMatchObject({
      workItemId: promotion.workItemId,
      annotationId,
    });
    const feedbackPromotion = await poll(feedbackToken.token, beforePromotion);
    expect(feedbackPromotion.items.some((event) => event.type === "work_item_created")).toBe(false);
    expect(
      feedbackPromotion.items.find((event) => event.type === "decision_created")?.payload,
    ).not.toHaveProperty("workItemId");

    expect(
      (await h.app.request(
        `/v1/projects/${h.projectId}/operations/${promotion.operationIds[0]}`,
        { headers: { Authorization: `Bearer ${workToken.token}` } },
      )).status,
    ).toBe(200);

    const beforeCancellation = workPromotion.latestId;
    const cancelled = await h.app.request(
      `/v1/projects/${h.projectId}/work-items/${promotion.workItemId}/cancel`,
      jsonRequest("POST", { reason: "superseded" }, { Cookie: maintainer }),
    );
    expect(cancelled.status).toBe(200);
    const cancellation = (await cancelled.json()) as { operationIds: string[] };

    const workCancellation = await poll(workToken.token, beforeCancellation);
    expect(workCancellation.items).toEqual([
      expect.objectContaining({
        type: "decision_created",
        payload: expect.objectContaining({
          workItemId: promotion.workItemId,
          result: "overridden",
          override: "cancel",
        }),
      }),
    ]);
    expect((await poll(feedbackToken.token, beforeCancellation)).items).toEqual([]);

    const cancelOperation = `/v1/projects/${h.projectId}/operations/${cancellation.operationIds[0]}`;
    expect((await h.app.request(cancelOperation, {
      headers: { Authorization: `Bearer ${workToken.token}` },
    })).status).toBe(200);
    expect((await h.app.request(cancelOperation, {
      headers: { Authorization: `Bearer ${feedbackToken.token}` },
    })).status).toBe(403);
  });

  it("projects token SSE across a full hidden page without exposing hidden payloads", async () => {
    const owner = await devLogin(h, "event-sse-owner", "maintainer");
    const zero = await mintCanonicalToken(h, owner, [], "event-sse-zero");
    const comments = await mintCanonicalToken(
      h,
      owner,
      ["comments:read"],
      "event-sse-comments",
    );
    const after = await h.repos.events.latestId(h.projectId);
    for (let index = 0; index < 101; index += 1) {
      await h.repos.events.append({
        projectId: h.projectId,
        type: "project_diverged",
        payload: { internalSecret: `hidden-control-${index}` },
        createdAt: `2026-07-22T12:00:${String(index % 60).padStart(2, "0")}Z`,
      });
    }
    const visible = await h.repos.events.append({
      projectId: h.projectId,
      type: "annotation_created",
      payload: {
        annotationId: "sse-comment-visible",
        chapterId: "chapter-one",
        kind: "comment",
        scope: "chapter",
        internalSecret: "sse-private-field",
      },
      createdAt: "2026-07-22T12:01:59Z",
    });
    const hiddenSuggestion = await h.repos.events.append({
      projectId: h.projectId,
      type: "annotation_created",
      payload: {
        annotationId: "sse-suggestion-hidden",
        chapterId: "chapter-one",
        kind: "suggestion",
        scope: "range",
      },
      createdAt: "2026-07-22T12:02:00Z",
    });

    const zeroResponse = await h.app.request(eventsPath(h), {
      headers: {
        Authorization: `Bearer ${zero.token}`,
        "Last-Event-ID": String(after),
      },
    });
    expect(zeroResponse.status).toBe(200);
    const zeroText = await readStream(zeroResponse, 120);
    expect(zeroText).not.toContain("event:");
    expect(zeroText).not.toContain("hidden-control");
    expect(zeroText).toContain(`id: ${hiddenSuggestion.id}`);

    const commentResponse = await h.app.request(eventsPath(h), {
      headers: {
        Authorization: `Bearer ${comments.token}`,
        "Last-Event-ID": String(after),
      },
    });
    expect(commentResponse.status).toBe(200);
    const text = await readStream(commentResponse, 200);
    expect(text).toContain(`id: ${visible.id}`);
    expect(text).toContain("event: annotation_created");
    expect(text).toContain("sse-comment-visible");
    expect(text).not.toContain("sse-suggestion-hidden");
    expect(text).not.toContain("hidden-control");
    expect(text).not.toContain("sse-private-field");
  });

  it("refuses anonymous SSE so EventSource falls back to filtered polling", async () => {
    const pub = await makeHarness({ config: { publicAnnotations: true } });
    const response = await pub.app.request(`/v1/projects/${pub.projectId}/events`);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect((await response.json()) as { code: string }).toMatchObject({ code: "forbidden" });
    pub.close();
  });

  it("rejects a malformed cursor", async () => {
    const res = await h.app.request(`${eventsPath(h)}?after=-1&poll=1`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
  });
});
