/**
 * Vote-tally arithmetic for the serialized vote command (Phase 3 contract
 * §3): the SQL tally reflects the *committed* votes, but the rule must be
 * evaluated against the aggregate *after* this command's vote change — and
 * the vote row, the decision, and everything else land in ONE `db.batch`
 * (contract §4), so the post-change tally is computed prospectively here
 * rather than re-queried mid-batch.
 *
 * Mirrors `@authorbot/rule-engine` metric semantics exactly: `net_score` =
 * approvals − rejections; `system` approvals count toward `approvals` only,
 * never the human/agent split.
 */
import type { VoteTally } from "@authorbot/database";
import type { VoteValue } from "@authorbot/domain";

export type VoterActorType = "human" | "agent" | "system";

function apply(
  tally: {
    approvals: number;
    rejections: number;
    abstentions: number;
    humanApprovals: number;
    agentApprovals: number;
  },
  actorType: VoterActorType,
  value: VoteValue,
  delta: 1 | -1,
): void {
  switch (value) {
    case "approve":
      tally.approvals += delta;
      if (actorType === "human") tally.humanApprovals += delta;
      if (actorType === "agent") tally.agentApprovals += delta;
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
 * The tally after `actorType`'s vote changes from `previous` to `next`
 * (`null` = no vote). Pure; the input tally is not mutated.
 */
export function adjustTally(
  base: VoteTally,
  actorType: VoterActorType,
  previous: VoteValue | null,
  next: VoteValue | null,
): VoteTally {
  const tally = { ...base };
  if (previous !== null) {
    apply(tally, actorType, previous, -1);
  }
  if (next !== null) {
    apply(tally, actorType, next, 1);
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
  };
}

/** Tally → API JSON (aggregate counts only — never per-voter data, §26.1). */
export function tallyJson(tally: VoteTally): Record<string, number> {
  return {
    approvals: tally.approvals,
    rejections: tally.rejections,
    abstentions: tally.abstentions,
    netScore: tally.netScore,
    distinctVoters: tally.distinctVoters,
    humanApprovals: tally.humanApprovals,
    agentApprovals: tally.agentApprovals,
  };
}
