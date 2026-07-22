/**
 * The Phase 4 claim-and-edit view (contract §7, design §16.4) rendered inside
 * the `/work/` island: task context, acceptance criteria, original text, a
 * textarea prefilled with the target, a live remaining-lease indicator with
 * renew/release controls, and the honest `submit → syncing → completed |
 * conflict` ladder.
 *
 * Security invariants (Phase 2b §3, design §19.6):
 * - Every API-sourced string - annotation bodies, acceptance criteria,
 *   chapter prose, problem details - reaches the DOM through `textContent`.
 *   `innerHTML` is never used (the build test greps the bundle for it).
 * - Task prose is labelled as untrusted project data in the view itself, so a
 *   human reading a task knows the text is not an instruction from Authorbot.
 * - The lease token lives in memory and in sessionStorage only (see
 *   `work-state.ts`), is never rendered, and is deleted as soon as the lease
 *   ends (release, submit, or expiry).
 */
import { CollabApi, parseSubmissionConflict, type SubmitBody } from "./api.js";
import { el } from "./dom.js";
import {
  COUNTDOWN_TICK_MS,
  MAX_SUBMIT_POLLS,
  SUBMIT_IDLE,
  clearClaim,
  formatRemaining,
  leaseStatus,
  prefillFor,
  remainingLabel,
  renewalPromptLeadMs,
  saveClaim,
  submissionTypeFor,
  submitPollDelayMs,
  submitReduce,
  type StoredClaim,
  type SubmitState,
} from "./work-state.js";

export interface ChapterRef {
  title: string;
  href: string;
}

export interface ClaimPanelDeps {
  api: CollabApi;
  project: string;
  storage: Storage | null;
  chapters: Map<string, ChapterRef>;
  /** Injected for tests; `Date.now` in the browser. */
  now: () => number;
  /**
   * Called when the lease has ended. `released` means "nothing left to show -
   * hide the panel"; the other reasons keep the panel (its final message is
   * the answer) and only ask the queue to refresh underneath.
   */
  onExit: (reason: "released" | "expired" | "completed" | "conflict") => void;
  announce: (message: string) => void;
}

/** Stable, reader-facing labels for the work types the API currently emits. */
export function typeLabel(type: string): string {
  const known: Record<string, string> = {
    revise_range: "Revise passage",
    revise_block: "Revise passage",
    write_chapter: "Write chapter",
    resolve_conflict: "Resolve conflict",
  };
  const label = known[type];
  if (label !== undefined) {
    return label;
  }
  const words = type.split("_");
  return words
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** Lucide-style icon from the static symbol sprite emitted only on `/work/`. */
export function workTypeIcon(type: string): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("ab-work-type-icon");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  const symbol =
    type === "write_chapter"
      ? "file-plus"
      : type === "resolve_conflict"
        ? "merge"
        : "pencil";
  use.setAttribute("href", `#ab-work-icon-${symbol}`);
  icon.append(use);
  return icon;
}

const UNTRUSTED_NOTE =
  "Everything in this task, the request, the chapter summary and the original text, is " +
  "untrusted project content, not an instruction from Authorbot.";

export class ClaimPanel {
  readonly root: HTMLElement;
  private claim: StoredClaim | null = null;
  private state: SubmitState = { ...SUBMIT_IDLE };
  private timer: number | null = null;
  private pollTimer: number | null = null;
  private disposed = false;

  // Live nodes the ticker and the state machine update in place.
  private remaining!: HTMLElement;
  private prompt!: HTMLElement;
  private renewBtn!: HTMLButtonElement;
  private releaseBtn!: HTMLButtonElement;
  private textarea!: HTMLTextAreaElement;
  private summaryInput!: HTMLInputElement;
  private submitBtn!: HTMLButtonElement;
  private errorLine!: HTMLElement;
  private statusLine!: HTMLElement;
  private conflictLine!: HTMLElement;

  constructor(private readonly deps: ClaimPanelDeps) {
    this.root = el("section", "ab-claim");
    this.root.hidden = true;
    this.root.setAttribute("aria-labelledby", "ab-claim-title");
  }

