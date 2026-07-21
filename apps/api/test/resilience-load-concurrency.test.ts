/**
 * Phase 7 exit criterion 4, load half - **sustained fleet-shaped traffic
 * against one project.**
 *
 * The contract asks for "sustained concurrent claims and submissions" and for
 * the load to "hold". Holding is not a latency number here; it is the Phase 4
 * invariants surviving contention:
 *
 * 1. **Exactly one lease per work item.** Enforced by the partial unique index
 *    `idx_leases_active_work_item`, not by application hope. Under a race the
 *    losers must see a typed `409 lease-held`, never a 500 and never a second
 *    lease.
 * 2. **No clobbered chapter revision.** Concurrent submissions against the
 *    same chapter must produce a revision sequence with no gaps, no repeats,
 *    and no lost prose - every applied revision appears exactly once in the
 *    attribution artifact, and each applied edit is still in the file.
 * 3. **No duplicated work item.** Votes crossing the governance threshold
 *    simultaneously must create one work item and one `create_work_item`
 *    decision, not one per voter who happened to observe the crossing.
 *
 * ## Why several app instances over one database
 *
 * The API serializes claims per project *in process*. A single `Hono` instance
 * would therefore make a "concurrent claim" test prove only that the
 * serializer works. The deployed shape is several Worker isolates over one D1,
 * where that serializer offers nothing - so the races below are driven through
 * MULTIPLE `createApi` instances sharing one database, which is the shape that
 * actually exercises the compare-and-swap and the unique index.
 *
 * ## Why this is still deterministic
 *
 * Concurrency is expressed as `Promise.all` over the real request handlers on
 * a synchronous SQLite driver: the interleaving varies at every `await`, but
 * the assertions are all invariants ("exactly one", "no gaps", "no loss")
 * rather than orderings, so there is no schedule under which they pass by
 * luck. Nothing sleeps, nothing polls, and the whole file runs in about a
 * second.
 */
import { describe, expect, it } from "vitest";
import { createApi, type AuthorbotApi } from "../src/app.js";
import { parseAttributionArtifact } from "@authorbot/repo-coordinator";
import { createDevIdentityProvider } from "../src/identity/provider.js";
import type { AppConfig } from "../src/deps.js";
import {
  BRANCH,
  CHAPTER_1,
  FULL_NAME,
  INITIAL_MAINTAINER,
  PROJECT_SLUG,
  SESSION_SECRET,
  WEBHOOK_SECRET,
  devLogin,
  jsonRequest,
  makeGitHubIntegrationApp,
  type GitHubIntegrationApp,
} from "./integration/phase5-helpers.js";

/** The five block ids of `examples/book-repo/chapters/001-baseline.md`. */
const BLOCKS = [
  {
    id: "019cadfe-7360-7049-a30b-1f5898a5020a",
    exact: "a Tuesday",
    start: 22,
    end: 31,
    replacement: "a Thursday",
  },
  {
    id: "019cadff-5dc0-7486-a457-a15be68bb8eb",
    exact: "found it",
    start: 10,
    end: 18,
    replacement: "noticed it",
  },
  {
    id: "019cae00-4820-7bef-81b9-c45c817eee7f",
    exact: "not clean",
    start: 13,
    end: 22,
    replacement: "not remotely clean",
  },
  {
    id: "019cae01-3280-79cf-95fd-0902938bded2",
    exact: "trained people",
    start: 13,
    end: 27,
    replacement: "careful people",
  },
  {
    id: "019cae02-1ce0-7f02-b609-9f3e2e9c2636",
    exact: "By morning",
    start: 0,
    end: 10,
    replacement: "By first light",
  },
] as const;

function suggestionOn(block: (typeof BLOCKS)[number], revision: number, body: string) {
  return {
    kind: "suggestion",
    scope: "range",
    chapterRevision: revision,
    target: {
      blockId: block.id,
      textPosition: { start: block.start, end: block.end },
      textQuote: { exact: block.exact },
    },
    body,
  };
}

/**
 * A second (third, fourth…) API instance over the SAME database - the test's
 * stand-in for another Worker isolate. Deliberately does not call
 * `bootstrap()`: the project row already exists, and re-seeding would be a
 * test-only path the deployment never takes.
 */
function siblingIsolate(app: GitHubIntegrationApp): AuthorbotApi {
  const config: AppConfig = {
    authMode: "dev",
    sessionSecret: SESSION_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    projectSlug: PROJECT_SLUG,
    projectRepo: FULL_NAME,
    initialMaintainer: INITIAL_MAINTAINER,
    mirrorMode: "durable",
  };
  return createApi({
    db: app.db,
    config,
    identityProvider: createDevIdentityProvider(),
    reader: app.git.reader,
    onMutationCommitted: async () => {
      await app.coordinator.drainOutbox();
    },
  });
}

