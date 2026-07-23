// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChapterActivity,
  ChapterProjection,
  Me,
} from "../site/src/islands/api.js";
import { AuthorbotAccount } from "../site/src/islands/account.js";
import { AuthorbotChapterActivity } from "../site/src/islands/chapter-activity.js";
import { AuthorbotDraftChapters } from "../site/src/islands/draft-chapters.js";
import {
  createProjectStore,
  getProjectStore,
  resetProjectStoresForTests,
  type ProjectStoreApi,
} from "../site/src/islands/project-store.js";

if (customElements.get("authorbot-chapter-activity") === undefined) {
  customElements.define("authorbot-chapter-activity", AuthorbotChapterActivity);
}
if (customElements.get("authorbot-account") === undefined) {
  customElements.define("authorbot-account", AuthorbotAccount);
}
if (customElements.get("authorbot-draft-chapters") === undefined) {
  customElements.define("authorbot-draft-chapters", AuthorbotDraftChapters);
}

const API = "http://api.test";
const CHAPTER_ID = "019cadfd-8900-7140-98fb-ceff64cada33";
let projectSequence = 0;
let requests: string[] = [];

const me: Me = {
  actor: { id: "actor-1", displayName: "Mara", externalIdentity: "github:mara" },
  scopes: ["chapters:read", "annotations:read", "work:read"],
  memberships: [{ role: "maintainer" }],
};

function chapter(
  id: string,
  activity?: ChapterActivity,
): ChapterProjection {
  return {
    id,
    projectId: "project-1",
    path: `chapters/${id}.md`,
    slug: id,
    title: id,
    summary: null,
    order: 10,
    status: "published",
    revision: 1,
    updatedAt: "2026-07-22T12:00:00Z",
    ...(activity === undefined ? {} : { activity }),
  };
}

