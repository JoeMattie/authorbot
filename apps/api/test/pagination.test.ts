import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toTimestamp } from "@authorbot/domain";
import { uuidv7 } from "../src/ids.js";
import { CHAPTER_ID, devLogin, makeHarness, type TestHarness } from "./helpers.js";

describe("cursor pagination", () => {
  let h: TestHarness;
  let cookie: string;

  beforeEach(async () => {
    h = await makeHarness();
    cookie = await devLogin(h, "pager", "contributor");

    const author = await h.repos.actors.getByExternalIdentity("github:pager");
    const now = toTimestamp(new Date());
    for (let i = 0; i < 7; i += 1) {
      await h.repos.annotations.insert({
        id: uuidv7(),
        projectId: h.projectId,
        chapterId: CHAPTER_ID,
        kind: "comment",
        scope: "chapter",
        chapterRevision: 3,
        target: null,
        authorActorId: author?.id ?? "",
        body: `note ${i}`,
        status: "open",
        gitOperationId: null,
        supersededBy: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  afterEach(() => h.close());

  it("walks all annotations through limit/cursor pages in id order", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = cursor === null ? "?limit=3" : `?limit=3&cursor=${cursor}`;
      const res = await h.app.request(
        `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations${query}`,
        { headers: { Cookie: cookie } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: {
          id: string;
          author: { id: string; displayName: string; type: string | null } | null;
        }[];
        nextCursor: string | null;
      };
      expect(body.items[0]?.author).toMatchObject({
        displayName: "pager",
        type: "human",
      });
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(seen).toHaveLength(7);
    expect([...seen].sort()).toEqual(seen); // ascending id order
    expect(new Set(seen).size).toBe(7); // no duplicates across pages
  });

  it("rejects an out-of-range limit", async () => {
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations?limit=0`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(400);
  });

  it("members list paginates too", async () => {
    await devLogin(h, "m1", "reader");
    await devLogin(h, "m2", "reader");
    const res = await h.app.request(`/v1/projects/${h.projectId}/members?limit=2`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { actor: { externalIdentity: string } | null }[];
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
    expect(body.items[0]?.actor).not.toBeNull();
  });
});
