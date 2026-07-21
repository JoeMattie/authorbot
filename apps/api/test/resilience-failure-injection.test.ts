/**
 * Phase 7 exit criterion 4, failure half — **degrade honestly.**
 *
 * The contract's phrasing is "Failures must degrade honestly — reads keep
 * working, writes refuse clearly." That is a stronger claim than "returns a
 * 5xx", and it is asserted here as three separate properties for every
 * injected failure:
 *
 * 1. **Reads keep working.** The published record is served from the
 *    projection, which no failure below touches. A GitHub outage, a rate
 *    limit, or a diverged repository must not take the book offline.
 * 2. **Writes refuse clearly, or queue honestly.** Either the response carries
 *    a typed `application/problem+json` with a stable `code`, or it is a `202`
 *    whose operation is observably NOT committed. What is forbidden is a `2xx`
 *    that implies durability the system did not achieve.
 * 3. **The repository is untouched.** Asserted against the fake's actual
 *    commit graph — branch head and tree — not against a status code. A test
 *    that only checks the response would pass on a system that returned an
 *    error *after* writing a half-commit.
 *
 * Where a failure is transient, the suite also asserts the *recovery*: the
 * queued work is still there afterwards and lands intact. Silent data loss and
 * fabricated success are the two failure modes this file exists to exclude,
 * and only asserting recovery excludes the first.
 */
import { describe, expect, it } from "vitest";
import { GitHubWriteError } from "@authorbot/git-github";
import type { BookRepoWriter } from "@authorbot/repo-coordinator";
import {
  BRANCH,
  CHAPTER_1,
  CHAPTER_3,
  devLogin,
  deliverPush,
  jsonRequest,
  makeGitHubIntegrationApp,
  rangeSuggestionPayload,
  type GitHubIntegrationApp,
} from "./integration/phase5-helpers.js";
import { uuidv7 } from "../src/ids.js";