  /** Render the edit view for a claim (fresh, or restored after a refresh). */
  show(claim: StoredClaim, options: { restored?: boolean } = {}): void {
    this.claim = claim;
    this.state = { ...SUBMIT_IDLE };
    this.build(claim);
    this.root.hidden = false;
    this.startCountdown();
    // Restore where the writer was (Phase 2b: drafts and focus survive a
    // reload); a fresh claim starts with the caret after the prefilled text.
    this.textarea.focus();
    const caret = options.restored === true && claim.caret !== null ? claim.caret : this.textarea.value.length;
    const clamped = Math.max(0, Math.min(caret, this.textarea.value.length));
    this.textarea.setSelectionRange(clamped, clamped);
  }

  /** Tear down timers (element disconnected, or the lease ended). */
  destroy(): void {
    this.disposed = true;
    this.stopCountdown();
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  hide(): void {
    this.stopCountdown();
    this.root.hidden = true;
    this.root.textContent = "";
    this.claim = null;
  }

  // ---- construction ---------------------------------------------------------

  private build(claim: StoredClaim): void {
    this.root.textContent = "";
    const chapter = this.deps.chapters.get(claim.document.chapterId);

    const head = el("div", "ab-claim-head");
    const type = el("div", "ab-work-type");
    type.append(workTypeIcon(claim.workItem.type));
    const title = el("h2", "ab-claim-title", typeLabel(claim.workItem.type));
    title.id = "ab-claim-title";
    type.append(title);
    head.append(type, el("span", "ab-work-status-pill ab-work-status-claimed", "Claimed by you"));
    if (claim.workItem.priority === "high") {
      head.append(el("span", "ab-work-priority", "High priority"));
    }
    this.root.append(head);

    const meta = el("p", "ab-claim-meta");
    if (chapter !== undefined) {
      const link = el("a", "ab-claim-chapter", chapter.title);
      link.href = chapter.href;
      meta.append(link);
    } else {
      meta.append(el("span", "ab-claim-chapter", `Chapter ${claim.document.chapterId}`));
    }
    meta.append(
      document.createTextNode(" · rev "),
      el("span", "ab-claim-base", String(claim.document.revision)),
    );
    this.root.append(meta, this.buildLeaseBar(claim));

    // ---- task context (untrusted prose) ----
    const context = el("section", "ab-claim-section ab-claim-context");
    context.append(el("h3", undefined, "Task context"));
    context.append(el("p", "ab-untrusted-note", UNTRUSTED_NOTE));
    if (claim.context.annotationBody !== "") {
      context.append(el("blockquote", "ab-claim-request", claim.context.annotationBody));
    }
    if (claim.context.chapterSummary !== "") {
      context.append(el("p", "ab-claim-summary", claim.context.chapterSummary));
    }
    if (claim.context.storyRefs.length > 0) {
      const refs = el("ul", "ab-claim-refs");
      for (const ref of claim.context.storyRefs) {
        refs.append(el("li", undefined, ref));
      }
      context.append(refs);
    }
    this.root.append(context);

    // ---- acceptance criteria ----
    if (claim.workItem.acceptanceCriteria.length > 0) {
      const criteria = el("section", "ab-claim-section ab-claim-criteria");
      criteria.append(el("h3", undefined, "Acceptance criteria"));
      const list = el("ul");
      for (const item of claim.workItem.acceptanceCriteria) {
        list.append(el("li", undefined, item));
      }
      criteria.append(list);
      this.root.append(criteria);
    }

    // ---- original text ----
    const original = el("section", "ab-claim-section ab-claim-original");
    original.append(el("h3", undefined, "Requested change"));
    original.append(el("blockquote", "ab-original-text", prefillFor(claim)));
    this.root.append(original);

    this.root.append(this.buildForm(claim));

    this.statusLine = el("p", "ab-submit-status");
    this.statusLine.setAttribute("role", "status");
    this.statusLine.hidden = true;
    this.conflictLine = el("p", "ab-conflict-line");
    this.conflictLine.hidden = true;
    this.root.append(this.statusLine, this.conflictLine);
  }

  private buildLeaseBar(claim: StoredClaim): HTMLElement {
    const bar = el("div", "ab-lease");
    const held = el("span", "ab-lease-held", "You hold the lease");
    this.remaining = el("span", "ab-lease-remaining");
    // `role="timer"` with polite live updates would spam a screen reader every
    // second; the countdown is silent and the T-5m prompt is the announcement.
    this.remaining.setAttribute("role", "timer");
    this.remaining.setAttribute("aria-live", "off");
    this.remaining.textContent = remainingLabel(leaseStatus(claim.lease, this.deps.now()));

    const actions = el("div", "ab-lease-actions");
    this.renewBtn = el("button", "ab-btn ab-lease-renew", "Renew lease");
    this.renewBtn.type = "button";
    this.renewBtn.addEventListener("click", () => void this.renew());
    this.releaseBtn = el("button", "ab-btn ab-lease-release", "Release lease");
    this.releaseBtn.type = "button";
    this.releaseBtn.addEventListener("click", () => void this.release());
    actions.append(this.renewBtn, this.releaseBtn);

    this.prompt = el("p", "ab-lease-prompt");
    this.prompt.setAttribute("role", "alert");
    this.prompt.hidden = true;

    bar.append(held, this.remaining, actions, this.prompt);
    return bar;
  }

  private buildForm(claim: StoredClaim): HTMLElement {
    const form = el("form", "ab-submit-form");
    const field = el("label", "ab-field");
    field.append(el("span", "ab-field-label", "Your revision"));
    this.textarea = el("textarea", "ab-input ab-textarea");
    this.textarea.value = claim.draft;
    this.textarea.rows = 8;
    this.textarea.name = "content";
    this.textarea.spellcheck = true;
    field.append(this.textarea);

    const summaryField = el("label", "ab-field");
    summaryField.append(el("span", "ab-field-label", "Summary (optional)"));
    this.summaryInput = el("input", "ab-input");
    this.summaryInput.type = "text";
    this.summaryInput.name = "summary";
    summaryField.append(this.summaryInput);

    this.errorLine = el("p", "ab-error");
    this.errorLine.setAttribute("role", "alert");
    this.errorLine.hidden = true;

    const actions = el("div", "ab-form-actions");
    this.submitBtn = el("button", "ab-btn ab-primary", "Submit edit");
    this.submitBtn.type = "submit";
    actions.append(this.submitBtn);

    this.textarea.addEventListener("input", () => this.persistDraft());
    this.textarea.addEventListener("blur", () => this.persistDraft());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    form.append(field, summaryField, this.errorLine, actions);
    return form;
  }

  private persistDraft(): void {
    if (this.claim === null) {
      return;
    }
    this.claim = {
      ...this.claim,
      draft: this.textarea.value,
      caret: this.textarea.selectionStart,
    };
    saveClaim(this.deps.storage, this.deps.project, this.claim);
  }

  // ---- lease countdown ------------------------------------------------------

  private startCountdown(): void {
    this.stopCountdown();
    this.tick();
    this.timer = window.setInterval(() => this.tick(), COUNTDOWN_TICK_MS);
  }

  private stopCountdown(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.claim === null || this.disposed) {
      return;
    }
    const status = leaseStatus(this.claim.lease, this.deps.now());
    this.remaining.textContent = remainingLabel(status);
    this.remaining.classList.toggle("ab-lease-soon", status.promptRenewal);
    // Never nag once the work is on its way to Git: the lease is already
    // consumed by an accepted submission (contract §4).
    const busy = this.state.phase !== "editing" && this.state.phase !== "failed";
    const showPrompt = status.promptRenewal && !busy;
    if (showPrompt && this.prompt.hidden) {
      // Say the real threshold: with a configured lead time the hardcoded
      // "5 minutes" was simply false.
      const window = formatRemaining(renewalPromptLeadMs(this.claim.lease));
      this.prompt.textContent = status.renewable
        ? `This lease expires in under ${window}. Renew it to keep working, or release it for someone else.`
        : `This lease expires in under ${window} and has reached its maximum duration. Submit or release it now.`;
      this.prompt.hidden = false;
      this.renewBtn.disabled = !status.renewable;
    } else if (!showPrompt && !this.prompt.hidden) {
      this.prompt.hidden = true;
    }
    if (status.expired && !busy) {
      this.onExpired();
    }
  }

