/**
 * `<authorbot-work-queue>` - the `/work/` island. Phase 3 shipped the
 * read-only queue of **ready** work items; Phase 4 (contract §7) adds the
 * claim-and-edit flow on top: a Claim button for actors holding `work:claim`,
 * the §15.3 task bundle rendered as an edit view (`work-claim.ts`), a live
 * lease countdown with renewal prompt and release, and the honest
 * `submit → syncing → completed | conflict` ladder.
 *
 * Progressive enhancement (§2b §1): the page ships a static fallback inside
 * the mount; this element replaces it only after the API answers. With JS off,
 * or the API unreachable, the fallback message stays and nothing errors.
 *
 * Security: every API string reaches the DOM through `textContent`; the only
 * markup is the chapter link, whose href comes from the build-time chapter map
 * (trusted), never from API data. The lease token is never rendered.
 */
import {
  hasEffectiveCapability,
  type CompletedWorkItem,
  type Me,
  type WorkItem,
} from "./api.js";
import { chapterHistoryHash } from "../lib/chapter-history-link.js";
import { el, srOnly } from "./dom.js";
import { tallyOrEmpty, tallySummary } from "./vote-view.js";
import { ClaimPanel, typeLabel, workTypeIcon, type ChapterRef } from "./work-claim.js";
import {
  clearClaim,
  leaseStatus,
  loadClaim,
  prefillFor,
  saveClaim,
  toStoredClaim,
  type StoredClaim,
} from "./work-state.js";
import {
  type ProjectStore,
  type SafeTaskBundle,
} from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

interface WorkConfig {
  apiBase: string;
  project: string;
  chapters: Map<string, ChapterRef>;
}

function parseConfig(host: HTMLElement): WorkConfig | null {
  const { apiBase, project } = host.dataset;
  if (apiBase === undefined || project === undefined) {
    return null;
  }
  const chapters = new Map<string, ChapterRef>();
  try {
    const raw = JSON.parse(host.dataset.chapters ?? "{}") as Record<string, ChapterRef>;
    for (const [id, ref] of Object.entries(raw)) {
      if (typeof ref?.title === "string" && typeof ref?.href === "string") {
        chapters.set(id, ref);
      }
    }
  } catch {
    // malformed map: fall back to bare chapter ids
  }
  return { apiBase, project, chapters };
}

