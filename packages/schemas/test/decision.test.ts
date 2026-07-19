import { describe, it } from "vitest";
import { decisionSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, validDecision } from "./samples.js";

describe("decisionSchema", () => {
  it("accepts a full decision record", () => {
    expectValid(decisionSchema, validDecision);
  });

  it("accepts a rejection without a work item", () => {
    const rejected = clone(validDecision);
    rejected.result = "rejected";
    delete rejected.work_item_id;
    rejected.override_reason = "Maintainer veto.";
    expectValid(decisionSchema, rejected);
  });

  it("rejects an unknown result", () => {
    const bad = clone(validDecision);
    bad.result = "approved";
    expectInvalid(decisionSchema, bad);
  });

  it("rejects non-numeric metrics", () => {
    const bad = clone(validDecision);
    bad.metrics = { approvals: "three" };
    expectInvalid(decisionSchema, bad);
  });

  it("rejects a missing effective_at", () => {
    const bad = clone(validDecision);
    delete bad.effective_at;
    expectInvalid(decisionSchema, bad);
  });

  it("rejects rule_version 0", () => {
    const bad = clone(validDecision);
    bad.rule_version = 0;
    expectInvalid(decisionSchema, bad);
  });

  it("rejects a UUIDv4 source_annotation_id", () => {
    const bad = clone(validDecision);
    bad.source_annotation_id = BAD_UUID_V4;
    expectInvalid(decisionSchema, bad);
  });

  it("rejects an unknown key", () => {
    const bad = clone(validDecision);
    bad.voters = ["github:octocat"];
    expectInvalid(decisionSchema, bad);
  });

  it("rejects a bad effective_at timestamp", () => {
    const bad = clone(validDecision);
    bad.effective_at = "2026-07-19T18:15:00";
    expectInvalid(decisionSchema, bad);
  });
});
