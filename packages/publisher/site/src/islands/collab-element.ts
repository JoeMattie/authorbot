/**
 * `<authorbot-collab>` - the collaboration island root (Phase 2b contract
 * §1-§2, §4). Framework-free custom element: reads its configuration from
 * data attributes stamped at build time, talks to the Phase 2 API with
 * credentialed fetch, and renders the annotation gutter (desktop) / inline
 * manuscript notes (mobile), chapter-wide Discussion, selection capture,
 * composers, replies, and moderation controls.
 *
 * Security invariants:
 * - Annotation/reply bodies and every other API-sourced string reach the DOM
 *   exclusively through `textContent` (newlines preserved via CSS
 *   `white-space: pre-wrap`); `innerHTML` is never used.
 * - Dynamic positioning goes through the CSSOM (`el.style.top = …`), never
 *   `setAttribute("style", …)`, so the contract §3 CSP holds without
 *   `'unsafe-inline'` styles.
 */
import { stackCards, type StackItem } from "./anchor.js";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
} from "@floating-ui/dom";
import {
  CollabApi,
  hasEffectiveCapability,
  hasLegacyEffectiveAction,
  isMaintainer,
  type Annotation,
  type FeedEvent,
  type Me,
  type Reply,
  type VoteValue,
} from "./api.js";
import {
  CLOSED,
  composerReduce,
  MAX_OPERATION_POLLS,
  pollDelayMs,
  type ComposerDraft,
  type ComposerKind,
  type ComposerState,
} from "./composer-state.js";
import {
  canOverride,
  OverrideControl,
  type OverrideAction,
  type OverrideDraft,
} from "./override-control.js";
import { captureRange, type CapturedSelection } from "./selection.js";
import { clearRangeHighlights, rangeForSelector } from "./range-highlight.js";
import { VoteControl } from "./vote-control.js";
import { iconButton, inlineIcon } from "./dom.js";
import type { ProjectStore } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";
import {
  noteIsExpanded,
  orderedChapterNotes,
  StaticChapterNotesTargetAdapter,
  type ChapterNotesTargetAdapter,
} from "./chapter-notes-presentation.js";

interface Config {
  apiBase: string;
  project: string;
  chapterId: string;
  chapterRevision: number;
  devLogin: boolean;
  showPublic: boolean;
}

/** What had keyboard focus before a full re-render, so it can be restored. */
interface FocusRestore {
  cardId: string;
  index: number;
  kind: string;
  /** For `kind === "vote"`: the segment's `data-vote` value. */
  voteValue?: string;
  /** For `kind === "override-action"`: the button's `data-override` value. */
  overrideAction?: string;
}

const DESKTOP_QUERY = "(min-width: 960px)";
const CARD_GAP = 12;
const DISCUSSION_PAGE_SIZE = 20;
const REPLY_HYDRATION_CONCURRENCY = 4;
const NOTE_FRAGMENT_PREFIX = "authorbot-note-";
const CHAPTER_EDIT_ACTIVE_ATTRIBUTE = "data-chapter-edit-active";
const REFRESH_HINT = "Still syncing; refresh the page to see the final state.";
const STALE_PAGE_HINT =
  "This chapter has changed since this page was published; " +
  "annotating is disabled until the site is republished.";

function sameDecision(
  left: Annotation["decision"],
  right: Annotation["decision"],
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  return left.id === right.id &&
    left.actionType === right.actionType &&
    left.result === right.result &&
    left.supportChanged === right.supportChanged &&
    left.workItemId === right.workItemId;
}

function sameReply(left: Reply | undefined, right: Reply | undefined): boolean {
  return left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.id === right.id &&
      left.parentReplyId === right.parentReplyId &&
      left.authorActorId === right.authorActorId &&
      left.body === right.body &&
      left.status === right.status &&
      left.workItemId === right.workItemId &&
      left.workPromotionPending === right.workPromotionPending &&
      left.gitOperationId === right.gitOperationId &&
      left.createdAt === right.createdAt &&
      left.updatedAt === right.updatedAt);
}

function sameSession(left: Me | null, right: Me | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const leftRoles = left.memberships?.map(({ role }) => role) ?? [];
  const rightRoles = right.memberships?.map(({ role }) => role) ?? [];
  const leftCapabilities = Array.isArray(left.effectiveCapabilities)
    ? left.effectiveCapabilities
    : [];
  const rightCapabilities = Array.isArray(right.effectiveCapabilities)
    ? right.effectiveCapabilities
    : [];
  const leftLegacyActions = Array.isArray(left.legacyEffectiveActions)
    ? left.legacyEffectiveActions.map(({ action }) => action)
    : [];
  const rightLegacyActions = Array.isArray(right.legacyEffectiveActions)
    ? right.legacyEffectiveActions.map(({ action }) => action)
    : [];
  return left.actor.id === right.actor.id &&
    left.actor.displayName === right.actor.displayName &&
    left.actor.externalIdentity === right.actor.externalIdentity &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => scope === right.scopes[index]) &&
    left.capabilityMode === right.capabilityMode &&
    leftCapabilities.length === rightCapabilities.length &&
    leftCapabilities.every((capability, index) => capability === rightCapabilities[index]) &&
    leftLegacyActions.length === rightLegacyActions.length &&
    leftLegacyActions.every((action, index) => action === rightLegacyActions[index]) &&
    leftRoles.length === rightRoles.length &&
    leftRoles.every((role, index) => role === rightRoles[index]);
}

function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project, chapterId, chapterRevision } = host.dataset;
  const revision = Number(chapterRevision);
  // apiBase === "" is a valid config: the API mounted at the site origin's
  // root (`--api-url /`), yielding relative `/v1/...` URLs. Only a missing
  // attribute means "not a collab build" (stay inert).
  if (
    apiBase === undefined ||
    project === undefined ||
    chapterId === undefined ||
    !Number.isInteger(revision) ||
    revision < 1
  ) {
    return null;
  }
  return {
    apiBase,
    project,
    chapterId,
    chapterRevision: revision,
    devLogin: host.dataset.devLogin === "true",
    showPublic: host.dataset.showPublic === "true",
  };
}

