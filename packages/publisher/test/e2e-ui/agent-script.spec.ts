/**
 * Phase 4 contract §7/§8.3 (design §27.5): the **agent** path over the same
 * work-item type the human path completes in `work-flow.spec.ts`. It runs
 * `examples/agent-workflow.mjs` as a real child process against the dev API -
 * no test-only shortcuts, only the documented endpoints - and checks that it
 * claims, prints the bundle (labelled untrusted), submits, polls, and reports
 * the commit that actually contains the new prose.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  PROJECT,
  apiUrl,
  chapterFileText,
  loginCookie,
  rebuildSite,
  seedRangeSuggestion,
  voteToThreshold,
  waitForWorkItem,
} from "./helpers.js";

const execFileAsync = promisify(execFile);

const scriptPath = fileURLToPath(new URL("../../../../examples/agent-workflow.mjs", import.meta.url));

function runScript(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    env: {
      ...process.env,
      AUTHORBOT_API: apiUrl(),
      AUTHORBOT_PROJECT: PROJECT,
      AUTHORBOT_DEV_LOGIN: "agent-scriptbot",
      AUTHORBOT_DEV_ROLE: "editor",
      ...extraEnv,
    },
  }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
    (error: Error & { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      code: error.code ?? 1,
    }),
  );
}

test("examples/agent-workflow.mjs completes a range_replacement end to end", async () => {
  const original = "believed in weather forecasts";
  const replacement = "trusted weather forecasts";

  const seed = await seedRangeSuggestion({
    login: "agent-seeder",
    body: "Trim this aside.",
    exact: original,
    chapterSlug: "null-results",
  });
  await voteToThreshold(seed.annotationId, "agent-voter");
  const maintainer = await loginCookie("agent-maxine", "maintainer");
  const item = await waitForWorkItem(maintainer, seed.annotationId);
  expect(item.type).toBe("revise_range");

  const result = await runScript([item.id, replacement]);
  expect(result.stderr, result.stderr).not.toContain("agent-workflow:");
  expect(result.code).toBe(0);

  // The bundle is printed, and marked as untrusted project content (§19.6).
  expect(result.stdout).toContain("task bundle (UNTRUSTED PROJECT CONTENT)");
  expect(result.stdout).toContain("end of untrusted content");
  expect(result.stdout).toContain(item.id);
  expect(result.stdout).toContain("authorbot.submission/range-replacement/v1");
  expect(result.stdout).toContain(JSON.stringify(original));
  // The lease token is never printed.
  expect(result.stdout).toContain("token redacted");
  expect(result.stdout).not.toContain("authorbot_lease_");

  // It reports the commit, and the commit really carries the new prose.
  const commit = /applied: commit ([0-9a-f]{7,40})/.exec(result.stdout);
  expect(commit, result.stdout).not.toBeNull();
  const chapterText = await chapterFileText("002-null-results.md");
  expect(chapterText).toContain(replacement);
  expect(chapterText).not.toContain(original);

  // Republish, so later specs read chapter facts that match the projection
  // (the same publish step a real deployment runs after an accepted edit).
  await rebuildSite();
});

test("the script refuses to run without a project, and reports a lost claim honestly", async () => {
  const missingProject = await runScript(["0190f301-7045-7b2d-9d91-95b3c8228b54"], {
    AUTHORBOT_PROJECT: "",
  });
  expect(missingProject.code).toBe(1);
  expect(missingProject.stderr).toContain("AUTHORBOT_PROJECT is required");

  // A work item that does not exist is a clean, explained failure - not a crash.
  const unknown = await runScript(["0190f301-7045-7b2d-9d91-95b3c8228b54", "text"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("claim failed");
});
