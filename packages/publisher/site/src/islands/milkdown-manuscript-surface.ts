/**
 * Heavy, browser-only manuscript surface.
 *
 * This module is reachable only through `manuscript-surface-loader.ts`. The
 * static generated manuscript remains the default reading view; Milkdown is
 * requested only after an explicit Notes or Edit action. Annotation data stays
 * in the project store/API and reaches ProseMirror as ephemeral decorations or
 * widgets. It is never serialized into chapter Markdown.
 */
import { parseProseMarkdown, scanSafety } from "@authorbot/markdown";
import { CrepeBuilder } from "@milkdown/crepe/builder";
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip";
import { listItem } from "@milkdown/crepe/feature/list-item";
import { table } from "@milkdown/crepe/feature/table";
import { toolbar } from "@milkdown/crepe/feature/toolbar";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { BlockProvider, block } from "@milkdown/kit/plugin/block";
import { TooltipProvider, tooltipFactory } from "@milkdown/kit/plugin/tooltip";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type PluginView,
} from "@milkdown/kit/prose/state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from "@milkdown/kit/prose/view";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import { $prose } from "@milkdown/kit/utils";
import type {
  ChapterNotesTargetAdapter,
  TargetVisibilityListener,
} from "./chapter-notes-presentation.js";
import type {
  ManuscriptSubmitResult,
  ManuscriptSurfaceOptions,
  ManuscriptSurfaceSession,
} from "./manuscript-surface.js";

const NOTES_META = "authorbot:notes-decorations";
const TOOLTIP_META = "authorbot:note-composer-tooltip";
const notesPluginKey = new PluginKey<DecorationSet>("AUTHORBOT_NOTES_DECORATIONS");
const noteComposerTooltip = tooltipFactory("AUTHORBOT_NOTE_COMPOSER");

interface BlockRange {
  id: string;
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
}

export interface MilkdownNoteHighlight {
  blockId: string;
  start: number;
  end: number;
  kind: "comment" | "suggestion";
}

interface InlineWidget {
  key: string;
  blockId: string | null;
  node: HTMLElement;
}

interface NotesModel {
  previews: Set<string>;
  highlights: MilkdownNoteHighlight[];
  widgets: InlineWidget[];
}

export class UnsafeManuscriptError extends Error {
  readonly findings: readonly string[];

  constructor(findings: readonly string[]) {
    super(`The chapter cannot enter rich-text mode: ${findings.join("; ")}`);
    this.name = "UnsafeManuscriptError";
    this.findings = findings;
  }
}

/** Shared editor boundary: reject source or output that Authorbot cannot save. */
export function validateManuscriptMarkdown(markdown: string): string[] {
  const parsed = parseProseMarkdown(markdown);
  const safety = scanSafety(parsed.ast);
  const findings: string[] = [];
  if (safety.rawHtml.length > 0) {
    findings.push("raw HTML is not allowed");
  }
  if (safety.forbiddenUrls.length > 0) {
    const schemes = [...new Set(safety.forbiddenUrls.map(({ scheme }) => scheme))].sort();
    findings.push(`unsafe URL scheme${schemes.length === 1 ? "" : "s"}: ${schemes.join(", ")}`);
  }
  if (parsed.blocks.markers.length > 0 || parsed.blocks.malformed.length > 0) {
    findings.push("Authorbot block markers are managed by the repository writer");
  }
  return findings;
}

/** Stable body form used for draft comparison and proposal submission. */
export function canonicalizeManuscriptMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").trim();
}

function requireSafeMarkdown(markdown: string): void {
  const findings = validateManuscriptMarkdown(markdown);
  if (findings.length > 0) throw new UnsafeManuscriptError(findings);
}

function blockRanges(doc: ProseNode, blockIds: readonly string[]): BlockRange[] {
  const ranges: BlockRange[] = [];
  doc.forEach((node, offset, index) => {
    const id = blockIds[index];
    if (id === undefined) return;
    ranges.push({
      id,
      from: offset,
      to: offset + node.nodeSize,
      contentFrom: offset + 1,
      contentTo: offset + 1 + node.content.size,
    });
  });
  return ranges;
}

function rangeFor(doc: ProseNode, blockIds: readonly string[], blockId: string): BlockRange | null {
  return blockRanges(doc, blockIds).find(({ id }) => id === blockId) ?? null;
}

class DecorationsBridge {
  readonly model: NotesModel = {
    previews: new Set(),
    highlights: [],
    widgets: [],
  };

  constructor(readonly blockIds: readonly string[]) {}

