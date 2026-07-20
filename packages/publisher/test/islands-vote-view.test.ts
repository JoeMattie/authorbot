import { describe, expect, it } from "vitest";
import type { DecisionSummary, VoteTally } from "../site/src/islands/api.js";
import {
  VOTE_VALUES,
  countFor,
  decisionBadge,
  formatNet,
  isCurrentVote,
  labelFor,
  tallyOrEmpty,
  tallySummary,
} from "../site/src/islands/vote-view.js";

/** Pure vote-tally / badge rendering (Phase 3 contract §6). */

const tally = (over: Partial<VoteTally> = {}): VoteTally => ({
  approvals: 0,
  rejections: 0,
  abstentions: 0,
  netScore: 0,
  distinctVoters: 0,
  humanApprovals: 0,
  agentApprovals: 0,
  ...over,
});

describe("tally rendering", () => {
  it("orders the segments approve, reject, abstain", () => {
    expect(VOTE_VALUES).toEqual(["approve", "reject", "abstain"]);
    expect(VOTE_VALUES.map(labelFor)).toEqual(["Approve", "Reject", "Abstain"]);
  });

  it("reads the count backing each segment", () => {
    const t = tally({ approvals: 3, rejections: 1, abstentions: 2 });
    expect(countFor(t, "approve")).toBe(3);
    expect(countFor(t, "reject")).toBe(1);
    expect(countFor(t, "abstain")).toBe(2);
  });

  it("substitutes zeros for an absent tally", () => {
    const empty = tallyOrEmpty(undefined);
    expect(countFor(empty, "approve")).toBe(0);
    expect(tallyOrEmpty(null).distinctVoters).toBe(0);
  });

  it("signs the net score explicitly", () => {
    expect(formatNet(2)).toBe("+2");
    expect(formatNet(0)).toBe("0");
    expect(formatNet(-1)).toBe("-1");
  });

  it("summarizes an aggregate tally in one screen-reader line (counts only)", () => {
    const summary = tallySummary(
      tally({ approvals: 3, rejections: 1, abstentions: 0, netScore: 2, distinctVoters: 4 }),
    );
    expect(summary).toBe("3 approve, 1 reject, 0 abstain (net +2, 4 voters)");
  });

  it("singularizes a lone voter", () => {
    expect(tallySummary(tally({ approvals: 1, netScore: 1, distinctVoters: 1 }))).toContain(
      "1 voter)",
    );
  });

  it("never leaks per-voter identity — summary is aggregate arithmetic only", () => {
    const summary = tallySummary(
      tally({ approvals: 2, humanApprovals: 1, agentApprovals: 1, distinctVoters: 2, netScore: 2 }),
    );
    // The human/agent split is not exposed in the reader-facing summary.
    expect(summary).not.toContain("human");
    expect(summary).not.toContain("agent");
  });
});

describe("current-vote highlighting", () => {
  it("marks only the viewer's own vote as pressed", () => {
    expect(isCurrentVote("approve", "approve")).toBe(true);
    expect(isCurrentVote("approve", "reject")).toBe(false);
    expect(isCurrentVote(null, "approve")).toBe(false);
    expect(isCurrentVote(undefined, "abstain")).toBe(false);
  });
});

describe("decisionBadge", () => {
  const decision = (over: Partial<DecisionSummary> = {}): DecisionSummary => ({
    id: "d-1",
    actionType: "create_work_item",
    result: "create_work_item",
    supportChanged: false,
    workItemId: "w-1",
    ...over,
  });

  it("is null without a decision", () => {
    expect(decisionBadge(null)).toBeNull();
    expect(decisionBadge(undefined)).toBeNull();
  });

  it("shows the queued badge for a create_work_item decision", () => {
    const badge = decisionBadge(decision());
    expect(badge?.text).toBe("Queued as work item");
    expect(badge?.supportChanged).toBe(false);
    expect(badge?.detail).toBeNull();
  });

  it("surfaces support_changed honestly (still queued, but with a detail line)", () => {
    const badge = decisionBadge(decision({ supportChanged: true }));
    expect(badge?.supportChanged).toBe(true);
    expect(badge?.detail).toContain("below the threshold");
    expect(badge?.text).toBe("Queued as work item");
  });

  it("shows no badge for a non-create decision (e.g. a rejection)", () => {
    expect(decisionBadge(decision({ result: "rejected" }))).toBeNull();
  });
});
