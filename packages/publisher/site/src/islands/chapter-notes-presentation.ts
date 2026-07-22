/**
 * Presentation-only chapter-note behavior.
 *
 * The API/project store remains authoritative for annotation data. This module
 * owns only stable ordering, expansion rules, and the small target adapter the
 * reading view needs. Keeping those concerns separate lets the same model drive
 * today's static manuscript DOM and a later Milkdown/ProseMirror adapter built
 * with decorations, block handles, and tooltip plugins. Nothing here serializes
 * annotations into Markdown or assumes an editor owns their durable state.
 */
import type { Annotation } from "./api.js";

const PRESENTABLE_STATUSES = new Set(["open", "pending_git", "work_item_created"]);

/** Whole-chapter first, then manuscript block and selector occurrence. */
export function orderedChapterNotes(
  annotations: readonly Annotation[],
  blockIds: readonly string[],
): Annotation[] {
  const blockOrder = new Map(blockIds.map((id, index) => [id, index]));
  return annotations
    .filter((annotation) => {
      if (!PRESENTABLE_STATUSES.has(annotation.status)) return false;
      return annotation.target === null || blockOrder.has(annotation.target.blockId);
    })
    .sort((left, right) => {
      const leftBlock = left.target === null
        ? -1
        : (blockOrder.get(left.target.blockId) ?? Number.MAX_SAFE_INTEGER);
      const rightBlock = right.target === null
        ? -1
        : (blockOrder.get(right.target.blockId) ?? Number.MAX_SAFE_INTEGER);
      const leftOffset = left.target?.textPosition?.start ?? -1;
      const rightOffset = right.target?.textPosition?.start ?? -1;
      return leftBlock - rightBlock ||
        leftOffset - rightOffset ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id);
    });
}

export interface NoteExpansionState {
  readonly explicitAnnotationId: string | null;
  readonly visibleBlockIds: ReadonlySet<string>;
  /** A reader-closed note stays shut until its target leaves the viewport. */
  readonly suppressedAnnotationIds: ReadonlySet<string>;
}

export function noteIsExpanded(
  annotation: Annotation,
  state: NoteExpansionState,
): boolean {
  if (annotation.target === null) return true;
  if (state.explicitAnnotationId === annotation.id) return true;
  return !state.suppressedAnnotationIds.has(annotation.id) &&
    state.visibleBlockIds.has(annotation.target.blockId);
}

export type TargetVisibilityListener = (blockId: string, visible: boolean) => void;

/**
 * The view capabilities notes need from a manuscript renderer.
 *
 * A Milkdown adapter can implement this with ProseMirror decorations and
 * `nodeDOM`; the static adapter below uses semantic block elements. The notes
 * model never depends on editor transactions or document serialization.
 */
export interface ChapterNotesTargetAdapter {
  elementFor(blockId: string): HTMLElement | null;
  observeVisibility(listener: TargetVisibilityListener): () => void;
  setPreview(blockId: string, visible: boolean): void;
  reveal(blockId: string, behavior?: ScrollBehavior): void;
  clearInlineNotes(): void;
  mountInlineNote(blockId: string | null, note: HTMLElement): void;
}

export class StaticChapterNotesTargetAdapter implements ChapterNotesTargetAdapter {
  private readonly blocks = new Map<string, HTMLElement>();
  private readonly inlineHosts = new Map<string, HTMLElement>();
  private readonly wholeChapterHost: HTMLElement;

  constructor(
    prose: HTMLElement,
    blockElements: readonly HTMLElement[],
    trailingUi: ReadonlyMap<HTMLElement, HTMLElement>,
  ) {
    this.wholeChapterHost = this.host(
      "ab-inline-notes ab-inline-notes-whole",
      "Notes on this chapter",
    );
    const first = blockElements[0];
    if (first === undefined) {
      prose.prepend(this.wholeChapterHost);
    } else {
      first.insertAdjacentElement("beforebegin", this.wholeChapterHost);
    }

    for (const block of blockElements) {
      const blockId = block.id.slice(2);
      this.blocks.set(blockId, block);
      const host = this.host("ab-inline-notes ab-inline-notes-block", "Notes on this passage");
      host.dataset.blockId = blockId;
      const ui = trailingUi.get(block);
      (ui ?? block).insertAdjacentElement("afterend", host);
      this.inlineHosts.set(blockId, host);
    }
  }

  elementFor(blockId: string): HTMLElement | null {
    return this.blocks.get(blockId) ?? null;
  }

  observeVisibility(listener: TargetVisibilityListener): () => void {
    if (typeof IntersectionObserver === "function") {
      const byElement = new Map<HTMLElement, string>(
        [...this.blocks].map(([blockId, block]) => [block, blockId]),
      );
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const blockId = byElement.get(entry.target as HTMLElement);
          if (blockId !== undefined) listener(blockId, entry.isIntersecting);
        }
      }, { threshold: 0 });
      for (const block of this.blocks.values()) observer.observe(block);
      return () => observer.disconnect();
    }

    // DOM test environments and older embedded browsers get a small,
    // deterministic fallback. Real browsers use IntersectionObserver above.
    const measure = (): void => {
      const top = 0;
      const bottom = window.innerHeight || document.documentElement.clientHeight;
      for (const [blockId, block] of this.blocks) {
        const rect = block.getBoundingClientRect();
        listener(blockId, rect.bottom >= top && rect.top <= bottom);
      }
    };
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    window.requestAnimationFrame(measure);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }

  setPreview(blockId: string, visible: boolean): void {
    this.blocks.get(blockId)?.classList.toggle("ab-note-target-preview", visible);
  }

  reveal(blockId: string, behavior: ScrollBehavior = "smooth"): void {
    this.blocks.get(blockId)?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior,
    });
  }

  clearInlineNotes(): void {
    this.wholeChapterHost.replaceChildren();
    for (const host of this.inlineHosts.values()) host.replaceChildren();
  }

  mountInlineNote(blockId: string | null, note: HTMLElement): void {
    const host = blockId === null ? this.wholeChapterHost : this.inlineHosts.get(blockId);
    host?.append(note);
  }

  private host(className: string, label: string): HTMLElement {
    const host = document.createElement("section");
    host.className = className;
    host.dataset.abUi = "true";
    host.setAttribute("aria-label", label);
    return host;
  }
}