  /**
   * The lease ran out while the view was open: stop, tell the truth, and drop
   * the stored token - the server has already returned the item to `ready`
   * (lazy expiry / sweep) and the token can no longer submit anything.
   */
  private onExpired(): void {
    this.stopCountdown();
    this.submitBtn.disabled = true;
    this.renewBtn.disabled = true;
    this.textarea.readOnly = true;
    this.setStatus(
      "Your lease expired, so this edit can no longer be submitted. The work item is back in the queue.",
      "ab-submit-expired",
    );
    clearClaim(this.deps.storage, this.deps.project);
    this.deps.announce("Lease expired.");
    this.deps.onExit("expired");
  }

  private async renew(): Promise<void> {
    if (this.claim === null) {
      return;
    }
    const claim = this.claim;
    this.renewBtn.disabled = true;
    const result = await this.deps.api.renewLease(claim.workItemId, claim.lease.id, claim.lease.token);
    this.renewBtn.disabled = false;
    if (!result.ok) {
      this.showError(`Renewal failed: ${result.message}`);
      // An expired/inactive lease is terminal - reflect it immediately.
      if (result.status === 409) {
        this.claim = {
          ...claim,
          lease: { ...claim.lease, expiresAt: new Date(this.deps.now()).toISOString() },
        };
        this.tick();
      }
      return;
    }
    this.claim = {
      ...claim,
      lease: {
        ...claim.lease,
        expiresAt: result.value.expiresAt,
        maxExpiresAt: result.value.maxExpiresAt,
        // Keep the server's prompt instant: its distance from `expiresAt` is
        // the operator's configured lead time, which the countdown honours
        // instead of assuming the 5-minute default.
        renewalPromptAt: result.value.renewalPromptAt,
      },
    };
    saveClaim(this.deps.storage, this.deps.project, this.claim);
    this.hideError();
    this.prompt.hidden = true;
    this.tick();
    this.deps.announce("Lease renewed.");
  }

