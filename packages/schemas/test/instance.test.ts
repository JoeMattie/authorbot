import { describe, it } from "vitest";
import { instanceConfigSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { validInstance } from "./samples.js";

describe("instanceConfigSchema", () => {
  it("accepts the design 25 defaults", () => {
    expectValid(instanceConfigSchema, validInstance);
  });

  it("accepts a minimal config (defaults applied by the loader)", () => {
    expectValid(instanceConfigSchema, { schema: "authorbot.instance/v1" });
  });

  it("rejects secret-looking unknown keys", () => {
    const bad = clone(validInstance);
    bad.github_app_private_key = "-----BEGIN...";
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects a rule without when", () => {
    const bad = clone(validInstance);
    delete bad.rules.suggestion_to_work_item.when;
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects a condition with an unknown operator", () => {
    const bad = clone(validInstance);
    bad.rules.suggestion_to_work_item.when.all[0].operator = "matches";
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects a condition with a non-numeric value", () => {
    const bad = clone(validInstance);
    bad.rules.suggestion_to_work_item.when.all[0].value = "three";
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects a when group mixing all and any", () => {
    const bad = clone(validInstance);
    bad.rules.suggestion_to_work_item.when.any =
      bad.rules.suggestion_to_work_item.when.all;
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects an unknown action type", () => {
    const bad = clone(validInstance);
    bad.rules.suggestion_to_work_item.action.type = "run_script";
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects an unknown work_type", () => {
    const bad = clone(validInstance);
    bad.rules.suggestion_to_work_item.action.work_type = "rewrite_everything";
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects a rule with an unknown trigger", () => {
    const bad = clone(validInstance);
    bad.rules.suggestion_to_work_item.trigger = "cron";
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects a non-ISO lease duration", () => {
    const bad = clone(validInstance);
    bad.leases.duration = "30m";
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects an unknown vote export mode", () => {
    const bad = clone(validInstance);
    bad.votes.export = "full";
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects an unknown range_scope", () => {
    const bad = clone(validInstance);
    bad.annotations.range_scope = "multi_block";
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects a rule name that is not snake_case", () => {
    const bad = clone(validInstance);
    bad.rules["Suggestion-To-Work-Item"] = bad.rules.suggestion_to_work_item;
    expectInvalid(instanceConfigSchema, bad);
  });

  it("rejects a wrong schema discriminator", () => {
    const bad = clone(validInstance);
    bad.schema = "authorbot.instance/v2";
    expectInvalid(instanceConfigSchema, bad);
  });
});
