/** Maintainer revision queue and document-neutral diff review surface. */
import {
  hasEffectiveCapability,
  isMaintainer,
  type Me,
  type RevisionProposalSummary,
} from "./api.js";
import { el } from "./dom.js";
import type { ProjectStore, ResourceStatus } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";
import {
  isRevisionProposalDetail,
  revisionActionCopy,
  revisionDocument,
  revisionStatusLabel,
  revisionWarning,
  workTypeLabel,
} from "./revision-review-model.js";
import { renderRevisionDiff, type RevisionDiffHandle } from "./revision-diff.js";

interface RevisionReviewConfig {
  apiBase: string;
  project: string;
  base: string;
}

function parseConfig(host: HTMLElement): RevisionReviewConfig | null {
  const { apiBase, project, base } = host.dataset;
  if (apiBase === undefined || project === undefined || base === undefined) return null;
  return { apiBase, project, base };
}

function canReadRevisions(me: Me | null): boolean {
  return hasEffectiveCapability(me, "revisions:read", "revisions:read");
}

function canReviewRevisions(me: Me | null): boolean {
  return isMaintainer(me) &&
    hasEffectiveCapability(me, "revisions:review", "revisions:review");
}

function compactHash(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "Unavailable";
  const hash = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return `sha256:${hash.slice(0, 12)}…`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function linkedProposalId(): string | null {
  const value = new URL(window.location.href).searchParams.get("proposal")?.trim();
  return value === undefined || value.length === 0 || value.length > 200 ? null : value;
}

interface RevisionListProjection {
  sessionStatus: ResourceStatus;
  session: Me | null;
  status: ResourceStatus;
  error: string | null;
  ids: readonly string[];
  proposals: readonly (RevisionProposalSummary | undefined)[];
}

interface RevisionDetailProjection {
  proposalId: string | null;
  session: Me | null;
  status: string | undefined;
  error: string | null | undefined;
  proposal: RevisionProposalSummary | undefined;
}

function sameValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameListProjection(
  left: RevisionListProjection | null,
  right: RevisionListProjection,
): boolean {
  return left !== null &&
    left.sessionStatus === right.sessionStatus &&
    left.session === right.session &&
    left.status === right.status &&
    left.error === right.error &&
    sameValues(left.ids, right.ids) &&
    sameValues(left.proposals, right.proposals);
}

function sameDetailProjection(
  left: RevisionDetailProjection | null,
  right: RevisionDetailProjection,
): boolean {
  return left !== null &&
    left.proposalId === right.proposalId &&
    left.session === right.session &&
    left.status === right.status &&
    left.error === right.error &&
    left.proposal === right.proposal;
}

export class AuthorbotRevisionReview extends HTMLElement {
  private store!: ProjectStore;
  private cfg!: RevisionReviewConfig;
  private started = false;
  private mountGeneration = 0;
  private unsubscribe: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private selectedProposalId: string | null = null;
  private linkedProposalId: string | null = null;
  private diffHandle: RevisionDiffHandle | null = null;
  private list!: HTMLUListElement;
  private listStatus!: HTMLParagraphElement;
  private detail!: HTMLElement;
  private live!: HTMLParagraphElement;
  private scaffolded = false;
  private listProjection: RevisionListProjection | null = null;
  private detailProjection: RevisionDetailProjection | null = null;
  /** Local form state must survive authoritative revision refreshes. */
  private rejectionDrafts = new Map<string, string>();

  connectedCallback(): void {
    if (this.started) return;
    this.started = true;
    const generation = ++this.mountGeneration;
    const cfg = parseConfig(this);
    if (cfg === null) return;
    this.cfg = cfg;
    void this.connectStore(cfg, generation);
  }

  disconnectedCallback(): void {
    this.started = false;
    this.mountGeneration += 1;
    this.diffHandle?.destroy();
    this.diffHandle = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.releaseConnection?.();
    this.releaseConnection = null;
  }

  private isCurrent(generation = this.mountGeneration): boolean {
    return this.started && this.isConnected && generation === this.mountGeneration;
  }

  private async connectStore(
    cfg: RevisionReviewConfig,
    generation: number,
  ): Promise<void> {
    let store: ProjectStore;
    try {
      store = await loadProjectStore(cfg);
    } catch {
      return; // Keep the server-rendered progressive-enhancement fallback.
    }
    if (!this.isCurrent(generation)) return;
    this.store = store;
    this.linkedProposalId = linkedProposalId();
    this.selectedProposalId = this.linkedProposalId;
    await store.getState().ensureSession();
    if (!this.isCurrent(generation)) return;
    if (store.getState().sessionStatus !== "ready") return;
    this.scaffold();
    this.unsubscribe = store.subscribe(() => this.sync());
    this.sync();
    if (canReadRevisions(store.getState().session)) {
      await store.getState().ensureRevisionProposals();
      if (!this.isCurrent(generation)) return;
      if (this.linkedProposalId !== null) {
        // The pending-only list intentionally drops approved/rejected detail
        // rows. Re-read the linked proposal after that authoritative refresh
        // so an early detail/list race cannot erase the deep-linked record.
        await store.getState().refreshRevisionProposal(this.linkedProposalId);
        if (!this.isCurrent(generation)) return;
      }
      this.releaseConnection = store.getState().retainConnection();
      this.sync();
    }
  }

  private scaffold(): void {
    this.listProjection = null;
    this.detailProjection = null;
    this.textContent = "";
    const layout = el("div", "ab-revision-layout");
    const queue = el("aside", "ab-revision-queue");
    queue.setAttribute("aria-label", "Revision proposals");
    queue.append(el("h2", undefined, "Pending revisions"));
    this.listStatus = el("p", "ab-revision-list-status", "Loading revisions…");
    this.listStatus.setAttribute("role", "status");
    this.list = el("ul", "ab-revision-list");
    queue.append(this.listStatus, this.list);
    this.detail = el("section", "ab-revision-detail");
    this.detail.setAttribute("aria-label", "Revision detail");
    this.detail.append(
      el("p", "ab-revision-empty", "Choose a revision to review its complete diff."),
    );
    layout.append(queue, this.detail);
    this.live = el("p", "ab-sr");
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");
    this.append(layout, this.live);
    this.scaffolded = true;
  }

  private sync(force = false): void {
    if (!this.scaffolded || !this.isCurrent()) return;
    const state = this.store.getState();
    const me = state.session;
    const ids = this.listedProposalIds();
    const nextListProjection: RevisionListProjection = {
      sessionStatus: state.sessionStatus,
      session: me,
      status: state.revisionProposalsStatus,
      error: state.revisionProposalsError,
      ids,
      proposals: ids.map((id) => state.revisionProposalsById[id]),
    };
    const listChanged = force || !sameListProjection(this.listProjection, nextListProjection);
    if (!listChanged) {
      const nextDetailProjection = this.currentDetailProjection(me);
      if (sameDetailProjection(this.detailProjection, nextDetailProjection)) return;
    }
    this.listProjection = nextListProjection;
    if (state.sessionStatus === "error") {
      if (listChanged || force) {
        this.detailProjection = null;
        this.showUnavailable("Revision review is unavailable. Sign in again to continue.");
      }
      return;
    }
    if (state.sessionStatus !== "ready") return;
    if (me === null) {
      if (listChanged || force) {
        this.detailProjection = null;
        this.showUnavailable("Sign in as a maintainer to review revisions.");
      }
      return;
    }
    if (!canReadRevisions(me)) {
      if (listChanged || force) {
        this.detailProjection = null;
        this.showUnavailable("Your credential cannot read revision proposals.");
      }
      return;
    }
    this.ensureSelection();
    if (listChanged) this.renderList();
    const nextDetailProjection = this.currentDetailProjection(me);
    if (force || !sameDetailProjection(this.detailProjection, nextDetailProjection)) {
      this.detailProjection = nextDetailProjection;
      this.renderDetail(me);
    }
  }

  private listedProposalIds(): readonly string[] {
    const state = this.store.getState();
    const linked = this.linkedProposalId === null
      ? undefined
      : state.revisionProposalsById[this.linkedProposalId];
    return linked === undefined || state.revisionProposalIds.includes(linked.id)
      ? state.revisionProposalIds
      : [linked.id, ...state.revisionProposalIds];
  }

  private currentDetailProjection(me: Me | null): RevisionDetailProjection {
    const state = this.store.getState();
    const proposalId = this.selectedProposalId;
    return {
      proposalId,
      session: me,
      status: proposalId === null
        ? undefined
        : state.revisionProposalDetailStatusById[proposalId],
      error: proposalId === null
        ? undefined
        : state.revisionProposalDetailErrorById[proposalId],
      proposal: proposalId === null
        ? undefined
        : state.revisionProposalsById[proposalId],
    };
  }

  private showUnavailable(message: string): void {
    this.list.textContent = "";
    this.listStatus.hidden = false;
    this.listStatus.textContent = message;
    this.diffHandle?.destroy();
    this.diffHandle = null;
    this.detail.replaceChildren(el("p", "ab-revision-empty", message));
  }

  private renderList(): void {
    const state = this.store.getState();
    this.list.textContent = "";
    if (state.revisionProposalsStatus === "loading" || state.revisionProposalsStatus === "idle") {
      this.listStatus.hidden = false;
      this.listStatus.textContent = "Loading revisions…";
      return;
    }
    if (state.revisionProposalsStatus === "error") {
      this.listStatus.hidden = false;
      this.listStatus.textContent =
        `Revision queue unavailable: ${state.revisionProposalsError ?? "request failed"}`;
      return;
    }
    const proposalIds = this.listedProposalIds();
    if (proposalIds.length === 0) {
      this.listStatus.hidden = false;
      this.listStatus.textContent = "No revisions are waiting for review.";
      return;
    }
    this.listStatus.hidden = true;
    for (const proposalId of proposalIds) {
      const proposal = state.revisionProposalsById[proposalId];
      if (proposal === undefined) continue;
      const targetDocument = revisionDocument(proposal);
      const item = el("li", "ab-revision-list-item");
      const button = el("button", "ab-revision-list-button");
      button.type = "button";
      button.dataset.proposalId = proposal.id;
      button.setAttribute(
        "aria-current",
        proposal.id === this.selectedProposalId ? "true" : "false",
      );
      button.append(
        el("span", "ab-revision-list-label", targetDocument.label),
        el(
          "span",
          "ab-revision-list-summary",
          proposal.changeSummary?.trim() || "Whole-document revision",
        ),
        el(
          "span",
          "ab-revision-list-byline",
          `By ${proposal.author?.displayName ?? "Unknown contributor"}`,
        ),
        el("span", `ab-revision-status ab-revision-status-${proposal.status}`, revisionStatusLabel(proposal.status)),
      );
      button.addEventListener("click", () => {
        this.selectedProposalId = proposal.id;
        this.sync(true);
        void this.store.getState().ensureRevisionProposal(proposal.id);
      });
      item.append(button);
      this.list.append(item);
    }
  }

  private ensureSelection(): void {
    const state = this.store.getState();
    if (
      this.selectedProposalId === null ||
      (!state.revisionProposalIds.includes(this.selectedProposalId) &&
        this.selectedProposalId !== this.linkedProposalId)
    ) {
      this.selectedProposalId = state.revisionProposalIds[0] ?? null;
    }
    if (this.selectedProposalId !== null) {
      const detailStatus = state.revisionProposalDetailStatusById[this.selectedProposalId];
      // `loadRevisionProposal` publishes "loading" before it installs its
      // request promise. Do not synchronously re-enter it from this store
      // subscriber while that notification is being delivered.
      if (detailStatus === undefined || detailStatus === "idle") {
        void state.ensureRevisionProposal(this.selectedProposalId);
      }
    }
  }

  private renderDetail(me: Me | null): void {
    const active = document.activeElement;
    const restoreReasonFocus =
      active instanceof HTMLTextAreaElement &&
      active.classList.contains("ab-revision-reason") &&
      this.detail.contains(active);
    this.diffHandle?.destroy();
    this.diffHandle = null;
    const proposalId = this.selectedProposalId;
    if (proposalId === null) {
      this.detail.replaceChildren(
        el("p", "ab-revision-empty", "No revision is selected."),
      );
      return;
    }
    const state = this.store.getState();
    const proposal = state.revisionProposalsById[proposalId];
    const detailStatus = state.revisionProposalDetailStatusById[proposalId];
    if (detailStatus === "error") {
      this.detail.replaceChildren(
        el(
          "p",
          "ab-revision-error",
          `Revision could not be loaded: ${state.revisionProposalDetailErrorById[proposalId] ?? "request failed"}`,
        ),
      );
      return;
    }
    if (proposal === undefined || !isRevisionProposalDetail(proposal)) {
      this.detail.replaceChildren(el("p", "ab-revision-empty", "Loading revision diff…"));
      return;
    }

    const targetDocument = revisionDocument(proposal);
    const header = el("header", "ab-revision-detail-header");
    const headingWrap = el("div");
    headingWrap.append(
      el("p", "ab-revision-kicker", `${targetDocument.kind} revision`),
      el("h2", undefined, targetDocument.label),
    );
    header.append(
      headingWrap,
      el(
        "span",
        `ab-revision-status ab-revision-status-${proposal.status}`,
        revisionStatusLabel(proposal.status),
      ),
    );

    const meta = el("dl", "ab-revision-meta");
    this.meta(meta, "Proposed by", proposal.author?.displayName ?? "Unknown contributor");
    this.meta(meta, "Created", dateLabel(proposal.createdAt));
    if (proposal.baseRevision === null) {
      this.meta(meta, "Base content", compactHash(proposal.baseContentHash));
      this.meta(meta, "Current content", compactHash(proposal.currentContentHash));
    } else {
      this.meta(meta, "Base revision", String(proposal.baseRevision));
      this.meta(
        meta,
        "Current revision",
        targetDocument.currentRevision === null
          ? "Unavailable"
          : String(targetDocument.currentRevision),
      );
    }
    if (proposal.workItem != null) {
      const workLink = el("a", "ab-revision-work", `Work · ${workTypeLabel(proposal.workItem.type)}`);
      workLink.href = `${this.cfg.base}work/`;
      const term = el("dt", undefined, "Source");
      const description = el("dd");
      description.append(workLink, document.createTextNode(` · ${proposal.workItem.status}`));
      meta.append(term, description);
    }
    if (targetDocument.path !== "") {
      this.meta(meta, "Repository path", targetDocument.path);
    }

    const body = el("div", "ab-revision-detail-body");
    body.append(header, meta);
    if (proposal.changeSummary?.trim()) {
      body.append(this.copyBlock("Change summary", proposal.changeSummary));
    }
    if (proposal.notes?.trim()) body.append(this.copyBlock("Contributor notes", proposal.notes));
    const warning = revisionWarning(proposal);
    if (warning !== null) {
      const warningNode = el(
        "p",
        `ab-revision-warning ab-revision-warning-${warning.tone}`,
        warning.message,
      );
      warningNode.setAttribute("role", "alert");
      body.append(warningNode);
    }
    if (proposal.diff.computationLimited) {
      body.append(
        el(
          "p",
          "ab-revision-diff-note",
          "The visual diff reached its computation limit. The complete before and after snapshots remain available below.",
        ),
      );
    }
    const diffHost = el("div", "ab-revision-comparison");
    body.append(diffHost);
    this.diffHandle = renderRevisionDiff(diffHost, {
      unifiedDiff: proposal.diff.unifiedDiff,
      before: proposal.baseContent,
      after: proposal.proposedContent,
      label: `Revision comparison for ${targetDocument.label}`,
    });

    if (proposal.status === "pending_review") {
      body.append(this.actions(proposal, me));
    } else if (proposal.status === "applying") {
      body.append(
        el(
          "p",
          "ab-revision-result ab-revision-result-applying",
          "Approved. The validated Git write is in progress; the published page updates after deployment.",
        ),
      );
    } else if (proposal.status === "rejected") {
      body.append(
        el(
          "p",
          "ab-revision-result ab-revision-result-rejected",
          "Rejected. The current document was not changed.",
        ),
      );
    }
    this.detail.replaceChildren(body);
    if (restoreReasonFocus) {
      const note = this.detail.querySelector<HTMLTextAreaElement>(".ab-revision-reason");
      note?.focus();
      const end = note?.value.length ?? 0;
      note?.setSelectionRange(end, end);
    }
  }

  private meta(list: HTMLDListElement, label: string, value: string): void {
    list.append(el("dt", undefined, label), el("dd", undefined, value));
  }

  private copyBlock(label: string, value: string): HTMLElement {
    const section = el("section", "ab-revision-copy");
    section.append(el("h3", undefined, label), el("p", undefined, value));
    return section;
  }

  private actions(proposal: RevisionProposalSummary, me: Me | null): HTMLElement {
    const section = el("section", "ab-revision-actions");
    section.setAttribute("aria-label", "Review decision");
    if (!canReviewRevisions(me)) {
      section.append(
        el("p", "ab-revision-permission", "A maintainer with revision review permission must decide this proposal."),
      );
      return section;
    }
    const copy = revisionActionCopy(proposal);
    section.append(el("p", "ab-revision-action-copy", copy.explanation));
    const noteLabel = el("label", "ab-revision-reason-label", "Rejection note (optional)");
    const note = el("textarea", "ab-revision-reason");
    note.rows = 2;
    note.placeholder = "Why this version should not be applied";
    note.value = this.rejectionDrafts.get(proposal.id) ?? "";
    note.addEventListener("input", () => {
      this.rejectionDrafts.set(proposal.id, note.value);
    });
    noteLabel.append(note);
    const buttons = el("div", "ab-revision-buttons");
    const approve = el("button", "ab-btn ab-primary ab-revision-approve", copy.approveLabel);
    approve.type = "button";
    const reject = el("button", "ab-btn ab-danger ab-revision-reject", "Reject");
    reject.type = "button";
    approve.addEventListener("click", () => {
      void this.decide(proposal.id, "approve", undefined);
    });
    reject.addEventListener("click", () => {
      void this.decide(proposal.id, "reject", note.value);
    });
    buttons.append(approve, reject);
    section.append(noteLabel, buttons);
    return section;
  }

  private async decide(
    proposalId: string,
    decision: "approve" | "reject",
    reason?: string,
  ): Promise<void> {
    const buttons = this.detail.querySelectorAll<HTMLButtonElement>(".ab-revision-buttons button");
    for (const button of buttons) button.disabled = true;
    this.live.textContent = decision === "approve" ? "Applying revision…" : "Rejecting revision…";
    const result = await this.store.getState().reviewRevision(proposalId, decision, reason);
    if (!this.isCurrent()) return;
    if (!result.ok) {
      this.live.textContent = `Revision ${decision} failed: ${result.message}`;
      this.sync();
      const error = el("p", "ab-revision-error", result.message);
      error.setAttribute("role", "alert");
      this.detail.prepend(error);
      return;
    }
    this.rejectionDrafts.delete(proposalId);
    this.live.textContent =
      decision === "approve"
        ? "Revision approved and queued for validated application."
        : "Revision rejected. The current document was not changed.";
    this.sync();
  }
}
