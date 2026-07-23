/** Inline, document-safe chapter history browser and restore-proposal surface. */
import {
  hasEffectiveCapability,
  type ChapterHistoryComparison,
  type ChapterHistoryDetail,
  type ChapterHistoryPage,
  type ChapterHistoryRevision,
  type Me,
} from "./api.js";
import { el } from "./dom.js";
import {
  chapterHistoryDetailKey,
  type ProjectStore,
  type ProjectStoreState,
} from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";
import { renderRevisionDiff, type RevisionDiffHandle } from "./revision-diff.js";

interface ChapterHistoryConfig {
  apiBase: string;
  project: string;
  base: string;
  chapterId: string;
  chapterTitle: string;
  chapterRevision: number;
  chapterStatus: string;
}

function parseConfig(host: HTMLElement): ChapterHistoryConfig | null {
  const { apiBase, project, base, chapterId, chapterTitle, chapterRevision, chapterStatus } =
    host.dataset;
  const revision = Number(chapterRevision);
  if (
    apiBase === undefined ||
    project === undefined ||
    base === undefined ||
    chapterId === undefined ||
    chapterTitle === undefined ||
    chapterStatus === undefined ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return null;
  }
  return {
    apiBase,
    project,
    base,
    chapterId,
    chapterTitle,
    chapterRevision: revision,
    chapterStatus,
  };
}

function canReadHistory(me: Me | null): boolean {
  return hasEffectiveCapability(me, "history:read", "history:read");
}

function canRestoreHistory(me: Me | null): boolean {
  return hasEffectiveCapability(me, "revisions:write", "revisions:write");
}

