/**
 * Phase 3 contract §5: the event feed. SSE framing + Last-Event-ID / ?after
 * resume, the ?poll=1 JSON fallback, heartbeats, and read-auth parity with
 * annotation reads (anonymous on public books).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenSuggestion,
  devLogin,
  jsonRequest,
  makeHarness,
  type TestHarness,
} from "./helpers.js";

const eventsPath = (h: TestHarness): string => `/v1/projects/${h.projectId}/events`;

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

  it("is anonymous-readable on public books and 401 otherwise", async () => {
    const priv = await h.app.request(`${eventsPath(h)}?poll=1`);
    expect(priv.status).toBe(401);

    const pub = await makeHarness({ config: { publicAnnotations: true } });
    const res = await pub.app.request(`/v1/projects/${pub.projectId}/events?poll=1`);
    expect(res.status).toBe(200);
    pub.close();
  });

  it("rejects a malformed cursor", async () => {
    const res = await h.app.request(`${eventsPath(h)}?after=-1&poll=1`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
  });
});
