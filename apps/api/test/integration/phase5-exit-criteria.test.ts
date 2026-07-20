/**
 * Phase 5 contract §8 — the exit criteria, end to end across package
 * boundaries.
 *
 * Every other Phase 5 suite tests one package: `@authorbot/git-github` proves
 * the writer and reader against the fake, `coordinator.test.ts` proves the
 * coordinator against a stub app, `reconcile.test.ts` and
 * `publications.test.ts` prove their handlers against a fake reader. None of
 * them closes the loop the contract's exit criteria actually name — an HTTP
 * request arriving at the real app and coming back out as a git commit, then
 * that commit being read back through the real reader and served by the real
 * API.
 *
 * So this file only ever drives **documented HTTP endpoints** and asserts on
 * **repository content**. It never calls a repository method to set up state
 * that an endpoint could produce, and it never asserts on an internal return
 * value where the committed bytes are the actual claim.
 */
import { describe, expect, it } from "vitest";
import {
  AUTHORBOT_GIT_EMAIL,
  AUTHORBOT_GIT_NAME,
  GitHubBookRepoReader,
} from "@authorbot/git-github";
import { applyMigrations, openSqliteDatabase } from "@authorbot/database";
import { createApi } from "../../src/app.js";
import { createDevIdentityProvider } from "../../src/identity/provider.js";
import {
  BRANCH,
  CHAPTER_1,
  CHAPTER_3,
  FULL_NAME,
  MIGRATIONS_DIR,
  OWNER,
  REPO,
  changedPaths,
  deliverPublication,
  deliverPush,
  devLogin,
  jsonRequest,
  makeGitHubIntegrationApp,
  rangeSuggestionPayload,
  type GitHubIntegrationApp,
} from "./phase5-helpers.js";