function canReadRevisions(me: Me | null): boolean {
  return hasEffectiveCapability(me, "revisions:read", "revisions:read");
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function plainLabel(value: string | null): string {
  return value === null || value.trim() === ""
    ? "Recorded revision"
    : value.replaceAll("_", " ");
}

function shortCommit(value: string | null): string {
  return value === null ? "commit not recorded" : `commit ${value.slice(0, 10)}`;
}

export class AuthorbotChapterHistoryPanel extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["hidden"];
  }

  private cfg!: ChapterHistoryConfig;
  private store: ProjectStore | null = null;
  private started = false;
  private generation = 0;
  private unsubscribe: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private selectedRevision: number | null = null;
  private comparison: ChapterHistoryComparison = "previous";
  private diffHandle: RevisionDiffHandle | null = null;
  private renderedListSignature = "";
  private pendingListFocus: number | null = null;
  private pendingComparisonFocus: ChapterHistoryComparison | null = null;
  private restoringRevision: number | null = null;
  private restoreSuccess = new Map<number, string>();
  private restoreError: { revision: number; message: string; ambiguous: boolean } | null = null;
  private refreshedCurrent = new Set<string>();

  private heading!: HTMLHeadingElement;
  private status!: HTMLParagraphElement;
  private currentCopy!: HTMLParagraphElement;
  private olderButton!: HTMLButtonElement;
  private newerButton!: HTMLButtonElement;
  private list!: HTMLOListElement;
  private detail!: HTMLElement;
  private live!: HTMLParagraphElement;

  connectedCallback(): void {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;
    const cfg = parseConfig(this);
    if (cfg === null) return;
    this.cfg = cfg;
    this.scaffold();
    this.addEventListener("keydown", this.onKeydown);
    void this.connectStore(generation);
  }

  disconnectedCallback(): void {
    this.started = false;
    this.generation += 1;
    this.removeEventListener("keydown", this.onKeydown);
    this.diffHandle?.destroy();
    this.diffHandle = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.releaseConnection?.();
    this.releaseConnection = null;
  }

  attributeChangedCallback(name: string, _before: string | null, after: string | null): void {
    if (name !== "hidden" || !this.started) return;
    if (after !== null) {
      this.diffHandle?.destroy();
      this.diffHandle = null;
    } else {
      this.sync();
    }
  }

  private isCurrent(generation = this.generation): boolean {
    return this.started && this.isConnected && generation === this.generation;
  }

  private scaffold(): void {
    this.textContent = "";
    this.setAttribute("role", "region");
    const shell = el("section", "ab-history-panel-shell");
    const header = el("header", "ab-history-panel-header");
    const title = el("div");
    title.append(
      el("p", "ab-history-eyebrow", "Chapter time machine"),
      (this.heading = el("h2", undefined, `${this.cfg.chapterTitle} history`)),
    );
    this.heading.tabIndex = -1;
    this.setAttribute("aria-labelledby", this.ensureHeadingId());
    const close = el("button", "ab-history-close", "Close history");
    close.type = "button";
    close.addEventListener("click", () => this.requestClose());
    header.append(title, close);

    this.status = el("p", "ab-history-status", "Loading revision history…");
    this.status.setAttribute("role", "status");
    const layout = el("div", "ab-history-layout");
    const rail = el("aside", "ab-history-rail");
    rail.setAttribute("aria-label", "Chapter revisions");
    this.currentCopy = el("p", "ab-history-current-copy");
    const nav = el("div", "ab-history-stepper");
    this.olderButton = el("button", "ab-history-step", "← Older revision");
    this.olderButton.type = "button";
    this.olderButton.disabled = true;
    this.olderButton.addEventListener("click", () => this.stepOlder());
    this.newerButton = el("button", "ab-history-step", "Newer revision →");
    this.newerButton.type = "button";
    this.newerButton.disabled = true;
    this.newerButton.addEventListener("click", () => this.stepNewer());
    nav.append(this.olderButton, this.newerButton);
    this.list = el("ol", "ab-history-list");
    rail.append(this.currentCopy, nav, this.list);
    this.detail = el("section", "ab-history-detail");
    this.detail.setAttribute("aria-label", "Selected chapter revision");
    layout.append(rail, this.detail);
    this.live = el("p", "ab-sr");
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");
    shell.append(header, this.status, layout, this.live);
    this.append(shell);
  }

  private ensureHeadingId(): string {
    const id = `${this.id || "ab-chapter-history"}-heading`;
    this.heading.id = id;
    return id;
  }

  private async connectStore(generation: number): Promise<void> {
    try {
      const store = await loadProjectStore(this.cfg);
      if (!this.isCurrent(generation)) return;
      this.store = store;
      this.unsubscribe = store.subscribe((state, previous) => {
        if (this.historyStateChanged(state, previous)) this.sync();
      });
      await store.getState().ensureSession();
      if (!this.isCurrent(generation)) return;
      const me = store.getState().session;
      if (!canReadHistory(me)) {
        this.showFatal("Your credential cannot read chapter history.");
        return;
      }
      await store.getState().ensureChapterHistory(this.cfg.chapterId);
      if (!this.isCurrent(generation)) return;
      this.releaseConnection = store.getState().retainConnection();
      this.sync();
    } catch {
      if (this.isCurrent(generation)) {
        this.showFatal("Chapter history could not load. Close the panel and try again.");
      }
    }
  }

  /**
   * The project store also carries notes, work, drafts, and live-connection
   * state. Rebuilding the history detail for those updates destroys the active
   * Diff2Html enhancement and steals focus from its controls, so only observe
   * the session and the currently displayed history resources.
   */
  private historyStateChanged(
    state: ProjectStoreState,
    previous: ProjectStoreState,
  ): boolean {
    if (state.sessionStatus !== previous.sessionStatus || state.session !== previous.session) {
      return true;
    }
    const chapterId = this.cfg.chapterId;
    if (
      state.chapterHistoryStatusByChapter[chapterId] !==
        previous.chapterHistoryStatusByChapter[chapterId] ||
      state.chapterHistoryByChapter[chapterId] !== previous.chapterHistoryByChapter[chapterId] ||
      state.chapterHistoryErrorByChapter[chapterId] !==
        previous.chapterHistoryErrorByChapter[chapterId]
    ) {
      return true;
    }
    if (this.selectedRevision === null) return false;
    const key = chapterHistoryDetailKey(
      chapterId,
      this.selectedRevision,
      this.comparison,
    );
    return (
      state.chapterHistoryDetailStatusByKey[key] !==
        previous.chapterHistoryDetailStatusByKey[key] ||
      state.chapterHistoryDetailByKey[key] !== previous.chapterHistoryDetailByKey[key] ||
      state.chapterHistoryDetailErrorByKey[key] !==
        previous.chapterHistoryDetailErrorByKey[key]
    );
  }

  private sync(): void {
    if (this.hidden || this.store === null || !this.isCurrent()) return;
    const state = this.store.getState();
    if (state.sessionStatus === "ready" && !canReadHistory(state.session)) {
      this.showFatal("Your credential can no longer read chapter history.");
      return;
    }
    const pageStatus = state.chapterHistoryStatusByChapter[this.cfg.chapterId];
    const page = state.chapterHistoryByChapter[this.cfg.chapterId];
    if (pageStatus === undefined || pageStatus === "idle") {
      void state.ensureChapterHistory(this.cfg.chapterId);
    }
    if (pageStatus === "error") {
      this.renderPageError(
        state.chapterHistoryErrorByChapter[this.cfg.chapterId] ?? "request failed",
      );
      return;
    }
    if (page === undefined) {
      this.status.hidden = false;
      this.status.textContent = "Loading revision history…";
      this.list.textContent = "";
      this.renderDetailPlaceholder("Loading the current snapshot…");
      return;
    }
    this.status.hidden = true;
    if (this.selectedRevision === null || this.selectedRevision > page.current.revision) {
      this.selectedRevision = page.current.revision;
      this.comparison = "previous";
    }
    this.renderCurrentClarity(page);
    this.ensureSelectedDetail(page);
    this.renderList(page);
    this.updateStepper(page);
    this.renderDetail(page, state.session);
  }

  private showFatal(message: string): void {
    this.status.hidden = false;
    this.status.textContent = message;
    this.status.setAttribute("role", "alert");
    this.list.textContent = "";
    this.olderButton.disabled = true;
    this.newerButton.disabled = true;
    this.renderDetailPlaceholder(message);
  }

  private renderPageError(message: string): void {
    this.status.hidden = false;
    this.status.setAttribute("role", "alert");
    this.status.textContent = `Revision history unavailable: ${message}`;
    this.list.textContent = "";
    this.renderDetailPlaceholder("The chapter remains readable while history is unavailable.");
    const retry = el("button", "ab-btn ab-history-retry", "Retry history");
    retry.type = "button";
    retry.addEventListener("click", () => {
      this.status.setAttribute("role", "status");
      void this.store?.getState().refreshChapterHistory(this.cfg.chapterId);
    });
    this.detail.append(retry);
  }

  private renderCurrentClarity(page: ChapterHistoryPage): void {
    const status = page.current.status.toLowerCase();
    const currentLabel =
      status === "published"
        ? `Current published revision: ${page.current.revision}.`
        : `Current ${plainLabel(status)} revision: ${page.current.revision}.`;
    const deployed =
      this.cfg.chapterRevision === page.current.revision
        ? " This reading page matches it."
        : ` This deployed reading page still shows revision ${this.cfg.chapterRevision}; it will catch up after the next successful publish.`;
    this.currentCopy.textContent = currentLabel + deployed;
  }

  private ensureSelectedDetail(page: ChapterHistoryPage): void {
    if (this.store === null || this.selectedRevision === null) return;
    const state = this.store.getState();
    const key = chapterHistoryDetailKey(
      this.cfg.chapterId,
      this.selectedRevision,
      this.comparison,
    );
    const status = state.chapterHistoryDetailStatusByKey[key];
    const detail = state.chapterHistoryDetailByKey[key];
    if (status === undefined || status === "idle") {
      void state.ensureChapterHistoryRevision(
        this.cfg.chapterId,
        this.selectedRevision,
        this.comparison,
      );
      return;
    }
    if (
      status === "ready" &&
      detail !== undefined &&
      detail.current.revision !== page.current.revision
    ) {
      const refreshKey = `${key}:${page.current.revision}`;
      if (!this.refreshedCurrent.has(refreshKey)) {
        this.refreshedCurrent.add(refreshKey);
        void state.refreshChapterHistoryRevision(
          this.cfg.chapterId,
          this.selectedRevision,
          this.comparison,
        );
      }
    }
  }

  private renderList(page: ChapterHistoryPage): void {
    const state = this.store?.getState();
    const selected = this.selectedRevision;
    const selectedDetail =
      selected === null || state === undefined
        ? undefined
        : state.chapterHistoryDetailByKey[
            chapterHistoryDetailKey(this.cfg.chapterId, selected, this.comparison)
          ];
    const listed = page.items.some((item) => item.revision === selected);
    const rows =
      !listed && selectedDetail !== undefined
        ? [...page.items, selectedDetail.selected]
        : page.items;
    const signature = JSON.stringify([
      page.current.revision,
      page.nextCursor,
      rows.map((item) => [item.revision, item.changeSummary, item.isCurrent]),
    ]);
    if (signature === this.renderedListSignature) {
      this.updateListSelection();
      this.focusPendingList();
      return;
    }
    this.renderedListSignature = signature;
    this.list.textContent = "";
    for (const item of rows) this.list.append(this.revisionRow(item, page));
    if (page.nextCursor !== null) {
      const note = el("li", "ab-history-list-limit");
      note.textContent =
        "The direct list shows the latest 50 revisions. Keep using Older revision to walk back to the original.";
      this.list.append(note);
    }
    this.updateListSelection();
    this.focusPendingList();
  }

  private updateListSelection(): void {
    for (const button of this.list.querySelectorAll<HTMLButtonElement>("button[data-revision]")) {
      button.setAttribute(
        "aria-current",
        button.dataset.revision === String(this.selectedRevision) ? "true" : "false",
      );
    }
  }

  private focusPendingList(): void {
    const focusRevision = this.pendingListFocus;
    this.pendingListFocus = null;
    if (focusRevision === null) return;
    this.list
      .querySelector<HTMLButtonElement>(`button[data-revision="${focusRevision}"]`)
      ?.focus();
  }

  private revisionRow(item: ChapterHistoryRevision, page: ChapterHistoryPage): HTMLLIElement {
    const row = el("li", "ab-history-list-item");
    if (!page.items.some((candidate) => candidate.revision === item.revision)) {
      row.classList.add("ab-history-list-item-walked");
    }
    const button = el("button", "ab-history-revision");
    button.type = "button";
    button.dataset.revision = String(item.revision);
    button.setAttribute("aria-current", item.revision === this.selectedRevision ? "true" : "false");
    button.setAttribute(
      "aria-label",
      `Revision ${item.revision} of ${page.current.revision}${item.isCurrent ? ", current" : ""}. ${
        item.status === null ? "" : `${plainLabel(item.status)}. `
      }${shortCommit(item.commitSha)}. ${item.changeSummary ?? plainLabel(item.origin)}`,
    );
    button.append(
      el("span", "ab-history-revision-number", `Revision ${item.revision}`),
      el(
        "span",
        "ab-history-revision-summary",
        item.changeSummary?.trim() || plainLabel(item.origin),
      ),
      el(
        "span",
        "ab-history-revision-date",
        `${dateLabel(item.createdAt)}${item.author === null ? "" : ` · ${item.author.displayName}`}` +
          `${item.status === null ? "" : ` · ${plainLabel(item.status)}`} · ${shortCommit(item.commitSha)}`,
      ),
    );
    if (item.isCurrent) button.append(el("span", "ab-history-current-badge", "Current"));
    button.addEventListener("click", () => this.selectRevision(item.revision, true));
    button.addEventListener("keydown", (event) => this.onListKeydown(event, item.revision, page));
    row.append(button);
    return row;
  }

  private onListKeydown(
    event: KeyboardEvent,
    revision: number,
    page: ChapterHistoryPage,
  ): void {
    const revisions = page.items.map((item) => item.revision);
    const index = revisions.indexOf(revision);
    let target: number | undefined;
    if (event.key === "ArrowDown" && index >= 0) target = revisions[index + 1];
    if (event.key === "ArrowUp" && index >= 0) target = revisions[index - 1];
    if (event.key === "Home") target = revisions[0];
    if (event.key === "End") target = revisions[revisions.length - 1];
    if (target === undefined) return;
    event.preventDefault();
    this.selectRevision(target, true);
  }

  private updateStepper(page: ChapterHistoryPage): void {
    const selected = this.selectedRevision;
    if (selected === null || this.store === null) {
      this.olderButton.disabled = true;
      this.newerButton.disabled = true;
      return;
    }
    const previous = this.store.getState().chapterHistoryDetailByKey[
      chapterHistoryDetailKey(this.cfg.chapterId, selected, "previous")
    ];
    this.olderButton.disabled = previous === undefined || previous.comparison === null;
    this.olderButton.dataset.revision = String(previous?.comparison?.revision ?? "");
    this.newerButton.disabled = selected >= page.current.revision;
    this.newerButton.dataset.revision = String(Math.min(selected + 1, page.current.revision));
  }

  private renderDetail(page: ChapterHistoryPage, me: Me | null): void {
    this.diffHandle?.destroy();
    this.diffHandle = null;
    const selected = this.selectedRevision;
    if (this.store === null || selected === null) {
      this.renderDetailPlaceholder("Choose a revision.");
      return;
    }
    const state = this.store.getState();
    const key = chapterHistoryDetailKey(this.cfg.chapterId, selected, this.comparison);
    const status = state.chapterHistoryDetailStatusByKey[key];
    const detail = state.chapterHistoryDetailByKey[key];
    if (status === "error") {
      const message = state.chapterHistoryDetailErrorByKey[key] ?? "request failed";
      this.detail.replaceChildren(
        this.detailHeader(this.historyMetadata(page, selected), page),
        this.comparisonControls(selected, page),
        this.alert(`Revision ${selected} could not be loaded: ${message}`),
      );
      const retry = el("button", "ab-btn ab-history-retry", "Retry revision");
      retry.type = "button";
      retry.addEventListener("click", () => {
        void this.store?.getState().refreshChapterHistoryRevision(
          this.cfg.chapterId,
          selected,
          this.comparison,
        );
      });
      this.detail.append(retry);
      return;
    }
    if (detail === undefined || status !== "ready") {
      this.detail.replaceChildren(
        this.detailHeader(this.historyMetadata(page, selected), page),
        this.comparisonControls(selected, page),
        el("p", "ab-history-detail-loading", "Loading snapshot and comparison…"),
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    fragment.append(this.detailHeader(detail.selected, page));
    fragment.append(this.comparisonControls(detail.selected.revision, page));
    const snapshot = el("section", "ab-history-snapshot");
    snapshot.append(
      el("h3", undefined, `Revision ${detail.selected.revision} Markdown snapshot`),
    );
    const pre = el("pre");
    pre.append(el("code", undefined, detail.selected.content));
    snapshot.append(pre);
    fragment.append(snapshot);

    if (detail.comparison === null || detail.diff === null) {
      fragment.append(
        el(
          "p",
          "ab-history-no-comparison",
          this.comparison === "previous"
            ? "This is the original revision. There is no earlier snapshot to compare."
            : `Revision ${detail.selected.revision} is the current ${plainLabel(detail.current.status)} revision, so there is no second snapshot to compare.`,
        ),
      );
    } else {
      const comparisonHeading =
        this.comparison === "previous"
          ? `Changes from revision ${detail.comparison.revision} to ${detail.selected.revision}`
          : `Revision ${detail.selected.revision} compared with current revision ${detail.comparison.revision}`;
      fragment.append(el("h3", "ab-history-diff-heading", comparisonHeading));
      if (detail.diff.computationLimited) {
        fragment.append(
          el(
            "p",
            "ab-history-diff-limit",
            "The visual diff reached its computation limit. Complete plain-text snapshots remain below it.",
          ),
        );
      }
      const host = el("div", "ab-history-diff");
      fragment.append(host);
      this.detail.replaceChildren(fragment);
      this.diffHandle = renderRevisionDiff(host, {
        unifiedDiff: detail.diff.unifiedDiff,
        before:
          this.comparison === "previous"
            ? detail.comparison.content
            : detail.selected.content,
        after:
          this.comparison === "previous"
            ? detail.selected.content
            : detail.comparison.content,
        label: comparisonHeading,
      });
      this.detail.append(this.restoreAction(detail, page, me));
      this.focusPendingComparison();
      return;
    }
    fragment.append(this.restoreAction(detail, page, me));
    this.detail.replaceChildren(fragment);
    this.focusPendingComparison();
  }

  private historyMetadata(
    page: ChapterHistoryPage,
    revision: number,
  ): ChapterHistoryRevision {
    return page.items.find((item) => item.revision === revision) ?? {
      ...page.current,
      revision,
      status: revision === page.current.revision ? page.current.status : null,
      isCurrent: revision === page.current.revision,
    };
  }

  private detailHeader(item: ChapterHistoryRevision, page: ChapterHistoryPage): HTMLElement {
    const header = el("header", "ab-history-detail-header");
    const copy = el("div");
    copy.append(
      el("p", "ab-history-selected-label", "Selected snapshot"),
      el("h3", undefined, `Revision ${item.revision} of ${page.current.revision}`),
    );
    const metadata = el("dl", "ab-history-selected-meta");
    for (const [label, value] of [
      ["Publication state", item.status === null ? "Loading with snapshot…" : plainLabel(item.status)],
      ["Commit", item.commitSha ?? "Not recorded"],
      ["Time", dateLabel(item.createdAt)],
      ["Author", item.author?.displayName ?? "Not recorded"],
    ] as const) {
      metadata.append(el("dt", undefined, label), el("dd", undefined, value));
    }
    copy.append(metadata);
    header.append(copy);
    if (item.revision === page.current.revision) {
      header.append(
        el(
          "span",
          "ab-history-current-badge",
          page.current.status.toLowerCase() === "published" ? "Current published" : "Current",
        ),
      );
    } else if (item.status !== null) {
      header.append(el("span", "ab-history-state-badge", plainLabel(item.status)));
    }
    return header;
  }

  private comparisonControls(revision: number, page: ChapterHistoryPage): HTMLElement {
    const controls = el("div", "ab-history-compare-controls");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Compare selected revision");
    for (const [value, label] of [
      ["previous", "From previous"],
      ["current", "With current"],
    ] as const) {
      const button = el("button", "ab-history-compare", label);
      button.type = "button";
      button.dataset.compare = value;
      button.setAttribute("aria-pressed", String(this.comparison === value));
      if (value === "current" && revision === page.current.revision) button.disabled = true;
      button.addEventListener("click", () => this.selectComparison(value));
      controls.append(button);
    }
    return controls;
  }

  private restoreAction(
    detail: ChapterHistoryDetail,
    page: ChapterHistoryPage,
    me: Me | null,
  ): HTMLElement {
    const section = el("section", "ab-history-restore");
    section.setAttribute("aria-label", "Restore this revision");
    const revision = detail.selected.revision;
    if (revision === page.current.revision) {
      section.append(
        el("p", undefined, "This is already the current revision; there is nothing to restore."),
      );
      return section;
    }
    if (!canRestoreHistory(me)) {
      section.append(
        el(
          "p",
          undefined,
          "You can inspect this revision, but your credential cannot propose restoring it.",
        ),
      );
      return section;
    }
    const proposalId = this.restoreSuccess.get(revision);
    if (proposalId !== undefined) {
      const success = el(
        "p",
        "ab-history-restore-success",
        `Revision ${revision} was submitted as a proposal for review.`,
      );
      success.setAttribute("role", "status");
      section.append(success);
      if (canReadRevisions(me)) {
        const link = el("a", "ab-history-review-link", "Open revision review");
        link.href = `${this.cfg.base}revisions/`;
        section.append(link);
      }
      return section;
    }
    section.append(
      el(
        "p",
        undefined,
        `This creates a pending proposal from revision ${revision}. It does not immediately replace the current chapter.`,
      ),
    );
    if (this.restoreError?.revision === revision) {
      section.append(
        this.alert(
          this.restoreError.ambiguous
            ? `The response was lost and the proposal may already exist. Retrying is safe: ${this.restoreError.message}`
            : this.restoreError.message,
        ),
      );
    }
    const restore = el(
      "button",
      "ab-btn ab-primary ab-history-restore-button",
      `Restore revision ${revision} as proposal`,
    );
    restore.type = "button";
    restore.disabled = this.restoringRevision !== null;
    if (this.restoringRevision === revision) {
      restore.textContent = "Submitting proposal…";
      restore.setAttribute("aria-busy", "true");
    }
    restore.addEventListener("click", () => void this.restore(revision));
    section.append(restore);
    return section;
  }

  private renderDetailPlaceholder(message: string): void {
    this.diffHandle?.destroy();
    this.diffHandle = null;
    this.detail.replaceChildren(el("p", "ab-history-detail-loading", message));
  }

  private alert(message: string): HTMLParagraphElement {
    const alert = el("p", "ab-history-error", message);
    alert.setAttribute("role", "alert");
    return alert;
  }

  private selectRevision(revision: number, focusList = false): void {
    if (revision === this.selectedRevision) return;
    this.selectedRevision = revision;
    this.comparison = "previous";
    this.restoreError = null;
    if (focusList) this.pendingListFocus = revision;
    this.live.textContent = `Selected revision ${revision}. Loading its snapshot.`;
    this.sync();
    if (focusList) {
      // Programmatic `.click()` does not focus buttons in every browser/test
      // DOM. Restore the roving-list focus after synchronous store updates.
      globalThis.setTimeout(() => {
        if (!this.isCurrent()) return;
        this.list
          .querySelector<HTMLButtonElement>(`button[data-revision="${revision}"]`)
          ?.focus();
      }, 0);
    }
  }

  private selectComparison(comparison: ChapterHistoryComparison): void {
    if (comparison === this.comparison || this.selectedRevision === null) return;
    this.comparison = comparison;
    this.pendingComparisonFocus = comparison;
    this.live.textContent =
      comparison === "previous"
        ? "Comparing with the previous revision."
        : "Comparing with the current revision.";
    this.sync();
  }

  private focusPendingComparison(): void {
    const comparison = this.pendingComparisonFocus;
    if (comparison === null) return;
    this.pendingComparisonFocus = null;
    this.detail
      .querySelector<HTMLButtonElement>(`button[data-compare="${comparison}"]`)
      ?.focus();
  }

  private stepOlder(): void {
    const revision = Number(this.olderButton.dataset.revision);
    if (Number.isSafeInteger(revision) && revision > 0) this.selectRevision(revision);
  }

  private stepNewer(): void {
    const revision = Number(this.newerButton.dataset.revision);
    if (Number.isSafeInteger(revision) && revision > 0) this.selectRevision(revision);
  }

  private async restore(revision: number): Promise<void> {
    if (this.store === null || this.restoringRevision !== null) return;
    this.restoringRevision = revision;
    this.restoreError = null;
    this.live.textContent = `Submitting revision ${revision} as a proposal for review…`;
    this.sync();
    const result = await this.store.getState().restoreChapterHistory(this.cfg.chapterId, revision);
    if (!this.isCurrent()) return;
    this.restoringRevision = null;
    if (result.ok) {
      this.restoreSuccess.set(revision, result.value.proposalId);
      this.live.textContent = `Revision ${revision} was submitted as a proposal for review.`;
    } else {
      this.restoreError = {
        revision,
        message: result.message,
        ambiguous: result.kind === "ambiguous",
      };
      this.live.textContent = `Revision ${revision} restore proposal failed: ${result.message}`;
    }
    this.sync();
  }

  private requestClose(): void {
    this.dispatchEvent(new CustomEvent("authorbot-history-close", { bubbles: true }));
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.requestClose();
  };
}
