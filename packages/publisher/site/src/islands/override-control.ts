/**
 * `OverrideControl` - the maintainer force-promote / reject surface on a
 * suggestion (Phase 6 contract §3.6 "Force-promote", surfacing the Phase 3
 * overrides).
 *
 * Framework-free view class in the shape of `VoteControl`: it owns its own
 * subtree, is handed its dependencies, and `update()`s in place so a live
 * tally refresh or a background poll never rebuilds the panel out from under
 * a half-typed reason.
 *
 * Contract invariants, all load-bearing:
 * - Offered only to a maintainer on an open suggestion. A non-maintainer sees
 *   nothing here at all - an override surface is not a thing to explain to
 *   everyone, and it is never a disabled button.
 * - Each action requires a reason: activating it opens an inline labelled
 *   textarea with an explicit Confirm (named after the action) and Cancel.
 *   Nothing is ever pre-filled and nothing is ever submitted without one.
 * - The current tally is shown beside the actions - the aggregate summary plus
 *   the role-aware maintainer / human-maintainer approvals added by the Phase 6
 *   amendment - so the maintainer cannot act without seeing the governance
 *   threshold they are bypassing. Counts the API did not supply render "-"
 *   rather than a confident zero.
 *
 * Security/accessibility: every string reaches the DOM via `textContent`
 * (`innerHTML` is never used); each action is a real `<button>`; the reason
 * textarea is labelled; errors land in a `role="alert"` node carrying the
 * API's `detail` verbatim.
 */
import type { Annotation } from "./api.js";
import { el } from "./dom.js";
import { tallyOrEmpty, tallySummary } from "./vote-view.js";

/** The two overrides this control surfaces. */
export type OverrideAction = "promote" | "reject";

/**
 * The in-progress override: which form is open and what has been typed into
 * it. Owned by the CALLER so it survives the caller's re-renders (a background
 * poll must never eat a typed reason).
 */
export interface OverrideDraft {
  action: OverrideAction | null;
  reason: string;
}

export interface OverrideControlDeps {
  /** The caller's current draft for this suggestion (never mutated here). */
  draft: OverrideDraft;
  /** Persist a draft change (form opened/closed, reason typed). */
  onDraftChange: (draft: OverrideDraft) => void;
  /**
   * Run the override. Resolves to `null` on success, or the message to show in
   * the alert node (the API's `detail`, verbatim, for 403/409).
   */
  onSubmit: (action: OverrideAction, reason: string) => Promise<string | null>;
}

/** Mirrors `packages/domain/src/overrides.ts` so an obviously-doomed reason
 *  is never sent to the API. */
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 2000;

const EM_DASH = "-";

/**
 * Both overrides apply to an OPEN suggestion. A `pending_git` annotation is
 * still being committed and the API refuses to override it, so the actions are
 * not offered in that state rather than offered and then failing.
 */
export function canOverride(annotation: Annotation): boolean {
  return annotation.kind === "suggestion" && annotation.status === "open";
}

function verb(action: OverrideAction): string {
  return action === "promote" ? "Promoting" : "Rejecting";
}

function confirmLabel(action: OverrideAction): string {
  return action === "promote" ? "Promote to work" : "Reject suggestion";
}

function reasonLabel(action: OverrideAction): string {
  return action === "promote"
    ? "Why promote this suggestion? (recorded on the override)"
    : "Why reject this suggestion? (recorded on the override)";
}

/** A role-aware count the API may not have supplied yet. */
function countText(value: number | undefined): string {
  return typeof value === "number" ? String(value) : EM_DASH;
}

export class OverrideControl {
  readonly root: HTMLElement;
  private readonly tallyLine: HTMLElement;
  private readonly maintainerLine: HTMLElement;
  private readonly humanMaintainerLine: HTMLElement;
  private readonly promoteBtn: HTMLButtonElement;
  private readonly rejectBtn: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly reasonLabelEl: HTMLElement;
  private readonly reason: HTMLTextAreaElement;
  private readonly errorLine: HTMLElement;
  private readonly confirmBtn: HTMLButtonElement;
  private annotation: Annotation | null = null;
  private action: OverrideAction | null;
  private busy = false;

  constructor(private readonly deps: OverrideControlDeps) {
    this.action = deps.draft.action;

    this.root = el("div", "ab-override");
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "Maintainer override");

    this.tallyLine = el("p", "ab-override-tally");
    const roles = el("ul", "ab-override-roles");
    this.maintainerLine = el("li", "ab-override-role");
    this.maintainerLine.dataset.count = "maintainer-approvals";
    this.humanMaintainerLine = el("li", "ab-override-role");
    this.humanMaintainerLine.dataset.count = "human-maintainer-approvals";
    roles.append(this.maintainerLine, this.humanMaintainerLine);

    const actions = el("div", "ab-actions ab-override-actions");
    this.promoteBtn = el("button", "ab-btn ab-override-btn", "Promote to work");
    this.promoteBtn.type = "button";
    this.promoteBtn.dataset.override = "promote";
    this.promoteBtn.addEventListener("click", () => this.openForm("promote"));
    this.rejectBtn = el("button", "ab-btn ab-danger ab-override-btn", "Reject suggestion");
    this.rejectBtn.type = "button";
    this.rejectBtn.dataset.override = "reject";
    this.rejectBtn.addEventListener("click", () => this.openForm("reject"));
    actions.append(this.promoteBtn, this.rejectBtn);