describe("Phase 5 exit criterion 1: an annotation becomes a real commit, and GitHub-backed reads serve it", () => {
  it("dev-login → 202 → commit in the fake repo → projection rebuilt through GitHubBookRepoReader serves it", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const headBefore = app.fake.state.getRef(BRANCH);
      expect(headBefore).not.toBeNull();

      // ---- write side: the documented endpoint, nothing else -------------
      const cookie = await devLogin(app, "p5-vera", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(created.status).toBe(202);
      const { annotationId, operationId } = (await created.json()) as {
        annotationId: string;
        operationId: string;
      };

      // `mirrorMode: "durable"` means the request itself asked the
      // coordinator to drain — no test-only drain call here.
      expect(app.mutations).toContain(app.projectId);

      // ---- the commit is real ------------------------------------------
      const headAfter = app.fake.state.getRef(BRANCH);
      expect(headAfter).not.toBe(headBefore);
      const commit = app.fake.state.getCommit(headAfter as string);
      expect(commit.parents).toEqual([headBefore]);

      const artifactPath = `.authorbot/annotations/${annotationId}/annotation.md`;
      const artifact = app.fake.fileAtHead(artifactPath);
      expect(artifact).not.toBeNull();
      expect(artifact).toContain(`id: ${annotationId}`);
      expect(artifact).toContain("kind: suggestion");
      expect(artifact).toContain("Consider tightening this opening line.");

      // §14.3 trailers identify the operation and the actor.
      expect(commit.message).toContain(`Authorbot-Operation: ${operationId}`);
      expect(commit.message).toContain(`Authorbot-Annotation: ${annotationId}`);
      expect(commit.message).toContain("Authorbot-Actor: github:p5-vera");

      // The commit is additive: `base_tree` carried the rest of the book.
      expect(app.fake.fileAtHead("book.yml")).not.toBeNull();
      expect(app.fake.fileAtHead(CHAPTER_1.path)).not.toBeNull();

      // The operation reached its terminal state, observable via the API.
      const operation = await app.repos.gitOperations.getById(operationId);
      expect(operation?.state).toBe("committed");
      expect(operation?.commitSha).toBe(headAfter);

      // ---- read side: a brand-new database, projected only from GitHub ---
      // Nothing is copied across: the second app shares only the fake
      // repository, so anything it serves came out of a git tree that was
      // read back through GitHubBookRepoReader.
      const freshDb = openSqliteDatabase(":memory:");
      try {
        await applyMigrations(freshDb, MIGRATIONS_DIR);
        const freshApi = createApi({
          db: freshDb,
          config: {
            authMode: "dev",
            sessionSecret: "p5-rebuild-secret",
            webhookSecret: "p5-rebuild-webhook",
            projectSlug: "hollow-creek-anomaly",
            projectRepo: FULL_NAME,
            initialMaintainer: "github:JoeMattie",
          },
          identityProvider: createDevIdentityProvider(),
          reader: new GitHubBookRepoReader({
            owner: OWNER,
            repo: REPO,
            branch: BRANCH,
            fetch: app.fake.fetch,
          }),
        });
        const { project, rebuild } = await freshApi.bootstrap();
        expect(rebuild).not.toBeNull();

        // The snapshot the projection was built from is pinned to the commit
        // the write produced (contract §3: "every snapshot records the commit
        // SHA it was taken at").
        const projected = await freshApi.repos.projects.getById(project.id);
        expect(projected?.projectedCommit).toBe(headAfter);

        // And the annotation the API wrote is served back by the API.
        const loginRes = await freshApi.app.request("/v1/dev/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost" },
          body: JSON.stringify({ login: "p5-reader", role: "reader" }),
        });
        expect(loginRes.status).toBe(200);
        const freshCookie = (loginRes.headers.get("set-cookie") as string).split(";")[0] as string;

        const listed = await freshApi.app.request(
          `/v1/projects/${project.id}/chapters/${CHAPTER_1.id}/annotations`,
          { headers: { Cookie: freshCookie } },
        );
        expect(listed.status).toBe(200);
        const page = (await listed.json()) as {
          items: { id: string; kind: string; body: string }[];
        };
        const found = page.items.find((item) => item.id === annotationId);
        expect(found, JSON.stringify(page.items.map((i) => i.id))).toBeDefined();
        expect(found?.kind).toBe("suggestion");
        expect(found?.body).toContain("Consider tightening this opening line.");
      } finally {
        freshDb.close();
      }
    } finally {
      app.close();
    }
  });
});

const ORIGINAL = "drift appeared on";
const REPLACEMENT = "anomaly surfaced on";

/**
 * Drive annotation → qualifying votes → ready work item through the
 * documented endpoints. Returns the work item id.
 *
 * Under `mirrorMode: "durable"` every one of these requests drains the outbox
 * through the GitHub writer on its way out, so the repository is up to date
 * when this returns.
 */