/** createElement + class + textContent helper (never innerHTML). */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function srOnly(text: string): HTMLSpanElement {
  return el("span", "ab-sr", text);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function chapterEditorIsActive(chapterId: string): boolean {
  return [...document.querySelectorAll<HTMLElement>(
    `authorbot-manuscript-editor[${CHAPTER_EDIT_ACTIVE_ATTRIBUTE}="true"]`,
  )].some((candidate) => candidate.dataset.chapterId === chapterId);
}

type SyncPhase = "syncing" | "stale" | "failed";

interface LocalSync {
  phase: SyncPhase;
  message?: string;
}

export class AuthorbotCollab extends HTMLElement {
  private cfg: Config | null = null;
  private api!: CollabApi;
  private store!: ProjectStore;
  private unsubscribeStore: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private me: Me | null = null;
  private memberNames = new Map<string, string>();
  private annotations: Annotation[] = [];
  private repliesByAnnotation = new Map<string, Reply[]>();
  private repliesSupported = true;
  private annotationSync = new Map<string, LocalSync>();
  private replySync = new Map<string, LocalSync>();
  private loadError: string | null = null;

  private mainEl!: HTMLElement;
  private proseEl!: HTMLElement;
  private blocks: HTMLElement[] = [];
  private blockUis = new Map<HTMLElement, HTMLElement>();
  private readingLayout: HTMLElement | null = null;
  private notesPanelVisible = true;
  private hiddenNotesPopover: HTMLElement | null = null;
  private hiddenNotesPopoverCleanup: (() => void) | null = null;
  private gutterAutoUpdateCleanups: Array<() => void> = [];
  private layoutFrame: number | undefined;
  private gutter!: HTMLElement;
  private railHeader!: HTMLElement;
  private railCount!: HTMLElement;
  private previousNoteBtn!: HTMLButtonElement;
  private nextNoteBtn!: HTMLButtonElement;
  private authbar!: HTMLElement;
  private cardsHost!: HTMLElement;
  private discussion!: HTMLElement;
  private discussionThreadsHost!: HTMLElement;
  private discussionComposerHost!: HTMLElement;
  private discussionEmpty!: HTMLElement;
  private discussionMore!: HTMLButtonElement;
  private discussionStart!: HTMLButtonElement;
  private liveRegion!: HTMLElement;
  private selTool!: HTMLElement;
  private cardEls = new Map<string, HTMLElement>();
  private voteControls = new Map<string, VoteControl>();
  private overrideControls = new Map<string, OverrideControl>();
  /** Open override form + typed reason per suggestion (survives re-renders). */
  private overrideDrafts = new Map<string, OverrideDraft>();
  private refetchTimer: number | undefined;
  private layoutGeneration = 0;

  private composer: ComposerState = CLOSED;
  private composerEl: HTMLFormElement | null = null;
  private composerReturnFocus: HTMLElement | null = null;
  private openReplyFor: string | null = null;
  private replyParent: string | null = null;
  private confirmWithdraw: string | null = null;
  private confirmWithdrawReply: string | null = null;
  private lastCapture: CapturedSelection | null = null;
  private lastSelectionRange: Range | null = null;
  private activeAnnotationId: string | null = null;
  private discussionVisibleLimit = DISCUSSION_PAGE_SIZE;
  private explicitExpandedAnnotationId: string | null = null;
  private visibleBlockIds = new Set<string>();
  private suppressedAnnotationIds = new Set<string>();
  /** The last deep link applied, so background refreshes never steal scroll. */
  private activatedNoteFragment: string | null = null;
  private targetAdapter!: ChapterNotesTargetAdapter;
  private staticTargetAdapter!: StaticChapterNotesTargetAdapter;
  private stopTargetVisibility: (() => void) | null = null;
  private chapterEditModeActive = false;

  private mql!: MediaQueryList;
  private started = false;
  private mountGeneration = 0;
  private scaffolded = false;
  private globalListenersConnected = false;
  /** Set when the API 409'd on the build-time chapter revision (stale page). */
  private staleRevision = false;
  /** Draft body of the open reply form (survives background re-renders). */
  private replyDraft = "";
  /** Submission error shown only when a failed reply is restored. */
  private replyError: string | null = null;
  /** Preserve the dev-login draft if a session change replaces its controls. */
  private devLoginDraft = "";
  private devLoginRole = "contributor";
  /** Session represented by the mounted auth controls; undefined means unrendered. */
  private renderedAuthSession: Me | null | undefined;
  private selectionTimer: number | undefined;
  private resizeTimer: number | undefined;

  connectedCallback(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const generation = ++this.mountGeneration;
    const cfg = parseConfig(this);
    const main = document.querySelector("main");
    const prose = document.querySelector<HTMLElement>("main .prose");
    if (cfg === null || main === null || prose === null) {
      return; // misconfigured build: stay inert, prose remains readable
    }
    this.cfg = cfg;
    // A collab island may be detached and reattached while the editor is
    // tearing down. Reconcile from DOM-owned state instead of retaining a
    // stale suppression latch across custom-element lifecycles.
    this.chapterEditModeActive = chapterEditorIsActive(cfg.chapterId);
    this.mainEl = main as HTMLElement;
    this.proseEl = prose;
    this.api = new CollabApi(cfg.apiBase, cfg.project);
    this.blocks = Array.from(prose.querySelectorAll<HTMLElement>('[id^="b-"]'));

    // No chrome yet: the scaffold is built by start() only after the API
    // answered the /v1/me probe (contract §1: with the API unreachable the
    // page keeps zero collaboration chrome).
    void this.connectStore(cfg, generation);
  }

  private async connectStore(cfg: Config, generation: number): Promise<void> {
    let store: ProjectStore;
    try {
      store = await loadProjectStore(cfg);
    } catch {
      // Collaboration is progressive enhancement. A permanently unavailable
      // split chunk must leave the prose readable and add no collaboration UI.
      return;
    }
    if (!this.isCurrentMount(generation)) return;
    this.store = store;
    this.unsubscribeStore = store.subscribe(() => {
      if (this.isCurrentMount(generation)) this.syncFromStore();
    });
    await this.start(generation, store);
  }

  disconnectedCallback(): void {
    this.clearComposerSelection();
    this.started = false;
    this.chapterEditModeActive = false;
    this.mountGeneration += 1;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.releaseConnection?.();
    this.releaseConnection = null;
    this.stopTargetVisibility?.();
    this.stopTargetVisibility = null;
    if (this.refetchTimer !== undefined) {
      window.clearTimeout(this.refetchTimer);
      this.refetchTimer = undefined;
    }
    if (this.selectionTimer !== undefined) {
      window.clearTimeout(this.selectionTimer);
      this.selectionTimer = undefined;
    }
    if (this.resizeTimer !== undefined) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
    }
    this.clearGutterAutoUpdates();
    if (this.layoutFrame !== undefined) {
      window.cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = undefined;
    }
    if (!this.scaffolded) {
      return;
    }
    this.disconnectGlobalListeners();
    this.readingLayout?.removeEventListener(
      "authorbot-notes-visibility-change",
      this.onNotesVisibilityChange,
    );
  }

  private isCurrentMount(generation: number): boolean {
    return this.started && this.isConnected && this.mountGeneration === generation;
  }

  // ---- scaffold -----------------------------------------------------------

  private buildScaffold(): void {
    this.mainEl.classList.add("ab-enabled");
    this.proseEl.classList.add("ab-prose");
    const readingLayout = this.closest<HTMLElement>(".chapter-reading-layout") ?? this.mainEl;
    this.readingLayout = readingLayout;
    this.notesPanelVisible = readingLayout.dataset.notesVisibility !== "hidden";
    readingLayout.addEventListener(
      "authorbot-notes-visibility-change",
      this.onNotesVisibilityChange,
    );
    readingLayout.classList.add("ab-reading-layout");

    this.liveRegion = el("div", "ab-sr");
    this.liveRegion.setAttribute("role", "status");
    this.liveRegion.setAttribute("aria-live", "polite");
    this.append(this.liveRegion);

    this.authbar = el("div", "ab-authbar");
    this.authbar.tabIndex = -1; // focus fallback target (never in tab order)
    this.authbar.hidden = true;
    this.cardsHost = el("div", "ab-cards");
    this.cardsHost.dataset.layoutReady = "false";

    this.railHeader = el("header", "ab-rail-head");
    this.railHeader.append(el("span", "ab-rail-eyebrow", "Notes on this chapter"));
    const noteNav = el("nav", "ab-note-nav");
    noteNav.setAttribute("aria-label", "Navigate chapter notes");
    this.previousNoteBtn = el("button", "ab-note-nav-btn", "‹");
    this.previousNoteBtn.type = "button";
    this.previousNoteBtn.setAttribute("aria-label", "Previous note");
    this.previousNoteBtn.title = "Previous note";
    this.previousNoteBtn.addEventListener("click", () => this.navigateAnnotation(-1));
    this.railCount = el("span", "ab-rail-count", "0 / 0");
    this.railCount.setAttribute("aria-live", "polite");
    this.nextNoteBtn = el("button", "ab-note-nav-btn", "›");
    this.nextNoteBtn.type = "button";
    this.nextNoteBtn.setAttribute("aria-label", "Next note");
    this.nextNoteBtn.title = "Next note";
    this.nextNoteBtn.addEventListener("click", () => this.navigateAnnotation(1));
    noteNav.append(this.previousNoteBtn, this.railCount, this.nextNoteBtn);
    this.railHeader.append(noteNav);

    this.gutter = el("aside", "ab-gutter");
    this.gutter.setAttribute("aria-label", "Annotations");
    readingLayout.append(this.gutter);

    this.discussion = el("section", "ab-discussion-boundary");
    this.discussion.setAttribute("aria-labelledby", "ab-discussion-title");
    const discussionHead = el("div", "ab-discussion-head");
    const discussionTitle = el("h2", undefined, "Discussion");
    discussionTitle.id = "ab-discussion-title";
    this.discussionStart = el("button", "ab-btn ab-primary ab-discussion-start", "Start a discussion");
    this.discussionStart.type = "button";
    this.discussionStart.addEventListener("click", () => {
      if (!this.canComment()) {
        this.promptSignIn();
        return;
      }
      this.openComposer(
        {
          kind: "comment",
          scope: "chapter",
          blockId: null,
          selector: null,
          body: "",
        },
        this.discussionStart,
      );
    });
    discussionHead.append(discussionTitle, this.discussionStart);
    this.discussionComposerHost = el("div", "ab-discussion-composer");
    this.discussionThreadsHost = el("div", "ab-discussion-threads");
    this.discussionThreadsHost.setAttribute("aria-live", "polite");
    this.discussionEmpty = el(
      "p",
      "ab-discussion-empty",
      "No chapter-wide discussion yet.",
    );
    this.discussionMore = el("button", "ab-btn ab-discussion-more", "Load more discussions");
    this.discussionMore.type = "button";
    this.discussionMore.addEventListener("click", () => void this.showMoreDiscussion());
    this.discussion.append(
      discussionHead,
      el(
        "p",
        "ab-discussion-copy",
        "Talk about the chapter as a whole. Passage and block notes stay with the manuscript above.",
      ),
      this.discussionComposerHost,
      this.discussionThreadsHost,
      this.discussionEmpty,
      this.discussionMore,
    );
    if (readingLayout === this.mainEl) {
      this.mainEl.append(this.discussion);
    } else {
      readingLayout.insertAdjacentElement("afterend", this.discussion);
    }

    this.selTool = el("div", "ab-seltool");
    this.selTool.dataset.abUi = "true";
    this.selTool.hidden = true;
    const commentBtn = el("button", "ab-btn ab-select-comment", "Comment");
    commentBtn.type = "button";
    const suggestBtn = el("button", "ab-btn ab-select-suggestion", "Suggest an edit");
    suggestBtn.type = "button";
    for (const [button, kind] of [
      [commentBtn, "comment"],
      [suggestBtn, "suggestion"],
    ] as const) {
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        const capture = this.lastCapture;
        if (capture !== null) {
          this.openComposer(
            {
              kind,
              scope: "range",
              blockId: capture.selector.blockId,
              selector: capture.selector,
              body: "",
            },
            button,
          );
        }
        this.hideSelTool();
      });
    }
    this.selTool.append(commentBtn, suggestBtn);
    this.mainEl.append(this.selTool);

    for (const block of this.blocks) {
      const ui = el("div", "ab-block-ui");
      ui.dataset.abUi = "true";
      const annotate = el("button", "ab-annotate");
      annotate.type = "button";
      const glyph = el("span", "ab-annotate-glyph", "✎");
      glyph.setAttribute("aria-hidden", "true"); // decorative; sr-only text names the button
      annotate.append(glyph);
      annotate.setAttribute("aria-label", "Note on this block");
      const preview = (visible: boolean): void => {
        this.targetAdapter?.setPreview(block.id.slice(2), visible);
      };
      annotate.addEventListener("pointerenter", () => preview(true));
      annotate.addEventListener("pointerleave", () => preview(false));
      annotate.addEventListener("focus", () => {
        preview(true);
        if (!annotate.matches(":focus-visible")) return;
        window.requestAnimationFrame(() => {
          if (
            annotate.matches(":focus-visible") &&
            this.composer.phase === "closed"
          ) {
            annotate.scrollIntoView({ block: "center", inline: "nearest" });
          }
        });
      });
      annotate.addEventListener("blur", () => preview(false));
      annotate.addEventListener("click", () => {
        preview(true);
        if (!this.canWrite()) {
          // Signed-out: the affordance leads to sign-in, never a dead end.
          this.promptSignIn();
          return;
        }
        this.openComposer(
          {
            kind: this.canComment() ? "comment" : "suggestion",
            scope: "block",
            blockId: block.id.slice(2),
            selector: null,
            body: "",
          },
          annotate,
        );
      });
      ui.append(annotate);
      block.insertAdjacentElement("afterend", ui);
      this.blockUis.set(block, ui);

      // §2.1 "and vice-versa": hovering/focusing the anchor block highlights
      // its cards (the card→block direction lives in buildCard).
      const highlight = (on: boolean): void => this.setBlockHighlight(block.id.slice(2), on);
      block.addEventListener("mouseenter", () => highlight(true));
      block.addEventListener("mouseleave", () => highlight(false));
      block.addEventListener("focusin", () => highlight(true));
      block.addEventListener("focusout", (event) => {
        if (!block.contains(event.relatedTarget as Node | null)) {
          highlight(false);
        }
      });
    }

    this.staticTargetAdapter = new StaticChapterNotesTargetAdapter(
      this.proseEl,
      this.blocks,
      this.blockUis,
    );
    this.targetAdapter = this.staticTargetAdapter;
    this.observeTargetVisibility();

    this.mql = window.matchMedia(DESKTOP_QUERY);
    this.placeContainers();
    this.connectGlobalListeners();
  }

  private observeTargetVisibility(): void {
    this.stopTargetVisibility?.();
    this.stopTargetVisibility = this.targetAdapter.observeVisibility((blockId, visible) => {
      if (visible) {
        this.visibleBlockIds.add(blockId);
      } else {
        this.visibleBlockIds.delete(blockId);
        for (const annotation of this.visibleNotes()) {
          if (annotation.target?.blockId === blockId) {
            this.suppressedAnnotationIds.delete(annotation.id);
          }
        }
      }
      this.refreshCardExpansion();
      this.layout();
    });
  }

  private connectGlobalListeners(): void {
    if (this.globalListenersConnected) return;
    this.globalListenersConnected = true;
    this.mql.addEventListener("change", this.onMediaChange);
    document.addEventListener("selectionchange", this.onSelectionChange);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("load", this.onWindowLoad);
    window.addEventListener("hashchange", this.onHashChange);
  }

  private disconnectGlobalListeners(): void {
    if (!this.globalListenersConnected) return;
    this.globalListenersConnected = false;
    this.mql.removeEventListener("change", this.onMediaChange);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("load", this.onWindowLoad);
    window.removeEventListener("hashchange", this.onHashChange);
  }

  /** Compatibility handoff for the chapter editor. Static prose needs no teardown. */
  async prepareForExternalMode(): Promise<boolean> {
    return true;
  }

  private readonly onWindowLoad = (): void => this.layout();

  private readonly onHashChange = (): void => {
    this.activatedNoteFragment = null;
    this.activateNoteFragment();
  };

  private readonly onMediaChange = (): void => {
    this.placeContainers();
    this.renderAll();
  };

  private readonly onResize = (): void => {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.layout(), 100);
  };

  private readonly onNotesVisibilityChange = (event: Event): void => {
    const visible = (event as CustomEvent<{ visible?: boolean }>).detail?.visible;
    this.notesPanelVisible = visible !== false;
    this.closeHiddenNotesPopover();
    this.placeContainers();
    this.renderAll();
  };

  private get isDesktop(): boolean {
    return this.mql.matches;
  }

  private placeContainers(): void {
    this.gutter.append(this.railHeader, this.authbar, this.cardsHost);
    this.gutter.hidden =
      !this.isDesktop ||
      !this.notesPanelVisible ||
      this.readingLayout?.classList.contains("ab-history-active") === true;
    this.updateNoteNavigation();
  }

  private closeHiddenNotesPopover(): void {
    this.hiddenNotesPopoverCleanup?.();
    this.hiddenNotesPopoverCleanup = null;
    for (const card of this.hiddenNotesPopover?.querySelectorAll<HTMLElement>(".ab-card") ?? []) {
      card.classList.remove("ab-note-popover-card");
    }
    for (
      const close of this.hiddenNotesPopover?.querySelectorAll<HTMLElement>(
        ".ab-note-popover-card-close",
      ) ?? []
    ) {
      close.remove();
    }
    this.hiddenNotesPopover?.remove();
    this.hiddenNotesPopover = null;
  }

  private hiddenPopover(blockId: string, trigger: HTMLElement): HTMLElement | null {
    const block = this.blocks.find((candidate) => candidate.id === `b-${blockId}`);
    if (block === undefined) return null;
    const ui = this.blockUis.get(block);
    if (ui === undefined) return null;
    this.closeHiddenNotesPopover();
    const popover = el("section", "ab-note-popover");
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Notes on this paragraph");
    popover.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      this.closeHiddenNotesPopover();
      trigger.focus();
    });
    ui.append(popover);
    const updatePosition = (): void => {
      void computePosition(trigger, popover, {
        placement: "right-start",
        strategy: "fixed",
        middleware: [
          offset(9),
          flip({ fallbackPlacements: ["left-start"] }),
          shift({
            padding: { top: 69, right: 12, bottom: 12, left: 12 },
          }),
          size({
            padding: { top: 69, right: 12, bottom: 12, left: 12 },
            apply({ availableHeight, elements }) {
              elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
            },
          }),
        ],
      }).then(({ x, y }) => {
        if (this.hiddenNotesPopover !== popover || !popover.isConnected) return;
        Object.assign(popover.style, {
          left: `${Math.round(x)}px`,
          top: `${Math.round(y)}px`,
        });
      });
    };
    this.hiddenNotesPopover = popover;
    this.hiddenNotesPopoverCleanup = autoUpdate(trigger, popover, updatePosition);
    return popover;
  }

  private showHiddenNotes(blockId: string, trigger: HTMLElement): void {
    const popover = this.hiddenPopover(blockId, trigger);
    if (popover === null) return;
    for (const annotation of this.visibleNotes()) {
      if (annotation.target?.blockId !== blockId) continue;
      const card = this.cardEls.get(annotation.id);
      if (card === undefined) continue;
      card.classList.add("ab-note-popover-card");
      const close = iconButton(
        "ab-note-popover-card-close",
        "Close note",
        "x",
      );
      close.addEventListener("click", () => {
        this.closeHiddenNotesPopover();
        trigger.focus();
      });
      card.querySelector(".ab-card-head")?.append(close);
      popover.append(card);
    }
    popover.querySelector<HTMLElement>(".ab-card")?.focus();
  }

  // ---- data ---------------------------------------------------------------

  private async start(
    generation = this.mountGeneration,
    store = this.store,
  ): Promise<void> {
    const cfg = this.cfg as Config;
    await store.getState().ensureSession();
    if (!this.isCurrentMount(generation)) return;
    const sessionState = store.getState();
    if (sessionState.sessionStatus !== "ready") {
      // API unreachable (contract §1): render no collaboration chrome at all.
      // A scaffold from an earlier successful start (e.g. a re-login attempt
      // during a network blip) is kept as-is rather than torn down mid-use.
      return;
    }
    this.me = sessionState.session;
    if (!this.scaffolded) {
      this.scaffolded = true;
      this.buildScaffold();
    } else {
      this.connectGlobalListeners();
    }
    const expectedSession = this.me;
    // Start attribution lookup alongside annotations, but never make either
    // it or reply fan-out a prerequisite for the first useful Notes render.
    const memberNamesRequest = expectedSession === null ? null : this.api.memberNames();
    if (this.me !== null || cfg.showPublic) {
      if (!(await this.loadAnnotations(generation, store, cfg))) return;
    }
    if (!this.isCurrentMount(generation)) return;
    this.renderAll();
    if (this.me !== null || cfg.showPublic) {
      if (!this.isCurrentMount(generation)) return;
      // Match the existing connection ordering: the first authoritative reply
      // pass completes before SSE recovery starts. The pass is now bounded and
      // progressive, so it no longer blocks the already-rendered Notes UI.
      void this.finishInitialReplyHydration(generation, store);
    }
    if (memberNamesRequest !== null && expectedSession !== null) {
      void this.finishMemberNames(memberNamesRequest, expectedSession, generation, store);
    }
  }

  private async finishMemberNames(
    request: Promise<Map<string, string>>,
    expectedSession: Me,
    generation: number,
    store: ProjectStore,
  ): Promise<void> {
    let memberNames: Map<string, string>;
    try {
      memberNames = await request;
    } catch {
      return;
    }
    if (
      !this.isCurrentMount(generation) ||
      !sameSession(expectedSession, store.getState().session)
    ) {
      return;
    }
    this.memberNames = memberNames;
    this.renderAll();
  }

  private async finishInitialReplyHydration(
    generation: number,
    store: ProjectStore,
  ): Promise<void> {
    if (!(await this.loadReplies(generation, store))) return;
    if (!this.isCurrentMount(generation)) return;
    this.releaseConnection ??= store.getState().retainConnection();
  }

  private async loadAnnotations(
    generation = this.mountGeneration,
    store = this.store,
    cfg = this.cfg as Config,
  ): Promise<boolean> {
    if (!this.isCurrentMount(generation)) return false;
    await store.getState().refreshAnnotations(cfg.chapterId);
    if (!this.isCurrentMount(generation)) return false;
    const state = store.getState();
    if (state.annotationStatusByChapter[cfg.chapterId] !== "ready") {
      // Signed-out 401/403 simply means the API has no public read for this
      // project yet: keep the page clean (progressive enhancement §1).
      this.loadError =
        state.annotationErrorByChapter[cfg.chapterId] ?? null;
      this.annotations = [];
      return true;
    }
    this.loadError = null;
    this.annotations = (state.annotationIdsByChapter[cfg.chapterId] ?? []).flatMap(
      (id) => state.annotationsById[id] ?? [],
    );
    if (
      this.activeAnnotationId === null ||
      !this.annotations.some((annotation) => annotation.id === this.activeAnnotationId)
    ) {
      this.activeAnnotationId = this.visibleNotes()[0]?.id ?? null;
    }
    // Cards for server-side pending records show "syncing" and poll (§2.5).
    for (const annotation of this.presentableAnnotations()) {
      if (
        annotation.status === "pending_git" &&
        annotation.gitOperationId !== null &&
        !this.annotationSync.has(annotation.id)
      ) {
        this.markAnnotationSyncing(annotation.id, annotation.gitOperationId);
      }
    }
    return true;
  }

  private async showMoreDiscussion(): Promise<void> {
    const before = this.visibleDiscussionThreads().length;
    this.discussionVisibleLimit += DISCUSSION_PAGE_SIZE;
    const added = this.visibleDiscussionThreads().slice(before);
    if (added.length > 0) {
      const generation = this.mountGeneration;
      if (!(await this.loadReplies(generation, this.store, added))) return;
    }
    this.renderAll();
    this.discussionThreadsHost
      .querySelector<HTMLElement>(`[data-annotation-id]:nth-child(${before + 1})`)
      ?.focus();
  }

  private syncRepliesFromStore(annotations: readonly Annotation[]): boolean {
    const state = this.store.getState();
    let changed = false;
    for (const annotation of annotations) {
      const replyIds = state.replyIdsByAnnotation[annotation.id] ?? [];
      const next = replyIds.flatMap((id) => state.repliesById[id] ?? []);
      const current = this.repliesByAnnotation.get(annotation.id) ?? [];
      if (
        next.length !== current.length ||
        next.some((reply, index) => !sameReply(current[index], reply))
      ) {
        this.repliesByAnnotation.set(annotation.id, next);
        changed = true;
      }
    }
    return changed;
  }

  private async loadReplies(
    generation = this.mountGeneration,
    store = this.store,
    requestedAnnotations?: readonly Annotation[],
  ): Promise<boolean> {
    // Attempted whenever annotations loaded (signed-in, or the anonymous
    // public read): a 401/403 simply yields no fetched replies.
    if (!this.repliesSupported) {
      return true;
    }
    // Notes retain their existing reply behavior. Chapter-wide threads are
    // hydrated one visible page at a time. A small worker pool prevents one
    // slow thread from serially blocking every other card without fanning out
    // one request per historical thread.
    const annotations = requestedAnnotations === undefined
      ? [...this.visibleNotes(), ...this.visibleDiscussionThreads()]
      : [...requestedAnnotations];
    let nextIndex = 0;
    const worker = async (): Promise<boolean> => {
      while (this.repliesSupported) {
        const index = nextIndex;
        nextIndex += 1;
        const annotation = annotations[index];
        if (annotation === undefined) return true;
        await store.getState().ensureReplies(annotation.id);
        if (!this.isCurrentMount(generation)) return false;
        const state = store.getState();
        if (state.replyStatusByAnnotation[annotation.id] !== "ready") {
          const status = state.replyErrorStatusByAnnotation[annotation.id];
          if (status === 404 || status === 405) {
            this.repliesSupported = false;
            return true;
          }
          continue;
        }
        if (this.syncRepliesFromStore([annotation])) this.renderAll();
      }
      return true;
    };
    const workers = Array.from(
      { length: Math.min(REPLY_HYDRATION_CONCURRENCY, annotations.length) },
      () => worker(),
    );
    return (await Promise.all(workers)).every(Boolean);
  }

  private async refetch(): Promise<void> {
    const generation = this.mountGeneration;
    const store = this.store;
    if (!(await this.loadAnnotations(generation, store))) return;
    if (!this.isCurrentMount(generation)) return;
    this.renderAll();
    void this.loadReplies(generation, store);
  }

  /** Compatibility adapter while card/form state remains local to the island. */
  private syncFromStore(): void {
    if (this.cfg === null || !this.scaffolded) {
      return;
    }
    const state = this.store.getState();
    const sessionChanged = !sameSession(this.me, state.session);
    const ids = state.annotationIdsByChapter[this.cfg.chapterId] ?? [];
    const projectionUnchanged =
      !sessionChanged &&
      ids.length === this.annotations.length &&
      ids.every((id, index) => state.annotationsById[id] === this.annotations[index]) &&
      this.annotations.every((annotation) => {
        const nextReplyIds = state.replyIdsByAnnotation[annotation.id] ?? [];
        const currentReplies = this.repliesByAnnotation.get(annotation.id) ?? [];
        return nextReplyIds.length === currentReplies.length &&
          nextReplyIds.every(
            (id, index) => state.repliesById[id] === currentReplies[index],
          );
      });
    // Connection cursors, unrelated queue operations, and other store slices
    // update frequently. They must not touch live controls or rebuild cards.
    if (projectionUnchanged) return;
    this.me = state.session;
    if (sessionChanged) this.memberNames = new Map();
    const nextAnnotations = ids.flatMap((id) => state.annotationsById[id] ?? []);
    const onlyVoteDataChanged =
      nextAnnotations.length === this.annotations.length &&
      nextAnnotations.every((next, index) => {
        const before = this.annotations[index];
        return (
          before !== undefined &&
          before.id === next.id &&
          before.status === next.status &&
          before.body === next.body &&
          sameDecision(before.decision, next.decision) &&
          before.gitOperationId === next.gitOperationId
        );
      }) &&
        nextAnnotations.every((annotation) => {
          const nextReplyIds = state.replyIdsByAnnotation[annotation.id] ?? [];
          const currentReplies = this.repliesByAnnotation.get(annotation.id) ?? [];
          return (
            nextReplyIds.length === currentReplies.length &&
            nextReplyIds.every(
              (id, index) => sameReply(currentReplies[index], state.repliesById[id]),
            )
          );
        });
    this.annotations = nextAnnotations;
    if (!sessionChanged && onlyVoteDataChanged) {
      for (const annotation of nextAnnotations) {
        this.voteControls.get(annotation.id)?.update(annotation);
        this.overrideControls.get(annotation.id)?.update(annotation);
      }
      return;
    }
    for (const annotation of this.annotations) {
      const replyIds = state.replyIdsByAnnotation[annotation.id] ?? [];
      this.repliesByAnnotation.set(
        annotation.id,
        replyIds.flatMap((id) => state.repliesById[id] ?? []),
      );
    }
    this.renderAll();
  }

  /** Test and rolling-deployment adapter; the project store owns the feed. */
  private onFeedEvent(event: FeedEvent): void {
    this.store.getState().reconcileEvent(event);
  }

  // ---- votes (Phase 3 contract §2/§6) --------------------------------------

  /** Cast (`value`) or clear (`null`) the viewer's vote on feedback. */
  private async castVoteOn(annotationId: string, value: VoteValue | null): Promise<void> {
    const annotation = this.annotations.find((a) => a.id === annotationId);
    const control = this.voteControls.get(annotationId);
    if (annotation === undefined || control === undefined) {
      return;
    }
    control.setBusy(true);
    const result = await this.store.getState().setVote(annotationId, value);
    control.setBusy(false);
    if (!result.ok) {
      this.announce(this.friendlyWriteError(result.status, result.message));
      return;
    }
    const hadDecision = annotation.decision != null;
    const current = this.store.getState().annotationsById[annotationId] ?? annotation;
    control.update(current);
    this.overrideControls.get(annotationId)?.update(current);
    this.announce(control.summary());
    // A fresh crossing changes the annotation's server-side status; reconcile
    // authoritative state so the card reflects it even if the feed is down.
    if (!hadDecision && result.value.decision != null) {
      this.announce("Threshold reached. Queued as a work item.");
      this.scheduleRefetch();
    }
  }

  // ---- maintainer overrides (Phase 6 contract §3.6) ------------------------

  /**
   * Run a force-promote / reject. Resolves to the message the control should
   * show in its alert node, or `null` on success. A 403/409 problem detail is
   * surfaced VERBATIM - "a work item already exists for this annotation" says
   * exactly what happened, and inventing copy for it would be a lie.
   */
  private async runOverride(
    annotationId: string,
    action: OverrideAction,
    reason?: string,
  ): Promise<string | null> {
    const control = this.overrideControls.get(annotationId);
    control?.setBusy(true);
    const result =
      action === "promote"
        ? await this.store.getState().promoteAnnotation(annotationId)
        : await this.store.getState().rejectAnnotation(annotationId, reason ?? "");
    control?.setBusy(false);
    if (!result.ok) {
      const message = result.status === 0 || result.status === 401
        ? this.friendlyWriteError(result.status, result.message)
        : result.message;
      // Optimistic promotion rebuilds the card. Put the error on the current
      // control too, not only the detached control that initiated the call.
      const currentError = this.overrideControls
        .get(annotationId)
        ?.root.querySelector<HTMLElement>(".ab-override-error");
      if (currentError !== undefined && currentError !== null) {
        currentError.textContent = message;
        currentError.hidden = false;
      }
      return message;
    }
    this.overrideDrafts.delete(annotationId);
    if (action === "promote") {
      this.openReplyFor = null;
      this.replyParent = null;
      this.renderAll();
    }
    this.announce(
      action === "promote"
        ? "Promoted to work. A work item was created."
        : "Suggestion rejected.",
    );
    this.scheduleRefetch();
    return null;
  }

  private async promoteReply(annotation: Annotation, reply: Reply): Promise<void> {
    const result = await this.store.getState().promoteReply(annotation.id, reply.id);
    if (!result.ok) {
      this.announce(
        result.status === 0 || result.status === 401
          ? this.friendlyWriteError(result.status, result.message)
          : result.message,
      );
      return;
    }
    this.announce("Reply promoted to work. A separate work item was created.");
  }

  private scheduleRefetch(): void {
    window.clearTimeout(this.refetchTimer);
    this.refetchTimer = window.setTimeout(() => void this.refetch(), 400);
  }

  private canWrite(): boolean {
    return this.canComment() || this.canSuggest();
  }

  private canReadChapter(): boolean {
    return hasEffectiveCapability(this.me, "chapters:read", "chapters:read");
  }

  private canComment(): boolean {
    return hasEffectiveCapability(this.me, "chapters:read", "chapters:read") &&
      hasEffectiveCapability(this.me, "comments:write", "annotations:write");
  }

  private canSuggest(): boolean {
    return hasEffectiveCapability(this.me, "chapters:read", "chapters:read") &&
      hasEffectiveCapability(this.me, "suggestions:write", "annotations:write");
  }

  private canReplyTo(annotation: Annotation): boolean {
    const readCapability = annotation.kind === "comment" ? "comments:read" : "suggestions:read";
    return hasEffectiveCapability(this.me, "replies:write", "annotations:write") &&
      hasEffectiveCapability(this.me, readCapability, "annotations:read");
  }

  private canWithdraw(annotation: Annotation): boolean {
    if (this.me === null) return false;
    if (this.me.actor.id === annotation.authorActorId) {
      return hasEffectiveCapability(this.me, "feedback:withdraw-own", "annotations:write");
    }
    return isMaintainer(this.me) &&
      (hasEffectiveCapability(this.me, "feedback:moderate") ||
        hasLegacyEffectiveAction(this.me, "feedback:moderate", "annotations:write"));
  }

  private canWithdrawReply(reply: Reply): boolean {
    if (this.me === null) return false;
    if (this.me.actor.id === reply.authorActorId) {
      return hasEffectiveCapability(this.me, "feedback:withdraw-own", "annotations:write");
    }
    return isMaintainer(this.me) &&
      (hasEffectiveCapability(this.me, "feedback:moderate") ||
        hasLegacyEffectiveAction(this.me, "feedback:moderate", "annotations:write"));
  }

  /** Phase 11 uses kind-specific vote capability; old Workers admit suggestions only. */
  private canVoteOn(annotation: Annotation): boolean {
    return annotation.kind === "comment"
      ? hasEffectiveCapability(this.me, "comments:vote")
      : hasEffectiveCapability(this.me, "suggestions:vote", "votes:write");
  }

  private canPromoteToWork(): boolean {
    return isMaintainer(this.me) &&
      (hasEffectiveCapability(this.me, "work:promote") ||
        hasLegacyEffectiveAction(this.me, "work:promote", "work:claim"));
  }

  private canRejectSuggestion(): boolean {
    return isMaintainer(this.me) &&
      (hasEffectiveCapability(this.me, "feedback:moderate") ||
        hasLegacyEffectiveAction(this.me, "feedback:moderate", "annotations:write"));
  }

  /** Human copy for 401/403 write failures instead of raw problem details. */
  private friendlyWriteError(status: number, message: string): string {
    if (status === 401) {
      return "Sign in to annotate.";
    }
    if (status === 403) {
      return "Your role is read-only here.";
    }
    if (status === 0) {
      return "Network error. Is the API reachable?";
    }
    return message;
  }

  private friendlySyncError(message: string): string {
    if (message.includes("invalid_format") || message.includes("namespace one of")) {
      return "This comment could not be saved with the current author identity.";
    }
    return message;
  }

  /** Signed-out annotate attempt: lead to the sign-in affordance (§16.6). */
  private promptSignIn(): void {
    this.announce("Sign in to annotate.");
    const target =
      document.querySelector<HTMLElement>("authorbot-account .ab-account-signin") ??
      this.authbar.querySelector<HTMLElement>(".ab-signin") ??
      this.authbar.querySelector<HTMLElement>(".ab-devlogin input") ??
      this.authbar;
    target.focus();
  }

  /** §2.1: highlight every card anchored to a manuscript block. */
  private setBlockHighlight(blockId: string, on: boolean): void {
    for (const annotation of this.visibleNotes()) {
      if (annotation.target?.blockId !== blockId) {
        continue;
      }
      const card = this.cardEls.get(annotation.id);
      if (card === undefined) {
        continue;
      }
      // Never clear the highlight of the card the user is focused in.
      if (!on && card.contains(document.activeElement)) {
        continue;
      }
      card.classList.toggle("ab-hovered", on);
    }
  }

  private activateAnnotation(annotationId: string, moveFocus = false): void {
    if (!this.visibleNotes().some(({ id }) => id === annotationId)) {
      const discussionCard = this.cardEls.get(annotationId);
      discussionCard?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (moveFocus) discussionCard?.focus();
      return;
    }
    this.activeAnnotationId = annotationId;
    this.explicitExpandedAnnotationId = annotationId;
    this.suppressedAnnotationIds.delete(annotationId);
    for (const [id, card] of this.cardEls) {
      card.classList.toggle("ab-active", id === annotationId);
    }
    for (const mark of this.proseEl.querySelectorAll<HTMLElement>(".ab-inline-highlight")) {
      mark.classList.toggle("ab-highlight-active", mark.dataset.annotationId === annotationId);
    }
    if (this.targetAdapter.setHighlights !== undefined) this.renderRangeHighlights();
    const card = this.cardEls.get(annotationId);
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (moveFocus) {
      card?.focus();
    }
    this.refreshCardExpansion();
    this.updateNoteNavigation();
    this.layout();
  }

  private collapseAnnotation(annotationId: string): void {
    if (this.explicitExpandedAnnotationId === annotationId) {
      this.explicitExpandedAnnotationId = null;
    }
    const annotation = this.visibleNotes().find(({ id }) => id === annotationId);
    if (
      annotation?.target !== null &&
      annotation?.target !== undefined &&
      this.visibleBlockIds.has(annotation.target.blockId)
    ) {
      this.suppressedAnnotationIds.add(annotationId);
    } else {
      this.suppressedAnnotationIds.delete(annotationId);
    }
    this.refreshCardExpansion();
    this.cardEls.get(annotationId)?.focus();
    this.layout();
  }

  private refreshCardExpansion(): void {
    const state = {
      explicitAnnotationId: this.explicitExpandedAnnotationId,
      visibleBlockIds: this.visibleBlockIds,
      suppressedAnnotationIds: this.suppressedAnnotationIds,
    };
    for (const annotation of this.visibleNotes()) {
      const card = this.cardEls.get(annotation.id);
      if (card === undefined) continue;
      const expanded = noteIsExpanded(annotation, state);
      card.classList.toggle("ab-note-collapsed", !expanded);
      card.classList.toggle("ab-note-expanded", expanded);
      card.setAttribute("aria-expanded", String(expanded));
      card.querySelector<HTMLElement>(".ab-card-summary")
        ?.setAttribute("aria-expanded", String(expanded));
    }
  }

  /** Move through the deterministic rail order and reveal the prose target. */
  private navigateAnnotation(direction: -1 | 1): void {
    const visible = this.visibleNotes();
    if (visible.length === 0) return;
    const current = visible.findIndex((annotation) => annotation.id === this.activeAnnotationId);
    const origin = current === -1 ? (direction === 1 ? -1 : visible.length) : current;
    const index = Math.min(Math.max(origin + direction, 0), visible.length - 1);
    const annotation = visible[index];
    if (annotation === undefined || index === current) return;

    this.activateAnnotation(annotation.id);
    const block = this.blockFor(annotation);
    if (annotation.target !== null) this.targetAdapter.reveal(annotation.target.blockId);
    this.cardEls.get(annotation.id)?.focus({ preventScroll: block !== null });
    this.announce(`Note ${index + 1} of ${visible.length}.`);
  }

  private updateNoteNavigation(): void {
    const visible = this.visibleNotes();
    const index = visible.findIndex((annotation) => annotation.id === this.activeAnnotationId);
    const position = index === -1 ? 0 : index + 1;
    this.railCount.textContent = `${position} / ${visible.length}`;
    this.previousNoteBtn.disabled = index <= 0;
    this.nextNoteBtn.disabled = visible.length === 0 || index >= visible.length - 1;
  }

  private renderRangeHighlights(): void {
    const annotations = this.visibleNotes()
      .filter(
        (annotation) =>
          annotation.scope === "range" &&
          annotation.target?.textPosition !== undefined &&
          annotation.target.textQuote !== undefined,
      )
      .sort(
        (a, b) =>
          (b.target?.textPosition?.start ?? 0) - (a.target?.textPosition?.start ?? 0),
      );
    if (this.targetAdapter.setHighlights !== undefined) {
      this.targetAdapter.setHighlights(annotations.flatMap((annotation) => {
        const position = annotation.target?.textPosition;
        const blockId = annotation.target?.blockId;
        return position === undefined || blockId === undefined
          ? []
          : [{
              annotationId: annotation.id,
              blockId,
              start: position.start,
              end: position.end,
              kind: annotation.kind,
              active: annotation.id === this.activeAnnotationId,
            }];
      }));
      return;
    }
    clearRangeHighlights(this.proseEl);
    for (const annotation of annotations) {
      const block = this.blockFor(annotation);
      const target = annotation.target;
      if (block === null || target?.textPosition === undefined) {
        continue;
      }
      const range = rangeForSelector(block, {
        textPosition: target.textPosition,
        ...(target.textQuote === undefined ? {} : { textQuote: target.textQuote }),
      });
      if (range === null) {
        continue;
      }
      const mark = el(
        "mark",
        `ab-inline-highlight ab-highlight-${annotation.kind}` +
          (annotation.id === this.activeAnnotationId ? " ab-highlight-active" : ""),
      );
      mark.dataset.annotationId = annotation.id;
      mark.tabIndex = 0;
      mark.setAttribute("role", "button");
      mark.setAttribute(
        "aria-label",
        `${annotation.kind === "suggestion" ? "Suggestion" : "Comment"} by ${this.authorName(annotation.authorActorId)}`,
      );
      mark.addEventListener("click", () => this.activateAnnotation(annotation.id, true));
      mark.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.activateAnnotation(annotation.id, true);
        }
      });
      const fragment = range.extractContents();
      mark.append(fragment);
      range.insertNode(mark);
    }
  }

  private authorName(actorId: string): string {
    if (this.me !== null && this.me.actor.id === actorId) {
      return this.me.actor.displayName;
    }
    const embedded = this.annotations.find(
      (annotation) => annotation.authorActorId === actorId,
    )?.author?.displayName;
    if (embedded !== undefined && embedded !== "") return embedded;
    return this.memberNames.get(actorId) ?? "member";
  }

  private formattedDate(createdAt: string): string {
    const parsed = new Date(createdAt);
    if (Number.isNaN(parsed.getTime())) {
      return createdAt;
    }
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(parsed);
  }

  private visibleNotes(): Annotation[] {
    return orderedChapterNotes(
      this.annotations.filter((annotation) => annotation.scope !== "chapter"),
      this.blocks.map((block) => block.id.slice(2)),
    );
  }

  private discussionThreads(): Annotation[] {
    return orderedChapterNotes(
      this.annotations.filter((annotation) => annotation.scope === "chapter"),
      [],
    );
  }

  private visibleDiscussionThreads(): Annotation[] {
    return this.discussionThreads().slice(0, this.discussionVisibleLimit);
  }

  private presentableAnnotations(): Annotation[] {
    return [...this.visibleNotes(), ...this.discussionThreads()];
  }

  private renderedAnnotations(): Annotation[] {
    return [...this.visibleNotes(), ...this.visibleDiscussionThreads()];
  }

  private blockFor(annotation: Annotation): HTMLElement | null {
    if (annotation.target === null) {
      return null;
    }
    return this.targetAdapter.elementFor(annotation.target.blockId);
  }

  // ---- operation polling (§2.5: bounded, then refresh hint) ----------------

  private pollOperation(
    operationId: string,
    settle: (outcome: "committed" | "failed" | "exhausted", message?: string) => void,
  ): void {
    let polls = 0;
    const step = async (): Promise<void> => {
      const operation = await this.store.getState().refreshOperation(operationId);
      polls += 1;
      if (operation !== null && (operation.state === "committed" || operation.state === "verified")) {
        settle("committed");
        return;
      }
      // Only `failed` is terminal: `conflict` is the domain's bounded-retry
      // state (conflict → queued, git-operation-state.ts) and the processor
      // may still commit - treat it like queued/preparing/committing (§2.5
      // status honesty: keep showing "syncing" until the operation settles).
      if (operation !== null && operation.state === "failed") {
        settle("failed", operation.error ?? "the change could not be committed");
        return;
      }
      if (polls >= MAX_OPERATION_POLLS) {
        settle("exhausted");
        return;
      }
      window.setTimeout(() => void step(), pollDelayMs(polls));
    };
    window.setTimeout(() => void step(), pollDelayMs(0));
  }

  private markAnnotationSyncing(annotationId: string, operationId: string): void {
    this.annotationSync.set(annotationId, { phase: "syncing" });
    this.pollOperation(operationId, (outcome, message) => {
      if (outcome === "committed") {
        this.annotationSync.delete(annotationId);
        this.announce("Annotation saved.");
        void this.refetch();
        return;
      }
      this.annotationSync.set(
        annotationId,
        outcome === "exhausted"
          ? { phase: "stale", message: REFRESH_HINT }
          : {
              phase: "failed",
              message: this.friendlySyncError(message ?? "The comment could not be saved."),
            },
      );
      this.renderAll();
    });
  }

  private async retryAnnotationSync(annotation: Annotation): Promise<void> {
    const operationId = annotation.gitOperationId;
    if (operationId === null) return;
    this.annotationSync.set(annotation.id, { phase: "syncing" });
    this.renderAll();
    const result = await this.api.retryOperation(operationId);
    if (!result.ok) {
      this.annotationSync.set(annotation.id, {
        phase: "failed",
        message: this.friendlyWriteError(result.status, result.message),
      });
      this.renderAll();
      return;
    }
    this.markAnnotationSyncing(annotation.id, operationId);
    this.announce("Retrying comment save.");
    this.renderAll();
  }

  private markReplySyncing(replyId: string, operationId: string): void {
    this.replySync.set(replyId, { phase: "syncing" });
    this.pollOperation(operationId, (outcome, message) => {
      if (outcome === "committed") {
        this.replySync.delete(replyId);
        this.announce("Reply saved.");
      } else {
        this.replySync.set(
          replyId,
          outcome === "exhausted"
            ? { phase: "stale", message: REFRESH_HINT }
            : { phase: "failed", message: message ?? "failed" },
        );
      }
      this.renderAll();
    });
  }

  private announce(message: string): void {
    this.liveRegion.textContent = message;
  }

  // ---- selection capture ---------------------------------------------------

  private readonly onSelectionChange = (): void => {
    window.clearTimeout(this.selectionTimer);
    this.selectionTimer = window.setTimeout(() => this.checkSelection(), 120);
  };

  setChapterEditMode(active: boolean): void {
    this.chapterEditModeActive = active;
    if (!this.scaffolded) return;
    this.hideSelTool();
    this.renderAll();
  }

  private checkSelection(): void {
    if (
      this.chapterEditModeActive ||
      !this.canWrite() ||
      this.composer.phase !== "closed"
    ) {
      this.hideSelTool();
      return;
    }
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
      this.hideSelTool();
      return;
    }
    const range = selection.getRangeAt(0);
    const capture = captureRange(range);
    if (capture === null || capture.selector.textQuote.exact.length < 5) {
      this.hideSelTool();
      return;
    }
    this.lastCapture = capture;
    this.lastSelectionRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    this.selTool.hidden = false;
    this.selTool.style.top = `${Math.max(8, rect.top - 8)}px`;
    this.selTool.style.left = `${Math.max(12, rect.left + rect.width / 2)}px`;
  }

  private hideSelTool(): void {
    this.selTool.hidden = true;
  }

  // ---- composer ------------------------------------------------------------

  private dispatchComposer(event: Parameters<typeof composerReduce>[1]): void {
    this.composer = composerReduce(this.composer, event);
    this.renderComposer();
  }

  private openComposer(draft: ComposerDraft, returnFocus: HTMLElement): void {
    if (this.chapterEditModeActive) return;
    if (
      (draft.kind === "comment" && !this.canComment()) ||
      (draft.kind === "suggestion" && !this.canSuggest())
    ) {
      this.promptSignIn();
      return;
    }
    this.composerReturnFocus = returnFocus;
    if (draft.scope === "range") this.latchComposerSelection();
    this.dispatchComposer({ type: "open", draft });
    this.composerEl?.querySelector("textarea")?.focus();
    this.layout();
  }

  private closeComposer(): void {
    const blockId = this.composer.draft?.blockId ?? null;
    this.clearComposerSelection();
    this.dispatchComposer({ type: "cancel" });
    this.targetAdapter.closeComposer?.();
    if (blockId !== null) this.targetAdapter.setPreview(blockId, false);
    this.layout();
    // The recorded return-focus element may be gone or hidden (the selection
    // toolbar is hidden while the composer is open): fall back to a focusable
    // affordance on the anchor block so keyboard focus never drops to <body>.
    const recorded = this.composerReturnFocus;
    const target =
      recorded !== null && recorded.isConnected && recorded.closest("[hidden]") === null
        ? recorded
        : this.blockAffordance(blockId);
    target?.focus();
    this.composerReturnFocus = null;
  }

  /** A focusable per-block affordance (annotate pencil, else count marker). */
  private blockAffordance(blockId: string | null): HTMLElement | null {
    if (blockId === null) {
      return null;
    }
    const block = this.blocks.find((candidate) => candidate.id === `b-${blockId}`);
    const ui = block === undefined ? undefined : this.blockUis.get(block);
    if (ui === undefined) {
      return null;
    }
    const annotate = ui.querySelector<HTMLElement>(".ab-annotate");
    if (annotate !== null && !annotate.hidden) {
      return annotate;
    }
    return ui.querySelector<HTMLElement>(".ab-marker");
  }

  private async submitComposer(): Promise<void> {
    const cfg = this.cfg as Config;
    this.dispatchComposer({ type: "submit" });
    if (this.composer.phase !== "submitting" || this.composer.draft === null) {
      return;
    }
    const draft = this.composer.draft;
    this.clearComposerSelection();
    const returnFocus = this.composerReturnFocus;
    // Submission owns its own immutable draft from here. Clear and remove the
    // visible form before waiting on the network so a normal POST never leaves
    // a disabled composer hanging on screen. A rejected request restores this
    // captured draft below, so immediate feedback never costs the user's text.
    this.composer = CLOSED;
    this.composerReturnFocus = null;
    this.targetAdapter.closeComposer?.();
    if (draft.blockId !== null) this.targetAdapter.setPreview(draft.blockId, false);
    this.renderComposer();
    if (draft.scope === "chapter") {
      this.discussionVisibleLimit = Math.max(
        this.discussionVisibleLimit,
        this.discussionThreads().length + 1,
      );
    }
    const focusTarget =
      returnFocus !== null && returnFocus.isConnected && returnFocus.closest("[hidden]") === null
        ? returnFocus
        : this.blockAffordance(draft.blockId);
    focusTarget?.focus();
    const command = draft.scope === "chapter"
      ? {
          kind: "comment" as const,
          scope: "chapter" as const,
          chapterRevision: cfg.chapterRevision,
          body: draft.body,
        }
      : {
          kind: draft.kind,
          scope: draft.scope,
          chapterRevision: cfg.chapterRevision,
          target: draft.scope === "range" && draft.selector !== null
            ? draft.selector
            : { blockId: draft.blockId as string },
          body: draft.body,
        };
    const result = await this.store.getState().createAnnotation(cfg.chapterId, command);
    if (!result.ok) {
      if (result.status === 409) {
        // Stale build-time revision: every retry with this page is guaranteed
        // to fail, so disable Post and say why in human terms.
        this.staleRevision = true;
        this.restoreComposerAfterFailure(draft, returnFocus, STALE_PAGE_HINT);
        return;
      }
      this.restoreComposerAfterFailure(
        draft,
        returnFocus,
        this.friendlyWriteError(result.status, result.message),
      );
      return;
    }
    if (result.value.outcome === "pending_review") {
      this.announce("Contribution submitted for maintainer review.");
      this.renderAll();
      return;
    }
    const annotationId = result.value.annotationId;
    const operationId = result.value.operationId;
    this.markAnnotationSyncing(annotationId, operationId);
    this.announce("Annotation submitted; syncing.");
    this.renderAll();
    const card = this.cardEls.get(annotationId);
    if (card !== undefined) {
      card.focus();
    }
  }

  private latchComposerSelection(): void {
    const range = this.lastSelectionRange;
    if (range === null || typeof Highlight === "undefined") return;
    CSS.highlights.set("ab-composer-selection", new Highlight(range));
  }

  private clearComposerSelection(): void {
    CSS.highlights?.delete("ab-composer-selection");
    this.lastSelectionRange = null;
  }

  private restoreComposerAfterFailure(
    draft: ComposerDraft,
    returnFocus: HTMLElement | null,
    message: string,
  ): void {
    let restored = composerReduce(CLOSED, { type: "open", draft });
    restored = composerReduce(restored, { type: "submit" });
    this.composer = composerReduce(restored, { type: "rejected", message });
    this.composerReturnFocus = returnFocus;
    this.renderComposer();
    if (!this.chapterEditModeActive) {
      this.composerEl?.querySelector("textarea")?.focus();
    }
  }

  private renderComposer(): void {
    if (this.composerEl !== null) {
      this.targetAdapter.closeComposer?.();
      this.composerEl.remove();
      this.composerEl = null;
    }
    const state = this.composer;
    if (
      this.chapterEditModeActive ||
      state.phase === "closed" ||
      state.phase === "synced" ||
      state.draft === null
    ) {
      this.layout();
      return;
    }
    const draft = state.draft;
    const form = el("form", "ab-composer ab-card-shell");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submitComposer();
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.closeComposer();
      }
    });

    const legendText = draft.scope === "chapter"
      ? "Start a chapter discussion"
      : draft.scope === "range"
        ? "Note on this passage"
        : "Note on this block";
    form.append(el("p", "ab-composer-title", legendText));

    if (draft.selector !== null) {
      const quote = el("blockquote", "ab-quote", truncate(draft.selector.textQuote.exact, 120));
      form.append(quote);
    }

    if (draft.scope !== "chapter") {
      const kinds = el("fieldset", "ab-kinds");
      kinds.append(el("legend", "ab-sr", "Annotation kind"));
      for (const [kind, label, allowed] of [
        ["comment", "Comment", this.canComment()],
        ["suggestion", "Suggest an edit", this.canSuggest()],
      ] as const) {
        if (!allowed) continue;
        const wrap = el("label", "ab-kind");
        const radio = el("input");
        radio.type = "radio";
        radio.name = "ab-kind";
        radio.value = kind;
        radio.checked = draft.kind === kind;
        radio.addEventListener("change", () => {
          this.dispatchComposer({ type: "set-kind", kind: kind as ComposerKind });
        });
        wrap.append(radio, document.createTextNode(` ${label}`));
        kinds.append(wrap);
      }
      form.append(kinds);
    }

    const bodyLabel = el("label", "ab-field");
    const labelText =
      draft.scope === "chapter"
        ? "What do you want to discuss?"
        : draft.kind === "suggestion"
          ? "Suggested replacement"
          : "What do you want to add?";
    bodyLabel.append(el("span", "ab-field-label", labelText));
    const textarea = el("textarea", "ab-textarea");
    textarea.rows = 4;
    textarea.required = true;
    textarea.value = draft.body;
    textarea.addEventListener("input", () => {
      this.composer = composerReduce(this.composer, { type: "set-body", body: textarea.value });
    });
    bodyLabel.append(textarea);
    form.append(bodyLabel);

    if (state.error !== null) {
      const error = el("p", "ab-error", state.error);
      error.setAttribute("role", "alert");
      form.append(error);
    }
    if (state.phase === "syncing" || state.phase === "stale") {
      form.append(
        el(
          "p",
          "ab-status",
          state.phase === "syncing" ? "Syncing…" : REFRESH_HINT,
        ),
      );
    }

    const actions = el("div", "ab-actions");
    const submit = el("button", "ab-btn ab-primary", "Post");
    submit.type = "submit";
    // staleRevision: the page can never learn the new projected revision, so
    // retrying is pointless until the site is republished and reloaded.
    const hasCapability = draft.kind === "comment" ? this.canComment() : this.canSuggest();
    submit.disabled = state.phase !== "editing" || this.staleRevision || !hasCapability;
    const cancel = el("button", "ab-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.closeComposer());
    actions.append(submit, cancel);
    form.append(actions);

    this.composerEl = form;
    if (draft.scope === "chapter") {
      this.discussionComposerHost.replaceChildren(form);
    } else if (
      draft.scope === "range" &&
      draft.selector !== null &&
      this.targetAdapter.mountComposer?.(
        draft.blockId as string,
        draft.selector.textPosition.start,
        draft.selector.textPosition.end,
        form,
      ) === true
    ) {
      // The Milkdown tooltip owns placement beside the selected passage.
    } else if (this.isDesktop && this.notesPanelVisible) {
      this.cardsHost.prepend(form);
    } else if (this.isDesktop) {
      const trigger = this.blockAffordance(draft.blockId);
      const popover =
        draft.blockId === null || trigger === null
          ? null
          : this.hiddenPopover(draft.blockId, trigger);
      if (popover !== null) {
        popover.append(form);
      } else {
        this.targetAdapter.mountInlineNote(draft.blockId, form);
      }
    } else {
      // Keep the composer immediately beside its manuscript target, ahead of
      // existing cards. If it follows an auto-expanding card, scrolling to the
      // submit controls can alternately expand and collapse that card as the
      // target crosses the viewport edge, making the form jump out of reach.
      this.targetAdapter.mountInlineNote(draft.blockId, form);
    }
    this.layout();
  }

  // ---- cards ---------------------------------------------------------------

  private renderAll(): void {
    const restore = this.captureFocus();
    this.clearGutterAutoUpdates();
    if (this.isDesktop && this.notesPanelVisible) {
      this.cardsHost.dataset.layoutReady = "false";
    }
    if (!this.notesPanelVisible) this.closeHiddenNotesPopover();
    // Notes and replies hydrate independently of the session. Keep live auth
    // controls mounted across those updates so a field cannot be detached
    // between a user's keystroke and its input event. A true session change
    // still replaces the controls immediately (for example, after login).
    if (
      this.renderedAuthSession === undefined ||
      !sameSession(this.renderedAuthSession, this.me)
    ) {
      this.renderAuthbar();
      this.renderedAuthSession = this.me;
    }
    this.cardEls.clear();
    this.voteControls.clear();
    this.overrideControls.clear();
    this.cardsHost.textContent = "";
    this.targetAdapter.clearInlineNotes();
    for (const annotation of this.visibleNotes()) {
      const card = this.buildCard(annotation);
      this.cardEls.set(annotation.id, card);
      if (this.isDesktop && this.notesPanelVisible) {
        this.cardsHost.append(card);
      } else if (!this.isDesktop) {
        this.targetAdapter.mountInlineNote(annotation.target?.blockId ?? null, card);
      }
    }
    this.renderDiscussion();
    this.renderRangeHighlights();
    if (this.loadError !== null) {
      const error = el("p", "ab-error", `Annotations unavailable: ${this.loadError}`);
      if (this.isDesktop) {
        this.cardsHost.append(error);
      } else {
        this.targetAdapter.mountInlineNote(null, error);
      }
    }
    // Write affordances are gated (§2.2): pencils stay for signed-out
    // visitors (they lead to sign-in) but disappear for signed-in read-only
    // roles, whose Post could only ever fail.
    const showPencils = !this.chapterEditModeActive && (this.me === null || this.canWrite());
    const commentSelection = this.selTool.querySelector<HTMLButtonElement>(".ab-select-comment");
    const suggestionSelection = this.selTool.querySelector<HTMLButtonElement>(".ab-select-suggestion");
    if (commentSelection !== null) commentSelection.hidden = !this.canComment();
    if (suggestionSelection !== null) suggestionSelection.hidden = !this.canSuggest();
    for (const [, ui] of this.blockUis) {
      const annotate = ui.querySelector<HTMLButtonElement>(".ab-annotate");
      if (annotate !== null) {
        annotate.hidden = !showPencils;
      }
    }
    for (const [block, ui] of this.blockUis) {
      const count = this.visibleNotes().filter(
        (annotation) => annotation.target?.blockId === block.id.slice(2),
      ).length;
      ui.querySelector(".ab-marker")?.remove();
      if (count > 0) {
        block.classList.add("ab-annotated");
        const marker = el("button", "ab-marker");
        marker.type = "button";
        if (this.isDesktop && !this.notesPanelVisible) {
          marker.classList.add("ab-marker-icon");
          marker.append(
            inlineIcon("note"),
            srOnly(`${count} annotation${count === 1 ? "" : "s"} on this block; show`),
          );
          marker.title = `${count} note${count === 1 ? "" : "s"}`;
        } else {
          marker.append(
            el("span", "ab-marker-count", String(count)),
            srOnly(`${count} annotation${count === 1 ? "" : "s"} on this block; show`),
          );
        }
        marker.addEventListener("click", () => {
          if (this.isDesktop && !this.notesPanelVisible) {
            this.showHiddenNotes(block.id.slice(2), marker);
            return;
          }
          const first = this.visibleNotes().find(
            (annotation) => annotation.target?.blockId === block.id.slice(2),
          );
          if (first === undefined) {
            return;
          }
          this.activateAnnotation(first.id);
          const card = this.cardEls.get(first.id);
          card?.scrollIntoView({ block: "nearest" });
          card?.focus();
        });
        ui.append(marker);
      } else {
        block.classList.remove("ab-annotated");
      }
    }
    if (this.composer.phase !== "closed") {
      this.renderComposer();
    }
    this.refreshCardExpansion();
    this.updateNoteNavigation();
    this.syncGutterAutoUpdates();
    this.layout();
    this.restoreFocus(restore);
    this.activateNoteFragment();
  }

  /** Resolve a Work-history source-note link after its API-backed card mounts. */
  private activateNoteFragment(): void {
    const hash = window.location.hash;
    if (hash === "" || hash === this.activatedNoteFragment) return;
    const encoded = hash.slice(1);
    if (!encoded.startsWith(NOTE_FRAGMENT_PREFIX)) return;
    let annotationId: string;
    try {
      annotationId = decodeURIComponent(encoded.slice(NOTE_FRAGMENT_PREFIX.length));
    } catch {
      return;
    }
    if (annotationId.length === 0 || !this.cardEls.has(annotationId)) return;
    this.activatedNoteFragment = hash;
    this.activateAnnotation(annotationId);
  }

  private renderDiscussion(): void {
    this.discussionThreadsHost.replaceChildren();
    const all = this.discussionThreads();
    const visible = this.visibleDiscussionThreads();
    for (const annotation of visible) {
      const card = this.buildCard(annotation, "discussion");
      this.cardEls.set(annotation.id, card);
      this.discussionThreadsHost.append(card);
    }
    this.discussionEmpty.hidden = all.length > 0 || this.loadError !== null;
    this.discussionMore.hidden = visible.length >= all.length;
    this.discussionMore.textContent = all.length - visible.length === 1
      ? "Load 1 more discussion"
      : `Load ${all.length - visible.length} more discussions`;
    // Signed-out readers get a useful sign-in affordance. Once authenticated,
    // the button reflects the exact comment-write capability projection.
    this.discussionStart.hidden =
      this.chapterEditModeActive || (this.me !== null && !this.canComment());
  }

  /**
   * §4 focus management across full re-renders: renderAll() rebuilds every
   * card, which would otherwise drop keyboard/screen-reader focus to <body>
   * whenever an unrelated background sync settles.
   */
  private captureFocus(): FocusRestore | null {
    const active = document.activeElement as HTMLElement | null;
    if (
      active === null ||
      ![...this.cardEls.values()].some((card) => card === active || card.contains(active))
    ) {
      return null; // focus is elsewhere (composer, prose, …): leave it alone
    }
    for (const [id, card] of this.cardEls) {
      if (card === active || card.contains(active)) {
        const voteButton = active.closest<HTMLElement>(".ab-vote-btn");
        const overrideButton = active.closest<HTMLElement>("[data-override]");
        const kind =
          active.classList.contains("ab-override-reason")
            ? "override-reason"
            : overrideButton !== null
              ? "override-action"
              : active.tagName === "TEXTAREA"
                ? "textarea"
                : active.classList.contains("ab-danger")
                  ? "danger"
                  : voteButton !== null
                    ? "vote"
                    : "card";
        const index = this.renderedAnnotations().findIndex(
          (annotation) => annotation.id === id,
        );
        const restore: FocusRestore = { cardId: id, index, kind };
        if (voteButton !== null && voteButton.dataset.vote !== undefined) {
          restore.voteValue = voteButton.dataset.vote;
        }
        if (overrideButton !== null && overrideButton.dataset.override !== undefined) {
          restore.overrideAction = overrideButton.dataset.override;
        }
        return restore;
      }
    }
    return null;
  }

  private restoreFocus(restore: FocusRestore | null): void {
    if (restore === null) {
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected && active !== document.documentElement) {
      return; // something else (e.g. the composer) already took focus
    }
    const card = this.cardEls.get(restore.cardId);
    if (card !== undefined) {
      // A focused vote segment must keep focus on the same segment across a
      // live re-render (contract §6 keyboard-complete voting).
      if (restore.kind === "vote" && restore.voteValue !== undefined) {
        const segment = card.querySelector<HTMLButtonElement>(
          `.ab-vote-btn[data-vote="${restore.voteValue}"]`,
        );
        if (segment !== null) {
          segment.focus();
          return;
        }
      }
      // An override reason is a textarea too, but a distinct one: match it
      // before the generic textarea branch so focus never lands in the reply
      // box instead (and the typed reason is restored with it).
      if (restore.kind === "override-reason") {
        const reason = card.querySelector<HTMLTextAreaElement>(".ab-override-reason");
        if (reason !== null) {
          reason.focus();
          const end = reason.value.length;
          reason.setSelectionRange(end, end);
          return;
        }
      }
      if (restore.kind === "override-action" && restore.overrideAction !== undefined) {
        const button = card.querySelector<HTMLButtonElement>(
          `[data-override="${restore.overrideAction}"]`,
        );
        if (button !== null) {
          button.focus();
          return;
        }
      }
      if (restore.kind === "textarea") {
        const textarea = card.querySelector("textarea");
        if (textarea !== null) {
          textarea.focus();
          const end = textarea.value.length;
          textarea.setSelectionRange(end, end);
          return;
        }
      }
      if (restore.kind === "danger") {
        const danger = card.querySelector<HTMLButtonElement>(".ab-danger");
        if (danger !== null) {
          danger.focus();
          return;
        }
      }
      card.focus();
      return;
    }
    // The card is gone (e.g. withdrawn): focus a sensible successor.
    const visible = this.renderedAnnotations();
    const successor =
      visible[Math.min(Math.max(restore.index, 0), visible.length - 1)];
    const successorCard = successor === undefined ? undefined : this.cardEls.get(successor.id);
    if (successorCard !== undefined) {
      successorCard.focus();
      return;
    }
    const fallback =
      document.querySelector<HTMLElement>("authorbot-account .ab-account-signin, authorbot-account .ab-account-identity") ??
      this.authbar;
    fallback.focus();
  }

  private statusLabel(annotation: Annotation): { label: string; hint: string | null } {
    const sync = this.annotationSync.get(annotation.id);
    if (sync !== undefined) {
      if (sync.phase === "failed") {
        return { label: "failed", hint: sync.message ?? null };
      }
      return { label: "syncing", hint: sync.phase === "stale" ? REFRESH_HINT : null };
    }
    if (annotation.status === "pending_git") {
      return { label: "syncing", hint: null };
    }
    return { label: annotation.status, hint: null };
  }

  private buildCard(
    annotation: Annotation,
    surface: "note" | "discussion" = "note",
  ): HTMLElement {
    const status = this.statusLabel(annotation);
    const promoted = annotation.status === "work_item_created";
    const author = this.authorName(annotation.authorActorId);
    const quote = annotation.target?.textQuote?.exact;
    const card = el("section", "ab-card ab-card-shell");
    card.id = `${NOTE_FRAGMENT_PREFIX}${annotation.id}`;
    card.tabIndex = -1;
    card.dataset.annotationId = annotation.id;
    card.dataset.surface = surface;
    card.classList.toggle("ab-discussion-thread", surface === "discussion");
    card.classList.toggle("ab-active", annotation.id === this.activeAnnotationId);
    card.classList.toggle("ab-promoted", promoted);
    const labelParts = [
      annotation.kind === "suggestion" ? "Suggestion" : "Comment",
      `by ${author}`,
      quote !== undefined
        ? `on “${truncate(quote, 60)}”`
        : annotation.target !== null
          ? "on this block" // block-scoped: a concrete anchor, not the chapter
          : "on this chapter",
      `(${promoted ? "Accepted" : status.label})`,
    ];
    card.setAttribute("aria-label", labelParts.join(" "));
    const compactBody = truncate(
      annotation.body.replace(/\s+/g, " ").trim(),
      110,
    );
    const summary = el("button", "ab-card-summary");
    summary.type = "button";
    summary.setAttribute(
      "aria-label",
      `${annotation.kind === "suggestion" ? "Suggestion" : "Comment"} from ${author}: ${compactBody}`,
    );
    summary.setAttribute("aria-expanded", "false");
    summary.append(
      el("span", "ab-card-summary-author", author),
      el("span", "ab-card-summary-body", compactBody),
    );
    summary.addEventListener("click", (event) => {
      event.stopPropagation();
      this.activateAnnotation(annotation.id);
      if (annotation.target !== null) this.targetAdapter.reveal(annotation.target.blockId);
      card.focus({ preventScroll: true });
    });
    card.append(summary);

    const block = this.blockFor(annotation);
    if (block !== null) {
      card.addEventListener("focusin", () => {
        block.classList.add("ab-target");
      });
      card.addEventListener("focusout", (event) => {
        if (!card.contains(event.relatedTarget as Node | null)) {
          block.classList.remove("ab-target");
        }
      });
      card.addEventListener("mouseenter", () => block.classList.add("ab-target"));
      card.addEventListener("mouseleave", () => {
        if (!card.contains(document.activeElement)) {
          block.classList.remove("ab-target");
        }
      });
    }

    const header = el("header", "ab-card-head");
    header.append(
      el("span", `ab-chip ab-kind-${annotation.kind}`, annotation.kind),
      el("span", "ab-author", author),
      el("time", "ab-card-date", this.formattedDate(annotation.createdAt)),
    );
    let collapse: HTMLButtonElement | null = null;
    if (annotation.target !== null) {
      header.classList.add("ab-card-head-collapsible");
      header.title = "Collapse note";
      collapse = iconButton(
        "ab-note-collapse",
        "Collapse note",
        "chevron-up",
      );
      collapse.addEventListener("click", (event) => {
        event.stopPropagation();
        this.collapseAnnotation(annotation.id);
      });
      header.addEventListener("click", (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button, a, input, textarea, select") !== null
        ) {
          return;
        }
        if (globalThis.getSelection?.()?.isCollapsed === false) return;
        event.stopPropagation();
        this.collapseAnnotation(annotation.id);
      });
    }
    if (promoted) {
      header.append(el("span", "ab-chip ab-accepted-badge", "Accepted"));
    } else {
      header.append(el("span", `ab-chip ab-status-${status.label} ab-card-status`, status.label));
    }
    if (collapse !== null) header.append(collapse);
    card.append(header);

    card.addEventListener("click", (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("button, a, input, textarea, select") !== null
      ) {
        return;
      }
      this.activateAnnotation(annotation.id);
      if (annotation.target !== null) this.targetAdapter.reveal(annotation.target.blockId);
    });
    card.addEventListener("keydown", (event) => {
      if (event.target === card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        this.activateAnnotation(annotation.id);
        if (annotation.target !== null) this.targetAdapter.reveal(annotation.target.blockId);
      }
    });

    if (quote !== undefined && !(promoted && annotation.kind === "suggestion")) {
      card.append(el("blockquote", "ab-quote", truncate(quote, 120)));
    }
    if (!(promoted && annotation.kind === "suggestion" && quote !== undefined)) {
      card.append(el("p", "ab-body", annotation.body));
    }
    if (annotation.kind === "suggestion" && quote !== undefined) {
      const diff = el("div", "ab-suggestion-diff");
      diff.setAttribute("aria-label", "Suggested edit");
      diff.append(
        el("del", "ab-diff-original", truncate(quote, 160)),
        el("ins", "ab-diff-replacement", annotation.body),
      );
      card.append(diff);
    }
    if (status.hint !== null) {
      card.append(el("p", "ab-hint", status.hint));
    }
    if (
      status.label === "failed" &&
      annotation.gitOperationId !== null &&
      isMaintainer(this.me)
    ) {
      const retry = el("button", "ab-btn ab-btn-small", "Retry save");
      retry.type = "button";
      retry.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.retryAnnotationSync(annotation);
      });
      card.append(retry);
    }

    // Promotion settles the feedback card. Keep only the accepted badge and
    // its compact diff/note context; governance and conversation controls
    // belong to the generated Work item now.
    if (promoted) {
      return card;
    }

    // Chapter-wide comments on this surface are already approved annotations.
    // Approval-gated submissions live in the separate moderation queue until
    // accepted, so approve/reject/abstain here would misleadingly suggest a
    // second approval round. Passage notes and suggestions keep governance
    // voting exactly as before.
    if (!(surface === "discussion" && annotation.kind === "comment")) {
      const control = new VoteControl({
        canVote: this.canVoteOn(annotation),
        signedIn: this.me !== null,
        onVote: (value) => void this.castVoteOn(annotation.id, value),
        onSignIn: () => this.promptSignIn(),
      });
      control.update(annotation);
      this.voteControls.set(annotation.id, control);
      card.append(control.root);
    }

    // Phase 11: a maintainer can promote either an open comment or suggestion
    // in one click. Suggestion rejection remains a separate scoped action.
    const canPromote = this.canPromoteToWork();
    const canReject = annotation.kind === "suggestion" && this.canRejectSuggestion();
    if (
      (canPromote || canReject) &&
      canOverride(annotation) &&
      !this.annotationSync.has(annotation.id)
    ) {
      const draft = this.overrideDrafts.get(annotation.id) ?? { action: null, reason: "" };
      const override = new OverrideControl({
        draft,
        canPromote,
        canReject,
        compactPromotion: surface === "discussion",
        onDraftChange: (next) => this.overrideDrafts.set(annotation.id, next),
        onSubmit: (action, reason) => this.runOverride(annotation.id, action, reason),
      });
      override.update(annotation);
      this.overrideControls.set(annotation.id, override);
      card.append(override.root);
    }

    const replies = this.repliesByAnnotation.get(annotation.id) ?? [];
    if (replies.length > 0) {
      card.append(this.buildReplyTree(annotation, replies, null, surface === "discussion"));
    }

    const actions = el("div", "ab-actions");
    if (
      !this.chapterEditModeActive &&
      this.canReplyTo(annotation) &&
      status.label !== "failed"
    ) {
      const reply = el("button", "ab-btn", "Reply");
      reply.type = "button";
      reply.addEventListener("click", () => {
        if (this.chapterEditModeActive) return;
        this.openReplyFor = this.openReplyFor === annotation.id ? null : annotation.id;
        this.replyParent = null;
        this.replyDraft = ""; // a fresh form starts empty
        this.replyError = null;
        this.renderAll();
        this.cardEls.get(annotation.id)?.querySelector("textarea")?.focus();
      });
      actions.append(reply);
    }
    if (
      this.canWithdraw(annotation) &&
      annotation.status === "open" &&
      !this.annotationSync.has(annotation.id)
    ) {
      const withdrawing = this.confirmWithdraw === annotation.id;
      const withdraw = withdrawing
        ? el("button", "ab-btn ab-danger", "Confirm withdraw")
        : iconButton(
            "ab-btn ab-icon-btn ab-danger ab-withdraw-icon",
            "Withdraw",
            "trash",
          );
      withdraw.type = "button";
      withdraw.addEventListener("click", () => {
        if (!withdrawing) {
          this.confirmWithdraw = annotation.id;
          this.renderAll();
          this.cardEls.get(annotation.id)?.querySelector<HTMLButtonElement>(".ab-danger")?.focus();
          return;
        }
        this.confirmWithdraw = null;
        void this.withdraw(annotation);
      });
      actions.append(withdraw);
      if (withdrawing) {
        const keep = el("button", "ab-btn", "Keep");
        keep.type = "button";
        keep.addEventListener("click", () => {
          this.confirmWithdraw = null;
          this.renderAll();
          this.cardEls.get(annotation.id)?.focus();
        });
        actions.append(keep);
      }
    }
    if (actions.childElementCount > 0) {
      card.append(actions);
    }

    if (
      !this.chapterEditModeActive &&
      this.openReplyFor === annotation.id &&
      this.canReplyTo(annotation)
    ) {
      card.append(this.buildReplyForm(annotation));
    }
    return card;
  }

  private buildReplyTree(
    annotation: Annotation,
    replies: Reply[],
    parentId: string | null,
    allowPromotion: boolean,
  ): HTMLElement {
    const list = el("ul", "ab-replies");
    for (const reply of replies.filter((entry) => entry.parentReplyId === parentId)) {
      const item = el("li", "ab-reply");
      item.dataset.replyId = reply.id;
      item.tabIndex = -1;
      const head = el("div", "ab-reply-head");
      head.append(
        el("span", "ab-author", this.authorName(reply.authorActorId)),
        el("time", "ab-reply-date", this.formattedDate(reply.createdAt)),
      );
      const sync = this.replySync.get(reply.id);
      if (sync !== undefined || reply.status === "pending_git") {
        head.append(
          el("span", "ab-chip ab-status-syncing", sync?.phase === "failed" ? "failed" : "syncing"),
        );
      }
      item.append(
        head,
        reply.status === "withdrawn"
          ? el("p", "ab-hint ab-reply-withdrawn", "Reply withdrawn.")
          : el("p", "ab-body", reply.body),
      );
      if (sync?.message !== undefined) {
        item.append(el("p", "ab-hint", sync.message));
      }
      const actions = el("div", "ab-actions ab-reply-actions");
      if (allowPromotion && reply.workPromotionPending === true) {
        actions.append(
          el("span", "ab-chip ab-status-ready", "queueing as work"),
        );
      } else if (allowPromotion && reply.workItemId != null) {
        actions.append(
          el("span", "ab-chip ab-status-ready", "queued as work"),
        );
      } else if (
        allowPromotion &&
        reply.status === "open" &&
        sync === undefined &&
        this.canPromoteToWork()
      ) {
        const promote = iconButton(
          "ab-btn ab-btn-small ab-icon-btn ab-outline-action",
          "Promote reply to work",
          "check",
        );
        promote.dataset.replyPromote = reply.id;
        promote.addEventListener("click", () => void this.promoteReply(annotation, reply));
        actions.append(promote);
      }
      if (
        !this.chapterEditModeActive &&
        reply.status !== "withdrawn" &&
        this.canReplyTo(annotation)
      ) {
        const replyBtn = el("button", "ab-btn ab-btn-small", "Reply");
        replyBtn.type = "button";
        replyBtn.addEventListener("click", () => {
          if (this.chapterEditModeActive) return;
          this.openReplyFor = annotation.id;
          this.replyParent = reply.id;
          this.replyDraft = "";
          this.replyError = null;
          this.renderAll();
          this.cardEls.get(annotation.id)?.querySelector("textarea")?.focus();
        });
        actions.append(replyBtn);
      }
      if (
        reply.status === "open" &&
        (sync === undefined || sync.phase === "failed") &&
        this.canWithdrawReply(reply)
      ) {
        const confirming = this.confirmWithdrawReply === reply.id;
        const withdraw = confirming
          ? el("button", "ab-btn ab-btn-small ab-danger", "Confirm withdraw reply")
          : iconButton(
              "ab-btn ab-btn-small ab-icon-btn ab-danger ab-withdraw-icon",
              "Withdraw reply",
              "trash",
            );
        withdraw.type = "button";
        withdraw.dataset.replyWithdraw = reply.id;
        withdraw.addEventListener("click", () => {
          if (!confirming) {
            this.confirmWithdrawReply = reply.id;
            this.renderAll();
            this.cardEls
              .get(annotation.id)
              ?.querySelector<HTMLButtonElement>(`[data-reply-withdraw="${reply.id}"]`)
              ?.focus();
            return;
          }
          // Close the confirmation before awaiting the network. The store
          // removes the body optimistically and restores it on rejection.
          this.confirmWithdrawReply = null;
          this.replySync.delete(reply.id);
          this.renderAll();
          void this.withdrawReply(annotation, reply);
        });
        actions.append(withdraw);
        if (confirming) {
          const keep = el("button", "ab-btn ab-btn-small", "Keep reply");
          keep.type = "button";
          keep.addEventListener("click", () => {
            this.confirmWithdrawReply = null;
            this.renderAll();
            this.cardEls.get(annotation.id)?.querySelector<HTMLElement>(
              `[data-reply-id="${reply.id}"]`,
            )?.focus();
          });
          actions.append(keep);
        }
      }
      if (actions.childElementCount > 0) {
        item.append(actions);
      }
      const children = this.buildReplyTree(annotation, replies, reply.id, allowPromotion);
      if (children.childElementCount > 0) {
        item.append(children);
      }
      list.append(item);
    }
    return list;
  }

  private buildReplyForm(annotation: Annotation): HTMLFormElement {
    const form = el("form", "ab-reply-form");
    const label = el("label", "ab-field");
    label.append(
      el("span", "ab-field-label", this.replyParent === null ? "Reply" : "Reply in thread"),
    );
    const textarea = el("textarea", "ab-textarea");
    textarea.rows = 3;
    textarea.required = true;
    const errorLine = el("p", "ab-error");
    errorLine.setAttribute("role", "alert");
    errorLine.textContent = this.replyError ?? "";
    errorLine.hidden = this.replyError === null;
    // The draft survives re-renders: an unrelated background sync settling
    // must never wipe a half-typed reply (§4 / data-loss).
    textarea.value = this.replyDraft;
    textarea.addEventListener("input", () => {
      this.replyDraft = textarea.value;
      this.replyError = null;
      errorLine.textContent = "";
      errorLine.hidden = true;
    });
    label.append(textarea);
    const actions = el("div", "ab-actions");
    const post = el("button", "ab-btn ab-primary", "Post reply");
    post.type = "submit";
    const cancel = el("button", "ab-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      this.openReplyFor = null;
      this.replyParent = null;
      this.replyDraft = "";
      this.replyError = null;
      this.renderAll();
      this.cardEls.get(annotation.id)?.focus();
    });
    actions.append(post, cancel);
    form.append(label, errorLine, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        const body = textarea.value;
        if (body.trim() === "") {
          errorLine.textContent = "Write something first.";
          errorLine.hidden = false;
          return;
        }
        const parent = this.replyParent ?? undefined;
        // As with the annotation composer, close and clear before awaiting the
        // request. Keep local copies so a rejected POST can restore the exact
        // reply and thread target.
        this.openReplyFor = null;
        this.replyParent = null;
        this.replyDraft = "";
        this.replyError = null;
        this.renderAll();
        this.cardEls.get(annotation.id)?.focus();
        const result = await this.store.getState().createReply(annotation.id, body, parent);
        if (!result.ok) {
          this.openReplyFor = annotation.id;
          this.replyParent = parent ?? null;
          this.replyDraft = body;
          this.replyError = this.friendlyWriteError(result.status, result.message);
          this.renderAll();
          if (!this.chapterEditModeActive) {
            this.cardEls.get(annotation.id)?.querySelector("textarea")?.focus();
          }
          return;
        }
        const replyId = result.value.replyId;
        this.markReplySyncing(replyId, result.value.operationId);
        this.announce("Reply submitted; syncing.");
        this.renderAll();
        this.cardEls.get(annotation.id)?.focus();
      })();
    });
    return form;
  }

  private async withdraw(annotation: Annotation): Promise<void> {
    const result = await this.store.getState().withdrawAnnotation(annotation.id);
    if (!result.ok) {
      this.annotationSync.set(annotation.id, {
        phase: "failed",
        message: this.friendlyWriteError(result.status, result.message),
      });
      this.renderAll();
      return;
    }
    this.annotationSync.set(annotation.id, { phase: "syncing" });
    this.announce("Withdrawing annotation.");
    this.pollOperation(result.value.operationId, (outcome, message) => {
      if (outcome === "committed") {
        this.annotationSync.delete(annotation.id);
        this.announce("Annotation withdrawn.");
        void this.refetch();
        return;
      }
      this.annotationSync.set(
        annotation.id,
        outcome === "exhausted"
          ? { phase: "stale", message: REFRESH_HINT }
          : { phase: "failed", message: message ?? "withdraw failed" },
      );
      this.renderAll();
    });
    this.renderAll();
  }

  private async withdrawReply(annotation: Annotation, reply: Reply): Promise<void> {
    const result = await this.store.getState().withdrawReply(annotation.id, reply.id);
    if (!result.ok) {
      this.replySync.set(reply.id, {
        phase: "failed",
        message: this.friendlyWriteError(result.status, result.message),
      });
      this.announce("Reply withdrawal failed. The reply was restored.");
      this.renderAll();
      return;
    }
    this.replySync.set(reply.id, { phase: "syncing" });
    this.announce("Withdrawing reply.");
    this.pollOperation(result.value.operationId, (outcome, message) => {
      if (outcome === "committed") {
        this.replySync.delete(reply.id);
        this.announce("Reply withdrawn.");
        void this.refetch();
        return;
      }
      this.replySync.set(
        reply.id,
        outcome === "exhausted"
          ? { phase: "stale", message: REFRESH_HINT }
          : { phase: "failed", message: message ?? "withdraw failed" },
      );
      this.renderAll();
    });
    this.renderAll();
  }

  // ---- auth bar ------------------------------------------------------------

  private renderAuthbar(): void {
    const cfg = this.cfg as Config;
    this.authbar.textContent = "";
    this.authbar.hidden = false;
    if (this.me !== null) {
      if (!this.canWrite()) {
        this.authbar.append(el("p", "ab-hint", "Your role is read-only here."));
      } else {
        // Identity already lives in the shared account control. An empty Notes
        // auth bar is removed from layout rather than repeating it here.
        this.authbar.hidden = true;
      }
      return;
    }
    if (cfg.devLogin) {
      const form = el("form", "ab-devlogin");
      const loginLabel = el("label", "ab-field");
      loginLabel.append(el("span", "ab-field-label", "Dev login"));
      const login = el("input", "ab-input");
      login.type = "text";
      login.name = "login";
      login.required = true;
      login.autocomplete = "username";
      login.value = this.devLoginDraft;
      login.addEventListener("input", () => {
        this.devLoginDraft = login.value;
      });
      loginLabel.append(login);
      const roleLabel = el("label", "ab-field");
      roleLabel.append(el("span", "ab-field-label", "Role"));
      const role = el("select", "ab-input");
      for (const value of ["reader", "contributor", "editor", "maintainer"]) {
        const option = el("option", undefined, value);
        option.value = value;
        if (value === this.devLoginRole) {
          option.selected = true;
        }
        role.append(option);
      }
      role.addEventListener("change", () => {
        this.devLoginRole = role.value;
      });
      roleLabel.append(role);
      const submit = el("button", "ab-btn ab-primary", "Sign in (dev)");
      submit.type = "submit";
      const errorLine = el("p", "ab-error");
      errorLine.setAttribute("role", "alert");
      errorLine.hidden = true;
      form.append(loginLabel, roleLabel, submit, errorLine);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        void (async () => {
          const generation = this.mountGeneration;
          const store = this.store;
          if (!this.isCurrentMount(generation)) return;
          this.devLoginDraft = login.value;
          this.devLoginRole = role.value;
          submit.disabled = true;
          const result = await this.api.devLogin(login.value, role.value);
          if (!this.isCurrentMount(generation)) return;
          submit.disabled = false;
          if (!result.ok) {
            errorLine.textContent = result.message;
            errorLine.hidden = false;
            return;
          }
          this.devLoginDraft = "";
          await store.getState().refreshSession(true);
          if (!this.isCurrentMount(generation)) return;
          await this.start(generation, store);
        })();
      });
      this.authbar.append(form);
      return;
    }
    const signIn = el("a", "ab-signin", "Sign in with GitHub to annotate");
    signIn.href = this.api.signInUrl(window.location.href);
    this.authbar.append(signIn);
  }

  // ---- layout --------------------------------------------------------------

  private clearGutterAutoUpdates(): void {
    for (const cleanup of this.gutterAutoUpdateCleanups) cleanup();
    this.gutterAutoUpdateCleanups = [];
  }

  private readonly scheduleLayout = (): void => {
    if (this.layoutFrame !== undefined) return;
    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      if (this.started && this.isConnected) this.layout();
    });
  };

  private syncGutterAutoUpdates(): void {
    if (!this.isDesktop || !this.notesPanelVisible) return;
    for (const annotation of this.visibleNotes()) {
      const anchor = this.blockFor(annotation);
      const card = this.cardEls.get(annotation.id);
      if (anchor === null || card === undefined || !card.isConnected) continue;
      this.gutterAutoUpdateCleanups.push(
        autoUpdate(anchor, card, this.scheduleLayout, {
          ancestorScroll: true,
          ancestorResize: true,
          elementResize: true,
          layoutShift: true,
        }),
      );
    }
    if (
      this.composerEl !== null &&
      this.composer.draft?.scope !== "chapter" &&
      this.composer.draft?.blockId !== null
    ) {
      const anchor = this.blocks.find(
        (candidate) => candidate.id === `b-${this.composer.draft?.blockId}`,
      );
      if (anchor !== undefined && this.composerEl.isConnected) {
        this.gutterAutoUpdateCleanups.push(
          autoUpdate(anchor, this.composerEl, this.scheduleLayout),
        );
      }
    }
  }

  private layout(): void {
    const generation = ++this.layoutGeneration;
    const proseRect = this.proseEl.getBoundingClientRect();
    for (const [block, ui] of this.blockUis) {
      ui.style.top = `${block.getBoundingClientRect().top - proseRect.top}px`;
    }
    if (!this.isDesktop || !this.notesPanelVisible) {
      this.cardsHost.style.height = "";
      this.cardsHost.dataset.layoutReady = "true";
      for (const card of this.cardEls.values()) {
        card.style.top = "";
      }
      if (this.composerEl !== null) {
        this.composerEl.style.top = "";
      }
      return;
    }
    void this.layoutGutterCards(generation);
  }

  private async layoutGutterCards(generation: number): Promise<void> {
    const anchored: Array<{
      id: string;
      anchor: HTMLElement | null;
      target: HTMLElement;
    }> = [];
    for (const annotation of this.visibleNotes()) {
      const card = this.cardEls.get(annotation.id);
      if (card === undefined) continue;
      anchored.push({
        id: annotation.id,
        anchor: this.blockFor(annotation),
        target: card,
      });
    }
    if (
      this.composerEl !== null &&
      this.composer.draft !== null &&
      this.composer.draft.scope !== "chapter"
    ) {
      const block =
        this.blocks.find((candidate) => candidate.id === `b-${this.composer.draft?.blockId}`) ??
        null;
      anchored.push({
        id: "\0composer",
        anchor: block,
        target: this.composerEl,
      });
    }
    const hostTop = this.cardsHost.getBoundingClientRect().top;
    const measured = await Promise.all(
      anchored.map(async ({ id, anchor, target }): Promise<StackItem> => {
        if (anchor === null) {
          return { id, desiredTop: 0, height: target.offsetHeight };
        }
        try {
          const position = await computePosition(anchor, target, {
            placement: "right-start",
            strategy: "absolute",
          });
          return {
            id,
            desiredTop: Math.max(0, position.y),
            height: target.offsetHeight,
          };
        } catch {
          return {
            id,
            desiredTop: Math.max(0, anchor.getBoundingClientRect().top - hostTop),
            height: target.offsetHeight,
          };
        }
      }),
    );
    if (
      generation !== this.layoutGeneration ||
      !this.isDesktop ||
      !this.notesPanelVisible
    ) {
      return;
    }
    const items: StackItem[] = measured;
    const assigned = stackCards(items, CARD_GAP);
    let bottom = 0;
    for (const [id, top] of assigned) {
      const target = id === "\0composer" ? this.composerEl : this.cardEls.get(id);
      if (target === null || target === undefined) {
        continue;
      }
      target.style.top = `${top}px`;
      bottom = Math.max(bottom, top + target.offsetHeight);
    }
    this.cardsHost.style.height = `${bottom}px`;
    this.cardsHost.dataset.layoutReady = "true";
  }
}
