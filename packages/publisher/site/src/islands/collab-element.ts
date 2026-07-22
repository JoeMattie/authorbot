/**
 * `<authorbot-collab>` - the collaboration island root (Phase 2b contract
 * §1-§2, §4). Framework-free custom element: reads its configuration from
 * data attributes stamped at build time, talks to the Phase 2 API with
 * credentialed fetch, and renders the annotation gutter (desktop) / bottom
 * drawer (mobile), selection capture, composer, replies, and withdraw.
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
  CollabApi,
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
import type { ProjectStore } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

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
      left.gitOperationId === right.gitOperationId &&
      left.createdAt === right.createdAt &&
      left.updatedAt === right.updatedAt);
}

function sameSession(left: Me | null, right: Me | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const leftRoles = left.memberships?.map(({ role }) => role) ?? [];
  const rightRoles = right.memberships?.map(({ role }) => role) ?? [];
  return left.actor.id === right.actor.id &&
    left.actor.displayName === right.actor.displayName &&
    left.actor.externalIdentity === right.actor.externalIdentity &&
    left.scopes.length === right.scopes.length &&
    left.scopes.every((scope, index) => scope === right.scopes[index]) &&
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
  private gutter!: HTMLElement;
  private railHeader!: HTMLElement;
  private railCount!: HTMLElement;
  private previousNoteBtn!: HTMLButtonElement;
  private nextNoteBtn!: HTMLButtonElement;
  private drawer!: HTMLElement;
  private drawerPanel!: HTMLElement;
  private drawerToggle!: HTMLButtonElement;
  private drawerOpen = false;
  private authbar!: HTMLElement;
  private cardsHost!: HTMLElement;
  private liveRegion!: HTMLElement;
  private selTool!: HTMLElement;
  private cardEls = new Map<string, HTMLElement>();
  private voteControls = new Map<string, VoteControl>();
  private overrideControls = new Map<string, OverrideControl>();
  /** Open override form + typed reason per suggestion (survives re-renders). */
  private overrideDrafts = new Map<string, OverrideDraft>();
  private refetchTimer: number | undefined;

  private composer: ComposerState = CLOSED;
  private composerEl: HTMLFormElement | null = null;
  private composerReturnFocus: HTMLElement | null = null;
  private openReplyFor: string | null = null;
  private replyParent: string | null = null;
  private confirmWithdraw: string | null = null;
  private lastCapture: CapturedSelection | null = null;
  private activeAnnotationId: string | null = null;

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
    this.started = false;
    this.mountGeneration += 1;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.releaseConnection?.();
    this.releaseConnection = null;
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
    if (!this.scaffolded) {
      return;
    }
    this.disconnectGlobalListeners();
  }

  private isCurrentMount(generation: number): boolean {
    return this.started && this.isConnected && this.mountGeneration === generation;
  }

  // ---- scaffold -----------------------------------------------------------

  private buildScaffold(): void {
    this.mainEl.classList.add("ab-enabled");
    this.proseEl.classList.add("ab-prose");
    const readingLayout = this.closest<HTMLElement>(".chapter-reading-layout") ?? this.mainEl;
    readingLayout.classList.add("ab-reading-layout");

    this.liveRegion = el("div", "ab-sr");
    this.liveRegion.setAttribute("role", "status");
    this.liveRegion.setAttribute("aria-live", "polite");
    this.append(this.liveRegion);

    this.authbar = el("div", "ab-authbar");
    this.authbar.tabIndex = -1; // focus fallback target (never in tab order)
    this.cardsHost = el("div", "ab-cards");

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

    this.drawer = el("div", "ab-drawer");
    this.drawerToggle = el("button", "ab-drawer-toggle");
    this.drawerToggle.type = "button";
    this.drawerToggle.setAttribute("aria-expanded", "false");
    this.drawerToggle.setAttribute("aria-controls", "ab-drawer-panel");
    this.drawerToggle.addEventListener("click", () => {
      this.drawerOpen = !this.drawerOpen;
      this.updateDrawer();
    });
    this.drawerPanel = el("div", "ab-drawer-panel");
    this.drawerPanel.id = "ab-drawer-panel";
    this.drawerPanel.hidden = true;
    this.drawer.append(this.drawerToggle, this.drawerPanel);
    document.body.append(this.drawer);

    const discussion = el("section", "ab-discussion-boundary");
    discussion.setAttribute("aria-labelledby", "ab-discussion-title");
    const discussionTitle = el("h2", undefined, "Discussion");
    discussionTitle.id = "ab-discussion-title";
    discussion.append(
      discussionTitle,
      el(
        "p",
        "ab-discussion-copy",
        "Chapter-wide threads are not available yet. For a line-level note, select a passage above.",
      ),
      el("span", "ab-chip ab-status-pending", "API planned"),
    );
    if (readingLayout === this.mainEl) {
      this.mainEl.append(discussion);
    } else {
      readingLayout.insertAdjacentElement("afterend", discussion);
    }

    this.selTool = el("div", "ab-seltool");
    this.selTool.dataset.abUi = "true";
    this.selTool.hidden = true;
    const commentBtn = el("button", "ab-btn", "Comment");
    commentBtn.type = "button";
    const suggestBtn = el("button", "ab-btn", "Suggest an edit");
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
      annotate.append(glyph, srOnly("Annotate this block"));
      annotate.addEventListener("focus", () => {
        window.requestAnimationFrame(() => {
          annotate.scrollIntoView({ block: "center", inline: "nearest" });
        });
      });
      annotate.addEventListener("click", () => {
        if (!this.canWrite()) {
          // Signed-out: the affordance leads to sign-in, never a dead end.
          this.promptSignIn();
          return;
        }
        this.openComposer(
          {
            kind: "comment",
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
      const highlight = (on: boolean): void => this.setBlockHighlight(block, on);
      block.addEventListener("mouseenter", () => highlight(true));
      block.addEventListener("mouseleave", () => highlight(false));
      block.addEventListener("focusin", () => highlight(true));
      block.addEventListener("focusout", (event) => {
        if (!block.contains(event.relatedTarget as Node | null)) {
          highlight(false);
        }
      });
    }

    this.mql = window.matchMedia(DESKTOP_QUERY);
    this.placeContainers();
    this.connectGlobalListeners();
  }

  private connectGlobalListeners(): void {
    if (this.globalListenersConnected) return;
    this.globalListenersConnected = true;
    this.mql.addEventListener("change", this.onMediaChange);
    document.addEventListener("selectionchange", this.onSelectionChange);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("load", this.onWindowLoad);
  }

  private disconnectGlobalListeners(): void {
    if (!this.globalListenersConnected) return;
    this.globalListenersConnected = false;
    this.mql.removeEventListener("change", this.onMediaChange);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("load", this.onWindowLoad);
  }

  private readonly onWindowLoad = (): void => this.layout();

  private readonly onMediaChange = (): void => {
    this.placeContainers();
    this.layout();
  };

  private readonly onResize = (): void => {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.layout(), 100);
  };

  private get isDesktop(): boolean {
    return this.mql.matches;
  }

  private placeContainers(): void {
    if (this.isDesktop) {
      this.gutter.append(this.railHeader, this.authbar, this.cardsHost);
      this.gutter.hidden = false;
      this.drawer.hidden = true;
    } else {
      this.drawerPanel.append(this.railHeader, this.authbar, this.cardsHost);
      this.gutter.hidden = true;
      this.drawer.hidden = false;
      this.updateDrawer();
    }
  }

  private updateDrawer(): void {
    const count = this.visibleAnnotations().length;
    this.drawerToggle.textContent = `Notes on this chapter (${count})`;
    this.drawerToggle.setAttribute("aria-expanded", String(this.drawerOpen));
    this.drawerPanel.hidden = !this.drawerOpen;
    this.updateNoteNavigation();
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
    if (this.me !== null) {
      const expectedSession = this.me;
      const memberNames = await this.api.memberNames();
      if (
        !this.isCurrentMount(generation) ||
        !sameSession(expectedSession, store.getState().session)
      ) {
        return;
      }
      this.memberNames = memberNames;
    }
    if (this.me !== null || cfg.showPublic) {
      if (!(await this.loadAnnotations(generation, store, cfg))) return;
    }
    if (!this.isCurrentMount(generation)) return;
    this.renderAll();
    if (this.me !== null || cfg.showPublic) {
      if (!this.isCurrentMount(generation)) return;
      this.releaseConnection ??= store.getState().retainConnection();
    }
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
      this.activeAnnotationId = this.visibleAnnotations()[0]?.id ?? null;
    }
    if (!(await this.loadReplies(generation, store))) return false;
    // Cards for server-side pending records show "syncing" and poll (§2.5).
    for (const annotation of this.annotations) {
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

  private async loadReplies(
    generation = this.mountGeneration,
    store = this.store,
  ): Promise<boolean> {
    // Attempted whenever annotations loaded (signed-in, or the anonymous
    // public read): a 401/403 simply yields no fetched replies.
    if (!this.repliesSupported) {
      return true;
    }
    for (const annotation of this.annotations) {
      await store.getState().ensureReplies(annotation.id);
      if (!this.isCurrentMount(generation)) return false;
      const state = store.getState();
      if (state.replyStatusByAnnotation[annotation.id] !== "ready") {
        const status = state.replyErrorStatusByAnnotation[annotation.id];
        if (status === 404 || status === 405) {
          this.repliesSupported = false;
        }
        return true;
      }
      this.repliesByAnnotation.set(
        annotation.id,
        (state.replyIdsByAnnotation[annotation.id] ?? []).flatMap(
          (id) => state.repliesById[id] ?? [],
        ),
      );
    }
    return true;
  }

  private async refetch(): Promise<void> {
    const generation = this.mountGeneration;
    const store = this.store;
    if (!(await this.loadAnnotations(generation, store))) return;
    if (!this.isCurrentMount(generation)) return;
    this.renderAll();
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

  /** Cast (`value`) or clear (`null`) the viewer's vote on a suggestion. */
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

  private scheduleRefetch(): void {
    window.clearTimeout(this.refetchTimer);
    this.refetchTimer = window.setTimeout(() => void this.refetch(), 400);
  }

  private canWrite(): boolean {
    return this.me !== null && this.me.scopes.includes("annotations:write");
  }

  /** Phase 3 contract §2/§6: vote controls are enabled only with this scope. */
  private canVote(): boolean {
    return this.me !== null && this.me.scopes.includes("votes:write");
  }

  private canPromoteToWork(): boolean {
    return isMaintainer(this.me) && this.me !== null && this.me.scopes.includes("work:claim");
  }

  private canRejectSuggestion(): boolean {
    return isMaintainer(this.me) && this.me !== null && this.me.scopes.includes("annotations:write");
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

  /** Signed-out annotate attempt: lead to the sign-in affordance (§16.6). */
  private promptSignIn(): void {
    if (!this.isDesktop) {
      this.drawerOpen = true;
      this.updateDrawer();
    }
    this.announce("Sign in to annotate.");
    const target =
      this.authbar.querySelector<HTMLElement>(".ab-signin") ??
      this.authbar.querySelector<HTMLElement>(".ab-devlogin input") ??
      this.authbar;
    target.focus();
  }

  /** §2.1: highlight every card anchored to `block` (and the block itself). */
  private setBlockHighlight(block: HTMLElement, on: boolean): void {
    const blockId = block.id.slice(2);
    for (const annotation of this.visibleAnnotations()) {
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
    this.activeAnnotationId = annotationId;
    for (const [id, card] of this.cardEls) {
      card.classList.toggle("ab-active", id === annotationId);
    }
    for (const mark of this.proseEl.querySelectorAll<HTMLElement>(".ab-inline-highlight")) {
      mark.classList.toggle("ab-highlight-active", mark.dataset.annotationId === annotationId);
    }
    const card = this.cardEls.get(annotationId);
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (moveFocus) {
      card?.focus();
    }
    this.updateNoteNavigation();
    this.layout();
  }

  /** Move through the deterministic rail order and reveal the prose target. */
  private navigateAnnotation(direction: -1 | 1): void {
    const visible = this.visibleAnnotations();
    if (visible.length === 0) return;
    const current = visible.findIndex((annotation) => annotation.id === this.activeAnnotationId);
    const origin = current === -1 ? (direction === 1 ? -1 : visible.length) : current;
    const index = Math.min(Math.max(origin + direction, 0), visible.length - 1);
    const annotation = visible[index];
    if (annotation === undefined || index === current) return;

    if (!this.isDesktop) {
      this.drawerOpen = true;
      this.updateDrawer();
    }
    this.activateAnnotation(annotation.id);
    const block = this.blockFor(annotation);
    block?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    this.cardEls.get(annotation.id)?.focus({ preventScroll: block !== null });
    this.announce(`Note ${index + 1} of ${visible.length}.`);
  }

  private updateNoteNavigation(): void {
    const visible = this.visibleAnnotations();
    const index = visible.findIndex((annotation) => annotation.id === this.activeAnnotationId);
    const position = index === -1 ? 0 : index + 1;
    this.railCount.textContent = `${position} / ${visible.length}`;
    this.previousNoteBtn.disabled = index <= 0;
    this.nextNoteBtn.disabled = visible.length === 0 || index >= visible.length - 1;
  }

  private renderRangeHighlights(): void {
    clearRangeHighlights(this.proseEl);
    const annotations = this.visibleAnnotations()
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

  private visibleAnnotations(): Annotation[] {
    const order = new Map(this.blocks.map((block, index) => [block.id.slice(2), index]));
    return this.annotations
      .filter((annotation) => {
        // `work_item_created` stays visible as the compact accepted diff/note.
        if (
          annotation.status !== "open" &&
          annotation.status !== "pending_git" &&
          annotation.status !== "work_item_created"
        ) {
          return false;
        }
        // Orphaned targets (block gone from this build) belong to a repair
        // queue, not beside random prose (design §16.2).
        if (annotation.target !== null && !order.has(annotation.target.blockId)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const blockA = a.target === null ? -1 : (order.get(a.target.blockId) ?? -1);
        const blockB = b.target === null ? -1 : (order.get(b.target.blockId) ?? -1);
        return blockA - blockB || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      });
  }

  private blockFor(annotation: Annotation): HTMLElement | null {
    if (annotation.target === null) {
      return null;
    }
    return this.blocks.find((block) => block.id === `b-${annotation.target?.blockId}`) ?? null;
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
          : { phase: "failed", message: message ?? "failed" },
      );
      this.renderAll();
    });
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

  private checkSelection(): void {
    if (!this.canWrite() || this.composer.phase !== "closed") {
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
    this.composerReturnFocus = returnFocus;
    this.dispatchComposer({ type: "open", draft });
    if (!this.isDesktop) {
      this.drawerOpen = true;
      this.updateDrawer();
    }
    this.composerEl?.querySelector("textarea")?.focus();
    this.layout();
  }

  private closeComposer(): void {
    const blockId = this.composer.draft?.blockId ?? null;
    this.dispatchComposer({ type: "cancel" });
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
    const returnFocus = this.composerReturnFocus;
    // Submission owns its own immutable draft from here. Clear and remove the
    // visible form before waiting on the network so a normal POST never leaves
    // a disabled composer hanging on screen. A rejected request restores this
    // captured draft below, so immediate feedback never costs the user's text.
    this.composer = CLOSED;
    this.composerReturnFocus = null;
    this.renderComposer();
    const focusTarget =
      returnFocus !== null && returnFocus.isConnected && returnFocus.closest("[hidden]") === null
        ? returnFocus
        : this.blockAffordance(draft.blockId);
    focusTarget?.focus();
    const result = await this.store.getState().createAnnotation(cfg.chapterId, {
      kind: draft.kind,
      scope: draft.scope,
      chapterRevision: cfg.chapterRevision,
      target: draft.scope === "range" && draft.selector !== null
        ? draft.selector
        : { blockId: draft.blockId },
      body: draft.body,
    });
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
    this.composerEl?.querySelector("textarea")?.focus();
  }

  private renderComposer(): void {
    if (this.composerEl !== null) {
      this.composerEl.remove();
      this.composerEl = null;
    }
    const state = this.composer;
    if (state.phase === "closed" || state.phase === "synced" || state.draft === null) {
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

    const legendText = draft.scope === "range" ? "Note on this passage" : "Note on this block";
    form.append(el("p", "ab-composer-title", legendText));

    if (draft.selector !== null) {
      const quote = el("blockquote", "ab-quote", truncate(draft.selector.textQuote.exact, 120));
      form.append(quote);
    }

    const kinds = el("fieldset", "ab-kinds");
    kinds.append(el("legend", "ab-sr", "Annotation kind"));
    for (const [kind, label] of [
      ["comment", "Comment"],
      ["suggestion", "Suggest an edit"],
    ] as const) {
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

    const bodyLabel = el("label", "ab-field");
    const labelText =
      draft.kind === "suggestion" ? "Suggested replacement" : "What do you want to add?";
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
    submit.disabled = state.phase !== "editing" || this.staleRevision;
    const cancel = el("button", "ab-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.closeComposer());
    actions.append(submit, cancel);
    form.append(actions);

    this.composerEl = form;
    this.cardsHost.prepend(form);
    this.layout();
  }

  // ---- cards ---------------------------------------------------------------

  private renderAll(): void {
    const restore = this.captureFocus();
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
    for (const annotation of this.visibleAnnotations()) {
      const card = this.buildCard(annotation);
      this.cardEls.set(annotation.id, card);
      this.cardsHost.append(card);
    }
    this.renderRangeHighlights();
    if (this.loadError !== null) {
      this.cardsHost.append(el("p", "ab-error", `Annotations unavailable: ${this.loadError}`));
    }
    // Write affordances are gated (§2.2): pencils stay for signed-out
    // visitors (they lead to sign-in) but disappear for signed-in read-only
    // roles, whose Post could only ever fail.
    const showPencils = this.me === null || this.canWrite();
    for (const [, ui] of this.blockUis) {
      const annotate = ui.querySelector<HTMLButtonElement>(".ab-annotate");
      if (annotate !== null) {
        annotate.hidden = !showPencils;
      }
    }
    for (const [block, ui] of this.blockUis) {
      const count = this.visibleAnnotations().filter(
        (annotation) => annotation.target?.blockId === block.id.slice(2),
      ).length;
      ui.querySelector(".ab-marker")?.remove();
      if (count > 0) {
        block.classList.add("ab-annotated");
        const marker = el("button", "ab-marker");
        marker.type = "button";
        marker.append(
          el("span", "ab-marker-count", String(count)),
          srOnly(`${count} annotation${count === 1 ? "" : "s"} on this block; show`),
        );
        marker.addEventListener("click", () => {
          const first = this.visibleAnnotations().find(
            (annotation) => annotation.target?.blockId === block.id.slice(2),
          );
          if (first === undefined) {
            return;
          }
          if (!this.isDesktop) {
            this.drawerOpen = true;
            this.updateDrawer();
          }
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
    this.updateDrawer();
    this.layout();
    this.restoreFocus(restore);
  }

  /**
   * §4 focus management across full re-renders: renderAll() rebuilds every
   * card, which would otherwise drop keyboard/screen-reader focus to <body>
   * whenever an unrelated background sync settles.
   */
  private captureFocus(): FocusRestore | null {
    const active = document.activeElement as HTMLElement | null;
    if (active === null || !this.cardsHost.contains(active)) {
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
        const index = this.visibleAnnotations().findIndex(
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
    const visible = this.visibleAnnotations();
    const successor =
      visible[Math.min(Math.max(restore.index, 0), visible.length - 1)];
    const successorCard = successor === undefined ? undefined : this.cardEls.get(successor.id);
    if (successorCard !== undefined) {
      successorCard.focus();
      return;
    }
    (this.isDesktop ? this.authbar : this.drawerToggle).focus();
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

  private buildCard(annotation: Annotation): HTMLElement {
    const status = this.statusLabel(annotation);
    const promoted = annotation.status === "work_item_created";
    const author = this.authorName(annotation.authorActorId);
    const quote = annotation.target?.textQuote?.exact;
    const card = el("section", "ab-card ab-card-shell");
    card.tabIndex = -1;
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

    const block = this.blockFor(annotation);
    if (block !== null) {
      card.addEventListener("focusin", () => {
        block.classList.add("ab-target");
        // Do not expand synchronously during pointer focus: moving controls
        // under the pointer between mousedown and mouseup can activate a vote
        // instead of the collapsed card the reader chose.
        if (!card.classList.contains("ab-active")) {
          window.requestAnimationFrame(() => this.activateAnnotation(annotation.id));
        }
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
    if (promoted) {
      header.append(el("span", "ab-chip ab-accepted-badge", "Accepted"));
    } else {
      header.append(el("span", `ab-chip ab-status-${status.label} ab-card-status`, status.label));
    }
    card.append(header);

    card.addEventListener("click", (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("button, a, input, textarea, select") !== null
      ) {
        return;
      }
      this.activateAnnotation(annotation.id);
      block?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
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

    // Promotion settles the feedback card. Keep only the accepted badge and
    // its compact diff/note context; governance and conversation controls
    // belong to the generated Work item now.
    if (promoted) {
      return card;
    }

    // Suggestions carry the vote control + live tally + decision badge
    // (Phase 3 contract §6). Comments never do.
    if (annotation.kind === "suggestion") {
      const control = new VoteControl({
        canVote: this.canVote(),
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
        onDraftChange: (next) => this.overrideDrafts.set(annotation.id, next),
        onSubmit: (action, reason) => this.runOverride(annotation.id, action, reason),
      });
      override.update(annotation);
      this.overrideControls.set(annotation.id, override);
      card.append(override.root);
    }

    const replies = this.repliesByAnnotation.get(annotation.id) ?? [];
    if (replies.length > 0) {
      card.append(this.buildReplyTree(annotation, replies, null));
    }

    const actions = el("div", "ab-actions");
    if (this.canWrite() && status.label !== "failed") {
      const reply = el("button", "ab-btn", "Reply");
      reply.type = "button";
      reply.addEventListener("click", () => {
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
      this.canWrite() &&
      this.me !== null &&
      this.me.actor.id === annotation.authorActorId &&
      annotation.status === "open" &&
      !this.annotationSync.has(annotation.id)
    ) {
      const withdrawing = this.confirmWithdraw === annotation.id;
      const withdraw = el("button", "ab-btn ab-danger", withdrawing ? "Confirm withdraw" : "Withdraw");
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

    if (this.openReplyFor === annotation.id && this.canWrite()) {
      card.append(this.buildReplyForm(annotation));
    }
    return card;
  }

  private buildReplyTree(
    annotation: Annotation,
    replies: Reply[],
    parentId: string | null,
  ): HTMLElement {
    const list = el("ul", "ab-replies");
    for (const reply of replies.filter((entry) => entry.parentReplyId === parentId)) {
      const item = el("li", "ab-reply");
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
      item.append(head, el("p", "ab-body", reply.body));
      if (sync?.message !== undefined) {
        item.append(el("p", "ab-hint", sync.message));
      }
      if (this.canWrite()) {
        const replyBtn = el("button", "ab-btn ab-btn-small", "Reply");
        replyBtn.type = "button";
        replyBtn.addEventListener("click", () => {
          this.openReplyFor = annotation.id;
          this.replyParent = reply.id;
          this.replyDraft = "";
          this.replyError = null;
          this.renderAll();
          this.cardEls.get(annotation.id)?.querySelector("textarea")?.focus();
        });
        item.append(replyBtn);
      }
      const children = this.buildReplyTree(annotation, replies, reply.id);
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
          this.cardEls.get(annotation.id)?.querySelector("textarea")?.focus();
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

  // ---- auth bar ------------------------------------------------------------

  private renderAuthbar(): void {
    const cfg = this.cfg as Config;
    this.authbar.textContent = "";
    if (this.me !== null) {
      this.authbar.append(el("p", "ab-me", `Signed in as ${this.me.actor.displayName}`));
      if (!this.canWrite()) {
        this.authbar.append(el("p", "ab-hint", "Your role is read-only here."));
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

  private layout(): void {
    const proseRect = this.proseEl.getBoundingClientRect();
    for (const [block, ui] of this.blockUis) {
      ui.style.top = `${block.getBoundingClientRect().top - proseRect.top}px`;
    }
    if (!this.isDesktop) {
      for (const card of this.cardEls.values()) {
        card.style.top = "";
      }
      if (this.composerEl !== null) {
        this.composerEl.style.top = "";
      }
      return;
    }
    const hostTop = this.cardsHost.getBoundingClientRect().top;
    const items: StackItem[] = [];
    const blockTop = (block: HTMLElement | null): number =>
      block === null ? 0 : Math.max(0, block.getBoundingClientRect().top - hostTop);
    for (const annotation of this.visibleAnnotations()) {
      const card = this.cardEls.get(annotation.id);
      if (card === undefined) {
        continue;
      }
      items.push({
        id: annotation.id,
        desiredTop: blockTop(this.blockFor(annotation)),
        height: card.offsetHeight,
      });
    }
    if (this.composerEl !== null && this.composer.draft !== null) {
      const block =
        this.blocks.find((candidate) => candidate.id === `b-${this.composer.draft?.blockId}`) ??
        null;
      items.push({
        id: "\0composer",
        desiredTop: blockTop(block),
        height: this.composerEl.offsetHeight,
      });
    }
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
  }
}