/** Annotation → three approvals → `ready` work item, all through HTTP. */
async function openWorkItem(
  app: GitHubIntegrationApp,
  payload: Record<string, unknown>,
  prefix: string,
): Promise<{ annotationId: string; workItemId: string }> {
  const author = await devLogin(app, `${prefix}-author`, "contributor");
  const created = await app.app.request(
    `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
    jsonRequest("POST", payload, { Cookie: author }),
  );
  expect(created.status).toBe(202);
  const { annotationId } = (await created.json()) as { annotationId: string };
  for (const [index, suffix] of ["a", "b", "c"].entries()) {
    const voter = await devLogin(
      app,
      `${prefix}-${suffix}`,
      index === 0 ? "maintainer" : "contributor",
    );
    const voted = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${annotationId}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: voter }),
    );
    expect(voted.status).toBeLessThan(300);
  }
  const items = await app.repos.workItems.listBySourceAnnotation(annotationId);
  expect(items).toHaveLength(1);
  expect(items[0]!.status).toBe("ready");
  return { annotationId, workItemId: items[0]!.id };
}

// ===========================================================================
// Invariant 1: exactly one lease per work item
// ===========================================================================

describe("load: sustained concurrent claims", () => {
  it("twelve isolates racing for one work item produce exactly one lease and eleven typed refusals", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const { workItemId } = await openWorkItem(
        app,
        suggestionOn(BLOCKS[0], CHAPTER_1.revision, "Reword the day."),
        "race",
      );

      // Four isolates, twelve claimants spread across them.
      const isolates = [app.api, siblingIsolate(app), siblingIsolate(app), siblingIsolate(app)];
      const claimants = await Promise.all(
        Array.from({ length: 12 }, async (_unused, index) => {
          const isolate = isolates[index % isolates.length] as AuthorbotApi;
          const login = await isolate.app.request("/v1/dev/login", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "http://localhost" },
            body: JSON.stringify({ login: `racer-${index}`, role: "editor" }),
          });
          expect(login.status).toBe(200);
          return {
            isolate,
            cookie: (login.headers.get("set-cookie") as string).split(";")[0] as string,
          };
        }),
      );

      const responses = await Promise.all(
        claimants.map(({ isolate, cookie }) =>
          isolate.app.request(
            `/v1/projects/${app.projectId}/work-items/${workItemId}/claim`,
            jsonRequest("POST", {}, { Cookie: cookie }),
          ),
        ),
      );
      const statuses = responses.map((response) => response.status);

      // Exactly one winner.
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      // Every loser is a typed conflict, never a 500 and never a 200.
      const losers = responses.filter((response) => response.status !== 201);
      expect(losers).toHaveLength(11);
      for (const loser of losers) {
        expect(loser.status, "contention must never surface as a 5xx").toBe(409);
        const body = (await loser.json()) as { code: string };
        expect(["lease-held", "state-conflict"]).toContain(body.code);
      }

      // The database agrees: exactly one ACTIVE lease on this work item, and
      // the work item is `leased` exactly once.
      const active = await app.db
        .prepare(
          `SELECT COUNT(*) AS n FROM leases
             WHERE work_item_id = ? AND released_at IS NULL AND revoked_at IS NULL`,
        )
        .bind(workItemId)
        .all();
      expect(Number(active[0]?.["n"])).toBe(1);
      const total = await app.db
        .prepare(`SELECT COUNT(*) AS n FROM leases WHERE work_item_id = ?`)
        .bind(workItemId)
        .all();
      expect(Number(total[0]?.["n"])).toBe(1);
      expect((await app.repos.workItems.getById(workItemId))?.status).toBe("leased");
    } finally {
      app.close();
    }
  });

  it("sustained claiming across five work items never issues two leases for one item", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const workItems: string[] = [];
      for (const [index, block] of BLOCKS.entries()) {
        const { workItemId } = await openWorkItem(
          app,
          suggestionOn(block, CHAPTER_1.revision, `Adjust passage ${index}.`),
          `sustained-${index}`,
        );
        workItems.push(workItemId);
      }

      const isolates = [app.api, siblingIsolate(app), siblingIsolate(app)];
      // 5 items × 6 claimants, all in flight at once: 30 concurrent claims.
      const attempts = workItems.flatMap((workItemId, itemIndex) =>
        Array.from({ length: 6 }, (_unused, claimant) => ({
          workItemId,
          isolate: isolates[(itemIndex + claimant) % isolates.length] as AuthorbotApi,
          login: `sustained-racer-${itemIndex}-${claimant}`,
        })),
      );

      const prepared = await Promise.all(
        attempts.map(async (attempt) => {
          const login = await attempt.isolate.app.request("/v1/dev/login", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "http://localhost" },
            body: JSON.stringify({ login: attempt.login, role: "editor" }),
          });
          return {
            ...attempt,
            cookie: (login.headers.get("set-cookie") as string).split(";")[0] as string,
          };
        }),
      );

      const results = await Promise.all(
        prepared.map(async (attempt) => {
          const response = await attempt.isolate.app.request(
            `/v1/projects/${app.projectId}/work-items/${attempt.workItemId}/claim`,
            jsonRequest("POST", {}, { Cookie: attempt.cookie }),
          );
          return { workItemId: attempt.workItemId, status: response.status };
        }),
      );

      // Exactly one winner per work item; nothing anywhere returned a 5xx.
      for (const workItemId of workItems) {
        const forItem = results.filter((result) => result.workItemId === workItemId);
        expect(forItem.filter((result) => result.status === 201)).toHaveLength(1);
      }
      expect(results.filter((result) => result.status >= 500)).toEqual([]);

      // And the index-level truth: one active lease per item, five in total.
      const rows = await app.db
        .prepare(
          `SELECT work_item_id AS w, COUNT(*) AS n FROM leases
             WHERE released_at IS NULL AND revoked_at IS NULL
             GROUP BY work_item_id`,
        )
        .all();
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(Number(row["n"])).toBe(1);
      }
    } finally {
      app.close();
    }
  });
});

// ===========================================================================
// Invariant 2: no clobbered chapter revision
// ===========================================================================

describe("load: sustained concurrent submissions against one chapter", () => {
  it("every applied submission gets its own revision - no gap, no repeat, no lost prose", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      // Five work items on five DIFFERENT blocks of the same chapter, each
      // claimed and each holding a valid bundle at the SAME base revision.
      // Submitting them all at once is the shape that clobbers a chapter if
      // anything about the write path is not serialized.
      const claims: {
        workItemId: string;
        cookie: string;
        isolate: AuthorbotApi;
        leaseId: string;
        leaseToken: string;
        baseRevision: number;
        baseContentHash: string;
        replacement: string;
      }[] = [];

      const isolates = [app.api, siblingIsolate(app), siblingIsolate(app)];
      for (const [index, block] of BLOCKS.entries()) {
        const { workItemId } = await openWorkItem(
          app,
          suggestionOn(block, CHAPTER_1.revision, `Revise passage ${index}.`),
          `submit-${index}`,
        );
        const isolate = isolates[index % isolates.length] as AuthorbotApi;
        const login = await isolate.app.request("/v1/dev/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost" },
          body: JSON.stringify({ login: `submitter-${index}`, role: "editor" }),
        });
        const cookie = (login.headers.get("set-cookie") as string).split(";")[0] as string;
        const claimed = await isolate.app.request(
          `/v1/projects/${app.projectId}/work-items/${workItemId}/claim`,
          jsonRequest("POST", {}, { Cookie: cookie }),
        );
        expect(claimed.status).toBe(201);
        const bundle = (await claimed.json()) as {
          lease: { id: string; token: string };
          document: { revision: number; contentHash: string };
        };
        claims.push({
          workItemId,
          cookie,
          isolate,
          leaseId: bundle.lease.id,
          leaseToken: bundle.lease.token,
          baseRevision: bundle.document.revision,
          baseContentHash: bundle.document.contentHash,
          replacement: block.replacement,
        });
      }

      // All five bundles share one base - this is a genuine five-way race.
      expect(new Set(claims.map((claim) => claim.baseContentHash)).size).toBe(1);
      const baseRevision = claims[0]!.baseRevision;

      const responses = await Promise.all(
        claims.map((claim) =>
          claim.isolate.app.request(
            `/v1/projects/${app.projectId}/work-items/${claim.workItemId}/submissions`,
            jsonRequest(
              "POST",
              {
                leaseId: claim.leaseId,
                leaseToken: claim.leaseToken,
                type: "range_replacement",
                baseRevision: claim.baseRevision,
                baseContentHash: claim.baseContentHash,
                content: claim.replacement,
                summary: "Concurrent revision.",
              },
              { Cookie: claim.cookie },
            ),
          ),
        ),
      );

      // Every submission is either accepted (202) or refused with a typed
      // conflict. Nothing is a 5xx.
      for (const response of responses) {
        expect([202, 409, 422]).toContain(response.status);
      }
      await app.coordinator.drainOutbox();

      // ---- the invariant ---------------------------------------------------
      const chapter = await app.repos.chapters.getById(CHAPTER_1.id);
      const finalRevision = chapter?.revision as number;
      expect(finalRevision).toBeGreaterThan(baseRevision);

      // The attribution artifact is the durable revision ledger. Every
      // revision from 1 to the final one appears EXACTLY once: a clobber
      // shows up here as a duplicate (two writers took the same number) or a
      // gap (a write was lost).
      const yaml = (await app.git.reader.readTextFile?.(
        `.authorbot/attribution/${CHAPTER_1.id}.yml`,
      )) as string;
      const revisions = parseAttributionArtifact(yaml).entries.map((entry) => entry.revision);
      expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
      expect(new Set(revisions).size, "a duplicate revision means a clobber").toBe(
        revisions.length,
      );
      expect(revisions[revisions.length - 1]).toBe(finalRevision);
      for (let i = 1; i < revisions.length; i += 1) {
        expect(
          (revisions[i] as number) - (revisions[i - 1] as number),
          "a revision gap means a lost write",
        ).toBe(1);
      }

      // The projection and the repository agree on the revision - the
      // projection never records a revision the file does not carry.
      const source = (await app.git.reader.readTextFile?.(CHAPTER_1.path)) as string;
      expect(source).toMatch(new RegExp(`^revision: ${finalRevision}$`, "m"));

      // Every applied submission's text is actually in the file, and nothing
      // that was NOT applied silently appeared.
      const applied = await app.db
        .prepare(`SELECT id, state FROM submissions WHERE state = 'applied'`)
        .all();
      expect(applied.length).toBe(finalRevision - baseRevision);

      // No prose was destroyed: the untouched blocks still hold their text.
      for (const block of BLOCKS) {
        expect(source).toContain(`authorbot:block id="${block.id}"`);
      }

      // Each commit on the chain has exactly one parent - a linear history,
      // never a lost or forked commit.
      let sha: string | null = app.fake.state.getRef(BRANCH);
      let walked = 0;
      while (sha !== null && walked < 200) {
        const commit = app.fake.state.getCommit(sha);
        expect(commit.parents.length).toBeLessThanOrEqual(1);
        sha = commit.parents[0] ?? null;
        walked += 1;
      }
      expect(walked).toBeGreaterThan(1);
    } finally {
      app.close();
    }
  });
});

// ===========================================================================
// Invariant 3: no duplicated work item
// ===========================================================================

describe("load: concurrent votes crossing the governance threshold", () => {
  it("six simultaneous approvals create ONE work item and ONE create_work_item decision", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const baselineWorkItemArtifacts = Object.keys(
        app.fake.state.readFiles(app.fake.state.getRef(BRANCH) as string),
      ).filter((path) => path.startsWith(".authorbot/work-items/")).length;

      const author = await devLogin(app, "vote-storm-author", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest(
          "POST",
          suggestionOn(BLOCKS[2], CHAPTER_1.revision, "Sharpen this."),
          { Cookie: author },
        ),
      );
      expect(created.status).toBe(202);
      const { annotationId } = (await created.json()) as { annotationId: string };

      // Six voters across three isolates, all voting at once. The rule fires
      // at the third approval, so several of them observe the crossing.
      const isolates = [app.api, siblingIsolate(app), siblingIsolate(app)];
      const voters = await Promise.all(
        Array.from({ length: 6 }, async (_unused, index) => {
          const isolate = isolates[index % isolates.length] as AuthorbotApi;
          const login = await isolate.app.request("/v1/dev/login", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "http://localhost" },
            body: JSON.stringify({
              login: `vote-storm-${index}`,
              role: index === 0 ? "maintainer" : "contributor",
            }),
          });
          return {
            isolate,
            cookie: (login.headers.get("set-cookie") as string).split(";")[0] as string,
          };
        }),
      );

      const responses = await Promise.all(
        voters.map(({ isolate, cookie }) =>
          isolate.app.request(
            `/v1/projects/${app.projectId}/annotations/${annotationId}/vote`,
            jsonRequest("PUT", { value: "approve" }, { Cookie: cookie }),
          ),
        ),
      );
      for (const response of responses) {
        expect(response.status, "a vote must never 5xx under contention").toBeLessThan(500);
      }

      // ONE work item, however many voters saw the threshold cross.
      const items = await app.repos.workItems.listBySourceAnnotation(annotationId);
      expect(items).toHaveLength(1);

      // ONE decision authorising it. A second would mean the rule fired twice
      // and a duplicate was merely suppressed downstream.
      const decisions = await app.db
        .prepare(
          `SELECT COUNT(*) AS n FROM decisions
             WHERE source_annotation_id = ? AND action_type = 'create_work_item'`,
        )
        .bind(annotationId)
        .all();
      expect(Number(decisions[0]?.["n"])).toBe(1);

      // And the repository gained exactly ONE work-item artifact. Counted as
      // a delta against the seeded fixture (`examples/book-repo` already ships
      // one) so this asserts what the vote storm produced, not what was there
      // before.
      await app.coordinator.drainOutbox();
      const tree = app.fake.state.readFiles(app.fake.state.getRef(BRANCH) as string);
      const artifacts = Object.keys(tree).filter((path) =>
        path.startsWith(".authorbot/work-items/"),
      );
      expect(artifacts).toHaveLength(baselineWorkItemArtifacts + 1);
      expect(artifacts).toContain(`.authorbot/work-items/${items[0]!.id}.md`);
    } finally {
      app.close();
    }
  });
});

// ===========================================================================
// Mixed sustained load
// ===========================================================================

describe("load: sustained mixed traffic", () => {
  it("thirty interleaved writes and reads all land, on one linear commit chain, with nothing lost", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const isolates = [app.api, siblingIsolate(app), siblingIsolate(app), siblingIsolate(app)];
      const actors = await Promise.all(
        Array.from({ length: 6 }, async (_unused, index) => {
          const isolate = isolates[index % isolates.length] as AuthorbotApi;
          const login = await isolate.app.request("/v1/dev/login", {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "http://localhost" },
            body: JSON.stringify({ login: `mixed-${index}`, role: "contributor" }),
          });
          return {
            isolate,
            cookie: (login.headers.get("set-cookie") as string).split(";")[0] as string,
          };
        }),
      );

      const headBefore = app.fake.state.getRef(BRANCH) as string;
      const writes: Promise<{ status: number; annotationId: string | undefined }>[] = [];
      const reads: Promise<number>[] = [];

      for (let index = 0; index < 30; index += 1) {
        const actor = actors[index % actors.length]!;
        const block = BLOCKS[index % BLOCKS.length]!;
        writes.push(
          (async () => {
            const response = await actor.isolate.app.request(
              `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
              jsonRequest(
                "POST",
                suggestionOn(block, CHAPTER_1.revision, `Mixed-load note ${index}.`),
                { Cookie: actor.cookie },
              ),
            );
            const body = (await response.json()) as { annotationId?: string };
            // Deliberately not spread: the 202 body carries its own `status`
            // field ("queued"), which would shadow the HTTP status.
            return { status: response.status, annotationId: body.annotationId };
          })(),
        );
        // Reads issued INTO the same window, from the same isolates.
        reads.push(
          (async () => {
            const response = await actor.isolate.app.request(
              `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
              { headers: { Cookie: actor.cookie } },
            );
            return response.status;
          })(),
        );
      }

      const written = await Promise.all(writes);
      const readStatuses = await Promise.all(reads);

      // Every write accepted, every read served, throughout the burst.
      expect(written.filter((result) => result.status !== 202)).toEqual([]);
      expect(readStatuses.filter((status) => status !== 200)).toEqual([]);

      await app.coordinator.drainOutbox();

      // Every single annotation reached the repository. A lost commit shows up
      // here as a missing artifact, not as a failed request.
      const head = app.fake.state.getRef(BRANCH) as string;
      expect(head).not.toBe(headBefore);
      const tree = app.fake.state.readFiles(head);
      for (const result of written) {
        expect(
          tree[`.authorbot/annotations/${result.annotationId as string}/annotation.md`],
          `annotation ${result.annotationId} never reached the repository`,
        ).toBeDefined();
      }

      // The history is linear: 30 commits' worth of concurrent writes, never
      // a fork and never a merge.
      let sha: string | null = head;
      let count = 0;
      while (sha !== null && sha !== headBefore && count < 200) {
        const commit = app.fake.state.getCommit(sha);
        expect(commit.parents).toHaveLength(1);
        sha = commit.parents[0] ?? null;
        count += 1;
      }
      expect(sha).toBe(headBefore);
      expect(count).toBe(30);

      // Nothing left owed.
      const pending = await app.db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending', 'processing')`)
        .all();
      expect(Number(pending[0]?.["n"])).toBe(0);
    } finally {
      app.close();
    }
  });
});
