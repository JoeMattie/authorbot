import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChapterHistoryComparison,
  ChapterHistoryDetail,
  ChapterHistoryPage,
  Me,
  MutationOptions,
} from "../site/src/islands/api.js";
import {
  chapterHistoryDetailKey,
  createProjectStore,
  resetProjectStoresForTests,
  type ProjectStoreApi,
} from "../site/src/islands/project-store.js";

const PROJECT = "hollow-creek-anomaly";
const CHAPTER = "chapter-1";

const me: Me = {
  actor: { id: "editor-1", displayName: "Editor", externalIdentity: "github:editor" },
  memberships: [{ role: "editor" }],
  scopes: ["history:read", "revisions:write"],
  capabilityMode: "canonical",
  grantedCapabilities: ["history:read", "revisions:write"],
  roleCapabilityCeiling: ["history:read", "revisions:write"],
  effectiveCapabilities: ["history:read", "revisions:write"],
  legacyEffectiveActions: [],
};

const revision = (value: number, current = false) => ({
  revision: value,
  contentHash: `sha256:${value}`,
  commitSha: `commit-${value}`,
  createdAt: "2026-07-22T00:00:00Z",
  author: null,
  changeSummary: `Revision ${value}`,
  origin: "chapter_edit",
  status: "published",
  isCurrent: current,
});

const page = (count = 60): ChapterHistoryPage => ({
  items: Array.from({ length: count }, (_, index) => revision(count - index, index === 0)),
  current: { ...revision(count, true), status: "published" },
  nextCursor: count > 50 ? "older" : null,
});

const detail = (
  selected: number,
  compare: ChapterHistoryComparison,
  current = 60,
): ChapterHistoryDetail => ({
  chapterId: CHAPTER,
  compare,
  selected: { ...revision(selected, selected === current), content: `Revision ${selected}\n` },
  comparison:
    compare === "previous"
      ? selected === 1
        ? null
        : { ...revision(selected - 1), content: `Revision ${selected - 1}\n` }
      : selected === current
        ? null
        : { ...revision(current, true), content: `Revision ${current}\n` },
  current: { ...revision(current, true), status: "published" },
  diff:
    compare === "previous" && selected === 1
      ? null
      : compare === "current" && selected === current
        ? null
        : {
            fromRevision: compare === "previous" ? selected - 1 : selected,
            toRevision: compare === "previous" ? selected : current,
            unifiedDiff: null,
            computationLimited: false,
          },
});

function api(overrides: Partial<ProjectStoreApi> = {}): ProjectStoreApi {
  return {
    async meResult() {
      return { ok: true, value: me };
    },
    async chapters() {
      return { ok: true, value: [] };
    },
    async chapterHistory() {
      return { ok: true, value: page() };
    },
    async chapterHistoryRevision(_chapterId, selected, compare) {
      return { ok: true, value: detail(selected, compare) };
    },
    ...overrides,
  };
}

beforeEach(() => resetProjectStoresForTests());

