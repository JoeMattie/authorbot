/**
 * Phase 4 contract §8.3, over the **real** example book repository.
 *
 * `phase4-submissions.test.ts` proves the apply pipeline against an in-memory
 * writer, so it can assert commit contents but never that the committed tree
 * is still a *valid book repo*. That last clause of exit criterion 3 —
 * "validated by the Phase 0 validator post-commit" — had no coverage
 * anywhere: nothing in the workspace ran `validateBookRepo` on a tree that
 * an apply had written to. This file closes that gap by driving the
 * documented endpoints (annotation → votes → work item → claim → submit)
 * through the inline mirror into a real git work tree, then running the
 * Phase 0 validator over the result.
 *
 * The human (Playwright) and agent (`examples/agent-workflow.mjs`) paths are
 * covered in `packages/publisher/test/e2e-ui/`; both complete the same
 * `revise_range` type this test drives, which is the §27.5 requirement.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateBookRepo } from "@authorbot/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAPTER_1,
  cloneExampleBookRepo,
  devLogin,
  git,
  jsonRequest,
  makeIntegrationApp,
  type BookRepoClone,
  type IntegrationApp,
} from "./helpers.js";

const CHAPTER_PATH = "chapters/001-baseline.md";

/**
 * A selector over the committed text of block 1 of chapter 001:
 * "The drift appeared on a Tuesday, in the fourth decimal place, …".
 * Offsets are normalized-text offsets; [4, 21) is exactly "drift appeared on".
 */
const ORIGINAL = "drift appeared on";
const REPLACEMENT = "anomaly surfaced on";

function rangeTarget(): Record<string, unknown> {
  return {
    blockId: CHAPTER_1.firstBlockId,
    textPosition: { start: 4, end: 21 },
    textQuote: { exact: ORIGINAL, prefix: "The ", suffix: " a Tuesday" },
  };
}