  build(doc: ProseNode): DecorationSet {
    const decorations: Decoration[] = [];
    const ranges = blockRanges(doc, this.blockIds);
    for (const range of ranges) {
      const classes = ["ab-milkdown-block"];
      if (this.model.previews.has(range.id)) classes.push("ab-note-target-preview");
      decorations.push(Decoration.node(range.from, range.to, {
        class: classes.join(" "),
        "data-authorbot-block-id": range.id,
      }));
    }
    for (const highlight of this.model.highlights) {
      const range = ranges.find(({ id }) => id === highlight.blockId);
      if (range === undefined) continue;
      const from = Math.max(range.contentFrom, Math.min(range.contentTo, range.contentFrom + highlight.start));
      const to = Math.max(from, Math.min(range.contentTo, range.contentFrom + highlight.end));
      if (from === to) continue;
      decorations.push(Decoration.inline(from, to, {
        class: `ab-inline-highlight ab-${highlight.kind}`,
        "data-authorbot-note-target": highlight.blockId,
      }));
    }
    for (const widget of this.model.widgets) {
      const range = widget.blockId === null
        ? null
        : ranges.find(({ id }) => id === widget.blockId) ?? null;
      const position = range === null ? 0 : range.to;
      widget.node.dataset.abUi = "true";
      widget.node.contentEditable = "false";
      decorations.push(Decoration.widget(position, () => widget.node, {
        key: widget.key,
        side: range === null ? -1 : 1,
      }));
    }
    return DecorationSet.create(doc, decorations);
  }

  refresh(view: EditorView): void {
    view.dispatch(view.state.tr.setMeta(NOTES_META, true));
  }
}

function notesDecorationsPlugin(bridge: DecorationsBridge) {
  return $prose(() => new Plugin<DecorationSet>({
    key: notesPluginKey,
    state: {
      init: (_config, state) => bridge.build(state.doc),
      apply: (transaction, previous, _oldState, newState) =>
        transaction.docChanged || transaction.getMeta(NOTES_META) === true
          ? bridge.build(newState.doc)
          : previous.map(transaction.mapping, transaction.doc),
    },
    props: {
      decorations: (state) => notesPluginKey.getState(state) ?? DecorationSet.empty,
    },
  }));
}

class ComposerTooltipBridge {
  readonly root = document.createElement("div");
  target: { from: number; to: number } | null = null;
  provider: TooltipProvider | null = null;

  constructor() {
    this.root.className = "ab-milkdown-note-tooltip";
    this.root.dataset.show = "false";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Write a note on this passage");
  }

  configure(ctx: Ctx, mount: HTMLElement): void {
    ctx.set(noteComposerTooltip.key, {
      view: (view) => {
        const provider = new TooltipProvider({
          content: this.root,
          root: mount,
          debounce: 0,
          shouldShow: () => this.target !== null,
        });
        this.provider = provider;
        return {
          update: (next, previous) => provider.update(next, previous),
          destroy: () => {
            provider.destroy();
            this.provider = null;
            this.root.remove();
          },
        };
      },
    });
  }

  open(view: EditorView, from: number, to: number, content: HTMLElement): void {
    this.root.replaceChildren(content);
    this.target = { from, to };
    const selection = TextSelection.between(view.state.doc.resolve(from), view.state.doc.resolve(to));
    view.dispatch(view.state.tr.setSelection(selection).setMeta(TOOLTIP_META, true));
  }

  close(view: EditorView): void {
    this.target = null;
    this.root.replaceChildren();
    view.dispatch(view.state.tr.setMeta(TOOLTIP_META, false));
    this.provider?.hide();
  }
}

let handleSequence = 0;

class BlockNoteHandleView implements PluginView {
  private readonly wrapper = document.createElement("div");
  private readonly button = document.createElement("button");
  private readonly tooltip = document.createElement("span");
  private readonly provider: BlockProvider;