    this.form = el("form", "ab-override-form");
    this.form.hidden = true;
    const label = el("label", "ab-field");
    this.reasonLabelEl = el("span", "ab-field-label");
    this.reason = el("textarea", "ab-textarea ab-override-reason");
    this.reason.rows = 3;
    // `aria-required` rather than `required`: native constraint validation
    // would block submit before the control could explain the actual rule
    // (a *meaningful* reason of at least three characters, recorded on the
    // override), leaving the maintainer with a generic browser bubble.
    this.reason.setAttribute("aria-required", "true");
    // Never pre-filled: an override reason is written, not accepted.
    this.reason.value = deps.draft.reason;
    this.reason.addEventListener("input", () => this.emitDraft());
    label.append(this.reasonLabelEl, this.reason);

    this.errorLine = el("p", "ab-error ab-override-error");
    this.errorLine.setAttribute("role", "alert");
    this.errorLine.hidden = true;

    const formActions = el("div", "ab-actions");
    this.confirmBtn = el("button", "ab-btn ab-primary ab-override-confirm");
    this.confirmBtn.type = "submit";
    this.confirmBtn.dataset.override = "confirm";
    const cancel = el("button", "ab-btn ab-override-cancel", "Cancel");
    cancel.type = "button";
    cancel.dataset.override = "cancel";
    cancel.addEventListener("click", () => this.closeForm());
    formActions.append(this.confirmBtn, cancel);
    this.form.append(label, this.errorLine, formActions);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });

    this.root.append(this.tallyLine, roles, actions, this.form);
    this.applyForm();
  }

  /** Re-render the tally and the open-form state in place. */
  update(annotation: Annotation): void {
    this.annotation = annotation;
    const tally = tallyOrEmpty(annotation.votes);
    const summary = tallySummary(tally);
    // The framing is explicit: this action overrides the project's rule, and
    // here is the support it is overriding.
    this.tallyLine.textContent =
      this.action === null
        ? `Overriding the project’s rule - this suggestion has ${summary}.`
        : `${verb(this.action)} overrides the project’s rule - this suggestion has ${summary}.`;
    this.maintainerLine.textContent = `Maintainer approvals: ${countText(tally.maintainerApprovals)}`;
    this.humanMaintainerLine.textContent =
      `Human maintainer approvals: ${countText(tally.humanMaintainerApprovals)}`;
    this.applyForm();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.applyEnabled();
  }

  private applyForm(): void {
    const action = this.action;
    this.form.hidden = action === null;
    if (action !== null) {
      this.reasonLabelEl.textContent = reasonLabel(action);
      this.confirmBtn.textContent = confirmLabel(action);
      this.confirmBtn.classList.toggle("ab-danger", action === "reject");
      const draft = this.deps.draft.reason;
      // Restore a draft carried across a caller re-render without ever
      // clobbering (or moving the caret in) the textarea being typed into.
      if (this.reason.value === "" && draft !== "") {
        this.reason.value = draft;
      }
    }
    this.promoteBtn.setAttribute("aria-expanded", String(action === "promote"));
    this.rejectBtn.setAttribute("aria-expanded", String(action === "reject"));
    this.applyEnabled();
  }

  private applyEnabled(): void {
    this.promoteBtn.disabled = this.busy;
    this.rejectBtn.disabled = this.busy;
    this.confirmBtn.disabled = this.busy;
  }

  private openForm(action: OverrideAction): void {
    if (this.busy) {
      return;
    }
    // Switching between the two actions keeps the typed reason: it is the same
    // sentence about the same suggestion.
    this.action = action;
    this.errorLine.hidden = true;
    this.errorLine.textContent = "";
    this.emitDraft();
    this.applyForm();
    if (this.annotation !== null) {
      this.update(this.annotation);
    }
    this.reason.focus();
  }

  private closeForm(): void {
    this.action = null;
    this.reason.value = "";
    this.errorLine.hidden = true;
    this.errorLine.textContent = "";
    this.emitDraft();
    this.applyForm();
    if (this.annotation !== null) {
      this.update(this.annotation);
    }
    this.promoteBtn.focus();
  }

  private emitDraft(): void {
    this.deps.onDraftChange({ action: this.action, reason: this.reason.value });
  }

  private showError(message: string): void {
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
  }

  private async submit(): Promise<void> {
    const action = this.action;
    if (action === null || this.busy) {
      return;
    }
    // The API trims and bounds the reason; check the same bounds here so an
    // obviously-doomed request is never sent.
    const reason = this.reason.value.trim();
    if (reason.length < MIN_REASON_LENGTH) {
      this.showError(
        `Give a reason of at least ${MIN_REASON_LENGTH} characters - it is recorded on the override.`,
      );
      this.reason.focus();
      return;
    }
    if (reason.length > MAX_REASON_LENGTH) {
      this.showError(`Keep the reason to ${MAX_REASON_LENGTH} characters or fewer.`);
      this.reason.focus();
      return;
    }
    this.errorLine.hidden = true;
    this.errorLine.textContent = "";
    const message = await this.deps.onSubmit(action, reason);
    if (message !== null) {
      this.showError(message);
      return;
    }
    // Success: the caller announces the outcome and refreshes; clear the draft
    // so a rebuilt card does not reopen a spent form.
    this.action = null;
    this.reason.value = "";
    this.emitDraft();
    this.applyForm();
  }
}