/** sessionStorage, or null where it is unavailable (privacy modes, SSR). */
function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export class AuthorbotWorkQueue extends HTMLElement {
  private store!: ProjectStore;
  private cfg!: WorkConfig;
  private started = false;
  private mountGeneration = 0;
  private list!: HTMLElement;
  private status!: HTMLElement;
  private live!: HTMLElement;
  private moreWrap!: HTMLElement;
  private completedList!: HTMLElement;
  private completedStatus!: HTMLElement;
  private completedMoreWrap!: HTMLElement;
  private panel: ClaimPanel | null = null;
  private cursor: string | null = null;
  private count = 0;
  private me: Me | null = null;
  private unsubscribe: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private scaffolded = false;
  private claimErrors = new Map<string, string>();
  private recoveryError: string | null = null;
  private renderedQueueProjection: string | null = null;
  private renderedCompletedProjection: string | null = null;

  /** Injected by tests; `Date.now` in the browser. */
  now: () => number = () => Date.now();

  connectedCallback(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const generation = ++this.mountGeneration;
    const cfg = parseConfig(this);
    if (cfg === null) {
      return; // misconfigured build: leave the static fallback in place
    }
    this.cfg = cfg;
    void this.connectStore(cfg, generation);
  }

  private async connectStore(cfg: WorkConfig, generation: number): Promise<void> {
    let store: ProjectStore;
    try {
      store = await loadProjectStore(cfg);
    } catch {
      // The queue's server-rendered explanation remains usable when the
      // shared state chunk cannot be loaded after its bounded retry.
      return;
    }
    if (!this.isCurrentMount(generation)) return;
    this.store = store;
    await this.start(generation, store);
  }

  disconnectedCallback(): void {
    this.started = false;
    this.mountGeneration += 1;
    this.panel?.destroy();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.releaseConnection?.();
    this.releaseConnection = null;
  }

  private isCurrentMount(generation: number): boolean {
    return this.started && this.isConnected && this.mountGeneration === generation;
  }

  private async start(generation: number, store: ProjectStore): Promise<void> {
    await store.getState().ensureSession();
    if (!this.isCurrentMount(generation)) return;
    const state = store.getState();
    if (state.sessionStatus !== "ready") {
      // Unreachable API: leave the static fallback (progressive enhancement).
      return;
    }
    this.me = state.session;
    this.scaffold(generation, store);
    // A claim survives a refresh (contract §7 / Phase 2b draft preservation).
    const stored = loadClaim(sessionStorageOrNull(), this.cfg.project);
    if (stored !== null) {
      if (leaseStatus(stored.lease, this.now()).expired) {
        clearClaim(sessionStorageOrNull(), this.cfg.project);
        this.announce("Your lease expired while you were away; the work item is back in the queue.");
      } else {
        await this.recoverStoredClaim(stored, generation, store);
        if (!this.isCurrentMount(generation)) return;
      }
    }
    await this.load(true, generation, store);
    if (!this.isCurrentMount(generation)) return;
    await store.getState().ensureCompletedWorkItems();
    if (!this.isCurrentMount(generation)) return;
    this.renderCompletedFromStore();
    this.unsubscribe = store.subscribe(() => {
      this.syncFromStore(generation, store);
    });
    if (!this.isCurrentMount(generation)) {
      this.unsubscribe();
      this.unsubscribe = null;
      return;
    }
    this.releaseConnection = store.getState().retainConnection();
  }

  /** Drop stale private rows and rebuild affordances when the viewer changes. */
  private syncFromStore(generation: number, store: ProjectStore): void {
    if (!this.isCurrentMount(generation) || !this.scaffolded) return;
    const state = store.getState();
    if (state.sessionStatus === "error") {
      this.me = null;
      this.clearQueue("Work queue unavailable. Sign in again to continue.");
      this.clearCompleted("Completed work unavailable. Sign in again to continue.");
      return;
    }
    if (state.sessionStatus !== "ready") return;
    this.me = state.session;
    if (state.workItemsStatus === "idle") {
      this.clearQueue("Loading work…");
      void state.ensureWorkItems();
    } else if (state.workItemsStatus === "ready") {
      this.renderQueueFromStore();
    } else if (state.workItemsStatus === "error") {
      this.clearQueue(
        state.session === null
          ? "Sign in with an editor (or higher) role to view work."
          : hasEffectiveCapability(state.session, "work:read", "work:read")
            ? `Work queue unavailable: ${state.workItemsError ?? "request failed"}`
            : "Your role cannot view the work queue.",
      );
    }
    if (state.completedWorkItemsStatus === "idle") {
      this.clearCompleted("Loading completed work…");
      void state.ensureCompletedWorkItems();
    } else {
      this.renderCompletedFromStore();
    }
  }

  private clearQueue(message: string): void {
    const projection = `clear:${message}`;
    if (this.renderedQueueProjection === projection) return;
    this.renderedQueueProjection = projection;
    this.list.textContent = "";
    this.count = 0;
    this.cursor = null;
    this.moreWrap.hidden = true;
    this.syncGlobalCount();
    this.status.hidden = false;
    this.status.textContent = message;
  }

  private clearCompleted(message: string): void {
    const projection = `clear:${message}`;
    if (this.renderedCompletedProjection === projection) return;
    this.renderedCompletedProjection = projection;
    this.completedList.textContent = "";
    this.completedMoreWrap.hidden = true;
    this.completedStatus.hidden = false;
    this.completedStatus.textContent = message;
  }

  private canClaim(): boolean {
    return hasEffectiveCapability(this.me, "work:claim", "work:claim");
  }

  private async recoverStoredClaim(
    stored: StoredClaim,
    generation: number,
    store: ProjectStore,
  ): Promise<void> {
    if (!this.isCurrentMount(generation)) return;
    const bundle: SafeTaskBundle = {
      workItem: stored.workItem,
      lease: stored.lease,
      document: stored.document,
      ...(stored.target === null ? {} : { target: stored.target }),
      context: stored.context,
      submissionSchema: stored.submissionSchema,
    };
    this.announce("Recovering your claimed work and draft.");
    const recovered = await store.getState().recoverClaim(bundle);
    if (!this.isCurrentMount(generation)) return;
    if (!recovered.ok) {
      this.showRecoveryFailure(stored, recovered.message, generation, store);
      return;
    }
    this.recoveryError = null;
    const claim: StoredClaim = {
      ...stored,
      lease: recovered.value.lease,
    };
    saveClaim(sessionStorageOrNull(), this.cfg.project, claim);
    this.openPanel(claim, true);
    if (store.getState().workItemsStatus === "ready") this.renderQueueFromStore();
    this.announce("Claim restored. Your lease token was rotated safely.");
  }

  private showRecoveryFailure(
    stored: StoredClaim,
    message: string,
    generation: number,
    store: ProjectStore,
  ): void {
    this.recoveryError =
      `Your saved draft is still here, but its lease could not be recovered: ${message}`;
    this.status.hidden = false;
    this.status.textContent = "";
    this.status.append(document.createTextNode(this.recoveryError));

    const retry = el("button", "ab-btn", "Retry recovery");
    retry.type = "button";
    retry.addEventListener("click", () => {
      retry.disabled = true;
      void this.recoverStoredClaim(stored, generation, store).finally(() => {
        if (this.isCurrentMount(generation)) retry.disabled = false;
      });
    });
    const forget = el("button", "ab-btn", "Discard saved draft and forget claim");
    forget.type = "button";
    forget.addEventListener("click", () => {
      if (!this.isCurrentMount(generation)) return;
      clearClaim(sessionStorageOrNull(), this.cfg.project);
      store.getState().forgetClaim(stored.workItemId);
      this.recoveryError = null;
      this.announce("Saved draft and stale claim removed.");
      this.renderQueueFromStore();
    });
    this.status.append(document.createTextNode(" "), retry, document.createTextNode(" "), forget);
  }

  /**
   * Whether this tab already holds a live claim. Read from storage (not just
   * panel visibility) so it stays correct across a refresh, and treated as
   * inactive once the lease has expired - the server has already returned
   * that item to the queue.
   */
  private hasActiveClaim(): boolean {
    const stored = loadClaim(sessionStorageOrNull(), this.cfg.project);
    return stored !== null && !leaseStatus(stored.lease, this.now()).expired;
  }

  private async load(
    first: boolean,
    generation = this.mountGeneration,
    store = this.store,
  ): Promise<void> {
    if (!this.isCurrentMount(generation)) return;
    if (first) {
      await store.getState().refreshWorkItems();
    } else {
      await store.getState().ensureWorkItems();
    }
    if (!this.isCurrentMount(generation)) return;
    const state = store.getState();
    if (state.workItemsStatus !== "ready") {
      if (state.workItemsStatus === "loading") {
        return;
      }
      this.status.hidden = false;
      this.status.textContent =
        `Work queue unavailable: ${state.workItemsError ?? "request failed"}`;
      this.moreWrap.hidden = true;
      return;
    }
    this.renderQueueFromStore();
  }

  private renderQueueFromStore(): void {
    const state = this.store.getState();
    const projection = JSON.stringify([
      state.session?.actor.id ?? null,
      [...(state.session?.scopes ?? [])].sort(),
      this.recoveryError,
      this.hasActiveClaim(),
      state.workItemIds.map((id) => state.workItemsById[id] ?? null),
    ]);
    if (projection === this.renderedQueueProjection) return;
    this.renderedQueueProjection = projection;
    this.list.textContent = "";
    this.count = 0;
    for (const id of state.workItemIds) {
      const item = state.workItemsById[id];
      if (item === undefined) continue;
      this.list.append(this.buildItem(item));
      this.count += 1;
    }
    this.cursor = null;
    this.moreWrap.hidden = true;
    this.syncGlobalCount();
    if (this.recoveryError !== null) {
      this.status.hidden = false;
    } else if (this.count === 0) {
      this.status.hidden = false;
      this.status.textContent = "No work items are ready.";
    } else {
      this.status.hidden = true;
      this.status.textContent = "";
    }
  }

  private renderCompletedFromStore(): void {
    const state = this.store.getState();
    const projection = JSON.stringify([
      state.completedWorkItemsStatus,
      state.completedWorkItemsError,
      state.completedWorkItemsNextCursor,
      state.completedWorkItemIds.map((id) => state.completedWorkItemsById[id] ?? null),
    ]);
    if (projection === this.renderedCompletedProjection) return;
    this.renderedCompletedProjection = projection;

    if (state.completedWorkItemsStatus === "error") {
      this.completedStatus.hidden = false;
      this.completedStatus.textContent =
        state.session === null
          ? "Sign in with an editor (or higher) role to view completed work."
          : hasEffectiveCapability(state.session, "work:read", "work:read")
            ? `Completed work unavailable: ${state.completedWorkItemsError ?? "request failed"}`
            : "Your role cannot view completed work.";
      this.completedMoreWrap.hidden = true;
      return;
    }

    if (state.completedWorkItemsStatus === "loading") {
      this.completedStatus.hidden = false;
      this.completedStatus.textContent =
        state.completedWorkItemIds.length === 0
          ? "Loading completed work…"
          : "Loading more completed work…";
      this.completedMoreWrap.hidden = true;
      return;
    }

    this.completedList.textContent = "";
    for (const id of state.completedWorkItemIds) {
      const item = state.completedWorkItemsById[id];
      if (item !== undefined) this.completedList.append(this.buildCompletedItem(item));
    }
    const empty = state.completedWorkItemIds.length === 0;
    this.completedStatus.hidden = !empty;
    this.completedStatus.textContent = empty ? "No completed work yet." : "";
    this.completedMoreWrap.hidden = state.completedWorkItemsNextCursor === null;
  }

  /** Re-read the queue from the top (after a claim, release, or completion). */
  private async reload(
    generation = this.mountGeneration,
    store = this.store,
  ): Promise<void> {
    if (!this.isCurrentMount(generation)) return;
    this.cursor = null;
    await this.load(true, generation, store);
  }

  private scaffold(generation: number, store: ProjectStore): void {
    this.textContent = "";
    this.status = el("p", "ab-work-status");
    this.status.setAttribute("role", "status");
    this.status.hidden = true;
    this.live = el("p", "ab-sr ab-work-live");
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");
    this.list = el("ul", "ab-work-list");
    this.moreWrap = el("div", "ab-work-more");
    this.moreWrap.hidden = true;
    const more = el("button", "ab-btn", "Load more");
    more.type = "button";
    more.addEventListener("click", () => {
      more.disabled = true;
      void this.load(false, generation, store).finally(() => {
        if (this.isCurrentMount(generation)) more.disabled = false;
      });
    });
    this.moreWrap.append(more);

    this.completedStatus = el("p", "ab-work-status ab-completed-status");
    this.completedStatus.setAttribute("role", "status");
    this.completedStatus.textContent = "Loading completed work…";
    this.completedList = el("ul", "ab-work-list ab-completed-list");
    this.completedMoreWrap = el("div", "ab-work-more ab-completed-more");
    this.completedMoreWrap.hidden = true;
    const moreCompleted = el("button", "ab-btn ab-completed-more-button", "Load more completed work");
    moreCompleted.type = "button";
    moreCompleted.addEventListener("click", () => {
      moreCompleted.disabled = true;
      moreCompleted.setAttribute("aria-busy", "true");
      void store.getState().loadMoreCompletedWorkItems().finally(() => {
        if (!this.isCurrentMount(generation)) return;
        moreCompleted.disabled = false;
        moreCompleted.removeAttribute("aria-busy");
        this.renderCompletedFromStore();
      });
    });
    this.completedMoreWrap.append(moreCompleted);

    this.panel = new ClaimPanel({
      store: this.store,
      project: this.cfg.project,
      storage: sessionStorageOrNull(),
      chapters: this.cfg.chapters,
      now: () => this.now(),
      announce: (message) => this.announce(message),
      onExit: (reason) => {
        if (!this.isCurrentMount(generation)) return;
        if (reason === "released") {
          this.panel?.hide();
        }
        void this.reload(generation, store);
      },
    });

    const active = el("section", "ab-work-active");
    active.setAttribute("aria-labelledby", "ab-work-active-heading");
    const activeHeading = el("h2", "ab-work-section-heading", "Open work");
    activeHeading.id = "ab-work-active-heading";
    active.append(activeHeading, this.panel.root, this.status, this.list, this.moreWrap);

    const completed = el("section", "ab-work-completed");
    completed.setAttribute("aria-labelledby", "ab-work-completed-heading");
    const completedHeading = el("h2", "ab-work-section-heading", "Completed work");
    completedHeading.id = "ab-work-completed-heading";
    completed.append(
      completedHeading,
      el(
        "p",
        "ab-work-section-intro",
        "Recently completed tasks stay here as compact, attributed records.",
      ),
      this.completedStatus,
      this.completedList,
      this.completedMoreWrap,
    );

    this.append(this.live, active, completed);
    this.scaffolded = true;
  }

  private announce(message: string): void {
    this.live.textContent = message;
  }

  /** Keep the primary-nav Work badge honest as the API-backed queue changes. */
  private syncGlobalCount(): void {
    for (const badge of document.querySelectorAll<HTMLElement>("[data-work-count]")) {
      badge.textContent = String(this.count);
      badge.hidden = this.count === 0;
    }
  }

  private openPanel(claim: StoredClaim, restored: boolean): void {
    this.panel?.show(claim, { restored });
    this.panel?.root.scrollIntoView({ block: "start", behavior: "auto" });
  }

  private buildItem(item: WorkItem): HTMLElement {
    const li = el("li", "ab-work-item");
    li.dataset["workItemId"] = item.id;
    const chapter = this.cfg.chapters.get(item.chapterId);

    const head = el("div", "ab-work-head");
    const type = el("span", "ab-work-type");
    type.append(workTypeIcon(item.type), document.createTextNode(typeLabel(item.type)));
    head.append(type, el("span", "ab-work-status-pill ab-work-status-ready", "Ready"));
    if (item.priority === "high") {
      head.append(el("span", "ab-work-priority", "High priority"));
    }
    head.append(el("span", "ab-work-head-spacer"));
    if (chapter !== undefined) {
      const link = el("a", "ab-work-chapter", chapter.title);
      link.href = chapter.href;
      head.append(
        link,
        document.createTextNode(" · rev "),
        el("span", "ab-work-base", String(item.baseRevision)),
      );
    } else {
      head.append(
        el("span", "ab-work-chapter", `Chapter ${item.chapterId}`),
        document.createTextNode(" · rev "),
        el("span", "ab-work-base", String(item.baseRevision)),
      );
    }
    li.append(head);

    li.append(
      el(
        "p",
        "ab-work-context",
        "This approved task is ready for an editor. Claim it to review the full context and acceptance criteria.",
      ),
    );

    const source = el("p", "ab-work-source");
    source.append(
      document.createTextNode("Source: accepted annotation · created "),
      document.createTextNode(formatCreatedAt(item.createdAt)),
      document.createTextNode(" · "),
      el("span", "ab-work-support", tallySummary(tallyOrEmpty(item.support))),
    );
    li.append(source);

    const quote = item.target?.textQuote?.exact;
    if (typeof quote === "string" && quote.length > 0) {
      const change = el("section", "ab-work-change");
      change.append(el("h3", undefined, "Passage to revise"));
      change.append(el("blockquote", "ab-quote", quote.length > 240 ? `${quote.slice(0, 239)}…` : quote));
      li.append(change);
    }

    const criteria = el("section", "ab-work-criteria-preview");
    criteria.append(el("h3", undefined, "Acceptance criteria"));
    criteria.append(
      el(
        "p",
        undefined,
        "The complete checklist is included in the task bundle after you claim this work.",
      ),
    );
    li.append(criteria);

    li.append(this.buildClaimAction(item));
    li.append(srOnly(`Ready work item: ${typeLabel(item.type)} on ${chapter?.title ?? item.chapterId}`));
    return li;
  }

  private buildCompletedItem(item: CompletedWorkItem): HTMLElement {
    const li = el("li", "ab-work-item ab-completed-item");
    li.dataset["workItemId"] = item.id;
    const chapterRef = this.cfg.chapters.get(item.chapterId);
    const chapterLabel = item.chapter?.title ?? chapterRef?.title ?? `Chapter ${item.chapterId}`;

    const head = el("div", "ab-work-head");
    const type = el("span", "ab-work-type");
    type.append(workTypeIcon(item.type), document.createTextNode(typeLabel(item.type)));
    head.append(type, el("span", "ab-work-status-pill ab-work-status-completed", "Completed"));
    head.append(el("span", "ab-work-head-spacer"));
    if (chapterRef !== undefined) {
      const chapter = el("a", "ab-work-chapter", chapterLabel);
      chapter.href = chapterRef.href;
      head.append(chapter);
    } else {
      head.append(el("span", "ab-work-chapter", chapterLabel));
    }
    li.append(head);

    const body = item.source?.body.trim();
    li.append(
      el(
        "p",
        "ab-work-context ab-completed-body",
        body === undefined || body.length === 0
          ? "The original note is no longer available."
          : truncateStub(body, 260),
      ),
    );

    const completedBy = item.completedBy?.displayName ?? "Unknown contributor";
    const attribution = el("p", "ab-work-meta ab-completed-attribution");
    attribution.append(
      document.createTextNode(`Completed by ${completedBy} · ${formatCreatedAt(item.completedAt)}`),
    );
    li.append(attribution);

    const metadata = el("p", "ab-work-meta ab-completed-result");
    const parts: Node[] = [];
    if (typeof item.resultingRevision === "number") {
      parts.push(document.createTextNode(`Chapter revision ${item.resultingRevision}`));
    }
    if (typeof item.commitSha === "string" && item.commitSha.length > 0) {
      if (parts.length > 0) parts.push(document.createTextNode(" · "));
      const commit = el("code", "ab-work-commit", item.commitSha.slice(0, 12));
      commit.title = item.commitSha;
      parts.push(document.createTextNode("Commit "), commit);
    }
    if (item.approvedBy !== null && item.approvedBy !== undefined) {
      if (parts.length > 0) parts.push(document.createTextNode(" · "));
      parts.push(document.createTextNode(`Approved by ${item.approvedBy.displayName}`));
    }
    if (parts.length > 0) {
      metadata.append(...parts);
      li.append(metadata);
    }

    const links = el("p", "ab-work-actions ab-completed-links");
    const historyRevision = item.resultingRevision ?? item.baseRevision;
    if (chapterRef !== undefined && historyRevision !== null) {
      const source = el(
        "a",
        "ab-btn ab-completed-source",
        "Load in History Viewer",
      );
      source.href = `${chapterRef.href}${chapterHistoryHash(historyRevision)}`;
      links.append(source);
    }
    if (typeof item.revisionProposalId === "string" && item.revisionProposalId.length > 0) {
      const revision = el("a", "ab-btn ab-completed-revision", "Review revision");
      revision.setAttribute(
        "href",
        `../revisions/?proposal=${encodeURIComponent(item.revisionProposalId)}`,
      );
      links.append(revision);
    }
    if (links.childElementCount > 0) li.append(links);
    li.append(srOnly(`Completed work item: ${typeLabel(item.type)} on ${chapterLabel}`));
    return li;
  }

  /**
   * The claim affordance (contract §7): a real button for actors with
   * `work:claim`, an honest hint otherwise - never a disabled mystery.
   */
  private buildClaimAction(item: WorkItem): HTMLElement {
    const wrap = el("div", "ab-work-actions");
    // One claim at a time per tab. Stored claims are keyed per PROJECT, and
    // the lease token comes back exactly once, so claiming a second item
    // overwrote the first token irrecoverably and replaced the in-progress
    // draft with no warning - leaving the first item stuck `leased` until it
    // expired, with no way to renew, release, or submit it from this UI.
    // Refusing the second claim is the honest fix; the panel is the one place
    // a claim lives (contract §7 draft preservation).
    if (this.hasActiveClaim()) {
      wrap.append(
        el(
          "p",
          "ab-work-hint",
          "You already have a work item claimed. Submit or release it before claiming another.",
        ),
      );
      return wrap;
    }
    if (!this.canClaim()) {
      wrap.append(
        el(
          "p",
          "ab-work-hint",
          this.me === null
            ? "Sign in with an editor (or higher) role to claim work."
            : "Your role cannot claim work items.",
        ),
      );
      return wrap;
    }
    const button = el("button", "ab-btn ab-primary ab-claim-btn", "Claim this work");
    button.type = "button";
    button.setAttribute("aria-label", `Claim ${typeLabel(item.type)} work item`);
    const error = el("p", "ab-error ab-claim-error");
    error.setAttribute("role", "alert");
    error.textContent = this.claimErrors.get(item.id) ?? "";
    error.hidden = error.textContent === "";
    button.addEventListener("click", () => {
      button.disabled = true;
      this.claimErrors.delete(item.id);
      error.hidden = true;
      void this.claim(item, error).finally(() => {
        button.disabled = false;
      });
    });
    wrap.append(button, error);
    return wrap;
  }

  private async claim(item: WorkItem, error: HTMLElement): Promise<void> {
    const result = await this.store.getState().claimWork(item.id);
    if (!result.ok) {
      // 409 `lease-held` carries the holder's display name only - no token,
      // no actor id (contract §2).
      const holder = result.problem?.["holder"];
      error.textContent =
        result.status === 409 && typeof holder === "string"
          ? `Already claimed by ${holder}.`
          : `Claim failed: ${result.message}`;
      this.claimErrors.set(item.id, error.textContent);
      // The message stays put: reloading the list here would wipe the very
      // explanation the reader needs.
      error.hidden = false;
      const currentError = [...this.querySelectorAll<HTMLElement>(".ab-work-item")]
        .find((row) => row.dataset["workItemId"] === item.id)
        ?.querySelector<HTMLElement>(".ab-claim-error");
      if (currentError !== undefined && currentError !== null) {
        currentError.textContent = error.textContent;
        currentError.hidden = false;
      }
      return;
    }
    const claim = storedClaimFor(result.value);
    this.claimErrors.delete(item.id);
    // Persist only non-secret task metadata and the draft. A refresh rotates
    // the token through the credential-bound recovery endpoint.
    saveClaim(sessionStorageOrNull(), this.cfg.project, claim);
    const bundle = result.value;
    this.announce(`Claimed. ${typeLabel(bundle.workItem.type)}, your lease is running.`);
    this.openPanel(claim, false);
    await this.reload();
  }
}

function formatCreatedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toISOString().slice(0, 10);
}

function truncateStub(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}…` : normalized;
}

/**
 * The task bundle as the edit view's working state: the textarea starts
 * prefilled with the target (contract §7), so the writer edits the existing
 * prose instead of retyping it.
 */
export function storedClaimFor(bundle: SafeTaskBundle): StoredClaim {
  const draft = prefillFor({
    workItem: bundle.workItem,
    document: bundle.document,
    target: bundle.target ?? null,
  });
  return toStoredClaim(bundle, draft);
}
