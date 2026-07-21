/**
 * Phase 3 exit criterion 1 & 5 (integration): concurrent qualifying votes
 * create exactly one decision and one work item, asserted at the DB **and in
 * Git** (one decision artifact, one work-item artifact) through the real
 * inline mirror; a fresh app on the same repo still serves them.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cloneExampleBookRepo,
  devLogin,
  git,
  jsonRequest,
  makeIntegrationApp,
  mintToken,
  rangeSuggestionPayload,
  type BookRepoClone,
  type IntegrationApp,
} from "./helpers.js";

const CHAPTER_1_ID = "019cadfd-8900-7140-98fb-ceff64cada33";

describe("Phase 3 collaboration pipeline (integration)", () => {
  let repo: BookRepoClone;
  let app: IntegrationApp;

  beforeEach(async () => {
    repo = await cloneExampleBookRepo();
    app = await makeIntegrationApp({ workTreePath: repo.workTreePath });
  });
  afterEach(async () => {
    app.close();
    await repo.cleanup();
  });

  async function createOpenSuggestion(cookie: string): Promise<string> {
    const res = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1_ID}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
    );
    expect(res.status).toBe(202);
    const { annotationId } = (await res.json()) as { annotationId: string };
    // The inline mirror committed the annotation and moved it to `open`.
    await app.mirror.drain(app.projectId);
    expect((await app.repos.annotations.getById(annotationId))?.status).toBe("open");
    return annotationId;
  }

  const vote = async (cookie: string, id: string, value: string): Promise<Response> =>
    app.app.request(
      `/v1/projects/${app.projectId}/annotations/${id}/vote`,
      jsonRequest("PUT", { value }, { Cookie: cookie }),
    );

  const voteWithToken = async (token: string, id: string, value: string): Promise<Response> =>
    app.app.request(`/v1/projects/${app.projectId}/annotations/${id}/vote`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": crypto.randomUUID(),
        Origin: "http://localhost",
      },
      body: JSON.stringify({ value }),
    });

  it("concurrent qualifying votes yield one decision + one work item, in DB and Git", async () => {
    const c1 = await devLogin(app, "vera", "contributor");
    // Phase 6 §3.6: the default rule requires a human maintainer's approval.
    const c2 = await devLogin(app, "wade", "maintainer");
    const c3 = await devLogin(app, "xena", "contributor");
    const id = await createOpenSuggestion(c1);

    await vote(c1, id, "approve");
    await vote(c2, id, "approve");
    // Hammer the crossing concurrently.
    await Promise.all([vote(c3, id, "approve"), vote(c3, id, "approve"), vote(c3, id, "approve")]);
    await app.mirror.drain(app.projectId);

    // DB: exactly one decision and one work item.
    const decisions = await app.repos.decisions.listByAnnotation(id);
    expect(decisions).toHaveLength(1);
    const workItems = await app.repos.workItems.listBySourceAnnotation(id);
    expect(workItems).toHaveLength(1);
    const workItemId = workItems[0]?.id ?? "";
    const decisionId = decisions[0]?.id ?? "";

    // Git: exactly one NEW decision artifact and one NEW work-item artifact
    // for this crossing (the example repo ships one pre-existing fixture of
    // each - the crossing must add exactly one, not duplicate on the race).
    const decisionsDir = join(repo.workTreePath, ".authorbot", "decisions");
    const workItemsDir = join(repo.workTreePath, ".authorbot", "work-items");
    expect(existsSync(join(decisionsDir, `${decisionId}.yml`))).toBe(true);
    expect(existsSync(join(workItemsDir, `${workItemId}.md`))).toBe(true);
    // The one crossing produced exactly one artifact for THIS work item id.
    expect(
      readdirSync(workItemsDir).filter((f) => f === `${workItemId}.md`),
    ).toHaveLength(1);
    expect(
      readdirSync(decisionsDir).filter((f) => f === `${decisionId}.yml`),
    ).toHaveLength(1);

    // A fresh app on the same DB still serves the work item.
    const fresh = await makeIntegrationApp({ db: app.db, workTreePath: repo.workTreePath });
    const maintainer = await devLogin(fresh, "yuki", "maintainer");
    const listed = await fresh.app.request(
      `/v1/projects/${fresh.projectId}/work-items?status=ready`,
      { headers: { Cookie: maintainer } },
    );
    const body = (await listed.json()) as { items: { id: string }[] };
    expect(body.items.map((w) => w.id)).toContain(workItemId);
  });

  // ---- Exit criterion §7.1: THE CONCURRENCY HAMMER --------------------------
  // N>=8 parallel qualifying votes by distinct actors (incl. an agent token)
  // plus concurrent re-evaluations against ONE suggestion must collapse to
  // exactly one decision row, one work-item row, one decision artifact and one
  // work-item artifact in the Git work tree - counted as both FILES and
  // COMMITS. Repeated across independent suggestions to shake races.
  it("N>=8 distinct concurrent voters + re-evaluations → one decision, one work item (files AND commits), x5", async () => {
    // 8 distinct human contributors, plus a maintainer added below...
    const humanNames = ["ada", "boris", "cleo", "dev", "esme", "finn", "gita", "hugo"];
    const humanCookies = await Promise.all(
      humanNames.map((name) => devLogin(app, name, "contributor")),
    );
    // Phase 6 §3.6: one human maintainer among the concurrent voters, without
    // which the default rule can never be satisfied and the race under test
    // would have nothing to race for.
    humanCookies.push(await devLogin(app, "iris", "maintainer"));
    // ...plus one agent token (agent membership is pinned to editor, whose
    // bundle grants votes:write) - the 9th, non-human qualifying voter.
    const maintainer = await devLogin(app, "quill", "maintainer");
    const { token: agentToken } = await mintToken(app, maintainer, [
      "annotations:read",
      "votes:write",
    ]);

    const ITERATIONS = 5;
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const id = await createOpenSuggestion(humanCookies[0] as string);

      // Baseline artifact/commit counts BEFORE this crossing.
      const decisionsDir = join(repo.workTreePath, ".authorbot", "decisions");
      const workItemsDir = join(repo.workTreePath, ".authorbot", "work-items");
      const beforeDecisionFiles = existsSync(decisionsDir)
        ? readdirSync(decisionsDir).length
        : 0;
      const beforeWorkItemFiles = existsSync(workItemsDir)
        ? readdirSync(workItemsDir).length
        : 0;
      const beforeCommits = Number(
        (await git(repo.workTreePath, "rev-list", "--count", "HEAD")).trim(),
      );

      // Fire every qualifying vote at once, AND fire concurrent duplicate
      // re-votes from a subset so several crossing evaluations race together.
      await Promise.all([
        ...humanCookies.map((cookie) => vote(cookie, id, "approve")),
        voteWithToken(agentToken, id, "approve"),
        // Concurrent re-evaluations: idempotent duplicate approves that each
        // re-run the rule against the same already-qualifying aggregate.
        vote(humanCookies[0] as string, id, "approve"),
        vote(humanCookies[1] as string, id, "approve"),
        voteWithToken(agentToken, id, "approve"),
      ]);
      await app.mirror.drain(app.projectId);

      // DB: exactly one decision row and one work item row for this source.
      const decisions = await app.repos.decisions.listByAnnotation(id);
      expect(decisions, `iteration ${iter}: decision rows`).toHaveLength(1);
      const workItems = await app.repos.workItems.listBySourceAnnotation(id);
      expect(workItems, `iteration ${iter}: work item rows`).toHaveLength(1);
      const decisionId = decisions[0]?.id ?? "";
      const workItemId = workItems[0]?.id ?? "";
      expect(workItems[0]?.status).toBe("ready");

      // Aggregate snapshot reflects all 10 distinct voters: 8 human
      // contributors, 1 human maintainer, and the agent token.
      const tally = await app.repos.votes.tally(id);
      expect(tally.approvals).toBe(10);
      expect(tally.humanApprovals).toBe(9);
      expect(tally.agentApprovals).toBe(1);
      expect(tally.distinctVoters).toBe(10);
      // Phase 6 §3.6: exactly one of those approvals is a human maintainer's.
      expect(tally.maintainerApprovals).toBe(1);
      expect(tally.humanMaintainerApprovals).toBe(1);

      // Git FILES: exactly one NEW decision artifact and one NEW work-item
      // artifact were added by this crossing (net +1 each), and they are the
      // rows' ids.
      const afterDecisionFiles = readdirSync(decisionsDir);
      const afterWorkItemFiles = readdirSync(workItemsDir);
      expect(afterDecisionFiles.length - beforeDecisionFiles).toBe(1);
      expect(afterWorkItemFiles.length - beforeWorkItemFiles).toBe(1);
      expect(afterDecisionFiles).toContain(`${decisionId}.yml`);
      expect(afterWorkItemFiles).toContain(`${workItemId}.md`);
      expect(afterDecisionFiles.filter((f) => f === `${decisionId}.yml`)).toHaveLength(1);
      expect(afterWorkItemFiles.filter((f) => f === `${workItemId}.md`)).toHaveLength(1);

      // Git COMMITS: the crossing added exactly one commit, and exactly one
      // commit in the whole history touches each artifact path.
      const afterCommits = Number(
        (await git(repo.workTreePath, "rev-list", "--count", "HEAD")).trim(),
      );
      expect(afterCommits - beforeCommits, `iteration ${iter}: commit delta`).toBe(1);
      const decisionCommits = (
        await git(
          repo.workTreePath,
          "log",
          "--oneline",
          "--",
          `.authorbot/decisions/${decisionId}.yml`,
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(decisionCommits, `iteration ${iter}: decision commits`).toHaveLength(1);
      const workItemCommits = (
        await git(
          repo.workTreePath,
          "log",
          "--oneline",
          "--",
          `.authorbot/work-items/${workItemId}.md`,
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(workItemCommits, `iteration ${iter}: work-item commits`).toHaveLength(1);

      // The annotation transitioned exactly once.
      expect((await app.repos.annotations.getById(id))?.status).toBe("work_item_created");
    }
  });
});