describe("project store chapter history", () => {
  it("publishes the first bounded page immediately, then accumulates every page without duplicates", async () => {
    let resolveOlder!: (value: ReturnType<typeof page>) => void;
    const older = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveOlder = resolve;
    });
    const cursors: Array<string | undefined> = [];
    const store = createProjectStore(
      { apiBase: "", project: PROJECT },
      api({
        async chapterHistory(_chapterId, cursor) {
          cursors.push(cursor);
          if (cursor === undefined) {
            return {
              ok: true,
              value: {
                items: Array.from({ length: 50 }, (_, index) =>
                  revision(60 - index, index === 0),
                ),
                current: { ...revision(60, true), status: "published" },
                nextCursor: "2",
              },
            };
          }
          return { ok: true, value: await older };
        },
      }),
    );

    const loading = store.getState().ensureChapterHistory(CHAPTER);
    await vi.waitFor(() => {
      expect(store.getState().chapterHistoryByChapter[CHAPTER]?.items).toHaveLength(50);
    });
    expect(store.getState().chapterHistoryStatusByChapter[CHAPTER]).toBe("ready");
    expect(store.getState().chapterHistoryByChapter[CHAPTER]?.nextCursor).toBe("2");
    expect(cursors).toEqual([undefined, "2"]);

    resolveOlder({
      // Revision 11 deliberately overlaps the first page boundary.
      items: Array.from({ length: 11 }, (_, index) => revision(11 - index)),
      current: { ...revision(60, true), status: "published" },
      nextCursor: null,
    });
    await loading;

    const accumulated = store.getState().chapterHistoryByChapter[CHAPTER];
    expect(accumulated?.items).toHaveLength(60);
    expect(accumulated?.items.map(({ revision: value }) => value)).toEqual(
      Array.from({ length: 60 }, (_, index) => 60 - index),
    );
    expect(accumulated?.nextCursor).toBeNull();
    expect(cursors).toEqual([undefined, "2"]);
  });

  it("stops repeated cursors and retains partial history when a later page fails", async () => {
    const repeatedCalls: Array<string | undefined> = [];
    const repeated = createProjectStore(
      { apiBase: "", project: PROJECT },
      api({
        async chapterHistory(_chapterId, cursor) {
          repeatedCalls.push(cursor);
          return {
            ok: true,
            value:
              cursor === undefined
                ? {
                    items: [revision(3, true), revision(2)],
                    current: { ...revision(3, true), status: "published" },
                    nextCursor: "2",
                  }
                : {
                    items: [revision(2), revision(1)],
                    current: { ...revision(3, true), status: "published" },
                    nextCursor: "2",
                  },
          };
        },
      }),
    );
    await repeated.getState().ensureChapterHistory(CHAPTER);
    expect(repeatedCalls).toEqual([undefined, "2"]);
    expect(
      repeated.getState().chapterHistoryByChapter[CHAPTER]?.items.map(({ revision: value }) => value),
    ).toEqual([3, 2, 1]);
    expect(repeated.getState().chapterHistoryByChapter[CHAPTER]?.nextCursor).toBeNull();
    expect(repeated.getState().chapterHistoryErrorByChapter[CHAPTER]).toContain(
      "repeated a cursor",
    );

    const failedCalls: Array<string | undefined> = [];
    const failed = createProjectStore(
      { apiBase: "", project: `${PROJECT}-failed` },
      api({
        async chapterHistory(_chapterId, cursor) {
          failedCalls.push(cursor);
          return cursor === undefined
            ? {
                ok: true,
                value: {
                  items: [revision(3, true), revision(2)],
                  current: { ...revision(3, true), status: "published" },
                  nextCursor: "2",
                },
              }
            : { ok: false, status: 503, message: "history backend unavailable" };
        },
      }),
    );
    await failed.getState().ensureChapterHistory(CHAPTER);
    expect(failedCalls).toEqual([undefined, "2"]);
    expect(failed.getState().chapterHistoryStatusByChapter[CHAPTER]).toBe("ready");
    expect(
      failed.getState().chapterHistoryByChapter[CHAPTER]?.items.map(({ revision: value }) => value),
    ).toEqual([3, 2]);
    expect(failed.getState().chapterHistoryByChapter[CHAPTER]?.nextCursor).toBeNull();
    expect(failed.getState().chapterHistoryErrorByChapter[CHAPTER]).toContain(
      "Older revisions could not finish loading",
    );
  });

  it("bounds a unique cursor chain from the current revision and stops on zero progress", async () => {
    const boundedCalls: Array<string | undefined> = [];
    const bounded = createProjectStore(
      { apiBase: "", project: `${PROJECT}-bounded` },
      api({
        async chapterHistory(_chapterId, cursor) {
          boundedCalls.push(cursor);
          const pageNumber = boundedCalls.length;
          return {
            ok: true,
            value:
              pageNumber === 1
                ? {
                    items: [revision(120, true), revision(119)],
                    current: { ...revision(120, true), status: "published" },
                    nextCursor: "cursor-1",
                  }
                : {
                    items: [revision(120 - pageNumber)],
                    current: { ...revision(120, true), status: "published" },
                    nextCursor: `cursor-${pageNumber}`,
                  },
          };
        },
      }),
    );

    await bounded.getState().ensureChapterHistory(CHAPTER);
    // ceil(120 / 50) expected pages plus two pages of cursor-overlap allowance.
    expect(boundedCalls).toEqual([
      undefined,
      "cursor-1",
      "cursor-2",
      "cursor-3",
      "cursor-4",
    ]);
    expect(bounded.getState().chapterHistoryByChapter[CHAPTER]?.nextCursor).toBeNull();
    expect(bounded.getState().chapterHistoryErrorByChapter[CHAPTER]).toContain(
      "bounded 5-page history window",
    );

    const noProgressCalls: Array<string | undefined> = [];
    const noProgress = createProjectStore(
      { apiBase: "", project: `${PROJECT}-no-progress` },
      api({
        async chapterHistory(_chapterId, cursor) {
          noProgressCalls.push(cursor);
          return {
            ok: true,
            value:
              cursor === undefined
                ? {
                    items: [revision(3, true), revision(2)],
                    current: { ...revision(3, true), status: "published" },
                    nextCursor: "overlap",
                  }
                : {
                    items: [revision(2)],
                    current: { ...revision(3, true), status: "published" },
                    nextCursor: "still-unique",
                  },
          };
        },
      }),
    );

    await noProgress.getState().ensureChapterHistory(CHAPTER);
    expect(noProgressCalls).toEqual([undefined, "overlap"]);
    expect(noProgress.getState().chapterHistoryByChapter[CHAPTER]?.nextCursor).toBeNull();
    expect(noProgress.getState().chapterHistoryErrorByChapter[CHAPTER]).toContain(
      "no metadata progress",
    );
  });

  it("shallow-refreshes only source-changing chapter events and retains the immutable suffix", async () => {
    const cursors: Array<string | undefined> = [];
    let refreshed = false;
    const store = createProjectStore(
      { apiBase: "", project: `${PROJECT}-events` },
      api({
        async chapterHistory(_chapterId, cursor) {
          cursors.push(cursor);
          if (refreshed) {
            return {
              ok: true,
              value: {
                items: Array.from({ length: 50 }, (_, index) =>
                  revision(61 - index, index === 0),
                ),
                current: { ...revision(61, true), status: "published" },
                // A shallow live refresh deliberately does not follow this.
                nextCursor: "newer-head-cursor",
              },
            };
          }
          if (cursor === undefined) {
            return {
              ok: true,
              value: {
                items: Array.from({ length: 50 }, (_, index) =>
                  revision(60 - index, index === 0),
                ),
                current: { ...revision(60, true), status: "published" },
                nextCursor: "older",
              },
            };
          }
          return {
            ok: true,
            value: {
              items: Array.from({ length: 10 }, (_, index) => revision(10 - index)),
              current: { ...revision(60, true), status: "published" },
              nextCursor: null,
            },
          };
        },
      }),
    );
    await store.getState().ensureChapterHistory(CHAPTER);
    expect(cursors).toEqual([undefined, "older"]);

    store.getState().reconcileEvent({
      id: 1,
      type: "vote_aggregate",
      payload: { chapterId: CHAPTER },
    });
    await Promise.resolve();
    expect(cursors).toEqual([undefined, "older"]);

    refreshed = true;
    store.getState().reconcileEvent({
      id: 2,
      type: "chapter_revised",
      payload: { chapterId: CHAPTER, revision: 61 },
    });
    await vi.waitFor(() => expect(cursors).toHaveLength(3));

    expect(cursors).toEqual([undefined, "older", undefined]);
    const history = store.getState().chapterHistoryByChapter[CHAPTER];
    expect(history?.current.revision).toBe(61);
    expect(history?.nextCursor).toBeNull();
    expect(history?.items.map(({ revision: value }) => value)).toEqual(
      Array.from({ length: 61 }, (_, index) => 61 - index),
    );
    expect(history?.items.find((item) => item.revision === 60)?.isCurrent).toBe(false);
  });

  it("fully retries a partial history before clearing its background error", async () => {
    const cursors: Array<string | undefined> = [];
    let recovered = false;
    const store = createProjectStore(
      { apiBase: "", project: `${PROJECT}-partial-recovery` },
      api({
        async chapterHistory(_chapterId, cursor) {
          cursors.push(cursor);
          if (!recovered) {
            return cursor === undefined
              ? {
                  ok: true,
                  value: {
                    items: Array.from({ length: 50 }, (_, index) =>
                      revision(60 - index, index === 0),
                    ),
                    current: { ...revision(60, true), status: "published" },
                    nextCursor: "older-failed",
                  },
                }
              : { ok: false, status: 503, message: "history backend unavailable" };
          }
          if (cursor === undefined) {
            return {
              ok: true,
              value: {
                items: Array.from({ length: 50 }, (_, index) =>
                  revision(61 - index, index === 0),
                ),
                current: { ...revision(61, true), status: "published" },
                nextCursor: "older-retry",
              },
            };
          }
          return {
            ok: true,
            value: {
              items: Array.from({ length: 12 }, (_, index) => revision(12 - index)),
              current: { ...revision(61, true), status: "published" },
              nextCursor: null,
            },
          };
        },
      }),
    );

    await store.getState().ensureChapterHistory(CHAPTER);
    expect(cursors).toEqual([undefined, "older-failed"]);
    expect(store.getState().chapterHistoryErrorByChapter[CHAPTER]).toContain(
      "Older revisions could not finish loading",
    );
    expect(store.getState().chapterHistoryByChapter[CHAPTER]?.items).toHaveLength(50);

    recovered = true;
    store.getState().reconcileEvent({
      id: 3,
      type: "chapter_revised",
      payload: { chapterId: CHAPTER, revision: 61 },
    });
    await vi.waitFor(() => expect(cursors).toHaveLength(4));

    expect(cursors).toEqual([undefined, "older-failed", undefined, "older-retry"]);
    expect(store.getState().chapterHistoryErrorByChapter[CHAPTER]).toBeNull();
    expect(store.getState().chapterHistoryByChapter[CHAPTER]?.items).toHaveLength(61);
    expect(
      store.getState().chapterHistoryByChapter[CHAPTER]?.items.map((item) => item.revision),
    ).toEqual(Array.from({ length: 61 }, (_, index) => 61 - index));
  });

  it("upgrades a queued shallow refresh when the active full walk later fails", async () => {
    let resolveOlderFailure!: (value: {
      ok: false;
      status: number;
      message: string;
    }) => void;
    const olderFailure = new Promise<{
      ok: false;
      status: number;
      message: string;
    }>((resolve) => {
      resolveOlderFailure = resolve;
    });
    const cursors: Array<string | undefined> = [];
    let headLoads = 0;
    const store = createProjectStore(
      { apiBase: "", project: `${PROJECT}-queued-partial-recovery` },
      api({
        async chapterHistory(_chapterId, cursor) {
          cursors.push(cursor);
          if (cursor === "older-inflight") return olderFailure;
          if (cursor === "older-retry") {
            return {
              ok: true,
              value: {
                items: Array.from({ length: 12 }, (_, index) => revision(12 - index)),
                current: { ...revision(61, true), status: "published" },
                nextCursor: null,
              },
            };
          }
          headLoads += 1;
          const current = headLoads === 1 ? 60 : 61;
          return {
            ok: true,
            value: {
              items: Array.from({ length: 50 }, (_, index) =>
                revision(current - index, index === 0),
              ),
              current: { ...revision(current, true), status: "published" },
              nextCursor: headLoads === 1 ? "older-inflight" : "older-retry",
            },
          };
        },
      }),
    );

    const loading = store.getState().ensureChapterHistory(CHAPTER);
    await vi.waitFor(() => expect(cursors).toEqual([undefined, "older-inflight"]));
    store.getState().reconcileEvent({
      id: 4,
      type: "chapter_revised",
      payload: { chapterId: CHAPTER, revision: 61 },
    });

    resolveOlderFailure({ ok: false, status: 503, message: "history backend unavailable" });
    await loading;
    await vi.waitFor(() => expect(cursors).toHaveLength(4));

    expect(cursors).toEqual([undefined, "older-inflight", undefined, "older-retry"]);
    expect(store.getState().chapterHistoryErrorByChapter[CHAPTER]).toBeNull();
    expect(store.getState().chapterHistoryByChapter[CHAPTER]?.items).toHaveLength(61);
  });

  it("limits full-snapshot cache growth without truncating loaded metadata", async () => {
    const store = createProjectStore(
      { apiBase: "", project: PROJECT },
      api({
        async chapterHistory() {
          return { ok: true, value: { ...page(), nextCursor: null } };
        },
      }),
    );
    await store.getState().ensureChapterHistory(CHAPTER);

    expect(store.getState().chapterHistoryByChapter[CHAPTER]?.items).toHaveLength(60);
    expect(store.getState().chapterHistoryByChapter[CHAPTER]?.nextCursor).toBeNull();

    for (let selected = 60; selected >= 50; selected -= 1) {
      await store.getState().ensureChapterHistoryRevision(CHAPTER, selected, "previous");
    }
    const cached = Object.values(store.getState().chapterHistoryDetailByKey).filter(
      (entry) => entry.chapterId === CHAPTER,
    );
    expect(cached).toHaveLength(8);
    expect(
      store.getState().chapterHistoryDetailByKey[
        chapterHistoryDetailKey(CHAPTER, 50, "previous")
      ],
    ).toBeDefined();
  });

  it("replays an ambiguous restore once with the exact same idempotency key", async () => {
    const keys: string[] = [];
    const restore = vi.fn(
      async (_chapterId: string, _revision: number, options?: MutationOptions) => {
        keys.push(options?.idempotencyKey ?? "");
        if (keys.length === 1) {
          return {
            ok: false as const,
            status: 0,
            message: "network error",
            ambiguous: true as const,
          };
        }
        return {
          ok: true as const,
          value: {
            proposalId: "proposal-restore",
            status: "pending_review" as const,
            correlationId: "correlation-restore",
          },
        };
      },
    );
    const store = createProjectStore(
      { apiBase: "", project: PROJECT },
      api({ restoreChapterRevision: restore }),
    );

    await expect(store.getState().restoreChapterHistory(CHAPTER, 4)).resolves.toEqual({
      ok: true,
      value: {
        proposalId: "proposal-restore",
        status: "pending_review",
        correlationId: "correlation-restore",
      },
    });
    expect(restore).toHaveBeenCalledTimes(2);
    expect(keys[0]).toMatch(/^[\w-]+$/u);
    expect(keys[1]).toBe(keys[0]);
  });
});