async function openWorkItem(
  app: GitHubIntegrationApp,
  voters: readonly string[],
): Promise<{ annotationId: string; workItemId: string }> {
  const author = await devLogin(app, "p5-author", "contributor");
  const created = await app.app.request(
    `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
    jsonRequest("POST", rangeSuggestionPayload({ body: "Reword this opening clause." }), {
      Cookie: author,
    }),
  );
  expect(created.status).toBe(202);
  const { annotationId } = (await created.json()) as { annotationId: string };
  expect((await app.repos.annotations.getById(annotationId))?.status).toBe("open");

  for (const login of voters) {
    const voter = await devLogin(app, login, "contributor");
    const voted = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${annotationId}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: voter }),
    );
    expect(voted.status).toBeLessThan(300);
  }

  const workItems = await app.repos.workItems.listBySourceAnnotation(annotationId);
  expect(workItems).toHaveLength(1);
  const workItem = workItems[0]!;
  expect(workItem.type).toBe("revise_range");
  expect(workItem.status).toBe("ready");
  return { annotationId, workItemId: workItem.id };
}

/** Claim a work item and submit a range replacement. Returns the ids. */
async function claimAndSubmit(
  app: GitHubIntegrationApp,
  workItemId: string,
  editorLogin: string,
  replacement: string,
): Promise<{ submissionId: string; operationId: string; status: number }> {
  const editor = await devLogin(app, editorLogin, "editor");
  const claimed = await app.app.request(
    `/v1/projects/${app.projectId}/work-items/${workItemId}/claim`,
    jsonRequest("POST", {}, { Cookie: editor }),
  );
  expect(claimed.status).toBe(201);
  const bundle = (await claimed.json()) as {
    lease: { id: string; token: string };
    document: { revision: number; contentHash: string };
    target: { exact: string };
  };
  expect(bundle.target.exact).toBe(ORIGINAL);

  const submitted = await app.app.request(
    `/v1/projects/${app.projectId}/work-items/${workItemId}/submissions`,
    jsonRequest(
      "POST",
      {
        leaseId: bundle.lease.id,
        leaseToken: bundle.lease.token,
        type: "range_replacement",
        baseRevision: bundle.document.revision,
        baseContentHash: bundle.document.contentHash,
        content: replacement,
        summary: "Reword the opening clause.",
      },
      { Cookie: editor },
    ),
  );
  const body = (await submitted.json()) as { submissionId: string; operationId: string };
  return { ...body, status: submitted.status };
}

describe("Phase 5 exit criterion 2: a Phase 4 submission completes through the GitHub writer", () => {
  it("ONE commit carries chapter bump + work-item disposition + annotation acceptance + attribution, with §14.3 trailers and no force update", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const { annotationId, workItemId } = await openWorkItem(app, [
        "p5-wade",
        "p5-nadia",
        "p5-omar",
      ]);

      const headBefore = app.fake.state.getRef(BRANCH) as string;
      const { submissionId, operationId, status } = await claimAndSubmit(
        app,
        workItemId,
        "p5-harriet",
        REPLACEMENT,
      );
      expect(status).toBe(202);

      // ---- exactly ONE commit --------------------------------------------
      const head = app.fake.state.getRef(BRANCH) as string;
      expect(head).not.toBe(headBefore);
      const commit = app.fake.state.getCommit(head);
      // A single parent, and that parent is the head the apply started from:
      // one commit, not a chain of them.
      expect(commit.parents).toEqual([headBefore]);

      // ---- carrying all four artifacts ------------------------------------
      const changed = changedPaths(app.fake, headBefore, head);
      expect(changed).toEqual(
        [
          CHAPTER_1.path,
          `.authorbot/annotations/${annotationId}/annotation.md`,
          `.authorbot/attribution/${CHAPTER_1.id}.yml`,
          `.authorbot/work-items/${workItemId}.md`,
        ].sort(),
      );

      // 1. chapter bump, edit confined to the target span, markers intact
      const chapter = app.fake.fileAtHead(CHAPTER_1.path) as string;
      expect(chapter).toContain("revision: 4");
      expect(chapter).toContain(`The ${REPLACEMENT} a Tuesday`);
      expect(chapter).not.toContain(ORIGINAL);
      expect(chapter).toContain(`id="${CHAPTER_1.firstBlockId}"`);
      expect(chapter).toContain("where nobody respectable ever looks.");

      // 2. work-item disposition
      expect(app.fake.fileAtHead(`.authorbot/work-items/${workItemId}.md`)).toContain(
        "status: completed",
      );

      // 3. annotation acceptance
      expect(
        app.fake.fileAtHead(`.authorbot/annotations/${annotationId}/annotation.md`),
      ).toContain("status: accepted");

      // 4. attribution — the human credit §14.3 keeps out of the git identity
      const attribution = app.fake.fileAtHead(
        `.authorbot/attribution/${CHAPTER_1.id}.yml`,
      ) as string;
      expect(attribution).toContain("revision: 4");
      expect(attribution).toContain("actor: github:p5-harriet");
      expect(attribution).toContain(`work_item_id: ${workItemId}`);

      // ---- §14.3 trailers --------------------------------------------------
      expect(commit.message).toContain(`Authorbot-Operation: ${operationId}`);
      expect(commit.message).toContain(`Authorbot-Work-Item: ${workItemId}`);
      expect(commit.message).toContain(`Authorbot-Annotation: ${annotationId}`);
      expect(commit.message).toContain("Authorbot-Actor: github:p5-harriet");
      expect(commit.message).toContain(`Authorbot-Base-Revision: ${CHAPTER_1.revision}`);

      // §14.3: the git identity is the *service*, never the human — the human
      // is credited in the attribution record asserted above.
      expect(commit.author.name).toBe(AUTHORBOT_GIT_NAME);
      expect(commit.author.email).toBe(AUTHORBOT_GIT_EMAIL);
      expect(commit.committer.name).toBe(AUTHORBOT_GIT_NAME);
      expect(commit.author.name).not.toContain("harriet");

      // ---- NO force update -------------------------------------------------
      // Asserted against what the fake actually received, not against the
      // writer's intent: every ref update in this test carried `force: false`.
      expect(app.refUpdates.length).toBeGreaterThan(0);
      for (const update of app.refUpdates) {
        expect(update.force).toBe(false);
      }

      expect((await app.repos.submissions.getById(submissionId))?.state).toBe("applied");
    } finally {
      app.close();
    }
  });
});

/**
 * A file a *competing* writer owns. Exit criterion 3 says exhaustion must
 * yield a conflict "never a clobber", and the only way to prove the absence
 * of a clobber is to show the competitor's bytes are still the bytes at HEAD.
 */
const COMPETITOR_PATH = "story/competing-writer.md";
const COMPETITOR_CONTENT = "# Written by someone else\n\nThis must survive.\n";

describe("Phase 5 exit criterion 3: moved-head retry succeeds within bounds; exhaustion conflicts without clobbering", () => {
  it("a head that moves once is retried and both writers' content survives", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      // Armed *after* bootstrap so the boot rebuild's ref read does not
      // burn the fault.
      app.fake.injectFault("movedHead", {
        branch: BRANCH,
        files: { [COMPETITOR_PATH]: COMPETITOR_CONTENT },
        message: "Concurrent external push",
        times: 1,
      });

      const cookie = await devLogin(app, "p5-retry", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(created.status).toBe(202);
      const { annotationId, operationId } = (await created.json()) as {
        annotationId: string;
        operationId: string;
      };

      // The fault really fired — otherwise this test would pass vacuously as
      // an ordinary happy-path commit.
      app.fake.assertAllFaultsFired();

      // The retry actually happened: more than one ref update was sent.
      expect(app.refUpdates.length).toBeGreaterThanOrEqual(2);
      for (const update of app.refUpdates) {
        expect(update.force).toBe(false);
      }

      // Both writers' content is at HEAD — the retry rebased onto the
      // competitor's commit rather than replacing it.
      expect(app.fake.fileAtHead(COMPETITOR_PATH)).toBe(COMPETITOR_CONTENT);
      expect(
        app.fake.fileAtHead(`.authorbot/annotations/${annotationId}/annotation.md`),
      ).toContain(`id: ${annotationId}`);

      const operation = await app.repos.gitOperations.getById(operationId);
      expect(operation?.state).toBe("committed");
    } finally {
      app.close();
    }
  });

  it("a head that keeps moving exhausts the bound, and the competing writer's content is still at HEAD", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      // Every attempt races. `times` exceeds the writer's bound, so the
      // sequence can only end in exhaustion.
      app.fake.injectFault("movedHead", {
        branch: BRANCH,
        files: { [COMPETITOR_PATH]: COMPETITOR_CONTENT },
        message: "Concurrent external push",
        times: 20,
      });

      const cookie = await devLogin(app, "p5-exhaust", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      // The write is still *accepted* — the 202 is about the command being
      // durably recorded, not about the commit having landed.
      expect(created.status).toBe(202);
      const { annotationId, operationId } = (await created.json()) as {
        annotationId: string;
        operationId: string;
      };

      // ---- a conflict, not a clobber --------------------------------------
      const operation = await app.repos.gitOperations.getById(operationId);
      expect(operation?.state).not.toBe("committed");
      expect(["conflict", "failed"]).toContain(operation?.state);

      // Asserted by CONTENT, as the contract requires: the competing
      // writer's file is intact at HEAD, byte for byte...
      const head = app.fake.state.getRef(BRANCH) as string;
      expect(app.fake.state.readFile(head, COMPETITOR_PATH)).toBe(COMPETITOR_CONTENT);

      // ...and Authorbot's artifact never landed.
      expect(
        app.fake.state.readFile(head, `.authorbot/annotations/${annotationId}/annotation.md`),
      ).toBeNull();

      // Not one force update was attempted, at any point in the sequence.
      expect(app.refUpdates.length).toBeGreaterThan(0);
      for (const update of app.refUpdates) {
        expect(update.force).toBe(false);
      }

      // The book is otherwise untouched — a failed write is inert, not
      // destructive.
      expect(app.fake.state.readFile(head, "book.yml")).not.toBeNull();
      expect(app.fake.state.readFile(head, CHAPTER_1.path)).toContain("revision: 3");
    } finally {
      app.close();
    }
  });
});

describe("Phase 5 exit criterion 4: coordinator serialization holds; duplicate drains commit once", () => {
  it("concurrent annotation writes all land, on one linear chain, with no lost commit", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const base = app.fake.state.getRef(BRANCH) as string;
      const logins = ["p5-c1", "p5-c2", "p5-c3", "p5-c4", "p5-c5"];
      const cookies = await Promise.all(
        logins.map((login) => devLogin(app, login, "contributor")),
      );

      // Fired together, not awaited in sequence: this is the concurrency the
      // coordinator exists to serialize.
      const responses = await Promise.all(
        cookies.map((cookie, index) =>
          app.app.request(
            `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
            jsonRequest(
              "POST",
              rangeSuggestionPayload({ body: `Concurrent suggestion ${index}.` }),
              { Cookie: cookie },
            ),
          ),
        ),
      );
      const ids: string[] = [];
      for (const response of responses) {
        expect(response.status).toBe(202);
        ids.push(((await response.json()) as { annotationId: string }).annotationId);
      }
      expect(new Set(ids).size).toBe(logins.length);

      // Anything still queued is drained now — the assertion below is about
      // ordering and loss, not about whether an alarm had fired yet.
      await app.coordinator.drainOutbox();

      // ---- nothing was lost ------------------------------------------------
      const head = app.fake.state.getRef(BRANCH) as string;
      for (const id of ids) {
        expect(
          app.fake.fileAtHead(`.authorbot/annotations/${id}/annotation.md`),
          `annotation ${id} missing from HEAD`,
        ).toContain(`id: ${id}`);
      }

      // ---- one linear chain, no forks, no force ---------------------------
      // Every commit from `base` to `head` has exactly one parent, and
      // walking parents from head reaches base. A lost update would show up
      // as an artifact missing above; a fork would break this walk.
      const history = app.fake.state.history(BRANCH);
      expect(history).toContain(base);
      expect(history[0]).toBe(head);
      const newCommits = history.slice(0, history.indexOf(base));
      expect(newCommits.length).toBeGreaterThan(0);
      for (const sha of newCommits) {
        expect(app.fake.state.getCommit(sha).parents).toHaveLength(1);
      }
      for (const update of app.refUpdates) {
        expect(update.force).toBe(false);
      }
    } finally {
      app.close();
    }
  });

  it("no two commits are ever in flight at once, through concurrent HTTP requests", async () => {
    // The "nothing was lost / one chain" test above is NOT sufficient to
    // prove serialization: with the drain chain deleted it still passes,
    // because the writer's own 422 retry rescues racing drains and the
    // commits end up on one chain anyway. Serialization has to be observed
    // directly, so this instruments the writer and asserts that the peak
    // number of overlapping `commitFiles` calls never exceeded one.
    let inFlight = 0;
    let peak = 0;
    const app = await makeGitHubIntegrationApp({
      wrapWriter: (writer) => ({
        ...writer,
        commitFiles: async (input) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          try {
            // Yield, so a second concurrent commit has a real opportunity to
            // begin before this one finishes. Without serialization it will.
            await new Promise((resolve) => setTimeout(resolve, 0));
            return await writer.commitFiles(input);
          } finally {
            inFlight -= 1;
          }
        },
        ...(writer.readFile
          ? { readFile: (branch: string, path: string) => writer.readFile!(branch, path) }
          : {}),
        ...(writer.resolveHead
          ? { resolveHead: (branch: string) => writer.resolveHead!(branch) }
          : {}),
      }),
    });
    try {
      const logins = ["p5-s1", "p5-s2", "p5-s3", "p5-s4", "p5-s5", "p5-s6"];
      const cookies = await Promise.all(
        logins.map((login) => devLogin(app, login, "contributor")),
      );
      const responses = await Promise.all(
        cookies.map((cookie, index) =>
          app.app.request(
            `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
            jsonRequest(
              "POST",
              rangeSuggestionPayload({ body: `Serialized suggestion ${index}.` }),
              { Cookie: cookie },
            ),
          ),
        ),
      );
      for (const response of responses) {
        expect(response.status).toBe(202);
      }
      await app.coordinator.drainOutbox();

      // The instrumentation actually ran (guards a vacuous pass where no
      // commit happened at all).
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBe(1);
      expect(inFlight).toBe(0);
    } finally {
      app.close();
    }
  });

  it("a duplicate drain after a committed mutation produces no second commit", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const cookie = await devLogin(app, "p5-dupe", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(created.status).toBe(202);
      const { annotationId } = (await created.json()) as { annotationId: string };

      const headAfterFirst = app.fake.state.getRef(BRANCH) as string;
      const historyAfterFirst = app.fake.state.history(BRANCH).length;
      expect(
        app.fake.fileAtHead(`.authorbot/annotations/${annotationId}/annotation.md`),
      ).not.toBeNull();

      // Drain again — including concurrently with itself, which is what an
      // alarm firing next to a mutation actually looks like.
      await Promise.all([
        app.coordinator.drainOutbox(),
        app.coordinator.drainOutbox(),
        app.coordinator.drainOutbox(),
      ]);

      expect(app.fake.state.getRef(BRANCH)).toBe(headAfterFirst);
      expect(app.fake.state.history(BRANCH)).toHaveLength(historyAfterFirst);
    } finally {
      app.close();
    }
  });
});

describe("Phase 5 exit criterion 5: webhook reconciliation projects an external edit; divergence blocks prose writes but not reads", () => {
  it("an external push is reconciled through the coordinator and the API serves the new revision", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const cookie = await devLogin(app, "p5-webhook-reader", "reader");
      const before = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_3.id}`,
        { headers: { Cookie: cookie } },
      );
      expect(((await before.json()) as { revision: number }).revision).toBe(CHAPTER_3.revision);

      // Somebody edits the chapter in GitHub directly and bumps its own
      // frontmatter revision — the §6 "external edit" case.
      const source = app.fake.fileAtHead(CHAPTER_3.path) as string;
      const edited = source
        .replace("revision: 1", "revision: 2")
        .replace(
          "Once you stop blaming an instrument",
          "Once you finally stop blaming an instrument",
        );
      expect(edited).not.toBe(source);
      const externalCommit = await app.fake.externalCommit({ [CHAPTER_3.path]: edited });

      const delivered = await deliverPush(app, {
        deliveryId: "p5-external-edit",
        headCommit: externalCommit,
      });
      expect(delivered.status).toBe(200);
      expect(((await delivered.json()) as { duplicate: boolean }).duplicate).toBe(false);

      // The refresher seam is the coordinator, so the reconciliation ran
      // where production runs it.
      const after = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_3.id}`,
        { headers: { Cookie: cookie } },
      );
      expect(after.status).toBe(200);
      const body = (await after.json()) as { revision: number };
      expect(body.revision).toBe(2);

      // The projection is pinned to the external commit, and no longer owes
      // a refresh.
      const project = await app.repos.projects.getById(app.projectId);
      expect(project?.projectedCommit).toBe(externalCommit);
      expect(project?.projectionStale).toBe(false);

      // Reconciling an external edit must not itself write to the
      // repository — the push is the source of truth here.
      expect(app.fake.state.getRef(BRANCH)).toBe(externalCommit);
    } finally {
      app.close();
    }
  });

  it("a backwards revision marks the project diverged: prose writes 409, reads keep working", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      // Establish a ready work item AND a valid lease while the repository is
      // still coherent. The submission below is then well-formed in every
      // respect except that the repository has diverged, so a 409 is
      // attributable to divergence and to nothing else.
      const { workItemId } = await openWorkItem(app, ["p5-dv1", "p5-dv2", "p5-dv3"]);
      const editor = await devLogin(app, "p5-dv-editor", "editor");
      const claimed = await app.app.request(
        `/v1/projects/${app.projectId}/work-items/${workItemId}/claim`,
        jsonRequest("POST", {}, { Cookie: editor }),
      );
      expect(claimed.status).toBe(201);
      const bundle = (await claimed.json()) as {
        lease: { id: string; token: string };
        document: { revision: number; contentHash: string };
      };

      // Now the repository moves *backwards*: the projection holds chapter
      // 001 at revision 3, and the repository is rewritten to revision 2.
      const applied = app.fake.fileAtHead(CHAPTER_1.path) as string;
      expect(applied).toContain(`revision: ${CHAPTER_1.revision}`);
      const regressed = applied.replace(`revision: ${CHAPTER_1.revision}`, "revision: 2");
      const badCommit = await app.fake.externalCommit({ [CHAPTER_1.path]: regressed });

      const delivered = await deliverPush(app, {
        deliveryId: "p5-divergence",
        headCommit: badCommit,
      });
      expect(delivered.status).toBe(200);

      const project = await app.repos.projects.getById(app.projectId);
      expect(project?.divergenceReason).not.toBeNull();
      expect(project?.divergedAt).not.toBeNull();

      // ---- reads keep working (design §14.5) -------------------------------
      const reader = await devLogin(app, "p5-dv-reader", "reader");
      const chapterRead = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}`,
        { headers: { Cookie: reader } },
      );
      expect(chapterRead.status).toBe(200);
      const projectRead = await app.app.request(`/v1/projects/${app.projectId}`, {
        headers: { Cookie: reader },
      });
      expect(projectRead.status).toBe(200);
      const projectBody = (await projectRead.json()) as {
        divergence: { state: string };
        gitIntegration?: string;
      };
      expect(projectBody.divergence.state).toBe("diverged");

      // ---- prose writes are refused with a clear problem type ---------------
      const submitted = await app.app.request(
        `/v1/projects/${app.projectId}/work-items/${workItemId}/submissions`,
        jsonRequest(
          "POST",
          {
            leaseId: bundle.lease.id,
            leaseToken: bundle.lease.token,
            type: "range_replacement",
            baseRevision: bundle.document.revision,
            baseContentHash: bundle.document.contentHash,
            content: "should never be applied",
            summary: "should never be applied",
          },
          { Cookie: editor },
        ),
      );
      // 409 — a valid lease and a valid base, refused solely because the
      // repository diverged.
      expect(submitted.status).toBe(409);
      const problem = (await submitted.json()) as { type: string; title: string };
      expect(problem.type).toContain("project-diverged");

      // The repository was not written to while diverged.
      expect(app.fake.state.getRef(BRANCH)).toBe(badCommit);
    } finally {
      app.close();
    }
  });
});

