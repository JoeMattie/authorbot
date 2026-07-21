/**
 * Vote-tally arithmetic for the serialized vote command (Phase 3 contract
 * §3): the SQL tally reflects the *committed* votes, but the rule must be
 * evaluated against the aggregate *after* this command's vote change - and
 * the vote row, the decision, and everything else land in ONE `db.batch`
 * (contract §4), so the post-change tally is computed prospectively here
 * rather than re-queried mid-batch.
 *
 * Mirrors `@authorbot/rule-engine` metric semantics exactly: `net_score` =
 * approvals − rejections; `system` approvals count toward `approvals` only,
 * never the human/agent split; a maintainer's approval counts toward
 * `maintainer_approvals`, and toward `human_maintainer_approvals` only when
 * the maintainer is a human actor (Phase 6 contract §3.6).
 */
import type { VoteTally } from "@authorbot/database";
import type { VoteValue } from "@authorbot/domain";

export type VoterActorType = "human" | "agent" | "system";

/**
 * Who is voting, as far as the metrics care (Phase 6 contract §3.6). `role` is
 * the voter's *current* project role, read from the request's auth context -
 * the same source the SQL tally's membership join reads, so the prospective
 * adjustment and the next SQL tally cannot disagree about who is a maintainer.
 */
export interface Voter {
  readonly actorType: VoterActorType;
  /** Current project role, or null for a non-member. */
  readonly role: string | null;
}

function apply(
  tally: {
    approvals: number;
    rejections: number;
    abstentions: number;
    humanApprovals: number;
    agentApprovals: number;
    maintainerApprovals: number;
    humanMaintainerApprovals: number;
  },
  voter: Voter,
  value: VoteValue,
  delta: 1 | -1,
): void {
  const { actorType } = voter;
  const isMaintainer = voter.role === "maintainer";
  switch (value) {
    case "approve":
      tally.approvals += delta;
      if (actorType === "human") tally.humanApprovals += delta;
      if (actorType === "agent") tally.agentApprovals += delta;
      if (isMaintainer) {
        tally.maintainerApprovals += delta;
        if (actorType === "human") tally.humanMaintainerApprovals += delta;
      }
      break;
    case "reject":
      tally.rejections += delta;
      break;
    case "abstain":
      tally.abstentions += delta;
      break;
  }
}

/**
 * The tally after `voter`'s vote changes from `previous` to `next`
 * (`null` = no vote). Pure; the input tally is not mutated.
 */
export function adjustTally(
  base: VoteTally,
  voter: Voter,
  previous: VoteValue | null,
  next: VoteValue | null,
): VoteTally {
  const tally = { ...base };
  if (previous !== null) {
    apply(tally, voter, previous, -1);
  }
  if (next !== null) {
    apply(tally, voter, next, 1);
  }
  if (previous === null && next !== null) {
    tally.distinctVoters += 1;
  }
  if (previous !== null && next === null) {
    tally.distinctVoters -= 1;
  }
  tally.netScore = tally.approvals - tally.rejections;
  return tally;
}

/** Tally → the rule-engine metric record (contract §2 vocabulary). */
export function tallyToMetrics(tally: VoteTally): Record<string, number> {
  return {
    approvals: tally.approvals,
    rejections: tally.rejections,
    abstentions: tally.abstentions,
    net_score: tally.netScore,
    distinct_voters: tally.distinctVoters,
    human_approvals: tally.humanApprovals,
    agent_approvals: tally.agentApprovals,
    maintainer_approvals: tally.maintainerApprovals,
    human_maintainer_approvals: tally.humanMaintainerApprovals,
  };
}

/** Tally → API JSON (aggregate counts only - never per-voter data, §26.1). */
export function tallyJson(tally: VoteTally): Record<string, number> {
  return {
    approvals: tally.approvals,
    rejections: tally.rejections,
    abstentions: tally.abstentions,
    netScore: tally.netScore,
    distinctVoters: tally.distinctVoters,
    humanApprovals: tally.humanApprovals,
    agentApprovals: tally.agentApprovals,
    maintainerApprovals: tally.maintainerApprovals,
    humanMaintainerApprovals: tally.humanMaintainerApprovals,
  };
}
