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
