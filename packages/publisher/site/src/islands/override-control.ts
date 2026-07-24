/**
 * Maintainer actions for an open annotation.
 *
 * Phase 11 makes promotion deliberately immediate: one button creates Work
 * for either a comment or suggestion, with no rationale or confirmation.
 * Reject remains suggestion-only and keeps the existing reason form. The API
 * is still the authorization boundary; this control only decides which
 * affordances to offer.
 */
import type { Annotation } from "./api.js";
import { el, iconButton } from "./dom.js";
import { tallyOrEmpty, tallySummary } from "./vote-view.js";

export type OverrideAction = "promote" | "reject";

/** Only reject has a draft now; the wider action type keeps stored Phase 6
 * state harmless across a rolling deployment. */
export interface OverrideDraft {
  action: OverrideAction | null;
  reason: string;
}

export interface OverrideControlDeps {
  draft: OverrideDraft;
  canPromote: boolean;
  canReject: boolean;
  compactPromotion?: boolean;
  onDraftChange: (draft: OverrideDraft) => void;
  onSubmit: (action: OverrideAction, reason?: string) => Promise<string | null>;
}

/** Mirrors the reason bounds in `@authorbot/domain` for rejection only. */
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 2000;

const NOT_REPORTED = "Not reported";

/** Promotion applies to either annotation kind, but only while it is open. */
export function canOverride(annotation: Annotation): boolean {
  return annotation.status === "open";
}

function countText(value: number | undefined): string {
  return typeof value === "number" ? String(value) : NOT_REPORTED;
}

export class OverrideControl {
  readonly root: HTMLElement;
  private readonly contextLine: HTMLElement;
  private readonly roles: HTMLElement;
  private readonly maintainerLine: HTMLElement;
  private readonly humanMaintainerLine: HTMLElement;
  private readonly promoteBtn: HTMLButtonElement;
  private readonly rejectBtn: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly reason: HTMLTextAreaElement;
  private readonly errorLine: HTMLElement;
  private readonly confirmBtn: HTMLButtonElement;
  private annotation: Annotation | null = null;
  private action: "reject" | null;
  private busy = false;