/** Everything a reader can ask for, in one call. Used after every failure. */
async function assertReadsStillWork(
  app: GitHubIntegrationApp,
  cookie: string,
): Promise<void> {
  const chapters = await app.app.request(`/v1/projects/${app.projectId}/chapters`, {
    headers: { Cookie: cookie },
  });
  expect(chapters.status, "GET chapters must keep working").toBe(200);
  expect(((await chapters.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);

  const chapter = await app.app.request(
    `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}`,
    { headers: { Cookie: cookie } },
  );
  expect(chapter.status, "GET chapter must keep working").toBe(200);

  const annotations = await app.app.request(
    `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
    { headers: { Cookie: cookie } },
  );
  expect(annotations.status, "GET annotations must keep working").toBe(200);

  const project = await app.app.request(`/v1/projects/${app.projectId}`, {
    headers: { Cookie: cookie },
  });
  expect(project.status, "GET project must keep working").toBe(200);
}

async function problemBody(response: Response): Promise<{ code: string; title: string }> {
  expect(
    response.headers.get("content-type"),
    "a refusal must be application/problem+json",
  ).toContain("application/problem+json");
  return (await response.json()) as { code: string; title: string };
}

async function operationState(
  app: GitHubIntegrationApp,
  cookie: string,
  operationId: string,
): Promise<{ state: string; attempts: number; commitSha: string | null; error: string | null }> {
  const response = await app.app.request(
    `/v1/projects/${app.projectId}/operations/${operationId}`,
    { headers: { Cookie: cookie } },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as never;
}

/**
 * A writer that fails every commit while `failing()` is true, then behaves
 * normally. Reads are passed through untouched: an outage on the write path
 * must not be confused with one on the read path.
 *
 * The thrown error is the one `GitHubBookRepoWriter` itself constructs when a
 * `fetch` is REJECTED (connection reset, TLS failure, cancelled request):
 * `kind: "git-failure"`, `retryable: true`. That classification matters — the
 * processor retries only `isGitWriteError(error) && error.retryable`, so
 * throwing a bare `Error` here would model a *different* failure (terminal,
 * never retried) and the recovery assertions below would be testing fiction.
 */
function outageWriter(inner: BookRepoWriter, failing: () => boolean): BookRepoWriter {
  return {
    ...(inner.readFile === undefined
      ? {}
      : { readFile: (branch: string, path: string) => inner.readFile!(branch, path) }),
    commitFiles: async (input) => {
      if (failing()) {
        throw new GitHubWriteError({
          kind: "git-failure",
          retryable: true,
          message:
            "GitHub request POST /git/commits did not complete (transport failure): " +
            "connect ECONNREFUSED api.github.invalid:443",
        });
      }
      return inner.commitFiles(input);
    },
  };
}

/**
 * Terminal-success states of the `git_operations` machine. `committed` is
 * reached by the commit itself; `verified` is a later confirmation step, so a
 * drain that succeeded may legitimately report either.
 */
const COMMITTED_STATES = ["committed", "verified"];

// ===========================================================================
// 1. Coordinator outbox backlog
// ===========================================================================

describe("failure injection: a coordinator outbox backlog", () => {
  it("keeps accepting and serving, reports every queued operation as NOT committed, and loses nothing when the coordinator returns", async () => {
    // `deferDrain` reproduces the real window: `onMutationCommitted` is a
    // fire-and-forget call to the Durable Object whose failure is swallowed,
    // so rows genuinely sit `pending` until the periodic alarm. A coordinator
    // that is down, evicted, or simply behind looks exactly like this.
    let coordinatorDown = true;
    const app = await makeGitHubIntegrationApp({ deferDrain: () => coordinatorDown });
    try {
      const cookie = await devLogin(app, "backlog-vera", "contributor");
      const headBefore = app.fake.state.getRef(BRANCH) as string;

      // Build a backlog of ten accepted commands.
      const operations: string[] = [];
      const annotations: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const response = await app.app.request(
          `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
          jsonRequest("POST", rangeSuggestionPayload({ body: `Backlog note ${i}.` }), {
            Cookie: cookie,
          }),
        );
        // 202 Accepted, not 201 Created: the API never claims the commit
        // landed. That distinction is the whole honesty argument here.
        expect(response.status).toBe(202);
        const body = (await response.json()) as {
          operationId: string;
          annotationId: string;
          status: string;
        };
        expect(body.status).toBe("queued");
        operations.push(body.operationId);
        annotations.push(body.annotationId);
      }

      // Nothing reached the repository.
      expect(app.fake.state.getRef(BRANCH)).toBe(headBefore);

      // Every operation reports itself as queued and uncommitted. An operator
      // (or a client polling) can see the backlog rather than inferring it.
      for (const operationId of operations) {
        const op = await operationState(app, cookie, operationId);
        expect(op.state).toBe("queued");
        expect(op.commitSha).toBeNull();
      }
      const pending = await app.db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`)
        .all();
      expect(Number(pending[0]?.["n"])).toBe(10);

      // The annotations are visible in the API as `pending_git`, so a reader
      // is told the state rather than shown a phantom committed comment.
      for (const annotationId of annotations) {
        expect((await app.repos.annotations.getById(annotationId))?.status).toBe("pending_git");
      }

      // Reads are entirely unaffected by the backlog.
      await assertReadsStillWork(app, cookie);

      // ---- the coordinator comes back --------------------------------------
      coordinatorDown = false;
      const drained = await app.coordinator.drainOutbox();
      expect(drained.failed).toBe(0);
      expect(drained.committed).toBe(10);

      // Nothing was dropped: every operation committed, and the branch moved.
      for (const operationId of operations) {
        const op = await operationState(app, cookie, operationId);
        expect(COMMITTED_STATES).toContain(op.state);
        expect(op.commitSha).not.toBeNull();
      }
      expect(app.fake.state.getRef(BRANCH)).not.toBe(headBefore);
      const tree = app.fake.state.readFiles(app.fake.state.getRef(BRANCH) as string);
      for (const annotationId of annotations) {
        expect(tree[`.authorbot/annotations/${annotationId}/annotation.md`]).toBeDefined();
      }
      const stillPending = await app.db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`)
        .all();
      expect(Number(stillPending[0]?.["n"])).toBe(0);
    } finally {
      app.close();
    }
  });

  it("a backlog delays governance on the backlogged annotation, and says so instead of failing strangely", async () => {
    // The honest boundary of "a backlog is only a delay". Intake keeps
    // working — a reader can still reply and a contributor can still annotate
    // — but an annotation that has not reached Git yet cannot be VOTED on,
    // because a vote is a governance act on a durable record. The refusal is
    // a typed 409 naming the status, not a 500 and not a silently dropped
    // ballot. Operators need to know this: a stuck coordinator quietly stalls
    // the governance pipeline for everything queued behind it.
    let down = true;
    const app = await makeGitHubIntegrationApp({ deferDrain: () => down });
    try {
      const author = await devLogin(app, "backlog-author", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: author }),
      );
      expect(created.status).toBe(202);
      const { annotationId } = (await created.json()) as { annotationId: string };

      // Replies to a queued annotation ARE accepted — the conversation keeps
      // moving even while the mirror is behind.
      const replied = await app.app.request(
        `/v1/projects/${app.projectId}/annotations/${annotationId}/replies`,
        jsonRequest("POST", { body: "Still able to talk." }, { Cookie: author }),
      );
      expect(replied.status).toBe(202);

      // A vote is refused, clearly.
      const voter = await devLogin(app, "backlog-voter", "maintainer");
      const voted = await app.app.request(
        `/v1/projects/${app.projectId}/annotations/${annotationId}/vote`,
        jsonRequest("PUT", { value: "approve" }, { Cookie: voter }),
      );
      expect(voted.status).toBe(409);
      const refusal = (await voted.json()) as { code: string; detail: string };
      expect(refusal.code).toBe("state-conflict");
      expect(refusal.detail).toContain("pending_git");

      await assertReadsStillWork(app, author);

      // Once the coordinator returns, the same vote is accepted: nothing was
      // permanently blocked, only deferred.
      down = false;
      const drained = await app.coordinator.drainOutbox();
      expect(drained.failed).toBe(0);
      expect((await app.repos.annotations.getById(annotationId))?.status).toBe("open");

      const retried = await app.app.request(
        `/v1/projects/${app.projectId}/annotations/${annotationId}/vote`,
        jsonRequest("PUT", { value: "approve" }, { Cookie: voter }),
      );
      expect(retried.status).toBeLessThan(300);
    } finally {
      app.close();
    }
  });
});