  constructor(
    private readonly ctx: Ctx,
    private readonly bridge: DecorationsBridge,
    private readonly options: ManuscriptSurfaceOptions,
  ) {
    const tooltipId = `ab-milkdown-note-tooltip-${++handleSequence}`;
    this.wrapper.className = "ab-milkdown-note-handle";
    this.wrapper.dataset.abUi = "true";
    this.wrapper.hidden = options.allowBlockNotes !== true;
    this.button.type = "button";
    this.button.className = "ab-annotate";
    this.button.setAttribute("aria-label", "Note on this block");
    this.button.setAttribute("aria-describedby", tooltipId);
    this.button.textContent = "✎";
    this.tooltip.id = tooltipId;
    this.tooltip.className = "ab-note-tooltip";
    this.tooltip.setAttribute("role", "tooltip");
    this.tooltip.textContent = "Note on this block";
    this.tooltip.hidden = true;
    this.wrapper.append(this.button, this.tooltip);
    this.wrapper.addEventListener("dragstart", (event) => event.preventDefault());
    this.button.addEventListener("pointerenter", () => this.preview(true));
    this.button.addEventListener("pointerleave", () => this.preview(false));
    this.button.addEventListener("focus", () => this.preview(true));
    this.button.addEventListener("blur", () => this.preview(false));
    this.button.addEventListener("click", () => {
      const id = this.activeBlockId();
      if (id !== null) this.options.onBlockNote?.(id);
    });
    this.provider = new BlockProvider({
      ctx,
      content: this.wrapper,
      root: options.root,
      getOffset: () => 8,
      getPlacement: () => "left-start",
      shouldShow: () => options.allowBlockNotes === true,
    });
    this.update();
  }

  update = (): void => this.provider.update();

  destroy = (): void => {
    this.provider.destroy();
    this.wrapper.remove();
  };

  private activeBlockId(): string | null {
    const active = this.provider.active;
    if (active === null) return null;
    const view = this.ctx.get(editorViewCtx);
    const position = active.$pos.pos;
    return blockRanges(view.state.doc, this.bridge.blockIds)
      .find(({ from, to }) => position >= from && position <= to)?.id ?? null;
  }

  private preview(visible: boolean): void {
    this.tooltip.hidden = !visible;
    const id = this.activeBlockId();
    if (id === null) return;
    this.bridge.model.previews[visible ? "add" : "delete"](id);
    this.bridge.refresh(this.ctx.get(editorViewCtx));
  }
}

/** ProseMirror implementation of the presentation-only notes target contract. */
export class ProseMirrorChapterNotesAdapter implements ChapterNotesTargetAdapter {
  private widgetSequence = 0;
  private visibilityCleanup: (() => void) | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly bridge: DecorationsBridge,
    private readonly tooltip: ComposerTooltipBridge,
  ) {}

  elementFor(blockId: string): HTMLElement | null {
    const range = rangeFor(this.view.state.doc, this.bridge.blockIds, blockId);
    if (range === null) return null;
    const node = this.view.nodeDOM(range.from);
    return node instanceof HTMLElement ? node : node?.parentElement ?? null;
  }

  observeVisibility(listener: TargetVisibilityListener): () => void {
    this.visibilityCleanup?.();
    const entries = this.bridge.blockIds
      .map((id) => [id, this.elementFor(id)] as const)
      .filter((entry): entry is readonly [string, HTMLElement] => entry[1] !== null);
    if (typeof IntersectionObserver === "function") {
      const ids = new Map(entries.map(([id, node]) => [node, id]));
      const observer = new IntersectionObserver((observed) => {
        for (const entry of observed) {
          const id = ids.get(entry.target as HTMLElement);
          if (id !== undefined) listener(id, entry.isIntersecting);
        }
      }, { threshold: 0 });
      for (const [, node] of entries) observer.observe(node);
      this.visibilityCleanup = () => observer.disconnect();
    } else {
      const measure = (): void => {
        const bottom = window.innerHeight || document.documentElement.clientHeight;
        for (const [id, node] of entries) {
          const rect = node.getBoundingClientRect();
          listener(id, rect.bottom >= 0 && rect.top <= bottom);
        }
      };
      window.addEventListener("scroll", measure, { passive: true });
      window.addEventListener("resize", measure);
      window.requestAnimationFrame(measure);
      this.visibilityCleanup = () => {
        window.removeEventListener("scroll", measure);
        window.removeEventListener("resize", measure);
      };
    }
    return () => {
      this.visibilityCleanup?.();
      this.visibilityCleanup = null;
    };
  }

  setPreview(blockId: string, visible: boolean): void {
    this.bridge.model.previews[visible ? "add" : "delete"](blockId);
    this.bridge.refresh(this.view);
  }

  reveal(blockId: string, behavior: ScrollBehavior = "smooth"): void {
    this.elementFor(blockId)?.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior,
    });
  }

  clearInlineNotes(): void {
    this.bridge.model.widgets = [];
    this.bridge.refresh(this.view);
  }

  mountInlineNote(blockId: string | null, note: HTMLElement): void {
    this.bridge.model.widgets.push({
      key: `authorbot-note-${++this.widgetSequence}`,
      blockId,
      node: note,
    });
    this.bridge.refresh(this.view);
  }

  setHighlights(highlights: readonly MilkdownNoteHighlight[]): void {
    this.bridge.model.highlights = [...highlights];
    this.bridge.refresh(this.view);
  }

  selectionTarget(): { blockId: string; start: number; end: number } | null {
    const { from, to } = this.view.state.selection;
    const range = blockRanges(this.view.state.doc, this.bridge.blockIds)
      .find((candidate) => from >= candidate.contentFrom && to <= candidate.contentTo);
    if (range === undefined) return null;
    return {
      blockId: range.id,
      start: from - range.contentFrom,
      end: to - range.contentFrom,
    };
  }

  mountComposer(
    blockId: string,
    start: number,
    end: number,
    composer: HTMLElement,
  ): boolean {
    const range = rangeFor(this.view.state.doc, this.bridge.blockIds, blockId);
    if (range === null) return false;
    const from = Math.max(range.contentFrom, Math.min(range.contentTo, range.contentFrom + start));
    const to = Math.max(from, Math.min(range.contentTo, range.contentFrom + end));
    this.tooltip.open(this.view, from, to, composer);
    return true;
  }

  closeComposer(): void {
    this.tooltip.close(this.view);
  }

  destroy(): void {
    this.visibilityCleanup?.();
    this.visibilityCleanup = null;
  }
}

