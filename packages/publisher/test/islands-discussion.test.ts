// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotCollab } from "../site/src/islands/collab-element.js";
import { resetProjectStoresForTests } from "../site/src/islands/project-store.js";

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER = "019cadfd-8900-7140-98fb-ceff64cada33";
const BLOCK = "019cadfe-7360-7049-a30b-1f5898a5020a";

if (customElements.get("authorbot-collab") === undefined) {
  customElements.define("authorbot-collab", AuthorbotCollab);
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function annotation(
  id: string,
  scope: "block" | "chapter" = "chapter",
  authorActorId = "actor-2",
) {
  return {
    id,
    chapterId: CHAPTER,
    kind: "comment" as const,
    scope,
    chapterRevision: 3,
    target: scope === "chapter" ? null : { blockId: BLOCK },
    authorActorId,
    body: scope === "chapter" ? `Whole chapter ${id}` : `Block note ${id}`,
    status: "open",
    gitOperationId: null,
    createdAt: `2026-07-20T00:00:${id.padStart(2, "0")}Z`,
  };
}

function me(effectiveCapabilities: string[], role = "maintainer") {
  return {
    actor: { id: "actor-1", displayName: "Mara", externalIdentity: "github:mara" },
    memberships: [{ role }],
    // Deliberately broad legacy fields: canonical effectiveCapabilities must
    // win when deciding whether an affordance exists.
    scopes: ["chapters:read", "annotations:read", "annotations:write", "work:claim"],
    capabilityMode: "human",
    grantedCapabilities: effectiveCapabilities,
    roleCapabilityCeiling: effectiveCapabilities,
    effectiveCapabilities,
    legacyEffectiveActions: [],
  };
}

function mount(): AuthorbotCollab {
  document.body.innerHTML = `<main id="main"><div class="chapter-page">
    <div class="chapter-reading-layout ab-reading-layout">
      <div class="chapter-reading-column"><article class="chapter">
        <div class="prose"><p id="b-${BLOCK}">The drift appeared on Tuesday.</p></div>
      </article></div>
    </div>
  </div></main>`;
  const host = document.createElement("authorbot-collab") as AuthorbotCollab;
  host.dataset.apiBase = API;
  host.dataset.project = PROJECT;
  host.dataset.chapterId = CHAPTER;
  host.dataset.chapterRevision = "3";
  host.dataset.showPublic = "true";
  document.querySelector(".chapter-reading-layout")?.append(host);
  return host;
}

function stub(options: {
  session: ReturnType<typeof me>;
  annotations: Array<ReturnType<typeof annotation>>;
  replies?: Record<string, unknown[]>;
  pendingCreate?: Promise<Response>;
  pendingReply?: Promise<Response>;
  pendingPromote?: Promise<Response>;
  replyResponse?: (annotationId: string) => Response | Promise<Response>;
  calls?: Call[];
  replyCalls?: string[];
}): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = undefined;
    if (typeof init?.body === "string") body = JSON.parse(init.body) as unknown;
    options.calls?.push({ url, method, body });
    if (url === `${API}/v1/me`) return json(200, options.session);
    if (url.includes("/members?")) return json(200, { items: [], nextCursor: null });
    if (url.includes(`/chapters/${CHAPTER}/annotations?`)) {
      return json(200, { items: options.annotations, nextCursor: null });
    }
    const replyMatch = /\/annotations\/([^/]+)\/replies\?/.exec(url);
    if (replyMatch !== null && method === "GET") {
      options.replyCalls?.push(replyMatch[1]!);
      const response = options.replyResponse?.(replyMatch[1]!);
      if (response !== undefined) return response;
      return json(200, { items: options.replies?.[replyMatch[1]!] ?? [], nextCursor: null });
    }
    if (url.endsWith(`/chapters/${CHAPTER}/annotations`) && method === "POST") {
      return options.pendingCreate ?? json(202, {
        status: "queued",
        operationId: "op-create",
        annotationId: "thread-created",
        correlationId: "corr-create",
      });
    }
    if (/\/annotations\/[^/]+\/replies$/.test(url) && method === "POST") {
      return options.pendingReply ?? json(202, {
        status: "queued",
        operationId: "op-reply",
        replyId: "reply-created",
        correlationId: "corr-reply",
      });
    }
    if (url.endsWith("/force-create-work-item") && method === "POST") {
      return options.pendingPromote ?? json(201, {
        annotationId: "thread-1",
        status: "work_item_created",
        decisionId: "decision-1",
        workItemId: "work-1",
        operationIds: [],
        correlationId: "corr-promote",
      });
    }
    if (url.includes("/operations/")) {
      return json(200, {
        id: "op-create",
        projectId: PROJECT,
        correlationId: "corr-create",
        state: "committed",
        attempts: 1,
        error: null,
        commitSha: "abc123",
        createdAt: "2026-07-20T00:00:00Z",
        updatedAt: "2026-07-20T00:00:01Z",
      });
    }
    if (url.includes("/events")) return json(200, { items: [], latestId: 0 });
    return json(404, { detail: "not found" });
  }));
}

