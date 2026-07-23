// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterProjection, Me } from "../site/src/islands/api.js";
import { AuthorbotOutlineSummaries } from "../site/src/islands/outline-summaries.js";
import {
  getProjectStore,
  resetProjectStoresForTests,
} from "../site/src/islands/project-store.js";

if (customElements.get("authorbot-outline-summaries") === undefined) {
  customElements.define("authorbot-outline-summaries", AuthorbotOutlineSummaries);
}

const API = "http://api.test";
const PROJECT = "outline-private-summaries";
const PUBLISHED = "01900000-0000-7000-8000-000000000001";
const PROPOSED = "01900000-0000-7000-8000-000000000002";
const DRAFT = "01900000-0000-7000-8000-000000000003";

const session = (capabilities: string[]): Me => ({
  actor: { id: "actor-1", displayName: "Mara", externalIdentity: "github:mara" },
  scopes: ["chapters:read"],
  memberships: [{ role: "contributor" }],
  capabilityMode: "canonical",
  grantedCapabilities: capabilities,
  roleCapabilityCeiling: ["chapters:read"],
  effectiveCapabilities: capabilities,
});

const chapter = (
  id: string,
  title: string,
  order: number | null,
  status: ChapterProjection["status"],
  summary: string | null,
): ChapterProjection => ({
  id,
  projectId: PROJECT,
  path: `chapters/${id}.md`,
  slug: title.toLowerCase().replaceAll(" ", "-"),
  title,
  summary,
  order,
  status,
  revision: 3,
  updatedAt: "2026-07-22T00:00:00Z",
});

function mount(): {
  fallback: HTMLElement;
  host: AuthorbotOutlineSummaries;
} {
  document.body.innerHTML = `
    <section id="published-summary-fallback">
      <ol>
        <li data-chapter-summary-id="${PUBLISHED}">
          <a href="/chapters/published/">Published</a>
          <p>Published summary captured at build time.</p>
        </li>
      </ol>
    </section>
    <authorbot-outline-summaries
      data-api-base="${API}"
      data-project="${PROJECT}"
      data-static-id="published-summary-fallback"></authorbot-outline-summaries>`;
  return {
    fallback: document.querySelector("#published-summary-fallback") as HTMLElement,
    host: document.querySelector("authorbot-outline-summaries") as AuthorbotOutlineSummaries,
  };
}

function stubApi(me: Me | null, chapters: unknown[]): string[] {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === `${API}/v1/me`) {
        return me === null
          ? new Response(null, { status: 401 })
          : new Response(JSON.stringify(me), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
      }
      if (url.includes("/chapters?limit=200")) {
        return new Response(JSON.stringify({ items: chapters, nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/events?poll=1")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  return requests;
}

beforeEach(() => {
  resetProjectStoresForTests();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  resetProjectStoresForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authenticated Outline summaries", () => {
  it("leaves published static HTML untouched while signed out", async () => {
    const requests = stubApi(null, []);
    const { fallback, host } = mount();
    await expect.poll(() => requests.filter((url) => url.endsWith("/v1/me")).length).toBe(1);
    expect(requests.some((url) => url.includes("/chapters?"))).toBe(false);
    expect(fallback.hidden).toBe(false);
    expect(host.childElementCount).toBe(0);
  });

  it("honors canonical denial even when a legacy scope string is present", async () => {
    const requests = stubApi(session([]), []);
    const { fallback, host } = mount();
    await expect.poll(() => requests.filter((url) => url.endsWith("/v1/me")).length).toBe(1);
    expect(requests.some((url) => url.includes("/chapters?"))).toBe(false);
    expect(fallback.hidden).toBe(false);
    expect(host.childElementCount).toBe(0);
  });

  it("loads current summaries when access is granted without reloading the page", async () => {
    const requests = stubApi(session([]), [
      chapter(PROPOSED, "Proposed", 20, "proposed", "Newly available summary."),
    ]);
    const { fallback, host } = mount();
    await expect.poll(() => requests.filter((url) => url.endsWith("/v1/me")).length).toBe(1);
    expect(requests.some((url) => url.includes("/chapters?"))).toBe(false);

    const store = getProjectStore({ apiBase: API, project: PROJECT });
    store.setState({ session: session(["chapters:read"]) });

    await expect.poll(() => host.textContent).toContain("Newly available summary.");
    expect(requests.filter((url) => url.includes("/chapters?limit=200"))).toHaveLength(1);
    expect(fallback.hidden).toBe(true);
  });

  it("renders current summaries in canonical order with text-only private content", async () => {
    const hostile = `Draft <img src=x onerror="alert(1)"> summary`;
    const requests = stubApi(session(["chapters:read"]), [
      chapter(DRAFT, "Draft", null, "draft", null),
      chapter(PROPOSED, "Proposed", 20, "proposed", hostile),
      chapter(PUBLISHED, "Published", 10, "published", "Current published summary."),
    ]);
    const { fallback, host } = mount();

    await expect.poll(() => host.querySelectorAll("ol > li").length).toBe(3);
    expect(fallback.hidden).toBe(true);
    expect(
      [...host.querySelectorAll<HTMLElement>(".ab-outline-summary-title")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Published", "Proposed", "Draft"]);
    expect(host.textContent).toContain(hostile);
    expect(host.textContent).toContain("No summary yet.");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
      "/chapters/published/",
    );
    expect(requests.filter((url) => url.includes("/chapters?limit=200"))).toHaveLength(1);
    expect(requests.some((url) => url.includes("/source"))).toBe(false);
  });

  it("keeps the public fallback during a rolling deploy without summary fields", async () => {
    const legacy = chapter(PUBLISHED, "Published", 10, "published", null) as
      ChapterProjection & Record<string, unknown>;
    Reflect.deleteProperty(legacy, "summary");
    stubApi(session(["chapters:read"]), [legacy]);
    const { fallback, host } = mount();
    await expect.poll(() => host.textContent).toContain("matching Authorbot API deployment");
    expect(fallback.hidden).toBe(false);
    expect(fallback.textContent).toContain("Published summary captured at build time.");
  });

  it("removes private summaries immediately when the effective capability disappears", async () => {
    stubApi(session(["chapters:read"]), [
      chapter(PROPOSED, "Proposed", 20, "proposed", "Private summary."),
    ]);
    const { fallback, host } = mount();
    await expect.poll(() => host.textContent).toContain("Private summary.");
    const store = getProjectStore({ apiBase: API, project: PROJECT });
    store.setState({ session: session([]) });
    await expect.poll(() => host.childElementCount).toBe(0);
    expect(fallback.hidden).toBe(false);
  });
});
