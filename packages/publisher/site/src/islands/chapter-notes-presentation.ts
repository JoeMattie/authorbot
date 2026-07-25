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

/** Presentation-only range decoration projected from durable annotation data. */
export interface ChapterNoteHighlight {
  annotationId: string;
  blockId: string;
  start: number;
  end: number;
  kind: "comment" | "suggestion";
  active: boolean;
}

/**
 * The view capabilities notes need from a manuscript renderer.
 *
 * A Milkdown adapter can implement this with ProseMirror decorations and
 * `nodeDOM`; the static adapter below uses semantic block elements. The notes
 * model never depends on editor transactions or document serialization.
 */
export interface ChapterNotesTargetAdapter {
  elementFor(blockId: string): HTMLElement | null;
  setPreview(blockId: string, visible: boolean): void;
  reveal(blockId: string, behavior?: ScrollBehavior): void;
  clearInlineNotes(): void;
  /** Forms stay nearest the target, ahead of existing note cards. */
  mountInlineNote(blockId: string | null, note: HTMLElement): void;
  /** Rich manuscript surfaces render highlights as document decorations. */
  setHighlights?(highlights: readonly ChapterNoteHighlight[]): void;
  /** Rich manuscript surfaces can keep a range composer beside its selection. */
  mountComposer?(
    blockId: string,
    start: number,
    end: number,
    composer: HTMLElement,
  ): boolean;
  closeComposer?(): void;
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
    if (note.localName === "form") host?.prepend(note);
    else host?.append(note);
  }

  private host(className: string, label: string): HTMLElement {
    const host = document.createElement("section");
    host.className = className;
    host.dataset.abUi = "true";
    host.setAttribute("aria-label", label);
    return host;
  }
}