  constructor(private readonly deps: OverrideControlDeps) {
    this.action = deps.draft.action === "reject" ? "reject" : null;

    this.root = el("div", "ab-override");
    this.root.classList.toggle("ab-override-compact", deps.compactPromotion === true);
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", "Maintainer actions");

    this.contextLine = el("p", "ab-override-tally");
    this.roles = el("ul", "ab-override-roles");
    this.maintainerLine = el("li", "ab-override-role");
    this.maintainerLine.dataset.count = "maintainer-approvals";
    this.humanMaintainerLine = el("li", "ab-override-role");
    this.humanMaintainerLine.dataset.count = "human-maintainer-approvals";
    this.roles.append(this.maintainerLine, this.humanMaintainerLine);

    const actions = el("div", "ab-actions ab-override-actions");
    this.promoteBtn = deps.compactPromotion === true
      ? iconButton(
          "ab-btn ab-icon-btn ab-outline-action ab-override-btn",
          "Promote to work",
          "check",
        )
      : el("button", "ab-btn ab-primary ab-override-btn", "Promote to work");
    this.promoteBtn.type = "button";
    this.promoteBtn.dataset.override = "promote";
    this.promoteBtn.addEventListener("click", () => void this.promote());

    this.rejectBtn = el("button", "ab-btn ab-danger ab-override-btn", "Reject suggestion");
    this.rejectBtn.type = "button";
    this.rejectBtn.dataset.override = "reject";
    this.rejectBtn.addEventListener("click", () => this.openRejectForm());
    actions.append(this.promoteBtn, this.rejectBtn);

    // Promotion errors must be visible even though promotion has no form.
    this.errorLine = el("p", "ab-error ab-override-error");
    this.errorLine.setAttribute("role", "alert");
    this.errorLine.hidden = true;

    this.form = el("form", "ab-override-form");
    this.form.hidden = true;
    const label = el("label", "ab-field");
    label.append(el("span", "ab-field-label", "Why reject this suggestion? (recorded on the override)"));
    this.reason = el("textarea", "ab-textarea ab-override-reason");
    this.reason.rows = 3;
    this.reason.setAttribute("aria-required", "true");
    this.reason.value = deps.draft.reason;
    this.reason.addEventListener("input", () => this.emitDraft());
    label.append(this.reason);

    const formActions = el("div", "ab-actions");
    this.confirmBtn = el("button", "ab-btn ab-danger ab-override-confirm", "Reject suggestion");
    this.confirmBtn.type = "submit";
    this.confirmBtn.dataset.override = "confirm";
    const cancel = el("button", "ab-btn ab-override-cancel", "Cancel");
    cancel.type = "button";
    cancel.dataset.override = "cancel";
    cancel.addEventListener("click", () => this.closeRejectForm());
    formActions.append(this.confirmBtn, cancel);
    this.form.append(label, formActions);
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.reject();
    });

    this.root.append(this.contextLine, this.roles, actions, this.errorLine, this.form);
    this.applyForm();
  }

  update(annotation: Annotation): void {
    this.annotation = annotation;
    const suggestion = annotation.kind === "suggestion";
    this.promoteBtn.hidden = !this.deps.canPromote;
    this.rejectBtn.hidden = !suggestion || !this.deps.canReject;
    this.roles.hidden = !suggestion;
    if (suggestion) {
      const tally = tallyOrEmpty(annotation.votes);
      this.contextLine.textContent = `This suggestion has ${tallySummary(tally)}.`;
      this.maintainerLine.textContent = `Maintainer approvals: ${countText(tally.maintainerApprovals)}`;
      this.humanMaintainerLine.textContent =
        `Human maintainer approvals: ${countText(tally.humanMaintainerApprovals)}`;
    } else {
      this.contextLine.textContent = "Turn this note into tracked work.";
    }
    if ((!suggestion || !this.deps.canReject) && this.action === "reject") {
      this.action = null;
      this.reason.value = "";
      this.emitDraft();
    }
    this.applyForm();
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.applyEnabled();
  }

  private applyForm(): void {
    this.form.hidden = this.action !== "reject";
    this.rejectBtn.setAttribute("aria-expanded", String(this.action === "reject"));
    if (this.action === "reject" && this.reason.value === "" && this.deps.draft.reason !== "") {
      this.reason.value = this.deps.draft.reason;
    }
    this.applyEnabled();
  }

  private applyEnabled(): void {
    this.promoteBtn.disabled = this.busy;
    this.rejectBtn.disabled = this.busy;
    this.confirmBtn.disabled = this.busy;
  }

  private clearError(): void {
    this.errorLine.hidden = true;
    this.errorLine.textContent = "";
  }

  private showError(message: string): void {
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
  }

  private async promote(): Promise<void> {
    if (this.busy || !this.deps.canPromote) return;
    this.clearError();
    const message = await this.deps.onSubmit("promote");
    if (message !== null) this.showError(message);
  }

  private openRejectForm(): void {
    if (this.busy || !this.deps.canReject || this.annotation?.kind !== "suggestion") return;
    this.action = "reject";
    this.clearError();
    this.emitDraft();
    this.applyForm();
    this.reason.focus();
  }

  private closeRejectForm(): void {
    this.action = null;
    this.reason.value = "";
    this.clearError();
    this.emitDraft();
    this.applyForm();
    this.rejectBtn.focus();
  }

  private emitDraft(): void {
    this.deps.onDraftChange({ action: this.action, reason: this.reason.value });
  }

  private async reject(): Promise<void> {
    if (this.action !== "reject" || this.busy) return;
    const reason = this.reason.value.trim();
    if (reason.length < MIN_REASON_LENGTH) {
      this.showError(
        `Give a reason of at least ${MIN_REASON_LENGTH} characters. It is recorded on the override.`,
      );
      this.reason.focus();
      return;
    }
    if (reason.length > MAX_REASON_LENGTH) {
      this.showError(`Keep the reason to ${MAX_REASON_LENGTH} characters or fewer.`);
      this.reason.focus();
      return;
    }
    this.clearError();
    const message = await this.deps.onSubmit("reject", reason);
    if (message !== null) {
      this.showError(message);
      return;
    }
    this.action = null;
    this.reason.value = "";
    this.emitDraft();
    this.applyForm();
  }
}
