import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryHistoryEntry, RepositoryHistoryReader } from "../src/deps.js";
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
const SHAS = {
  1: "1111111111111111111111111111111111111111",
  2: "2222222222222222222222222222222222222222",
  3: "3333333333333333333333333333333333333333",
} as const;

function chapterSource(revision: number, body: string): string {
  return `---
schema: authorbot.chapter/v1
id: ${CHAPTER_ID}
slug: baseline
title: Baseline
order: 10
status: published
revision: ${String(revision)}
authors:
  - actor: github:avery-cole
---

<!-- authorbot:block id="${BLOCK_ID_1}" -->
${body}
`;
}

const SOURCES = {
  1: chapterSource(1, "Original paragraph."),
  2: chapterSource(2, "Second paragraph."),
  3: chapterSource(3, "Current paragraph."),
} as const;

function commitEntry(revision: 1 | 2 | 3): RepositoryHistoryEntry {
  return {
    commitSha: SHAS[revision],
    message: revision === 1 ? "Write the original chapter" : `Revise chapter to ${revision}`,
    authoredAt: `2026-07-${String(19 + revision).padStart(2, "0")}T20:00:00.000Z`,
    committedAt: `2026-07-${String(19 + revision).padStart(2, "0")}T20:01:00.000Z`,
    authorName: revision === 2 ? "continuity-reader" : "Joe Mattie",
    authorLogin: revision === 2 ? null : "JoeMattie",
    parentShas: revision === 1 ? [] : [SHAS[(revision - 1) as 1 | 2]],
  };
}

describe("Phase 11 bounded chapter history", () => {
  let h: TestHarness;
  let maintainer: string;
  let editor: string;
  let listCalls: number;
  let snapshotCalls: number;

  beforeEach(async () => {
    listCalls = 0;
    snapshotCalls = 0;
    const snapshot = fixtureSnapshot();
    const chapter = snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");
    snapshot.chapters[0] = {
      ...chapter,
      contentHash: `sha256:${createHash("sha256").update(SOURCES[3]).digest("hex")}`,
    };
    const reader = new FakeReader(snapshot);
    reader.files.set(CHAPTER_PATH, SOURCES[3]);
    const history: RepositoryHistoryReader = {
      listFileHistory: async (_projectId, path, options) => {
        listCalls += 1;
        expect(path).toBe(CHAPTER_PATH);
        const entries = [commitEntry(3), commitEntry(2), commitEntry(1)];
        const limit = options?.limit ?? 50;
        const page = options?.page ?? 1;
        const start = (page - 1) * limit;
        return {
          outcome: "found",
          entries: entries.slice(start, start + limit),
          page,
          hasMore: start + limit < entries.length,
        };
      },
      readTextFileAtCommit: async (_projectId, path, commitSha) => {
        snapshotCalls += 1;
        expect(path).toBe(CHAPTER_PATH);
        const revision = ([1, 2, 3] as const).find((value) => SHAS[value] === commitSha);
        return revision === undefined
          ? { outcome: "not-found" }
          : { outcome: "found", source: SOURCES[revision] };
      },
    };
    h = await makeHarness({ reader, repositoryHistoryReader: history });
    maintainer = await devLogin(h, "history-maintainer", "maintainer");
    editor = await devLogin(h, "history-editor", "editor");
  });

  afterEach(() => h.close());

  const historyPath = (suffix = "") =>
    `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/history${suffix}`;

  it("lists newest-first metadata without reading historical chapter bodies", async () => {
    const response = await h.app.request(`${historyPath()}?limit=2`, {
      headers: { Cookie: editor },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      current: Record<string, unknown>;
      nextCursor: string | null;
    };
    expect(body.items.map((item) => item["revision"])).toEqual([3, 2]);
    expect(body.items[0]).toMatchObject({
      revision: 3,
      contentHash: expect.stringMatching(/^sha256:/u),
      commitSha: SHAS[3],
      isCurrent: true,
    });
    expect(body.items[1]).toMatchObject({
      revision: 2,
      contentHash: null,
      author: { displayName: "continuity-reader", type: null },
      isCurrent: false,
    });
    expect(body.current).toMatchObject({ revision: 3, status: "published" });
    expect(body.nextCursor).toBe("2");
    expect(listCalls).toBe(1);
    expect(snapshotCalls).toBe(0);
  });

  it("loads one selected snapshot and an adjacent diff with exact orientation", async () => {
    const response = await h.app.request(`${historyPath("/2")}?compare=previous`, {
      headers: { Cookie: editor },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      compare: "previous",
      selected: { revision: 2, content: "Second paragraph." },
      comparison: { revision: 1, content: "Original paragraph." },
      diff: { fromRevision: 1, toRevision: 2, computationLimited: false },
    });
    expect((body["diff"] as { unifiedDiff: string }).unifiedDiff).toContain(
      "+Second paragraph.",
    );
    expect(snapshotCalls).toBe(2);
    expect(listCalls).toBeLessThanOrEqual(2);
  });

  it("compares an old revision to current and handles revision one without a fake before", async () => {
    const current = await h.app.request(`${historyPath("/2")}?compare=current`, {
      headers: { Cookie: editor },
    });
    expect(await current.json()).toMatchObject({
      selected: { revision: 2 },
      comparison: { revision: 3 },
      diff: { fromRevision: 2, toRevision: 3 },
    });

    const original = await h.app.request(`${historyPath("/1")}?compare=previous`, {
      headers: { Cookie: editor },
    });
    expect(await original.json()).toMatchObject({
      selected: { revision: 1, content: "Original paragraph." },
      comparison: null,
      diff: null,
    });
  });

  it("creates an immutable restore proposal without writing or rewinding Git", async () => {
    const response = await h.app.request(
      `${historyPath("/1")}/restore`,
      jsonRequest("POST", {}, { Cookie: editor, "Idempotency-Key": uuidv7() }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { proposalId: string; status: string };
    expect(body.status).toBe("pending_review");
    expect(await h.repos.revisionProposals.getById(body.proposalId)).toMatchObject({
      origin: "history_restore",
      proposalType: "chapter_replacement",
      baseRevision: 3,
      baseContent: "Current paragraph.",
      proposedContent: "Original paragraph.",
      status: "pending_review",
      gitOperationId: null,
    });
    expect(await h.repos.outbox.listPending(h.projectId)).toHaveLength(0);
  });

  it("keeps raw history fail-closed for readers, legacy tokens, and adjacent grants", async () => {
    const reader = await devLogin(h, "ordinary-reader", "reader");
    const readerAttempt = await h.app.request(historyPath(), {
      headers: { Cookie: reader },
    });
    expect(readerAttempt.status).toBe(403);

    const legacy = await mintToken(h, maintainer, ["chapters:read", "annotations:read"]);
    const legacyAttempt = await h.app.request(historyPath(), {
      headers: { Authorization: `Bearer ${legacy.token}` },
    });
    expect(legacyAttempt.status).toBe(403);

    const historyOnly = await mintCanonicalToken(h, maintainer, ["history:read"]);
    expect(
      (
        await h.app.request(historyPath(), {
          headers: { Authorization: `Bearer ${historyOnly.token}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.app.request(
          `${historyPath("/1")}/restore`,
          jsonRequest("POST", {}, { Authorization: `Bearer ${historyOnly.token}` }),
        )
      ).status,
    ).toBe(403);

    const writeOnly = await mintCanonicalToken(h, maintainer, ["revisions:write"]);
    expect(
      (
        await h.app.request(historyPath(), {
          headers: { Authorization: `Bearer ${writeOnly.token}` },
        })
      ).status,
    ).toBe(403);
  });
});