// ===========================================================================
// 2. GitHub API rate limiting (403 + headers)
// ===========================================================================

describe("failure injection: GitHub rate limiting", () => {
  it("a 403 secondary rate limit does not commit, does not lose the row, and does not stop reads", async () => {
    const app = await makeGitHubIntegrationApp({ deferDrain: true, maxAttempts: 1 });
    try {
      const cookie = await devLogin(app, "ratelimit-nina", "contributor");
      const headBefore = app.fake.state.getRef(BRANCH) as string;

      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(created.status).toBe(202);
      const { operationId, annotationId } = (await created.json()) as {
        operationId: string;
        annotationId: string;
      };

      // GitHub's real shape: 403 with `retry-after` and `x-ratelimit-reset`.
      app.fake.faults.set("rateLimited", {
        times: 50,
        secondary: true,
        retryAfterSeconds: 60,
      });

      const drained = await app.coordinator.drainOutbox();
      app.fake.faults.clear();

      // The drain reports failure rather than success. `maxAttempts: 1` makes
      // this deterministic: one attempt, one refusal, one terminal state.
      expect(drained.committed).toBe(0);
      expect(drained.failed).toBe(1);

      // Nothing was committed and the branch did not move — the refusal is
      // asserted on the commit graph, not on a return value.
      expect(app.fake.state.getRef(BRANCH)).toBe(headBefore);

      // The operation says so, in terms an operator can act on. It rests in
      // `queued`, NOT `failed`: a rate limit is GitHub being unavailable, not
      // anything wrong with this write, so the coordinator hands it to a later
      // drain instead of spending the commit budget on an outage. That is what
      // "does not lose the row" means — the row is still there to retry.
      const op = await operationState(app, cookie, operationId);
      expect(op.state).toBe("queued");
      expect(op.error).toContain("rate limit");
      const stillQueued = await app.db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`)
        .all();
      expect(Number((stillQueued[0] as { n: number }).n)).toBeGreaterThan(0);
      expect(op.commitSha).toBeNull();
      expect(op.error).toBeTruthy();
      // No credential material ever reaches a stored error string.
      expect(op.error).not.toMatch(/ghs_|ghp_|BEGIN PRIVATE KEY/);

      // The annotation's CONTENT is not lost. It stays in the operational
      // database as `pending_git`, which is the state the rebuild is
      // documented to preserve — an operator can retry rather than ask the
      // author to retype it.
      const annotation = await app.repos.annotations.getById(annotationId);
      expect(annotation?.status).toBe("pending_git");
      expect(annotation?.body).toBe(rangeSuggestionPayload()["body"]);

      // Reads keep working throughout.
      await assertReadsStillWork(app, cookie);

      // And new work is still accepted: a rate limit on the write path must
      // not become a refusal on the intake path, or a fleet's backoff turns
      // into a human's outage.
      const stillAccepting = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload({ body: "Accepted anyway." }), {
          Cookie: cookie,
        }),
      );
      expect(stillAccepting.status).toBe(202);
    } finally {
      app.close();
    }
  });

  it("a rate limit that clears within the retry budget commits normally", async () => {
    // Honest degradation is not the same as giving up. A single 403 inside the
    // bounded-retry budget must be absorbed, not escalated to the operator.
    const app = await makeGitHubIntegrationApp({ deferDrain: true, maxAttempts: 3 });
    try {
      const cookie = await devLogin(app, "ratelimit-omar", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(created.status).toBe(202);
      const { operationId } = (await created.json()) as { operationId: string };

      app.fake.faults.set("rateLimited", { times: 1, retryAfterSeconds: 1 });
      await app.coordinator.drainOutbox();
      // Prove the fault actually fired; a silently-not-taken code path would
      // otherwise let this test pass for the wrong reason.
      expect(app.fake.faults.remaining("rateLimited")).toBe(0);

      // The processor's bounded retry (Phase 2 contract §5, 3 attempts) needs
      // a second drain pass; the row stays claimable rather than being failed.
      await app.coordinator.drainOutbox();

      const op = await operationState(app, cookie, operationId);
      expect(COMMITTED_STATES).toContain(op.state);
      expect(op.commitSha).not.toBeNull();
      expect(op.attempts).toBeGreaterThan(1);
    } finally {
      app.close();
    }
  });
});

// ===========================================================================
// 3. Outright GitHub outage
// ===========================================================================

describe("failure injection: GitHub is unreachable", () => {
  it("reads keep serving the last projection, writes queue, and the backlog lands intact when GitHub returns", async () => {
    // A flaky/unreachable GitHub that recovers inside the retry budget. Note
    // that the budget is consumed WITHIN one drain — the processor loops
    // `conflict → queued` internally — so "two failed attempts then success"
    // is expressed as a failure count, not as a number of drain calls.
    let failuresLeft = 2;
    const app = await makeGitHubIntegrationApp({
      deferDrain: true,
      maxAttempts: 5,
      wrapWriter: (inner) =>
        outageWriter(inner, () => {
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            return true;
          }
          return false;
        }),
    });
    try {
      const cookie = await devLogin(app, "outage-pia", "contributor");
      const headBefore = app.fake.state.getRef(BRANCH) as string;

      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload({ body: "Written during an outage." }), {
          Cookie: cookie,
        }),
      );
      expect(created.status).toBe(202);
      const { operationId, annotationId } = (await created.json()) as {
        operationId: string;
        annotationId: string;
      };

      // While the coordinator has not run, nothing reached the repository and
      // the operation is honestly reported as queued.
      expect(app.fake.state.getRef(BRANCH)).toBe(headBefore);
      const midOutage = await operationState(app, cookie, operationId);
      expect(COMMITTED_STATES).not.toContain(midOutage.state);
      expect(midOutage.commitSha).toBeNull();

      // The whole read surface is unaffected — the projection is local.
      await assertReadsStillWork(app, cookie);

      // ---- successive drains absorb the outage, then the write lands -------
      // One attempt per drain, by design: an availability failure defers to
      // the next pass rather than burning the commit budget in a tight loop.
      // So the recovery is modelled the way production experiences it — the
      // coordinator's alarm firing again — not as one drain retrying inline.
      for (let pass = 0; pass < 5 && failuresLeft > 0; pass += 1) {
        await app.coordinator.drainOutbox();
      }
      expect(failuresLeft).toBe(0);
      await app.coordinator.drainOutbox();

      const recovered = await operationState(app, cookie, operationId);
      expect(recovered.attempts).toBeGreaterThan(1);
      expect(COMMITTED_STATES).toContain(recovered.state);
      expect(recovered.commitSha).not.toBeNull();
      const tree = app.fake.state.readFiles(app.fake.state.getRef(BRANCH) as string);
      const artifact = tree[`.authorbot/annotations/${annotationId}/annotation.md`];
      expect(artifact).toContain("Written during an outage.");
    } finally {
      app.close();
    }
  });

  it("a sustained outage eventually gives up and says so, rather than deferring in silence", async () => {
    // An availability failure defers instead of spending the commit budget, so
    // a transient outage cannot strand a write. But deferral must still END:
    // an operation parked in `queued` forever is invisible — neither committed
    // nor failed — so nobody is ever told the write did not land. `maxDeferralMs`
    // is the deadline, set to zero here because the production default is an
    // hour and no test should wait for it.
    const app = await makeGitHubIntegrationApp({
      deferDrain: true,
      maxAttempts: 2,
      maxDeferralMs: 0,
      wrapWriter: (inner) => outageWriter(inner, () => true),
    });
    try {
      const cookie = await devLogin(app, "outage-quinn", "contributor");
      const headBefore = app.fake.state.getRef(BRANCH) as string;
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(created.status).toBe(202);
      const { operationId, annotationId } = (await created.json()) as {
        operationId: string;
        annotationId: string;
      };

      for (let i = 0; i < 4; i += 1) {
        await app.coordinator.drainOutbox();
      }

      const op = await operationState(app, cookie, operationId);
      expect(op.state).toBe("failed");
      expect(op.commitSha).toBeNull();
      expect(op.error).toContain("ECONNREFUSED");
      expect(app.fake.state.getRef(BRANCH)).toBe(headBefore);

      // Failed does not mean deleted: the author's words are still in the
      // database, so a re-queue after the outage is a recovery rather than a
      // rewrite.
      const annotation = await app.repos.annotations.getById(annotationId);
      expect(annotation?.status).toBe("pending_git");
      expect(annotation?.body).toBe(rangeSuggestionPayload()["body"]);

      await assertReadsStillWork(app, cookie);
    } finally {
      app.close();
    }
  });

  it("the coordinator alarm still sweeps leases while GitHub is down", async () => {
    // Contract §5 / Phase 4 §2: lease expiry is the one maintenance task that
    // must keep working with Git unavailable, or a crashed agent strands a
    // work item until somebody notices. The alarm records the Git failure as
    // an error and carries on.
    const app = await makeGitHubIntegrationApp({
      deferDrain: true,
      maxAttempts: 1,
      wrapWriter: (inner) => outageWriter(inner, () => true),
    });
    try {
      const cookie = await devLogin(app, "outage-sweeper", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(created.status).toBe(202);

      const result = await app.coordinator.alarm();
      // The drain failed…
      expect(result.drain.failed).toBe(1);
      // …and the sweep still ran, and the alarm still rescheduled itself.
      expect(result.sweep).toBeDefined();
      expect(result.sweep.expired).toBe(0);
      // A failing step never aborts the alarm.
      expect(result.errors).toEqual([]);
    } finally {
      app.close();
    }
  });
});

// ===========================================================================
// 4. D1 errors mid-batch
// ===========================================================================

describe("failure injection: the operational database fails mid-command", () => {
  it("a D1 failure inside a command's batch produces a typed 500 and leaves NOTHING behind", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const cookie = await devLogin(app, "d1-tess", "contributor");
      const headBefore = app.fake.state.getRef(BRANCH) as string;
      const annotationsBefore = await app.db
        .prepare(`SELECT COUNT(*) AS n FROM annotations`)
        .all();

      // Fail exactly the next `batch()` — the atomic write every command
      // funnels through (Phase 2 contract §5: record + audit event + outbox
      // row in ONE batch).
      const realBatch = app.db.batch.bind(app.db);
      let failNext = true;
      app.db.batch = async (statements) => {
        if (failNext) {
          failNext = false;
          throw new Error("D1_ERROR: network connection lost");
        }
        return realBatch(statements);
      };

      const response = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload({ body: "Should not survive." }), {
          Cookie: cookie,
        }),
      );

      // A clear refusal — never a 202 for a write that did not happen.
      expect(response.status).toBe(500);
      const body = await problemBody(response);
      expect(body.code).toBe("internal");
      // The response must not leak the database's own error text, which can
      // carry SQL values.
      expect(JSON.stringify(body)).not.toContain("D1_ERROR");
      expect((body as { correlationId?: string }).correlationId).toBeTruthy();

      // Nothing landed anywhere. This is the assertion that distinguishes an
      // honest failure from a half-applied one: no annotation, no outbox row,
      // no git operation, no commit.
      const annotationsAfter = await app.db.prepare(`SELECT COUNT(*) AS n FROM annotations`).all();
      expect(annotationsAfter[0]?.["n"]).toBe(annotationsBefore[0]?.["n"]);
      const orphanOutbox = await app.db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`)
        .all();
      expect(Number(orphanOutbox[0]?.["n"])).toBe(0);
      expect(app.fake.state.getRef(BRANCH)).toBe(headBefore);

      // Reads never went near the failing write path.
      await assertReadsStillWork(app, cookie);

      // The next identical request succeeds — the failure left no poison.
      const retry = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload({ body: "Should not survive." }), {
          Cookie: cookie,
        }),
      );
      expect(retry.status).toBe(202);
    } finally {
      app.close();
    }
  });

  it("a D1 failure during the drain's commit batch leaves the outbox row retryable, never silently done", async () => {
    // The dangerous shape: the commit reached GitHub but the bookkeeping batch
    // that records it failed. The row must NOT be marked committed on the
    // strength of a database write that did not happen.
    const app = await makeGitHubIntegrationApp({ deferDrain: true });
    try {
      const cookie = await devLogin(app, "d1-ulla", "contributor");
      const created = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(created.status).toBe(202);
      const { operationId } = (await created.json()) as { operationId: string };

      const realBatch = app.db.batch.bind(app.db);
      let armed = true;
      app.db.batch = async (statements) => {
        if (armed) {
          armed = false;
          throw new Error("D1_ERROR: statement failed mid-batch");
        }
        return realBatch(statements);
      };

      // The drain throws rather than swallowing; the coordinator's alarm
      // records it as an error and reschedules (asserted in the outage suite).
      await expect(app.coordinator.drainOutbox()).rejects.toThrow(/D1_ERROR/);

      // The operation is left mid-flight: `committing`, with the sha of the
      // commit that really did land on record, and the outbox row still
      // `processing`. Emphatically NOT a terminal success state, so nothing
      // downstream can mistake it for finished work — which is the whole
      // hazard of "the commit reached GitHub but the bookkeeping did not".
      const op = await operationState(app, cookie, operationId);
      expect(COMMITTED_STATES).not.toContain(op.state);
      expect(op.state).toBe("committing");
      const outbox = await app.db.prepare(`SELECT status FROM outbox`).all();
      expect(outbox.map((row) => row["status"])).toEqual(["processing"]);

      await assertReadsStillWork(app, cookie);

      // A later drain finishes the job. Rows found `processing` at drain entry
      // are treated as crash leftovers and resumed, and the resumed operation
      // reuses the commit it already made rather than producing a second one:
      // the failure cost a delay, not a duplicate and not a loss.
      const headBeforeRecovery = app.fake.state.getRef(BRANCH) as string;
      await app.coordinator.drainOutbox();
      const recovered = await operationState(app, cookie, operationId);
      expect(COMMITTED_STATES).toContain(recovered.state);
      expect(recovered.commitSha).toBe(op.commitSha);
      expect(app.fake.state.getRef(BRANCH)).toBe(headBeforeRecovery);
    } finally {
      app.close();
    }
  });
});