export async function createManuscriptSurface(
  options: ManuscriptSurfaceOptions,
): Promise<ManuscriptSurfaceSession> {
  const initialMarkdown = canonicalizeManuscriptMarkdown(options.markdown);
  requireSafeMarkdown(initialMarkdown);
  const bridge = new DecorationsBridge(options.blockIds);
  const tooltip = new ComposerTooltipBridge();
  const crepe = new CrepeBuilder({
    root: options.root,
    defaultValue: initialMarkdown,
  });
  if (options.activation === "edit") {
    crepe
      .addFeature(listItem)
      .addFeature(linkTooltip)
      .addFeature(table)
      .addFeature(toolbar);
  }
  crepe.editor
    .config((ctx) => {
      tooltip.configure(ctx, options.root);
      ctx.set(block.key, {
        view: () => new BlockNoteHandleView(ctx, bridge, options),
      });
    })
    .use(notesDecorationsPlugin(bridge))
    .use(noteComposerTooltip)
    .use(block);
  if (options.activation === "notes") crepe.setReadonly(true);

  let dirty = false;
  let baseline = initialMarkdown;
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown) => {
      const canonical = canonicalizeManuscriptMarkdown(markdown);
      dirty = canonical !== baseline;
      options.onMarkdownChange?.(canonical);
    });
  });
  try {
    await crepe.create();
  } catch (error) {
    // A rejected lazy activation must leave the caller's static manuscript
    // usable, even if Crepe mounted part of its frame before failing.
    try {
      await crepe.destroy();
    } catch {
      // Preserve the create error; the empty owned root is the safe fallback.
    }
    options.root.replaceChildren();
    delete options.root.dataset.manuscriptMode;
    throw error;
  }
  const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  view.dom.classList.add("ab-manuscript-prosemirror");
  view.dom.setAttribute("aria-label", options.accessibleName);
  view.dom.setAttribute("aria-multiline", "true");
  if (options.activation === "edit") {
    view.dom.setAttribute("role", "textbox");
  } else {
    view.dom.setAttribute("role", "region");
    view.dom.setAttribute("aria-readonly", "true");
  }
  options.root.dataset.manuscriptMode = options.activation;
  const notes = new ProseMirrorChapterNotesAdapter(view, bridge, tooltip);
  const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!dirty) return;
    event.preventDefault();
  };
  if (options.activation === "edit") {
    window.addEventListener("beforeunload", warnBeforeUnload);
  }

  return {
    activation: options.activation,
    notes,
    get dirty() {
      return dirty;
    },
    getMarkdown: () => {
      const markdown = canonicalizeManuscriptMarkdown(crepe.getMarkdown());
      requireSafeMarkdown(markdown);
      return markdown;
    },
    focus: () => view.focus(),
    submit: async (): Promise<ManuscriptSubmitResult> => {
      const markdown = canonicalizeManuscriptMarkdown(crepe.getMarkdown());
      requireSafeMarkdown(markdown);
      if (options.onSubmit === undefined) {
        return {
          ok: false,
          message: "Revision submission is not connected on this deployment.",
        };
      }
      const result = await options.onSubmit({ markdown });
      if (result.ok) {
        baseline = markdown;
        dirty = false;
      }
      return result;
    },
    destroy: async () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      notes.destroy();
      await crepe.destroy();
      options.root.replaceChildren();
      delete options.root.dataset.manuscriptMode;
    },
  };
}