beforeEach(() => {
  resetProjectStoresForTests();
  vi.useRealTimers();
  vi.stubGlobal("EventSource", class {
    onopen: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    addEventListener(): void {}
    close(): void {}
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  resetProjectStoresForTests();
});

describe("chapter-wide Discussion", () => {
  it("uses embedded actor attribution when the author is no longer a member", async () => {
    const discussion = {
      ...annotation("thread-1"),
      author: {
        id: "actor-2",
        displayName: "Joe Mattie",
        type: "human",
      },
    };
    stub({
      session: me(["chapters:read", "comments:read"]),
      annotations: [discussion],
    });
    mount();

    await expect.poll(() => document.querySelector(".ab-discussion-thread .ab-author")?.textContent)
      .toBe("Joe Mattie");
  });

  it("losslessly suspends and restores annotation entry during chapter edit mode", async () => {
    stub({
      session: me([
        "chapters:read",
        "comments:read",
        "comments:write",
        "suggestions:write",
      ]),
      annotations: [],
    });
    const host = mount();
    await expect.poll(() => document.querySelector(".ab-discussion-start")).toBeTruthy();

    const discussion = document.querySelector<HTMLButtonElement>(".ab-discussion-start")!;
    const pencil = document.querySelector<HTMLButtonElement>(".ab-annotate")!;
    discussion.click();
    const textarea = document.querySelector<HTMLTextAreaElement>(".ab-composer textarea")!;
    textarea.value = "Keep this discussion draft while I edit.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    host.setChapterEditMode(true);
    await host.prepareForExternalMode();
    expect(document.querySelector(".ab-composer")).toBeNull();
    expect(discussion.hidden).toBe(true);
    expect(pencil.hidden).toBe(true);

    // Programmatic/stale block and selection clicks are also ignored, not
    // merely hidden.
    pencil.click();
    discussion.click();
    (host as unknown as {
      lastCapture: {
        block: HTMLElement;
        selector: {
          blockId: string;
          textPosition: { start: number; end: number };
          textQuote: { exact: string };
        };
      };
    }).lastCapture = {
      block: document.getElementById(`b-${BLOCK}`)!,
      selector: {
        blockId: BLOCK,
        textPosition: { start: 0, end: 9 },
        textQuote: { exact: "The drift" },
      },
    };
    document.querySelector<HTMLButtonElement>(".ab-select-suggestion")!.click();
    expect(document.querySelector(".ab-composer")).toBeNull();

    host.setChapterEditMode(false);
    expect(discussion.hidden).toBe(false);
    expect(pencil.hidden).toBe(false);
    expect(document.querySelector<HTMLTextAreaElement>(".ab-composer textarea")?.value)
      .toBe("Keep this discussion draft while I edit.");
  });

  it("reconciles edit suppression when the collaboration island is reattached", async () => {
    stub({
      session: me([
        "chapters:read",
        "comments:read",
        "comments:write",
        "suggestions:write",
      ]),
      annotations: [],
    });
    const host = mount();
    await expect.poll(() => document.querySelector(".ab-discussion-start")).toBeTruthy();

    const editor = document.createElement("authorbot-manuscript-editor");
    editor.dataset.chapterId = CHAPTER;
    editor.dataset.chapterEditActive = "true";
    document.querySelector(".chapter-reading-column")?.prepend(editor);
    host.setChapterEditMode(true);
    const parent = host.parentElement!;

    host.remove();
    parent.append(host);
    await expect.poll(
      () => (document.querySelector(".ab-discussion-start") as HTMLButtonElement).hidden,
    ).toBe(true);

    editor.removeAttribute("data-chapter-edit-active");
    host.remove();
    parent.append(host);
    await expect.poll(
      () => (document.querySelector(".ab-discussion-start") as HTMLButtonElement).hidden,
    ).toBe(false);
    expect((document.querySelector(".ab-annotate") as HTMLButtonElement).hidden).toBe(false);
  });

  it("defers a failed suggestion restore until chapter edit mode exits", async () => {
    let resolveCreate!: (response: Response) => void;
    const pendingCreate = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    stub({
      session: me([
        "chapters:read",
        "comments:read",
        "comments:write",
        "suggestions:write",
      ]),
      annotations: [],
      pendingCreate,
    });
    const host = mount();
    await expect.poll(() => document.querySelector(".ab-select-suggestion")).toBeTruthy();

    (host as unknown as {
      lastCapture: {
        block: HTMLElement;
        selector: {
          blockId: string;
          textPosition: { start: number; end: number };
          textQuote: { exact: string };
        };
      };
    }).lastCapture = {
      block: document.getElementById(`b-${BLOCK}`)!,
      selector: {
        blockId: BLOCK,
        textPosition: { start: 0, end: 9 },
        textQuote: { exact: "The drift" },
      },
    };
    document.querySelector<HTMLButtonElement>(".ab-select-suggestion")!.click();
    const form = document.querySelector(".ab-composer") as HTMLFormElement;
    const textarea = form.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "The fog appeared";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit();
    expect(document.querySelector(".ab-composer")).toBeNull();

    host.setChapterEditMode(true);
    resolveCreate(json(422, { detail: "suggestion rejected" }));
    await expect.poll(
      () => (host as unknown as { composer: { phase: string } }).composer.phase,
    ).toBe("editing");
    expect(document.querySelector(".ab-composer")).toBeNull();

    host.setChapterEditMode(false);
    expect(document.querySelector<HTMLTextAreaElement>(".ab-composer textarea")?.value)
      .toBe("The fog appeared");
    expect(document.querySelector(".ab-composer [role='alert']")).toBeTruthy();
  });

  it("defers a failed reply restore until chapter edit mode exits", async () => {
    let resolveReply!: (response: Response) => void;
    const pendingReply = new Promise<Response>((resolve) => {
      resolveReply = resolve;
    });
    stub({
      session: me([
        "chapters:read",
        "comments:read",
        "replies:write",
      ]),
      annotations: [annotation("thread-1")],
      pendingReply,
    });
    const host = mount();
    await expect.poll(() => document.querySelector(".ab-discussion-thread")).toBeTruthy();

    const thread = document.querySelector(".ab-discussion-thread") as HTMLElement;
    [...thread.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Reply")
      ?.click();
    const form = document.querySelector(".ab-reply-form") as HTMLFormElement;
    const textarea = form.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "Keep this reply, too.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit();
    expect(document.querySelector(".ab-reply-form")).toBeNull();

    host.setChapterEditMode(true);
    resolveReply(json(422, { detail: "reply rejected" }));
    await expect.poll(
      () => (host as unknown as { openReplyFor: string | null }).openReplyFor,
    ).toBe("thread-1");
    expect(document.querySelector(".ab-reply-form")).toBeNull();

    host.setChapterEditMode(false);
    expect(document.querySelector<HTMLTextAreaElement>(".ab-reply-form textarea")?.value)
      .toBe("Keep this reply, too.");
    expect(document.querySelector(".ab-reply-form [role='alert']")).toBeTruthy();
  });

  it("does not offer a second approval vote on an already approved discussion comment", async () => {
    stub({
      session: me([
        "chapters:read",
        "comments:read",
        "comments:vote",
      ]),
      annotations: [annotation("thread-1"), annotation("note-1", "block")],
    });
    mount();
    await expect.poll(() => document.querySelectorAll(".ab-card").length).toBe(2);

    expect(document.querySelector(".ab-discussion-thread .ab-votes")).toBeNull();
    expect(document.querySelector("[data-surface='note'] .ab-votes")).toBeTruthy();
  });

  it("keeps chapter threads below the manuscript and outside deterministic Notes order", async () => {
    const nested = [
      {
        id: "reply-root",
        annotationId: "thread-1",
        parentReplyId: null,
        authorActorId: "actor-2",
        body: "Root reply",
        status: "open",
        createdAt: "2026-07-20T00:01:00Z",
      },
      {
        id: "reply-child",
        annotationId: "thread-1",
        parentReplyId: "reply-root",
        authorActorId: "actor-1",
        body: "Nested reply",
        status: "open",
        createdAt: "2026-07-20T00:02:00Z",
      },
    ];
    stub({
      session: me([
        "chapters:read",
        "comments:read",
        "comments:write",
        "replies:write",
        "feedback:moderate",
        "work:promote",
      ]),
      annotations: [annotation("thread-1"), annotation("note-1", "block")],
      replies: { "thread-1": nested },
    });
    mount();

    await expect.poll(() => document.querySelectorAll(".ab-card").length).toBe(2);
    expect(document.querySelector(".ab-gutter [data-annotation-id='thread-1']")).toBeNull();
    expect(document.querySelector(".ab-gutter [data-annotation-id='note-1']")).toBeTruthy();
    expect(document.querySelector(".ab-inline-notes-whole .ab-card")).toBeNull();
    const discussion = document.querySelector(".ab-discussion-boundary") as HTMLElement;
    expect(discussion.previousElementSibling?.classList.contains("chapter-reading-layout")).toBe(true);
    expect(discussion.querySelector("[data-annotation-id='thread-1']")).toBeTruthy();
    expect(discussion.querySelectorAll(".ab-replies .ab-replies .ab-reply")).toHaveLength(1);
    expect(document.querySelector(".ab-rail-count")?.textContent).toBe("1 / 1");
  });

  it("uses exact canonical capabilities instead of broad legacy scopes", async () => {
    stub({
      session: me(["chapters:read", "comments:read", "suggestions:write"]),
      annotations: [annotation("thread-1")],
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-discussion-thread")).toBeTruthy();

    expect((document.querySelector(".ab-discussion-start") as HTMLButtonElement).hidden).toBe(true);
    const thread = document.querySelector(".ab-discussion-thread") as HTMLElement;
    expect([...thread.querySelectorAll("button")].map((button) => button.textContent))
      .not.toContain("Reply");
    expect(thread.querySelector("[data-override='promote']")).toBeNull();
  });

  it("clears and closes the chapter composer before its request settles", async () => {
    let resolveCreate!: (response: Response) => void;
    const pendingCreate = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const calls: Call[] = [];
    stub({
      session: me(["chapters:read", "comments:read", "comments:write"]),
      annotations: [],
      pendingCreate,
      calls,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-discussion-start")).toBeTruthy();

    (document.querySelector(".ab-discussion-start") as HTMLButtonElement).click();
    const form = document.querySelector(".ab-discussion-composer form") as HTMLFormElement;
    const textarea = form.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "Does the final beat land?";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit();

    expect(document.querySelector(".ab-discussion-composer form")).toBeNull();
    await expect.poll(() => document.querySelector(".ab-discussion-thread")?.textContent)
      .toContain("Does the final beat land?");
    const create = calls.find((call) => call.url.endsWith(`/chapters/${CHAPTER}/annotations`));
    expect(create?.body).toEqual({
      kind: "comment",
      scope: "chapter",
      chapterRevision: 3,
      body: "Does the final beat land?",
    });

    resolveCreate(json(202, {
      status: "queued",
      operationId: "op-create",
      annotationId: "thread-created",
      correlationId: "corr-create",
    }));
    await expect.poll(() => calls.some((call) => call.url.includes("/operations/"))).toBe(true);
  });

  it("paginates reply hydration and settles one-click chapter promotion immediately", async () => {
    const threads = Array.from({ length: 25 }, (_, index) => annotation(String(index + 1)));
    const replyCalls: string[] = [];
    let resolvePromote!: (response: Response) => void;
    const pendingPromote = new Promise<Response>((resolve) => {
      resolvePromote = resolve;
    });
    const calls: Call[] = [];
    stub({
      session: me([
        "chapters:read",
        "comments:read",
        "comments:write",
        "replies:write",
        "feedback:moderate",
        "work:promote",
      ]),
      annotations: threads,
      replyCalls,
      pendingPromote,
      calls,
    });
    mount();
    await expect.poll(() => document.querySelectorAll(".ab-discussion-thread").length).toBe(20);
    expect([...new Set(replyCalls)]).toHaveLength(20);
    expect(replyCalls).not.toContain("21");
    expect(document.querySelector(".ab-discussion-more")?.textContent)
      .toBe("Load 5 more discussions");

    (document.querySelector(".ab-discussion-more") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelectorAll(".ab-discussion-thread").length).toBe(25);
    expect([...new Set(replyCalls)]).toHaveLength(25);

    const firstId = document.querySelector<HTMLElement>(".ab-discussion-thread")
      ?.dataset.annotationId as string;
    document.querySelector<HTMLElement>(`[data-annotation-id='${firstId}']`)
      ?.querySelector<HTMLButtonElement>("[data-override='promote']")
      ?.click();
    const currentFirst = (): HTMLElement | null =>
      document.querySelector(`[data-annotation-id='${firstId}']`);
    await expect.poll(() => currentFirst()?.classList.contains("ab-promoted")).toBe(true);
    expect(currentFirst()?.querySelector(".ab-accepted-badge")?.textContent).toBe("Accepted");
    expect(currentFirst()?.querySelector("[data-override='promote']")).toBeNull();
    expect(calls.find((call) => call.url.endsWith("/force-create-work-item"))?.body).toEqual({});

    const promoted = threads.find(({ id }) => id === firstId)!;
    promoted.status = "work_item_created";
    resolvePromote(json(201, {
      annotationId: firstId,
      status: "work_item_created",
      decisionId: "decision-1",
      workItemId: "work-1",
      operationIds: [],
      correlationId: "corr-promote",
    }));
    await expect.poll(() => calls.filter((call) => call.url.includes("/annotations?")).length)
      .toBeGreaterThan(1);
  });

  it("renders notes before replies settle and hydrates threads with bounded concurrency", async () => {
    const annotations = [
      annotation("1", "block"),
      annotation("2", "block"),
      annotation("3"),
      annotation("4"),
      annotation("5"),
      annotation("6"),
    ];
    const replyCalls: string[] = [];
    const resolvers = new Map<string, (response: Response) => void>();
    const resolved = new Set<string>();
    stub({
      session: me(["chapters:read", "comments:read"]),
      annotations,
      replyCalls,
      replyResponse: (annotationId) => new Promise<Response>((resolve) => {
        resolvers.set(annotationId, resolve);
      }),
    });
    mount();

    // The manuscript annotations are useful immediately even though every
    // reply request is intentionally still pending.
    await expect.poll(() => document.querySelectorAll(".ab-card").length).toBe(6);
    expect(
      [...document.querySelectorAll<HTMLElement>(".ab-card")]
        .map((card) => card.dataset.annotationId),
    ).toEqual(["1", "2", "3", "4", "5", "6"]);
    await expect.poll(() => replyCalls.length).toBe(4);
    expect(new Set(replyCalls).size).toBe(4);

    const resolveReply = (annotationId: string): void => {
      if (resolved.has(annotationId)) return;
      resolved.add(annotationId);
      resolvers.get(annotationId)?.(json(200, {
        items: [{
          id: `reply-${annotationId}`,
          annotationId,
          parentReplyId: null,
          authorActorId: "actor-2",
          body: `Reply for ${annotationId}`,
          status: "open",
          createdAt: "2026-07-20T00:01:00Z",
        }],
        nextCursor: null,
      }));
    };

    const first = replyCalls[0]!;
    resolveReply(first);
    await expect.poll(() => replyCalls.length).toBe(5);
    await expect.poll(
      () => document.querySelector(`[data-annotation-id='${first}'] .ab-reply`)?.textContent,
    ).toContain(`Reply for ${first}`);

    for (const annotationId of [...replyCalls]) resolveReply(annotationId);
    await expect.poll(() => replyCalls.length).toBe(6);
    for (const annotationId of [...replyCalls]) resolveReply(annotationId);
    await expect.poll(() => document.querySelectorAll(".ab-reply").length).toBe(6);
  });
});