function stubFetch(items: ChapterProjection[], signedIn = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === `${API}/v1/me`) {
        return new Response(JSON.stringify(signedIn ? me : { detail: "sign in" }), {
          status: signedIn ? 200 : 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/chapters?limit=200")) {
        return new Response(JSON.stringify({ items, nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/work-items?status=ready")) {
        return new Response(
          JSON.stringify({ items: [{ id: "work-1" }], nextCursor: null }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ detail: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function row(id: string, surface: string): HTMLElement {
  const item = document.createElement("div");
  item.className = surface;
  item.dataset.chapterActivityId = id;
  const slot = document.createElement("span");
  slot.dataset.chapterActivitySlot = "";
  slot.hidden = true;
  item.append(slot);
  document.body.append(item);
  return item;
}

function mount(project = `activity-test-${++projectSequence}`): HTMLElement {
  const host = document.createElement("authorbot-chapter-activity");
  host.dataset.apiBase = API;
  host.dataset.project = project;
  host.hidden = true;
  document.body.append(host);
  return host;
}

beforeEach(() => {
  resetProjectStoresForTests();
  requests = [];
  document.body.textContent = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = "";
});

describe("chapter activity navigation", () => {
  it("renders all five labeled categories on every chapter surface", async () => {
    stubFetch([
      chapter(CHAPTER_ID, {
        openSuggestions: 2,
        openBlockComments: 1,
        openChapterComments: 3,
        openReplies: 4,
        openWorkItems: 5,
      }),
    ]);
    const surfaces = [
      row(CHAPTER_ID, "chapter-index-row"),
      row(CHAPTER_ID, "chapter-current-heading"),
      row(CHAPTER_ID, "chapter-next-row"),
    ];
    mount();

    await expect
      .poll(() => document.querySelectorAll(".ab-chapter-activity-badge").length)
      .toBe(15);
    const expectedLabels = [
      "2 open suggestions",
      "1 open block comment",
      "3 open whole-chapter comments",
      "4 open replies",
      "5 open work items",
    ];
    for (const surface of surfaces) {
      const badges = [...surface.querySelectorAll(".ab-chapter-activity-badge")];
      expect(badges.map((badge) => badge.getAttribute("aria-label"))).toEqual(
        expectedLabels,
      );
      expect(surface.querySelector(".ab-chapter-activity")?.getAttribute("aria-label")).toBe(
        `Chapter activity: ${expectedLabels.join(", ")}`,
      );
      expect(surface.textContent).toContain("Suggestions2");
      expect(surface.textContent).toContain("Block1");
      expect(surface.textContent).toContain("Chapter3");
      expect(surface.textContent).toContain("Replies4");
      expect(surface.textContent).toContain("Work5");
    }
    expect(requests.filter((url) => url.includes("/chapters?limit=200"))).toHaveLength(1);
  });

  it("omits zero, absent, and unauthorized categories without fake zeros", async () => {
    const visibleId = `${CHAPTER_ID}-visible`;
    const zeroId = `${CHAPTER_ID}-zero`;
    const absentId = `${CHAPTER_ID}-absent`;
    stubFetch([
      chapter(visibleId, { openSuggestions: 1 }),
      chapter(zeroId, {
        openSuggestions: 0,
        openBlockComments: 0,
        openChapterComments: 0,
        openReplies: 0,
        openWorkItems: 0,
      }),
      chapter(absentId),
    ]);
    const visible = row(visibleId, "visible");
    const zero = row(zeroId, "zero");
    const absent = row(absentId, "absent");
    mount();

    await expect
      .poll(() => visible.querySelectorAll(".ab-chapter-activity-badge").length)
      .toBe(1);
    expect(
      visible.querySelector(".ab-chapter-activity-badge")?.getAttribute("aria-label"),
    ).toBe("1 open suggestion");
    expect(visible.textContent).not.toContain("Work");
    expect(visible.textContent).not.toContain("0");
    for (const quiet of [zero, absent]) {
      const slot = quiet.querySelector<HTMLElement>("[data-chapter-activity-slot]");
      expect(slot?.hidden).toBe(true);
      expect(slot?.childElementCount).toBe(0);
      expect(quiet.textContent).not.toContain("0");
    }
  });

  it("renders chapters from one bounded pagination chain without per-row reads", async () => {
    const secondId = `${CHAPTER_ID}-second`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === `${API}/v1/me`) {
          return new Response(JSON.stringify(me), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("cursor=page-2")) {
          return new Response(
            JSON.stringify({
              items: [chapter(secondId, { openReplies: 2 })],
              nextCursor: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/chapters?limit=200")) {
          return new Response(
            JSON.stringify({
              items: [chapter(CHAPTER_ID, { openSuggestions: 1 })],
              nextCursor: "page-2",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
      }),
    );
    const first = row(CHAPTER_ID, "first-page");
    const second = row(secondId, "second-page");
    mount();

    await expect
      .poll(() => second.querySelector(".ab-chapter-activity-badge")?.getAttribute("aria-label"))
      .toBe("2 open replies");
    expect(
      first.querySelector(".ab-chapter-activity-badge")?.getAttribute("aria-label"),
    ).toBe("1 open suggestion");
    const chapterRequests = requests.filter((url) => url.includes("/chapters?"));
    expect(chapterRequests).toEqual([
      expect.stringContaining("/chapters?limit=200"),
      expect.stringContaining("/chapters?limit=200&cursor=page-2"),
    ]);
    expect(requests.some((url) => url.includes(CHAPTER_ID))).toBe(false);
    expect(requests.some((url) => url.includes(secondId))).toBe(false);
  });

  it("stays quiet and skips chapter metadata while signed out", async () => {
    stubFetch([chapter(CHAPTER_ID, { openSuggestions: 8 })], false);
    const item = row(CHAPTER_ID, "signed-out");
    mount();

    await expect.poll(() => requests.length).toBe(1);
    expect(requests).toEqual([`${API}/v1/me`]);
    expect(item.querySelector("[data-chapter-activity-slot]")?.childElementCount).toBe(0);
  });

  it("resubscribes and renders after being disconnected and reconnected", async () => {
    stubFetch([chapter(CHAPTER_ID, { openReplies: 2 })]);
    const item = row(CHAPTER_ID, "reconnected");
    const host = mount();
    host.remove();
    document.body.append(host);

    await expect
      .poll(() => item.querySelector(".ab-chapter-activity-badge")?.getAttribute("aria-label"))
      .toBe("2 open replies");
    expect(requests.filter((url) => url === `${API}/v1/me`)).toHaveLength(1);
    expect(requests.filter((url) => url.includes("/chapters?limit=200"))).toHaveLength(1);
  });

  it("does not retain a feed for the superseded side of an async reconnect", async () => {
    const project = `delayed-reconnect-${++projectSequence}`;
    let resolveSession!: (value: Response) => void;
    const pendingSession = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === `${API}/v1/me`) return pendingSession;
      if (url.includes("/chapters?limit=200")) {
        return new Response(
          JSON.stringify({
            items: [chapter(CHAPTER_ID, { openSuggestions: 1 })],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = getProjectStore({ apiBase: API, project });
    const release = vi.fn();
    const retain = vi
      .spyOn(store.getState(), "retainConnection")
      .mockReturnValue(release);
    const item = row(CHAPTER_ID, "delayed-reconnect");
    const host = mount(project);

    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    host.remove();
    document.body.append(host);
    resolveSession(
      new Response(JSON.stringify(me), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect
      .poll(() => item.querySelector(".ab-chapter-activity-badge")?.getAttribute("aria-label"))
      .toBe("1 open suggestion");
    await expect.poll(() => retain.mock.calls.length).toBe(1);
    host.remove();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("shares one session and chapter read across account, drafts, and activity", async () => {
    const project = `combined-${++projectSequence}`;
    const published = chapter(CHAPTER_ID, {
      openSuggestions: 1,
      openWorkItems: 2,
    });
    const draft = {
      ...chapter(`${CHAPTER_ID}-draft`, { openWorkItems: 2 }),
      title: "Private draft",
      status: "draft" as const,
    };
    stubFetch([published, draft]);
    const item = row(CHAPTER_ID, "combined");
    const workBadge = document.createElement("span");
    workBadge.dataset.workCount = "";
    workBadge.hidden = true;
    const account = document.createElement("authorbot-account");
    account.dataset.apiBase = API;
    account.dataset.project = project;
    account.dataset.base = "/";
    const drafts = document.createElement("authorbot-draft-chapters");
    drafts.dataset.apiBase = API;
    drafts.dataset.project = project;
    document.body.append(workBadge, account, drafts);
    mount(project);

    await expect.poll(() => account.querySelector(".ab-account-who")?.textContent).toBe("Mara");
    await expect.poll(() => drafts.querySelector(".ab-draft-title")?.textContent).toBe(
      "Private draft",
    );
    expect(
      drafts.querySelector(".ab-chapter-activity")?.getAttribute("aria-label"),
    ).toBe("Chapter activity: 2 open work items");
    await expect
      .poll(() => item.querySelector(".ab-chapter-activity-badge")?.getAttribute("aria-label"))
      .toBe("1 open suggestion");
    await expect.poll(() => workBadge.textContent).toBe("1");
    expect(requests.filter((url) => url === `${API}/v1/me`)).toHaveLength(1);
    expect(requests.filter((url) => url.includes("/chapters?limit=200"))).toHaveLength(1);
  });
});

describe("project-scoped Zustand store", () => {
  it("deduplicates concurrent session and chapter loads and normalizes projections", async () => {
    let meCalls = 0;
    let chapterCalls = 0;
    const projected = chapter(CHAPTER_ID, { openReplies: 2 });
    const api: ProjectStoreApi = {
      async meResult() {
        meCalls += 1;
        await Promise.resolve();
        return { ok: true, value: me };
      },
      async chapters() {
        chapterCalls += 1;
        await Promise.resolve();
        return { ok: true, value: [projected] };
      },
    };
    const store = createProjectStore({ apiBase: API, project: "store-test" }, api);

    await Promise.all([
      store.getState().ensureSession(),
      store.getState().ensureSession(),
    ]);
    await Promise.all([
      store.getState().ensureChapters(),
      store.getState().ensureChapters(),
    ]);

    expect(meCalls).toBe(1);
    expect(chapterCalls).toBe(1);
    expect(store.getState().sessionStatus).toBe("ready");
    expect(store.getState().chaptersStatus).toBe("ready");
    expect(store.getState().chapterIds).toEqual([CHAPTER_ID]);
    expect(store.getState().chaptersById[CHAPTER_ID]).toBe(projected);
  });
});
