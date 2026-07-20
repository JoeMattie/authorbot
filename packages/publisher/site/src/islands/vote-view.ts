/**
 * Pure presentation helpers for the Phase 3 vote control and decision badge
 * (contract §6). No DOM, no network — the arithmetic and copy are unit tested
 * in isolation, and both the suggestion cards and the `/work/` queue reuse
 * them.
 */
import type { DecisionSummary, VoteTally, VoteValue } from "./api.js";

/** The three votable positions, in the order the segmented control renders. */
export const VOTE_VALUES: readonly VoteValue[] = ["approve", "reject", "abstain"];

const EMPTY_TALLY: VoteTally = {
  approvals: 0,
  rejections: 0,
  abstentions: 0,
  netScore: 0,
  distinctVoters: 0,
  humanApprovals: 0,
  agentApprovals: 0,
};

/** A tally that may be absent (comment reads, optimistic gaps) → zeros. */
export function tallyOrEmpty(tally: VoteTally | undefined | null): VoteTally {
  return tally ?? EMPTY_TALLY;
}

/** The count backing one segment's inline number. */
export function countFor(tally: VoteTally, value: VoteValue): number {
  switch (value) {
    case "approve":
      return tally.approvals;
    case "reject":
      return tally.rejections;
    case "abstain":
      return tally.abstentions;
  }
}

/** Human label for a segment button. */
export function labelFor(value: VoteValue): string {
  switch (value) {
    case "approve":
      return "Approve";
    case "reject":
      return "Reject";
    case "abstain":
      return "Abstain";
  }
}

/**
 * A one-line, screen-reader-friendly summary of the aggregate tally — used
 * for the control's `aria-label`/announcements and the `/work/` support
 * column. Aggregate only (§26.1: never per-voter).
 */
export function tallySummary(tally: VoteTally): string {
  const t = tallyOrEmpty(tally);
  const voters = t.distinctVoters === 1 ? "1 voter" : `${t.distinctVoters} voters`;
  return (
    `${t.approvals} approve, ${t.rejections} reject, ${t.abstentions} abstain` +
    ` (net ${formatNet(t.netScore)}, ${voters})`
  );
}

/** Net score with an explicit sign so "+2" and "-1" read unambiguously. */
export function formatNet(net: number): string {
  return net > 0 ? `+${net}` : String(net);
}

/**
 * Whether a segment is the viewer's current vote (drives `aria-pressed` and
 * the highlighted state). `myVote` is member-only; `null`/absent means the
 * viewer has not voted (or cannot see their own vote).
 */
export function isCurrentVote(myVote: VoteValue | null | undefined, value: VoteValue): boolean {
  return myVote === value;
}

export interface Badge {
  /** Visible chip text. */
  text: string;
  /** True when the decision no longer meets the rule (§4 sticky honesty). */
  supportChanged: boolean;
  /** Extra line shown under the badge when support has changed. */
  detail: string | null;
}

/**
 * The "Queued as work item" badge for a suggestion (contract §6). Present only
 * once a `create_work_item` decision exists; `support_changed` is surfaced
 * honestly rather than hidden — the work item is still queued, but the vote
 * aggregate has since fallen back below the rule.
 */
export function decisionBadge(decision: DecisionSummary | null | undefined): Badge | null {
  if (decision === null || decision === undefined) {
    return null;
  }
  if (decision.result !== "create_work_item") {
    return null;
  }
  const supportChanged = decision.supportChanged === true;
  return {
    text: "Queued as work item",
    supportChanged,
    detail: supportChanged
      ? "Support has since dropped below the threshold; the work item remains queued."
      : null,
  };
}