describe("Phase 4 exit criterion 3: applied edit leaves a repo the Phase 0 validator accepts", () => {
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

  const request = async (path: string, init: RequestInit): Promise<Response> =>
    await app.app.request(`/v1/projects/${app.projectId}${path}`, init);

  it("claim → submit → one commit → `authorbot validate` still passes", async () => {
    // Baseline: the pristine example repo validates, so any post-commit
    // failure below is attributable to the apply, not to the fixture.
    const before = await validateBookRepo(repo.workTreePath);
    expect(before.errors, JSON.stringify(before.errors)).toEqual([]);
    expect(before.valid).toBe(true);

    // 1. An open range suggestion on chapter 001.
    const author = await devLogin(app, "exit-vera", "contributor");
    const created = await request(
      `/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest(
        "POST",
        {
          kind: "suggestion",
          scope: "range",
          chapterRevision: CHAPTER_1.revision,
          target: rangeTarget(),
          body: "Reword this opening clause.",
        },
        { Cookie: author },
      ),
    );
    expect(created.status).toBe(202);
    const { annotationId } = (await created.json()) as { annotationId: string };
    await app.mirror.drain(app.projectId);
    expect((await app.repos.annotations.getById(annotationId))?.status).toBe("open");

    // 2. Vote it past the governance threshold → a ready work item.
    for (const login of ["exit-wade", "exit-nadia", "exit-omar"]) {
      const voter = await devLogin(app, login, "contributor");
      const voted = await request(
        `/annotations/${annotationId}/vote`,
        jsonRequest("PUT", { value: "approve" }, { Cookie: voter }),
      );
      expect(voted.status).toBeLessThan(300);
    }
    await app.mirror.drain(app.projectId);
    const workItems = await app.repos.workItems.listBySourceAnnotation(annotationId);
    expect(workItems).toHaveLength(1);
    const workItem = workItems[0]!;
    expect(workItem.type).toBe("revise_range");
    expect(workItem.status).toBe("ready");

    const headBefore = (await git(repo.workTreePath, "rev-parse", "HEAD")).trim();

    // 3. Claim through the documented endpoint; the bundle carries the base.
    const editor = await devLogin(app, "exit-harriet", "editor");
    const claimed = await request(
      `/work-items/${workItem.id}/claim`,
      jsonRequest("POST", {}, { Cookie: editor }),
    );
    expect(claimed.status).toBe(201);
    const bundle = (await claimed.json()) as {
      lease: { id: string; token: string };
      document: { revision: number; contentHash: string; source: string };
      target: { exact: string };
    };
    expect(bundle.target.exact).toBe(ORIGINAL);
    expect(bundle.document.revision).toBe(CHAPTER_1.revision);

    // 4. Submit the replacement.
    const submitted = await request(
      `/work-items/${workItem.id}/submissions`,
      jsonRequest(
        "POST",
        {
          leaseId: bundle.lease.id,
          leaseToken: bundle.lease.token,
          type: "range_replacement",
          baseRevision: bundle.document.revision,
          baseContentHash: bundle.document.contentHash,
          content: REPLACEMENT,
          summary: "Reword the opening clause.",
        },
        { Cookie: editor },
      ),
    );
    expect(submitted.status).toBe(202);
    const { submissionId, operationId } = (await submitted.json()) as {
      submissionId: string;
      operationId: string;
    };
    await app.mirror.drain(app.projectId);

    // 5. Exactly ONE commit, carrying all four artifacts (contract §5/§8.3).
    const revList = (
      await git(repo.workTreePath, "rev-list", `${headBefore}..HEAD`)
    )
      .split("\n")
      .filter((line) => line !== "");
    expect(revList).toHaveLength(1);

    const changed = (await git(repo.workTreePath, "show", "--name-only", "--format=", "HEAD"))
      .split("\n")
      .filter((line) => line !== "")
      .sort();
    expect(changed).toEqual(
      [
        CHAPTER_PATH,
        `.authorbot/annotations/${annotationId}/annotation.md`,
        `.authorbot/attribution/${CHAPTER_1.id}.yml`,
        `.authorbot/work-items/${workItem.id}.md`,
      ].sort(),
    );

    const message = await git(repo.workTreePath, "log", "-1", "--format=%B");
    expect(message).toContain(`Authorbot-Work-Item: ${workItem.id}`);
    expect(message).toContain(`Authorbot-Annotation: ${annotationId}`);
    expect(message).toContain(`Authorbot-Operation: ${operationId}`);
    expect(message).toContain("Authorbot-Actor: github:exit-harriet");

    // Chapter bumped, edit confined to the target span, markers intact.
    const chapter = readFileSync(join(repo.workTreePath, CHAPTER_PATH), "utf8");
    expect(chapter).toContain("revision: 4");
    expect(chapter).toContain(`The ${REPLACEMENT} a Tuesday`);
    expect(chapter).not.toContain(ORIGINAL);
    expect(chapter).toContain(`id="${CHAPTER_1.firstBlockId}"`);
    // Untouched prose elsewhere in the chapter survives byte-for-byte.
    expect(chapter).toContain("where nobody respectable ever looks.");
    expect(chapter).toContain("the annex quiet, the vacuum pumps humming their one note");

    // Work item done, annotation accepted, attribution appended.
    expect(
      readFileSync(join(repo.workTreePath, `.authorbot/work-items/${workItem.id}.md`), "utf8"),
    ).toContain("status: completed");
    expect(
      readFileSync(
        join(repo.workTreePath, `.authorbot/annotations/${annotationId}/annotation.md`),
        "utf8",
      ),
    ).toContain("status: accepted");
    const attribution = readFileSync(
      join(repo.workTreePath, `.authorbot/attribution/${CHAPTER_1.id}.yml`),
      "utf8",
    );
    expect(attribution).toContain("revision: 4");
    expect(attribution).toContain("actor: github:exit-harriet");
    expect(attribution).toContain(`work_item_id: ${workItem.id}`);

    expect((await app.repos.submissions.getById(submissionId))?.state).toBe("applied");

    // 6. The clause exit criterion 3 names and nothing else asserted: the
    //    post-commit tree is still a valid book repo.
    const after = await validateBookRepo(repo.workTreePath);
    expect(after.errors, JSON.stringify(after.errors)).toEqual([]);
    expect(after.valid).toBe(true);
  });
});
