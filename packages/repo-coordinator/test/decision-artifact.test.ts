import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { decisionSchema } from "@authorbot/schemas";
import {
  decisionFilePath,
  parseDecisionArtifact,
  renderDecisionArtifact,
  type DecisionArtifactInput,
} from "../src/index.js";

const BASE: DecisionArtifactInput = {
  id: "0190f400-0000-7000-8000-000000000001",
  sourceAnnotationId: "0190f300-0000-7000-8000-000000000002",
  rule: "suggestion_to_work_item",
  ruleVersion: 1,
  metrics: { approvals: 3, net_score: 2, human_approvals: 1 },
  result: "create_work_item",
  supportChanged: false,
  workItemId: "0190f500-0000-7000-8000-000000000003",
  effectiveAt: "2026-07-19T18:20:00Z",
};

describe("renderDecisionArtifact", () => {
  it("emits authorbot.decision/v1 YAML at the stable path", () => {
    const file = renderDecisionArtifact(BASE);
    expect(file.path).toBe(`.authorbot/decisions/${BASE.id}.yml`);
    expect(decisionFilePath(BASE.id)).toBe(file.path);
    const doc = decisionSchema.parse(parse(file.content));
    expect(doc.schema).toBe("authorbot.decision/v1");
    expect(doc.result).toBe("create_work_item");
    expect(doc.work_item_id).toBe(BASE.workItemId);
  });

  it("is byte-stable and ends with exactly one trailing newline", () => {
    const a = renderDecisionArtifact(BASE);
    const b = renderDecisionArtifact({
      ...BASE,
      // Different key order must not change bytes (metrics sorted).
      metrics: { human_approvals: 1, approvals: 3, net_score: 2 },
    });
    expect(a.content).toBe(b.content);
    expect(a.content.endsWith("\n")).toBe(true);
    expect(a.content.endsWith("\n\n")).toBe(false);
  });

  it("sorts metric keys deterministically", () => {
    const content = renderDecisionArtifact(BASE).content;
    const lines = content.split("\n");
    const metricStart = lines.findIndex((l) => l === "metrics:");
    const keys = lines
      .slice(metricStart + 1)
      .filter((l) => l.startsWith("  "))
      .map((l) => l.trim().split(":")[0]);
    expect(keys).toEqual(["approvals", "human_approvals", "net_score"]);
  });

  it("renders result: support_changed when the flag is set, keeping other lines", () => {
    const clear = renderDecisionArtifact(BASE);
    const changed = renderDecisionArtifact({ ...BASE, supportChanged: true });
    expect(parse(changed.content).result).toBe("support_changed");
    // Only the `result` line differs between the two renders (design §11.3).
    const diff = lineDiff(clear.content, changed.content);
    expect(diff).toEqual(["result"]);
  });

  it("accepts rule_version 0 (force-create) despite the canonical schema pin", () => {
    const file = renderDecisionArtifact({
      ...BASE,
      ruleVersion: 0,
      result: "overridden",
      rule: "maintainer_force_create",
      overrideReason: "Editorial call before the release freeze.",
    });
    const doc = parse(file.content);
    expect(doc.rule_version).toBe(0);
    expect(doc.result).toBe("overridden");
    expect(doc.override_reason).toBe("Editorial call before the release freeze.");
  });

  it("rejects support_changed passed as a stored result", () => {
    expect(() => renderDecisionArtifact({ ...BASE, result: "support_changed" })).toThrow(
      /derived at render time/,
    );
  });

  it("rejects supportChanged without a work item", () => {
    expect(() =>
      renderDecisionArtifact({ ...BASE, workItemId: null, supportChanged: true }),
    ).toThrow(/only meaningful/);
  });
});

describe("parseDecisionArtifact", () => {
  it("round-trips a rule crossing (supportChanged false)", () => {
    const file = renderDecisionArtifact(BASE);
    const parsed = parseDecisionArtifact(file.content);
    expect(parsed.result).toBe("create_work_item");
    expect(parsed.supportChanged).toBe(false);
    expect(parsed.artifact.id).toBe(BASE.id);
    expect(parsed.artifact.metrics).toEqual(BASE.metrics);
  });

  it("decodes support_changed back to the stored create_work_item result", () => {
    const file = renderDecisionArtifact({ ...BASE, supportChanged: true });
    const parsed = parseDecisionArtifact(file.content);
    expect(parsed.result).toBe("create_work_item");
    expect(parsed.supportChanged).toBe(true);
  });

  it("decodes support_changed on a force-create back to overridden", () => {
    const file = renderDecisionArtifact({
      ...BASE,
      ruleVersion: 0,
      result: "overridden",
      supportChanged: true,
    });
    const parsed = parseDecisionArtifact(file.content);
    expect(parsed.result).toBe("overridden");
    expect(parsed.supportChanged).toBe(true);
    expect(parsed.artifact.rule_version).toBe(0);
  });

  it("throws on non-mapping and malformed YAML", () => {
    expect(() => parseDecisionArtifact("- a\n- b\n")).toThrow(/not a mapping/);
    expect(() => parseDecisionArtifact(": :\n  bad")).toThrow();
  });
});

/** Field names whose serialized lines differ between two YAML documents. */
function lineDiff(a: string, b: string): string[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  const diffs: string[] = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) diffs.push((lb[i] ?? la[i] ?? "").split(":")[0]?.trim() ?? "");
  }
  return diffs;
}