  private async release(): Promise<void> {
    if (this.claim === null) {
      return;
    }
    const claim = this.claim;
    this.releaseBtn.disabled = true;
    const result = await this.deps.api.releaseLease(claim.workItemId, claim.lease.id);
    this.releaseBtn.disabled = false;
    if (!result.ok) {
      this.showError(`Release failed: ${result.message}`);
      return;
    }
    clearClaim(this.deps.storage, this.deps.project);
    this.deps.announce("Lease released. The work item is back in the queue.");
    this.deps.onExit("released");
  }

  // ---- submit ---------------------------------------------------------------

  private async submit(): Promise<void> {
    if (this.claim === null) {
      return;
    }
    const claim = this.claim;
    const submissionType = submissionTypeFor(claim.workItem.type);
    if (submissionType === null) {
      this.showError(
        `Work items of type "${claim.workItem.type}" have no submission flow yet. Release the lease instead.`,
      );
      return;
    }
    const content = this.textarea.value;
    // A range replacement may legitimately be empty (a deletion); block and
    // chapter replacements may not (mirrors the API's own rule).
    if (content.trim() === "" && submissionType !== "range_replacement") {
      this.showError("Enter the replacement text before submitting.");
      this.textarea.focus();
      return;
    }
    // Mirror the API's rule (and the patch engine's): a range replacement is
    // inline text. Catching a stray Enter here keeps a typo from becoming a
    // conflict work item and a commit in the book repository.
    if (submissionType === "range_replacement" && /[\r\n]/.test(content)) {
      this.showError(
        "This edit replaces a single span, so it must stay on one line. Remove the line breaks and submit again.",
      );
      this.textarea.focus();
      return;
    }
    if (leaseStatus(claim.lease, this.deps.now()).expired) {
      this.onExpired();
      return;
    }

    this.dispatch({ type: "submit" });
    const summary = this.summaryInput.value.trim();
    const body: SubmitBody = {
      leaseId: claim.lease.id,
      leaseToken: claim.lease.token,
      type: submissionType as SubmitBody["type"],
      baseRevision: claim.document.revision,
      baseContentHash: claim.document.contentHash,
      content,
      ...(summary === "" ? {} : { summary }),
    };
    const result = await this.deps.api.submitWork(claim.workItemId, body);
    if (!result.ok) {
      this.dispatch({ type: "rejected", message: result.message });
      return;
    }
    // The lease is consumed by the accepted submission (contract §4): drop the
    // token now so a refresh never offers to renew a dead lease.
    clearClaim(this.deps.storage, this.deps.project);
    this.dispatch({
      type: "accepted",
      operationId: result.value.operationId,
      submissionId: result.value.submissionId,
    });
    this.pollOperation(result.value.operationId);
  }

