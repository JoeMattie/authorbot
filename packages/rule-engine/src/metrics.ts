/**
 * Vote-tally metric computation (Phase 3 contract section 2). Pure: plain
 * vote tuples in, a complete metric record out. The metric vocabulary is the
 * closed design section 11.1 subset the contract pins for Phase 3.
 */

/** Vote values (contract section 2; mirrors `authorbot.instance/v1` `votes.values`). */
export const VOTE_VALUES = ["approve", "reject", "abstain"] as const;
export type VoteValue = (typeof VOTE_VALUES)[number];

/** Actor types as stored in `actors.type` (Phase 2 migration 0001). */
export const VOTER_ACTOR_TYPES = ["human", "agent", "system"] as const;
export type VoterActorType = (typeof VOTER_ACTOR_TYPES)[number];

/**
 * One current vote, reduced to what metrics need. Callers pass one tuple per
 * voter: the `votes` table is unique on `(annotation_id, actor_id)` (one
 * current vote per actor), so the caller's SELECT already yields distinct
 * voters and no actor id is needed here (aggregate-only, design section 26.1).
 */
export interface VoteTuple {
  readonly value: VoteValue;
  readonly actorType: VoterActorType;
  /**
   * Whether the voter holds the **maintainer** role on the project at the time
   * the tally is computed (Phase 6 contract section 3.6). Optional so
   * pre-Phase-6 callers keep compiling; absent is read as "not a maintainer",
   * which fails closed — an uncounted maintainer approval can only make a rule
   * harder to satisfy, never easier.
   */
  readonly maintainer?: boolean;
}

/**
 * Closed metric vocabulary: the Phase 3 section 2 subset plus the two Phase 6
 * section 3.6 role-aware metrics.
 */
export const METRIC_NAMES = [
  "approvals",
  "rejections",
  "abstentions",
  "net_score",
  "distinct_voters",
  "human_approvals",
  "agent_approvals",
  "maintainer_approvals",
  "human_maintainer_approvals",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export type VoteMetrics = Readonly<Record<MetricName, number>>;

const VOTE_VALUE_SET: ReadonlySet<string> = new Set(VOTE_VALUES);
const ACTOR_TYPE_SET: ReadonlySet<string> = new Set(VOTER_ACTOR_TYPES);

/** All-zero tally (the aggregate of an annotation nobody voted on). */
export const EMPTY_VOTE_METRICS: VoteMetrics = Object.freeze({
  approvals: 0,
  rejections: 0,
  abstentions: 0,
  net_score: 0,
  distinct_voters: 0,
  human_approvals: 0,
  agent_approvals: 0,
  maintainer_approvals: 0,
  human_maintainer_approvals: 0,
});

/**
 * Compute the full Phase 3 metric record from current-vote tuples.
 *
 * - `net_score` = approvals − rejections (abstentions are neutral).
 * - `distinct_voters` = tuple count (one-current-vote semantics; see
 *   {@link VoteTuple}).
 * - `human_approvals` / `agent_approvals` split approvals by actor type;
 *   `system` approvals count toward `approvals` only.
 * - `maintainer_approvals` counts approvals from any actor holding the
 *   maintainer role — human or agent.
 * - `human_maintainer_approvals` counts only maintainers whose actor type is
 *   `human`. The distinction is load-bearing rather than pedantic: Phase 7
 *   lets an author grant maintainer role to their own agent tokens, so a plain
 *   `maintainer_approvals` clause would be satisfiable by an agent the author
 *   owns — exactly the manufactured-consensus hole the human-approval
 *   requirement exists to close (Phase 6 contract section 3.6).
 *
 * Fails closed on malformed input: an unknown vote value or actor type throws
 * (it can only mean a corrupted row — never silently miscount governance).
 */
export function computeVoteMetrics(votes: readonly VoteTuple[]): VoteMetrics {
  let approvals = 0;
  let rejections = 0;
  let abstentions = 0;
  let humanApprovals = 0;
  let agentApprovals = 0;
  let maintainerApprovals = 0;
  let humanMaintainerApprovals = 0;

  for (const vote of votes) {
    if (!VOTE_VALUE_SET.has(vote.value)) {
      throw new RangeError(`unknown vote value: ${JSON.stringify(vote.value)}`);
    }
    if (!ACTOR_TYPE_SET.has(vote.actorType)) {
      throw new RangeError(`unknown voter actor type: ${JSON.stringify(vote.actorType)}`);
    }
    switch (vote.value) {
      case "approve":
        approvals += 1;
        if (vote.actorType === "human") humanApprovals += 1;
        if (vote.actorType === "agent") agentApprovals += 1;
        if (vote.maintainer === true) {
          maintainerApprovals += 1;
          if (vote.actorType === "human") humanMaintainerApprovals += 1;
        }
        break;
      case "reject":
        rejections += 1;
        break;
      case "abstain":
        abstentions += 1;
        break;
    }
  }

  return {
    approvals,
    rejections,
    abstentions,
    net_score: approvals - rejections,
    distinct_voters: votes.length,
    human_approvals: humanApprovals,
    agent_approvals: agentApprovals,
    maintainer_approvals: maintainerApprovals,
    human_maintainer_approvals: humanMaintainerApprovals,
  };
}
