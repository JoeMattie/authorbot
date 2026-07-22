// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { AuthorbotCollab } from "../site/src/islands/collab-element.js";
import { resetProjectStoresForTests } from "../site/src/islands/project-store.js";
import type { Annotation } from "../site/src/islands/api.js";

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER_ID = "019cadfd-8900-7140-98fb-ceff64cada33";
const BLOCK_1 = "019cadfe-7360-7049-a30b-1f5898a5020a";
const BLOCK_2 = "019cadfe-7360-7049-a30b-1f5898a5020b";

if (customElements.get("authorbot-collab") === undefined) {
  customElements.define("authorbot-collab", AuthorbotCollab);
}

function annotation(id: string, blockId: string, body: string, createdAt: string): Annotation {
  return {
    id,
    chapterId: CHAPTER_ID,
    kind: "comment",
    scope: "block",
    chapterRevision: 3,
    target: { blockId },
    authorActorId: "actor-2",
    body,
    status: "open",
    gitOperationId: null,
    createdAt,
  };
}

function chapterAnnotation(id: string, body: string, createdAt: string): Annotation {
  return {
    ...annotation(id, BLOCK_1, body, createdAt),
    scope: "chapter",
    target: null,
  };
}

function stub(items: Annotation[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown = { items: [], nextCursor: null };
      if (url.endsWith("/v1/me")) {
        body = {
          actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
          scopes: ["chapters:read", "annotations:read"],
          memberships: [{ role: "reader" }],
        };
      } else if (url.includes(`/chapters/${CHAPTER_ID}/annotations`)) {
        body = { items, nextCursor: null };
      }
      return { ok: true, status: 200, json: async () => body } as Response;
    }),
  );
}

function mount(): AuthorbotCollab {
  document.body.innerHTML = `
    <main>
      <article class="chapter">
        <div class="prose">
          <p id="b-${BLOCK_1}">First block.</p>
          <p id="b-${BLOCK_2}">Second block.</p>
        </div>
      </article>
    </main>`;
  const element = document.createElement("authorbot-collab") as AuthorbotCollab;
  element.dataset.apiBase = API;
  element.dataset.project = PROJECT;
  element.dataset.chapterId = CHAPTER_ID;
  element.dataset.chapterRevision = "3";
  element.dataset.showPublic = "true";
  document.querySelector("main")?.append(element);
  return element;
}

afterEach(() => {
  resetProjectStoresForTests();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("moves to the next and previous note, focuses it, and reveals its target", async () => {
  stub([
    annotation("ann-1", BLOCK_1, "First note", "2026-07-19T00:00:00Z"),
    annotation("ann-2", BLOCK_2, "Second note", "2026-07-19T00:01:00Z"),
  ]);
  mount();
  await expect.poll(() => document.querySelectorAll(".ab-card").length).toBe(2);

  const previous = document.querySelector<HTMLButtonElement>('[aria-label="Previous note"]');
  const next = document.querySelector<HTMLButtonElement>('[aria-label="Next note"]');
  const position = document.querySelector(".ab-rail-count");
  expect(position?.textContent).toBe("1 / 2");
  expect(previous?.disabled).toBe(true);
  expect(next?.disabled).toBe(false);

  const secondBlock = document.getElementById(`b-${BLOCK_2}`) as HTMLElement;
  const revealSecond = vi.fn();
  secondBlock.scrollIntoView = revealSecond;
  next?.click();

  expect(position?.textContent).toBe("2 / 2");
  expect(next?.disabled).toBe(true);
  expect(previous?.disabled).toBe(false);
  const active = document.querySelector(".ab-card.ab-active") as HTMLElement;
  expect(active.querySelector(".ab-body")?.textContent).toBe("Second note");
  expect(document.activeElement).toBe(active);
  expect(revealSecond).toHaveBeenCalledWith({
    block: "center",
    inline: "nearest",
    behavior: "smooth",
  });

  previous?.click();
  expect(position?.textContent).toBe("1 / 2");
  expect(document.querySelector(".ab-card.ab-active .ab-body")?.textContent).toBe("First note");
});

it("disables both navigation buttons for an empty chapter", async () => {
  stub([]);
  mount();
  await expect.poll(() => document.querySelector(".ab-rail-count")).toBeTruthy();
  expect(document.querySelector(".ab-rail-count")?.textContent).toBe("0 / 0");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Previous note"]')?.disabled).toBe(
    true,
  );
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Next note"]')?.disabled).toBe(
    true,
  );
});

it("mounts mobile notes inline in stable manuscript order and expands without reordering", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "(min-width: 960px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  stub([
    annotation("second", BLOCK_2, "Second block", "2026-07-19T00:02:00Z"),
    {
      ...annotation("late", BLOCK_1, "Late range", "2026-07-19T00:01:00Z"),
      scope: "range",
      target: { blockId: BLOCK_1, textPosition: { start: 8, end: 12 } },
    },
    chapterAnnotation("whole", "Whole chapter", "2026-07-19T00:03:00Z"),
    {
      ...annotation("early", BLOCK_1, "Early range", "2026-07-19T00:04:00Z"),
      scope: "range",
      target: { blockId: BLOCK_1, textPosition: { start: 2, end: 5 } },
    },
  ]);
  mount();
  await expect.poll(() => document.querySelectorAll(".ab-card").length).toBe(4);

  const order = (): string[] =>
    [...document.querySelectorAll<HTMLElement>(".ab-card")].map(
      (card) => card.dataset.annotationId ?? "",
    );
  expect(order()).toEqual(["whole", "early", "late", "second"]);
  expect(document.querySelector(".ab-inline-notes-whole .ab-card")?.getAttribute("data-annotation-id"))
    .toBe("whole");
  expect(document.querySelector(".ab-drawer")).toBeNull();

  const late = document.querySelector<HTMLElement>('[data-annotation-id="late"]') as HTMLElement;
  expect(late.classList.contains("ab-note-collapsed")).toBe(true);
  late.querySelector<HTMLButtonElement>(".ab-card-summary")?.click();
  expect(late.classList.contains("ab-note-expanded")).toBe(true);
  expect(order()).toEqual(["whole", "early", "late", "second"]);
  late.querySelector<HTMLButtonElement>(".ab-note-collapse")?.click();
  expect(late.classList.contains("ab-note-collapsed")).toBe(true);
  expect(order()).toEqual(["whole", "early", "late", "second"]);
});