  private pollOperation(operationId: string): void {
    const step = async (): Promise<void> => {
      if (this.disposed) {
        return;
      }
      const operation = await this.deps.api.operation(operationId);
      if (operation !== null && (operation.state === "committed" || operation.state === "verified")) {
        // A committed operation carrying the `submission-conflict` problem IS
        // the conflict record (contract §5) - the chapter was not touched.
        const conflict = parseSubmissionConflict(operation.error);
        if (conflict !== null) {
          this.dispatch({
            type: "poll-conflict",
            conflictWorkItemId: conflict.conflictWorkItemId,
            reason: conflict.reason,
          });
        } else {
          this.dispatch({ type: "poll-committed" });
        }
        return;
      }
      if (operation !== null && operation.state === "failed") {
        this.dispatch({
          type: "poll-failed",
          message: operation.error ?? "the edit could not be committed",
        });
        return;
      }
      this.dispatch({ type: "poll-pending" });
      if (this.state.phase === "syncing") {
        this.pollTimer = window.setTimeout(() => void step(), submitPollDelayMs(this.state.polls));
      }
    };
    this.pollTimer = window.setTimeout(() => void step(), submitPollDelayMs(0));
  }

  private dispatch(event: Parameters<typeof submitReduce>[1]): void {
    const next = submitReduce(this.state, event);
    if (next === this.state) {
      return;
    }
    this.state = next;
    this.renderSubmitState();
  }

  private renderSubmitState(): void {
    const busy = this.state.phase === "submitting" || this.state.phase === "syncing";
    this.submitBtn.disabled = busy || this.state.phase === "completed" || this.state.phase === "conflict";
    this.textarea.readOnly = this.state.phase !== "editing" && this.state.phase !== "failed";
    this.renewBtn.hidden = this.state.phase !== "editing" && this.state.phase !== "failed";
    this.releaseBtn.hidden = this.renewBtn.hidden;
    this.conflictLine.hidden = true;

    switch (this.state.phase) {
      case "editing":
        this.statusLine.hidden = true;
        break;
      case "submitting":
        this.hideError();
        this.setStatus("Submitting…", "ab-submit-syncing");
        break;
      case "syncing":
        this.setStatus("Syncing to the repository…", "ab-submit-syncing");
        break;
      case "completed":
        this.stopCountdown();
        this.setStatus(
          "Completed. Your edit was applied and committed. The published page updates on the next site build.",
          "ab-submit-completed",
        );
        this.deps.announce("Edit applied.");
        this.deps.onExit("completed");
        break;
      case "conflict": {
        this.stopCountdown();
        this.setStatus(this.state.message ?? "Conflict.", "ab-submit-conflict");
        if (this.state.conflictWorkItemId !== null) {
          this.conflictLine.textContent = "";
          this.conflictLine.append(
            document.createTextNode("Conflict work item: "),
            el("code", "ab-conflict-id", this.state.conflictWorkItemId),
            document.createTextNode(", it is in the queue below."),
          );
          this.conflictLine.hidden = false;
        }
        this.deps.announce("Your edit conflicted with a newer revision.");
        this.deps.onExit("conflict");
        break;
      }
      case "failed":
        this.statusLine.hidden = true;
        this.showError(this.state.message ?? "Submission failed.");
        break;
      case "stale":
        this.setStatus(this.state.message ?? "Still syncing.", "ab-submit-stale");
        break;
      default:
        break;
    }
  }

  private setStatus(text: string, className: string): void {
    this.statusLine.className = `ab-submit-status ${className}`;
    this.statusLine.textContent = text;
    this.statusLine.hidden = false;
  }

  private showError(message: string): void {
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
  }

  private hideError(): void {
    this.errorLine.hidden = true;
    this.errorLine.textContent = "";
  }

  /** Exposed for tests: the bounded poll ceiling this panel honours. */
  static readonly maxPolls = MAX_SUBMIT_POLLS;
}
