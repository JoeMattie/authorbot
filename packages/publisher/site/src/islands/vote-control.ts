/**
 * `VoteControl` — the approve/reject/abstain segmented control with a live
 * aggregate tally and the "Queued as work item" badge (Phase 3 contract §6).
 * Framework-free; owns its own subtree and updates it in place so a live
 * tally refresh (SSE/poll) never rebuilds the card or steals keyboard focus.
 *
 * Security/accessibility invariants (contract §6, §2b §3/§4):
 * - Every string reaches the DOM via `textContent` (never `innerHTML`).
 * - Each segment is a real `<button>` with `aria-pressed` reflecting the
 *   viewer's current vote; the group is labelled and the tally is announced.
 * - Controls are enabled only when the viewer holds `votes:write`.
 */
import type { Annotation, VoteValue } from "./api.js";
import { el, srOnly } from "./dom.js";
import {
  VOTE_VALUES,
  countFor,
  decisionBadge,
  isCurrentVote,
  labelFor,
  tallyOrEmpty,
  tallySummary,
} from "./vote-view.js";

export interface VoteControlDeps {
  /** The viewer holds `votes:write` (enables the segments). */
  canVote: boolean;
  /** The viewer is authenticated (drives the disabled-state hint copy). */
  signedIn: boolean;
  /** Cast (value) or clear (null) the viewer's vote. */
  onVote: (value: VoteValue | null) => void;
  /** A signed-out viewer tried to vote: lead them to sign-in, not a dead end. */
  onSignIn: () => void;
}

export class VoteControl {
  readonly root: HTMLElement;
  private readonly buttons = new Map<VoteValue, HTMLButtonElement>();
  private readonly countEls = new Map<VoteValue, HTMLElement>();
  private readonly tallyLine: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly badgeArea: HTMLElement;
  private annotation: Annotation | null = null;
  private busy = false;

  constructor(private readonly deps: VoteControlDeps) {
    this.root = el("div", "ab-votes");

    const group = el("div", "ab-vote-seg");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Vote on this suggestion");
    for (const value of VOTE_VALUES) {
      const button = el("button", "ab-vote-btn");
      button.type = "button";
      button.dataset.vote = value;
      button.setAttribute("aria-pressed", "false");
      const count = el("span", "ab-vote-count", "0");
      count.setAttribute("aria-hidden", "true"); // the count is in the sr label
      button.append(
        el("span", "ab-vote-label", labelFor(value)),
        count,
        srOnly(`${labelFor(value)}: 0`),
      );
      button.addEventListener("click", () => this.onClick(value));
      this.buttons.set(value, button);
      this.countEls.set(value, count);
      group.append(button);
    }
    this.root.append(group);

    this.tallyLine = el("p", "ab-vote-tally");
    this.hint = el("p", "ab-hint ab-vote-hint");
    this.hint.hidden = true;
    this.badgeArea = el("div", "ab-badge-area");
    this.root.append(this.tallyLine, this.hint, this.badgeArea);
  }

  /** Announce copy for the caller's live region after a vote settles. */
  summary(): string {
    return this.annotation === undefined || this.annotation === null
      ? ""
      : tallySummary(tallyOrEmpty(this.annotation.votes));
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.applyEnabled();
  }

  /** Re-render the tally, current-vote highlighting, and badge in place. */
  update(annotation: Annotation): void {
    this.annotation = annotation;
    const tally = tallyOrEmpty(annotation.votes);
    for (const value of VOTE_VALUES) {
      const count = countFor(tally, value);
      const countEl = this.countEls.get(value);
      if (countEl !== undefined) {
        countEl.textContent = String(count);
      }
      const button = this.buttons.get(value);
      if (button !== undefined) {
        const current = isCurrentVote(annotation.myVote, value);
        button.setAttribute("aria-pressed", String(current));
        button.classList.toggle("ab-vote-current", current);
        const label = button.querySelector(".ab-sr");
        if (label !== null) {
          label.textContent = `${labelFor(value)}: ${count}${current ? " (your vote)" : ""}`;
        }
      }
    }
    this.tallyLine.textContent = tallySummary(tally);

    if (!this.deps.canVote) {
      this.hint.hidden = false;
      this.hint.textContent = this.deps.signedIn
        ? "Your role can’t vote here."
        : "Sign in to vote.";
    } else {
      this.hint.hidden = true;
    }
    this.applyEnabled();

    this.badgeArea.textContent = "";
    const badge = decisionBadge(annotation.decision);
    if (badge !== null) {
      const chip = el(
        "span",
        `ab-badge${badge.supportChanged ? " ab-badge-support-changed" : ""}`,
        badge.text,
      );
      this.badgeArea.append(chip);
      if (badge.detail !== null) {
        this.badgeArea.append(el("p", "ab-hint ab-badge-detail", badge.detail));
      }
    }
  }

  private applyEnabled(): void {
    const enabled = this.deps.canVote && !this.busy;
    for (const button of this.buttons.values()) {
      button.disabled = !enabled;
    }
  }

  private onClick(value: VoteValue): void {
    if (!this.deps.canVote) {
      if (!this.deps.signedIn) {
        this.deps.onSignIn();
      }
      return;
    }
    if (this.busy) {
      return;
    }
    // Clicking the current vote toggles it off (clear); otherwise cast/change.
    const current = isCurrentVote(this.annotation?.myVote, value);
    this.deps.onVote(current ? null : value);
  }
}
