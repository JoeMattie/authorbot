import { afterEach, describe, expect, it, vi } from "vitest";
import { CollabApi } from "../site/src/islands/api.js";

const API = "https://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER = "chapter/one";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const revision = (value: number, current = false) => ({
  revision: value,
  contentHash: `sha256:revision-${value}`,
  commitSha: `commit-${value}`,
  createdAt: `2026-07-${String(value).padStart(2, "0")}T00:00:00Z`,
  author: { id: "actor-1", displayName: "Writer", type: "human" },
  changeSummary: `Revision ${value}`,
  origin: "chapter_edit",
  status: "published",
  isCurrent: current,
});

afterEach(() => vi.unstubAllGlobals());

describe("CollabApi chapter history transport", () => {
  it("uses bounded metadata, explicit comparison, and proposal-only restore routes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, ...(init === undefined ? {} : { init }) });
        if (url.endsWith("/history?limit=50")) {
          return json({
            items: [revision(3, true), revision(2)],
            current: { ...revision(3, true), status: "published" },
            nextCursor: "revision-2",
          });
        }
        if (url.endsWith("/history/2?compare=current")) {
          return json({
            chapterId: CHAPTER,
            compare: "current",
            selected: { ...revision(2), content: "Older\n" },
            comparison: { ...revision(3, true), content: "Current\n" },
            current: { ...revision(3, true), status: "published" },
            diff: {
              fromRevision: 2,
              toRevision: 3,
              unifiedDiff: null,
              computationLimited: false,
            },
          });
        }
        return json(
          {
            proposalId: "proposal-restore",
            status: "pending_review",
            correlationId: "correlation-restore",
          },
          201,
        );
      }),
    );

    const api = new CollabApi(API, PROJECT);
    await expect(api.chapterHistory(CHAPTER)).resolves.toMatchObject({
      ok: true,
      value: { nextCursor: "revision-2" },
    });
    await expect(api.chapterHistoryRevision(CHAPTER, 2, "current")).resolves.toMatchObject({
      ok: true,
      value: { compare: "current", selected: { content: "Older\n" } },
    });
    await expect(
      api.restoreChapterRevision(CHAPTER, 2, { idempotencyKey: "restore-key" }),
    ).resolves.toEqual({
      ok: true,
      value: {
        proposalId: "proposal-restore",
        status: "pending_review",
        correlationId: "correlation-restore",
      },
    });

    expect(calls.map(({ url }) => url)).toEqual([
      `${API}/v1/projects/${PROJECT}/chapters/chapter%2Fone/history?limit=50`,
      `${API}/v1/projects/${PROJECT}/chapters/chapter%2Fone/history/2?compare=current`,
      `${API}/v1/projects/${PROJECT}/chapters/chapter%2Fone/history/2/restore`,
    ]);
    const restore = calls[2]?.init;
    expect(restore?.method).toBe("POST");
    expect(restore?.body).toBe("{}");
    expect(new Headers(restore?.headers).get("idempotency-key")).toBe("restore-key");
  });
});