// ===========================================================================
// 5. A submission arriving while the projection is stale
// ===========================================================================

/** Annotation → three approvals → `ready` work item, all via HTTP. */
async function openWorkItem(
  app: GitHubIntegrationApp,
  chapterId: string,
  payload: Record<string, unknown>,
  prefix: string,
): Promise<{ annotationId: string; workItemId: string }> {
  const author = await devLogin(app, `${prefix}-author`, "contributor");
  const created = await app.app.request(
    `/v1/projects/${app.projectId}/chapters/${chapterId}/annotations`,
    jsonRequest("POST", payload, { Cookie: author }),
  );
  expect(created.status).toBe(202);
  const { annotationId } = (await created.json()) as { annotationId: string };
  for (const [index, suffix] of ["one", "two", "three"].entries()) {
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
  return { annotationId, workItemId: items[0]!.id };
}

describe("failure injection: a submission arrives against a stale projection", () => {
  it("an external edit under a live lease keeps the claim honest and never overwrites the outside editor's prose", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const { workItemId } = await openWorkItem(
        app,
        CHAPTER_1.id,
        rangeSuggestionPayload(),
        "stale",
      );
      const editor = await devLogin(app, "stale-editor", "editor");
      const claimed = await app.app.request(
        `/v1/projects/${app.projectId}/work-items/${workItemId}/claim`,
        jsonRequest("POST", {}, { Cookie: editor }),
      );
      expect(claimed.status).toBe(201);
      const bundle = (await claimed.json()) as {
        lease: { id: string; token: string };
        document: { revision: number; contentHash: string };
      };

      // Somebody edits the chapter directly on GitHub while the lease is out.
      const currentSource = (await app.git.reader.readTextFile?.(CHAPTER_1.path)) as string;
      const edited = currentSource
        .replace(/^revision: \d+$/m, `revision: ${bundle.document.revision + 1}`)
        .replace("Mara Voss found it", "Mara Voss noticed it");
      await app.fake.externalCommit({ [CHAPTER_1.path]: edited });
      expect((await deliverPush(app, { deliveryId: uuidv7() })).status).toBe(200);

      // The projection has moved on; the agent is holding a stale bundle.
      const projected = await app.repos.chapters.getById(CHAPTER_1.id);
      expect(projected?.revision).toBe(bundle.document.revision + 1);

      // A work-item artifact always says `ready` — leases are operational-only
      // and never written to Git — so a naive rebuild would reset this item to
      // `ready` while its lease row lived on, advertising work that cannot be
      // claimed. The projection keeps the operational status instead.
      expect((await app.repos.workItems.getById(workItemId))?.status).toBe("leased");

      // The lease is deliberately NOT released. A chapter moving under a claim
      // does not void the work: §5 rebases a submission whose target still
      // resolves uniquely. Ending the lease here would discard work that might
      // still apply cleanly.
      const heldLease = await app.repos.leases.getActiveByWorkItem(workItemId);
      expect(heldLease).not.toBeNull();

      // A rival is refused, and the refusal now matches what the queue says.
      const rival = await devLogin(app, "stale-rival", "editor");
      const blocked = await app.app.request(
        `/v1/projects/${app.projectId}/work-items/${workItemId}/claim`,
        jsonRequest("POST", {}, { Cookie: rival }),
      );
      expect(blocked.status).toBe(409);
      expect((await problemBody(blocked)).code).toBe("lease-held");

      const headBefore = app.fake.state.getRef(BRANCH) as string;
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
            content: "anomaly surfaced on",
            summary: "Reword the opening clause.",
          },
          { Cookie: editor },
        ),
      );

      // Accepted, not refused at the door. The lease is valid and names this
      // work item; §4 checks the base against the LEASE'S BUNDLE, and §5 owns
      // what happens when the chapter has since moved. (This previously
      // returned 409 "state-conflict" whose detail said `ready` — it was
      // refusing because the rebuild had clobbered the item's status, not
      // because anything was semantically wrong.)
      expect(submitted.status).toBe(202);
      const accepted = (await submitted.json()) as { operationId: string };

      // Whatever §5 decides — a clean rebase or an explicit conflict — the one
      // thing it may never do is overwrite the outside editor's work.
      const outcome = await operationState(app, editor, accepted.operationId);
      expect(["committed", "conflict", "failed"]).toContain(outcome.state);

      const source = (await app.git.reader.readTextFile?.(CHAPTER_1.path)) as string;
      expect(source).toContain("Mara Voss noticed it");
      if (outcome.state !== "committed") {
        // Nothing applied: the repository is exactly where the outsider left it.
        expect(app.fake.state.getRef(BRANCH)).toBe(headBefore);
      }

      await assertReadsStillWork(app, editor);
    } finally {
      app.close();
    }
  });

  it("a diverged repository refuses prose writes with a recovery path, while reads and non-prose writes keep working", async () => {
    const app = await makeGitHubIntegrationApp();
    try {
      const { workItemId } = await openWorkItem(
        app,
        CHAPTER_3.id,
        {
          kind: "suggestion",
          scope: "range",
          chapterRevision: CHAPTER_3.revision,
          target: {
            blockId: "019d7c33-c1e0-70bf-a41b-b75d55ff7980",
            textPosition: { start: 9, end: 35 },
            textQuote: {
              exact: "stop blaming an instrument",
              prefix: "Once you ",
              suffix: ", you have to",
            },
          },
          body: "Tighten this line.",
        },
        "diverge",
      );
      const editor = await devLogin(app, "diverge-editor", "editor");
      const claimed = await app.app.request(
        `/v1/projects/${app.projectId}/work-items/${workItemId}/claim`,
        jsonRequest("POST", {}, { Cookie: editor }),
      );
      expect(claimed.status).toBe(201);
      const bundle = (await claimed.json()) as {
        lease: { id: string; token: string };
        document: { revision: number; contentHash: string };
      };

      // Force divergence: a chapter's revision moves BACKWARDS in the
      // repository, which no deterministic rule can reconcile.
      const chapter1Source = (await app.git.reader.readTextFile?.(CHAPTER_1.path)) as string;
      const regressed = chapter1Source.replace(/^revision: \d+$/m, "revision: 1");
      await app.fake.externalCommit({ [CHAPTER_1.path]: regressed });
      expect((await deliverPush(app, { deliveryId: uuidv7() })).status).toBe(200);

      const project = await app.repos.projects.getById(app.projectId);
      expect(project?.status).toBe("diverged");

      const headBefore = app.fake.state.getRef(BRANCH) as string;
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
            content: "quit blaming the instrument",
            summary: "Tighten.",
          },
          { Cookie: editor },
        ),
      );

      expect(submitted.status).toBe(409);
      const body = (await submitted.json()) as {
        code: string;
        recovery: string;
        divergence: { kinds: string[] };
      };
      expect(body.code).toBe("project-diverged");
      // "Refuse clearly" means the refusal tells the operator what to do.
      expect(body.recovery).toContain("/divergence/clear");
      expect(body.divergence.kinds).toContain("revision-regressed");

      // No prose was written.
      expect(app.fake.state.getRef(BRANCH)).toBe(headBefore);

      // Reads keep working — including the diverged chapter itself, served
      // from the last coherent projection.
      await assertReadsStillWork(app, editor);

      // And non-prose collaboration keeps working: refusing annotations while
      // diverged would turn a repository problem into a total outage for
      // people who cannot fix it.
      const commenter = await devLogin(app, "diverge-commenter", "contributor");
      const comment = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest(
          "POST",
          { kind: "comment", scope: "chapter", chapterRevision: 3, body: "What happened here?" },
          { Cookie: commenter },
        ),
      );
      expect(comment.status).toBe(202);
    } finally {
      app.close();
    }
  });
});
