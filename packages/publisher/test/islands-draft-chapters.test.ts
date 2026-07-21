// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotChapterComposer } from "../site/src/islands/chapter-composer.js";
import { AuthorbotDraftChapters } from "../site/src/islands/draft-chapters.js";

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER_ID = "019cadfd-8900-7140-98fb-ceff64cada33";

if (customElements.get("authorbot-chapter-composer") === undefined) {
  customElements.define("authorbot-chapter-composer", AuthorbotChapterComposer);
}
if (customElements.get("authorbot-draft-chapters") === undefined) {
  customElements.define("authorbot-draft-chapters", AuthorbotDraftChapters);
}

interface Route {
  status: number;
  body: unknown;
}

type Routes = Record<string, Route>;

let requests: string[] = [];

function stubFetch(routes: Routes): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const key = Object.keys(routes)
        .filter((prefix) => url.startsWith(prefix))
        .sort((a, b) => b.length - a.length)[0];
      const route =
        (key === undefined ? undefined : routes[key]) ??
        ({ status: 404, body: { detail: "not found" } } satisfies Route);
      return new Response(JSON.stringify(route.body), {
        status: route.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const me = (role: string) => ({
  actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
  scopes: ["chapters:read", "submissions:write"],
  memberships: [{ role }],
});

const chapter = (over: Record<string, unknown> = {}) => ({
  id: CHAPTER_ID,
  projectId: "project-1",
  path: "chapters/0010-the-baseline.md",
  slug: "the-baseline",
  title: "The Baseline",
  status: "draft",
  revision: 3,
  updatedAt: "2026-07-21T22:22:55Z",
  ...over,
});

const base = `${API}/v1/projects/${PROJECT}`;

function maintainerRoutes(items: unknown[]): Routes {
  return {
    [`${API}/v1/me`]: { status: 200, body: me("maintainer") },
    [`${base}/chapters?limit=200`]: { status: 200, body: { items, nextCursor: null } },
  };
}

function mount(): HTMLElement {
  const host = document.createElement("authorbot-draft-chapters");
  host.dataset.apiBase = API;
  host.dataset.project = PROJECT;
  document.body.append(host);
  return host;
}

beforeEach(() => {
  requests = [];
  document.body.textContent = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.textContent = "";
});

describe("maintainer draft list", () => {
  it("shows draft and proposed chapters to a maintainer, newest first", async () => {
    stubFetch(
      maintainerRoutes([
        chapter({ title: "Published", status: "published" }),
        chapter({ title: "Older draft", updatedAt: "2026-07-20T00:00:00Z" }),
        chapter({ title: "Ready for review", status: "proposed", updatedAt: "2026-07-22T00:00:00Z" }),
        chapter({ title: "Archived", status: "archived" }),
      ]),
    );
    const host = mount();

    await expect.poll(() => host.querySelectorAll(".ab-draft-item").length).toBe(2);
    expect(host.querySelector(".ab-drafts-heading")?.textContent).toBe("Drafts");
    expect(host.textContent).toContain("Private workspace");
    expect(host.textContent).toContain("Older draft");
    expect(host.textContent).toContain("Ready for review");
    expect(host.textContent).not.toContain("Published");
    expect(host.textContent).not.toContain("Archived");
    const titles = [...host.querySelectorAll(".ab-draft-title")].map((node) => node.textContent);
    expect(titles).toEqual(["Ready for review", "Older draft"]);
  });

  it("fetches no chapter metadata for an editor or a signed-out reader", async () => {
    for (const response of [
      { status: 200, body: me("editor") },
      { status: 401, body: { detail: "sign in required" } },
    ]) {
      document.body.textContent = "";
      requests = [];
      stubFetch({ [`${API}/v1/me`]: response });
      const host = mount();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(host.textContent).toBe("");
      expect(requests).toEqual([`${API}/v1/me`]);
    }
  });

  it("opens the existing editor and publish control without exposing marker syntax", async () => {
    stubFetch({
      ...maintainerRoutes([chapter()]),
      [`${base}/chapters/${CHAPTER_ID}/source`]: {
        status: 200,
        body: {
          chapterId: CHAPTER_ID,
          title: "The Baseline",
          summary: null,
          revision: 3,
          status: "draft",
          body: "The drift appeared on a Tuesday.",
        },
      },
    });
    const host = mount();
    await expect.poll(() => host.querySelector(".ab-draft-review")).toBeTruthy();

    const review = host.querySelector<HTMLButtonElement>(".ab-draft-review") as HTMLButtonElement;
    review.click();
    await expect.poll(() => host.querySelector("textarea.ab-chapter-text")).toBeTruthy();
    expect(host.querySelector<HTMLInputElement>("input.ab-chapter-title")?.value).toBe("The Baseline");
    expect(host.querySelector<HTMLTextAreaElement>("textarea.ab-chapter-text")?.value).toBe(
      "The drift appeared on a Tuesday.",
    );
    expect(host.querySelector<HTMLButtonElement>("button.ab-chapter-publish")?.textContent).toBe(
      "Publish",
    );
    expect(host.textContent).not.toContain(CHAPTER_ID);
    expect(host.textContent).not.toContain("authorbot:block");
  });

  it("renders an untrusted draft title as text, never markup", async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    stubFetch(maintainerRoutes([chapter({ title: hostile })]));
    const host = mount();
    await expect.poll(() => host.querySelector(".ab-draft-title")).toBeTruthy();
    expect(host.querySelector(".ab-draft-title")?.textContent).toBe(hostile);
    expect(host.querySelector("img")).toBeNull();
  });
});
