import { describe, expect, it } from "vitest";
import {
  EMPTY_VOTE_METRICS,
  METRIC_NAMES,
  computeVoteMetrics,
  type VoteMetrics,
  type VoteTuple,
} from "../src/index.js";

function vote(value: VoteTuple["value"], actorType: VoteTuple["actorType"]): VoteTuple {
  return { value, actorType };
}

describe("computeVoteMetrics", () => {
  it("empty tally is all zeros and covers every metric name", () => {
    const metrics = computeVoteMetrics([]);
    expect(metrics).toEqual(EMPTY_VOTE_METRICS);
    expect(Object.keys(metrics).sort()).toEqual([...METRIC_NAMES].sort());
    for (const name of METRIC_NAMES) {
      expect(metrics[name]).toBe(0);
    }
  });

  it("counts a mixed tally with the human/agent approval split", () => {
    const metrics = computeVoteMetrics([
      vote("approve", "human"),
      vote("approve", "agent"),
      vote("approve", "agent"),
      vote("reject", "human"),
      vote("abstain", "agent"),
    ]);
    expect(metrics).toEqual<VoteMetrics>({
      approvals: 3,
      rejections: 1,
      abstentions: 1,
      net_score: 2,
      distinct_voters: 5,
      human_approvals: 1,
      agent_approvals: 2,
    });
  });

  it("net_score goes negative when rejections dominate; abstentions are neutral", () => {
    const metrics = computeVoteMetrics([
      vote("approve", "human"),
      vote("reject", "agent"),
      vote("reject", "human"),
      vote("reject", "agent"),
      vote("abstain", "human"),
      vote("abstain", "human"),
    ]);
    expect(metrics.net_score).toBe(-2);
    expect(metrics.abstentions).toBe(2);
    expect(metrics.distinct_voters).toBe(6);
  });

  it("system approvals count toward approvals but neither human nor agent split", () => {
    const metrics = computeVoteMetrics([vote("approve", "system")]);
    expect(metrics.approvals).toBe(1);
    expect(metrics.human_approvals).toBe(0);
    expect(metrics.agent_approvals).toBe(0);
  });

  it("rejections and abstentions do not contribute to the approval splits", () => {
    const metrics = computeVoteMetrics([
      vote("reject", "human"),
      vote("abstain", "human"),
      vote("reject", "agent"),
    ]);
    expect(metrics.human_approvals).toBe(0);
    expect(metrics.agent_approvals).toBe(0);
    expect(metrics.approvals).toBe(0);
  });

  it("distinct_voters equals the tuple count (one current vote per actor)", () => {
    const metrics = computeVoteMetrics([
      vote("approve", "human"),
      vote("approve", "human"),
      vote("reject", "agent"),
    ]);
    expect(metrics.distinct_voters).toBe(3);
  });

  it("throws on an unknown vote value (fail closed, never miscount)", () => {
    expect(() =>
      computeVoteMetrics([{ value: "upvote", actorType: "human" } as unknown as VoteTuple]),
    ).toThrow(RangeError);
  });

  it("throws on an unknown actor type", () => {
    expect(() =>
      computeVoteMetrics([{ value: "approve", actorType: "robot" } as unknown as VoteTuple]),
    ).toThrow(RangeError);
  });

  it("EMPTY_VOTE_METRICS is frozen", () => {
    expect(Object.isFrozen(EMPTY_VOTE_METRICS)).toBe(true);
  });
});