describe("Phase 5 exit criterion 6: publication tracking distinguishes integrated from deployed", () => {
  it("a signed CI callback moves build state, and the integrated/deployed gap is visible until it closes", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      // Integrate something, so `integratedCommit` is a commit Authorbot
      // actually produced rather than a fixture string.
      const cookie = await devLogin(app, "p5-pub", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(created.status).toBe(202);
      const integrated = app.fake.state.getRef(BRANCH) as string;

      // GitHub sends a `push` for Authorbot's own commit too, and that is
      // what advances the *integrated* commit: "integrated" means Authorbot
      // has projected it, not merely that a write returned success
      // (contract §6 — never mark a revision published because a commit
      // succeeded).
      expect((await deliverPush(app, { deliveryId: "p5-pub-push-1" })).status).toBe(200);

      const readProject = async (): Promise<{
        projection: { commit: string | null };
        publication: {
          integratedCommit: string | null;
          deployedCommit: string | null;
          buildStatus: string | null;
          publicUrl: string | null;
          inSync: boolean;
        };
      }> => {
        const response = await app.app.request(`/v1/projects/${app.projectId}`, {
          headers: { Cookie: cookie },
        });
        expect(response.status).toBe(200);
        return (await response.json()) as never;
      };

      // Before any callback: integrated is known, deployed is not. The gap
      // is reported, not assumed away.
      const initial = await readProject();
      expect(initial.publication.integratedCommit).toBe(integrated);
      expect(initial.publication.deployedCommit).toBeNull();
      expect(initial.publication.inSync).toBe(false);

      // ---- bad signature is rejected before anything is recorded -----------
      const forged = await deliverPublication(
        app,
        { integratedCommit: integrated, buildStatus: "succeeded" },
        { signature: `sha256=${"0".repeat(64)}` },
      );
      expect(forged.status).toBe(401);
      expect((await readProject()).publication.buildStatus).toBeNull();

      // ---- CI reports a build in flight ------------------------------------
      const building = await deliverPublication(app, {
        integratedCommit: integrated,
        buildStatus: "building",
      });
      expect(building.status).toBe(201);

      const midBuild = await readProject();
      expect(midBuild.publication.buildStatus).toBe("building");
      // Integrated ≠ deployed: the commit exists in git but nothing is live.
      expect(midBuild.publication.integratedCommit).toBe(integrated);
      expect(midBuild.publication.deployedCommit).toBeNull();
      expect(midBuild.publication.inSync).toBe(false);

      // ---- the deploy lands -------------------------------------------------
      const deployed = await deliverPublication(app, {
        integratedCommit: integrated,
        buildStatus: "succeeded",
        deployedCommit: integrated,
        publicUrl: "https://causal-projector.joemattie.com",
        deployedAt: "2026-07-19T18:30:00Z",
        publisherVersion: "0.1.0",
      });
      expect(deployed.status).toBe(200);

      const live = await readProject();
      expect(live.publication.buildStatus).toBe("succeeded");
      expect(live.publication.deployedCommit).toBe(integrated);
      expect(live.publication.publicUrl).toBe("https://causal-projector.joemattie.com");
      // Only now, with both sides known and equal, is it in sync.
      expect(live.publication.inSync).toBe(true);

      // ---- a new commit reopens the gap -------------------------------------
      // Nothing about a successful commit may mark a revision published
      // (contract §6); integrating again must make the site stale.
      const second = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload({ body: "A second suggestion." }), {
          Cookie: cookie,
        }),
      );
      expect(second.status).toBe(202);
      const reintegrated = app.fake.state.getRef(BRANCH) as string;
      expect(reintegrated).not.toBe(integrated);
      expect((await deliverPush(app, { deliveryId: "p5-pub-push-2" })).status).toBe(200);

      const stale = await readProject();
      expect(stale.publication.integratedCommit).toBe(reintegrated);
      expect(stale.publication.deployedCommit).toBe(integrated);
      expect(stale.publication.inSync).toBe(false);
    } finally {
      app.close();
    }
  });
});
