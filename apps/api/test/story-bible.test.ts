import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BookConfig } from "@authorbot/schemas";
import { repositoryPathMatchesGlob } from "../src/repository-documents.js";
import {
  FakeReader,
  devLogin,
  makeHarness,
  mintCanonicalToken,
  type TestHarness,
} from "./helpers.js";

const OUTLINE_PATH = "lore/plot.yml";
const TIMELINE_PATH = "lore/chronology.yaml";
const CHARACTERS_GLOB = "lore/people/*.md";

const OUTLINE = `schema: authorbot.story-graph/v1
nodes:
  - id: premise:main
    type: premise
    title: The test premise
    summary: The machine changes causality.
    order: 10
`;

const TIMELINE = `schema: authorbot.timeline/v1
events:
  - id: event:first-contact
    sort_key: 10
    display_time: Day one
    title: First contact
    participants: [character:ada]
    facts: [The chamber stays sealed.]
`;

function character(id: string, name: string, body: string): string {
  return `---
schema: authorbot.character/v1
id: character:${id}
name: ${name}
summary: Canon entry for ${name}.
---

${body}
`;
}

class StoryReader extends FakeReader {
  readonly pageCalls: Array<{ glob: string; after?: string; limit?: number }> = [];

  async listTextFiles(
    glob: string,
    options: { after?: string; limit?: number } = {},
  ) {
    this.pageCalls.push({ glob, ...options });
    const limit = options.limit ?? 20;
    const paths = [...this.files.keys()]
      .filter((path) => repositoryPathMatchesGlob(path, glob))
      .sort()
      .filter((path) => options.after === undefined || path > options.after);
    const pagePaths = paths.slice(0, limit);
    return {
      headCommit: "0123456789abcdef0123456789abcdef01234567",
      files: pagePaths.map((path) => ({ path, source: this.files.get(path) as string })),
      nextAfter:
        paths.length > pagePaths.length && pagePaths.length > 0
          ? (pagePaths[pagePaths.length - 1] as string)
          : null,
    };
  }
}

function readerWithStory(): StoryReader {
  const reader = new StoryReader();
  reader.files.set(OUTLINE_PATH, OUTLINE);
  reader.files.set(TIMELINE_PATH, TIMELINE);
  reader.files.set("lore/people/ada.md", character("ada", "Ada", "Ada keeps the experiment honest."));
  reader.files.set("lore/people/ben.md", character("ben", "Ben", "Ben runs the chamber."));
  reader.files.set("lore/people/cam.md", character("cam", "Cam", "Cam records the results."));
  reader.files.set("private/secret.md", "must never be returned");
  return reader;
}

describe("authenticated story-bible API", () => {
  let h: TestHarness;
  let reader: StoryReader;
  let maintainer: string;
  let readerCookie: string;

  beforeEach(async () => {
    reader = readerWithStory();
    h = await makeHarness({ reader });
    maintainer = await devLogin(h, "story-maintainer", "maintainer");
    readerCookie = await devLogin(h, "story-reader", "reader");
    const config: BookConfig = {
      schema: "authorbot.book/v1",
      id: "01900000-0000-7000-8000-0000000000bb",
      title: "Hollow Creek Anomaly",
      slug: "hollow-creek-anomaly",
      language: "en",
      planning: {
        outline: OUTLINE_PATH,
        timeline: TIMELINE_PATH,
        characters_glob: CHARACTERS_GLOB,
      },
    };
    await h.repos.bookConfigs.upsert({
      projectId: h.projectId,
      config,
      status: "committed",
      gitOperationId: null,
      sourceCommit: null,
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:00:00Z",
    });
  });

  afterEach(() => h.close());

  it("returns configured, schema-validated outline and timeline documents", async () => {
    const outline = await h.app.request(`/v1/projects/${h.projectId}/story/outline?path=private/secret.md`, {
      headers: { Cookie: readerCookie },
    });
    expect(outline.status).toBe(200);
    expect(await outline.json()).toMatchObject({
      path: OUTLINE_PATH,
      outline: {
        schema: "authorbot.story-graph/v1",
        nodes: [{ id: "premise:main", summary: "The machine changes causality." }],
      },
      links: {
        outline: `/v1/projects/${h.projectId}/story/outline`,
        timeline: `/v1/projects/${h.projectId}/story/timeline`,
        characters: `/v1/projects/${h.projectId}/story/characters`,
      },
    });
    expect(JSON.stringify(await (await h.app.request(
      `/v1/projects/${h.projectId}/story/timeline`,
      { headers: { Cookie: readerCookie } },
    )).json())).toContain("The chamber stays sealed.");
  });

  it("paginates configured character files without reading the whole glob", async () => {
    const first = await h.app.request(
      `/v1/projects/${h.projectId}/story/characters?limit=2`,
      { headers: { Cookie: readerCookie } },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Array<{ path: string; character: { id: string }; body: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.items.map((item) => item.character.id)).toEqual([
      "character:ada",
      "character:ben",
    ]);
    expect(firstBody.items[0]?.body).toBe("Ada keeps the experiment honest.");
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(reader.pageCalls).toEqual([{ glob: CHARACTERS_GLOB, limit: 2 }]);

    const second = await h.app.request(
      `/v1/projects/${h.projectId}/story/characters?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { Cookie: readerCookie } },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { items: Array<{ character: { id: string } }> };
    expect(secondBody.items.map((item) => item.character.id)).toEqual(["character:cam"]);
    expect(reader.pageCalls[1]).toMatchObject({
      glob: CHARACTERS_GLOB,
      after: "lore/people/ben.md",
      limit: 2,
    });
    expect(JSON.stringify(firstBody)).not.toContain("must never be returned");
  });

  it("requires exactly chapters:read for sessions and canonical agent tokens", async () => {
    const url = `/v1/projects/${h.projectId}/story/outline`;
    expect((await h.app.request(url)).status).toBe(401);

    const allowed = await mintCanonicalToken(h, maintainer, ["chapters:read"]);
    expect((await h.app.request(url, {
      headers: { Authorization: `Bearer ${allowed.token}` },
    })).status).toBe(200);

    const denied = await mintCanonicalToken(h, maintainer, ["comments:read"]);
    expect((await h.app.request(url, {
      headers: { Authorization: `Bearer ${denied.token}` },
    })).status).toBe(403);
  });

  it("rejects invalid cursors and unsafe character content without partial output", async () => {
    const invalidCursor = await h.app.request(
      `/v1/projects/${h.projectId}/story/characters?cursor=%%%`,
      { headers: { Cookie: readerCookie } },
    );
    expect(invalidCursor.status).toBe(400);
    expect(reader.pageCalls).toHaveLength(0);

    reader.files.set(
      "lore/people/ada.md",
      character("ada", "Ada", '<script src="https://example.test/x.js"></script>'),
    );
    const unsafe = await h.app.request(
      `/v1/projects/${h.projectId}/story/characters?limit=1`,
      { headers: { Cookie: readerCookie } },
    );
    expect(unsafe.status).toBe(409);
    expect(await unsafe.json()).toMatchObject({ code: "state-conflict" });
  });
});
