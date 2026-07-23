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
  it("keeps the metadata list bounded and limits full-snapshot cache growth", async () => {
    const store = createProjectStore({ apiBase: "", project: PROJECT }, api());
    await store.getState().ensureChapterHistory(CHAPTER);

    expect(store.getState().chapterHistoryByChapter[CHAPTER]?.items).toHaveLength(50);
    expect(store.getState().chapterHistoryByChapter[CHAPTER]?.nextCursor).toBe("older");

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
