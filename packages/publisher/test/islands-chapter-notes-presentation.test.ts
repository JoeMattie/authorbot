// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "../site/src/islands/api.js";
import {
  noteIsExpanded,
  orderedChapterNotes,
  StaticChapterNotesTargetAdapter,
} from "../site/src/islands/chapter-notes-presentation.js";

const CHAPTER = "019cadfd-8900-7140-98fb-ceff64cada33";
const BLOCK_A = "019cadfe-7360-7049-a30b-1f5898a5020a";
const BLOCK_B = "019cadfe-7360-7049-a30b-1f5898a5020b";

function note(
  id: string,
  target: Annotation["target"],
  createdAt = "2026-07-19T00:00:00Z",
): Annotation {
  return {
    id,
    chapterId: CHAPTER,
    kind: "comment",
    scope: target === null ? "chapter" : target.textPosition === undefined ? "block" : "range",
    chapterRevision: 3,
    target,
    authorActorId: "actor-1",
    body: id,
    status: "open",
    gitOperationId: null,
    createdAt,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("chapter note presentation model", () => {
  it("orders whole-chapter notes first, then block and selector occurrence with stable ties", () => {
    const ordered = orderedChapterNotes(
      [
        note("late-offset", { blockId: BLOCK_A, textPosition: { start: 40, end: 44 } }),
        note("second-block", { blockId: BLOCK_B }),
        note("same-newer", { blockId: BLOCK_A, textPosition: { start: 4, end: 8 } }, "2026-07-20T00:00:00Z"),
        note("whole-b", null, "2026-07-20T00:00:00Z"),
        note("block-level", { blockId: BLOCK_A }),
        note("same-older", { blockId: BLOCK_A, textPosition: { start: 4, end: 8 } }),
        note("whole-a", null),
        note("orphan", { blockId: "missing" }),
        { ...note("withdrawn", null), status: "withdrawn" },
      ],
      [BLOCK_A, BLOCK_B],
    );

    expect(ordered.map(({ id }) => id)).toEqual([
      "whole-a",
      "whole-b",
      "block-level",
      "same-older",
      "same-newer",
      "late-offset",
      "second-block",
    ]);
  });

  it("expands viewport and explicit notes while allowing a viewport note to be closed", () => {
    const annotation = note("note-a", { blockId: BLOCK_A });
    const visible = new Set([BLOCK_A]);
    expect(noteIsExpanded(annotation, {
      explicitAnnotationId: null,
      visibleBlockIds: visible,
      suppressedAnnotationIds: new Set(),
    })).toBe(true);
    expect(noteIsExpanded(annotation, {
      explicitAnnotationId: null,
      visibleBlockIds: visible,
      suppressedAnnotationIds: new Set([annotation.id]),
    })).toBe(false);
    expect(noteIsExpanded(annotation, {
      explicitAnnotationId: annotation.id,
      visibleBlockIds: new Set(),
      suppressedAnnotationIds: new Set([annotation.id]),
    })).toBe(true);
    expect(noteIsExpanded(note("whole", null), {
      explicitAnnotationId: null,
      visibleBlockIds: new Set(),
      suppressedAnnotationIds: new Set(),
    })).toBe(true);
  });
});

describe("static manuscript target adapter", () => {
  it("mounts whole-chapter and anchored notes in manuscript order and previews without layout markup", () => {
    document.body.innerHTML = `<div class="prose">
      <p id="b-${BLOCK_A}">First.</p><span id="ui-a"></span>
      <p id="b-${BLOCK_B}">Second.</p><span id="ui-b"></span>
    </div>`;
    const prose = document.querySelector(".prose") as HTMLElement;
    const first = document.getElementById(`b-${BLOCK_A}`) as HTMLElement;
    const second = document.getElementById(`b-${BLOCK_B}`) as HTMLElement;
    const trailing = new Map<HTMLElement, HTMLElement>([
      [first, document.getElementById("ui-a") as HTMLElement],
      [second, document.getElementById("ui-b") as HTMLElement],
    ]);
    const adapter = new StaticChapterNotesTargetAdapter(prose, [first, second], trailing);
    const whole = document.createElement("article");
    whole.textContent = "Whole";
    const anchored = document.createElement("article");
    anchored.textContent = "Anchored";
    adapter.mountInlineNote(null, whole);
    adapter.mountInlineNote(BLOCK_A, anchored);

    expect(prose.firstElementChild?.classList.contains("ab-inline-notes-whole")).toBe(true);
    expect(document.getElementById("ui-a")?.nextElementSibling?.textContent).toBe("Anchored");
    adapter.setPreview(BLOCK_A, true);
    expect(first.classList.contains("ab-note-target-preview")).toBe(true);
    adapter.setPreview(BLOCK_A, false);
    expect(first.classList.contains("ab-note-target-preview")).toBe(false);

    adapter.clearInlineNotes();
    expect(document.querySelectorAll(".ab-inline-notes > *")).toHaveLength(0);
  });
});
