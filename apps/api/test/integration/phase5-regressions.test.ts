/**
 * Regression tests for defects found in the Phase 5 coordinator and
 * reconciliation paths. Each block names the defect it pins and fails if the
 * corresponding fix is reverted.
 *
 * They run on the same real harness as the exit criteria (real app, real
 * coordinator, real reader/writer, fake GitHub) because every one of these
 * defects was about how those pieces INTERLEAVE — a stub would not have shown
 * any of them.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { GitHubBookRepoReader } from "@authorbot/git-github";
import type { BookRepoReader, BookRepoSnapshot } from "../../src/projection/reader.js";
import {
  BRANCH,
  CHAPTER_1,
  devLogin,
  jsonRequest,
  makeGitHubIntegrationApp,
  rangeSuggestionPayload,
  type GitHubIntegrationApp,
} from "./phase5-helpers.js";

const ORIGINAL = "drift appeared on";
const REPLACEMENT = "anomaly surfaced on";

let open: GitHubIntegrationApp[] = [];
afterEach(() => {
  for (const app of open) app.close();
  open = [];
});
async function harness(
  options: Parameters<typeof makeGitHubIntegrationApp>[0] = {},
): Promise<GitHubIntegrationApp> {
  const app = await makeGitHubIntegrationApp(options);
  open.push(app);
  return app;
}

/** Annotation → qualifying votes → ready work item, through the API. */
async function openWorkItem(app: GitHubIntegrationApp): Promise<string> {
  const author = await devLogin(app, "reg-author", "contributor");
  const created = await app.app.request(
    `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
    jsonRequest("POST", rangeSuggestionPayload({ body: "Reword this opening clause." }), {
      Cookie: author,
    }),
  );
  expect(created.status).toBe(202);
  const { annotationId } = (await created.json()) as { annotationId: string };
  // Phase 6 §3.6: the default rule now also requires
  // `human_maintainer_approvals >= 1`, so one approver is the maintainer.
  for (const [index, login] of ["reg-wade", "reg-nadia", "reg-omar"].entries()) {
    const voter = await devLogin(app, login, index === 0 ? "maintainer" : "contributor");
    const voted = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${annotationId}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: voter }),
    );
    expect(voted.status).toBeLessThan(300);
  }
  const workItems = await app.repos.workItems.listBySourceAnnotation(annotationId);
  expect(workItems).toHaveLength(1);
  return (workItems[0] as { id: string }).id;
}

/** Claim and submit a range replacement; returns the outbox-bearing ids. */
async function claimAndSubmit(
  app: GitHubIntegrationApp,
  workItemId: string,
): Promise<{ submissionId: string; operationId: string }> {
  const editor = await devLogin(app, "reg-harriet", "editor");
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
        content: REPLACEMENT,
        summary: "Reword the opening clause.",
      },
      { Cookie: editor },
    ),
  );
  expect(submitted.status).toBe(202);
  return (await submitted.json()) as { submissionId: string; operationId: string };
}

/** Mark the project diverged exactly as `markDiverged` does. */
async function divergeProject(app: GitHubIntegrationApp): Promise<void> {
  await app.repos.projects
    .markDivergedStatement({
      projectId: app.projectId,
      reason: {
        state: "diverged",
        detectedAt: new Date().toISOString(),
        correlationId: "regression",
        findings: [],
      },
      at: new Date().toISOString(),
    })
    .run();
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------

describe("a diverged project stops prose commits already queued (contract §6)", () => {
  /**
   * The defect: `proseWriteBlocked` guarded only submission INTAKE
   * (phase4.ts). Nothing on the drain path read `projects.status` —
   * `drainOutbox`, the drain runner, the processor and the applier all
   * ignored it, and `alarm()` drains BEFORE it refreshes. So a submission
   * accepted moments before a webhook reconciliation marked the project
   * diverged still committed prose to a repository Authorbot knows it
   * mis-models, overwriting the external commit that caused the divergence.
   */
  it("leaves the queued submission.apply row pending, then commits it once divergence clears", async () => {
    // Drains run normally until the work item is ready — the annotation must
    // actually reach `synced` for voting to be accepted. Only the submission's
    // own row is left pending, which is the window the defect lived in.
    let defer = false;
    const app = await harness({ deferDrain: () => defer });
    const workItemId = await openWorkItem(app);
    defer = true;
    const { submissionId } = await claimAndSubmit(app, workItemId);

    const pendingBefore = await app.repos.outbox.listPending(app.projectId);
    expect(pendingBefore.map((row) => row.kind)).toContain("submission.apply");

    await divergeProject(app);
    const headBefore = app.fake.state.getRef(BRANCH) as string;

    const drained = await app.coordinator.drainOutbox();

    // The prose row was neither committed nor failed — it is still owed work.
    expect(drained.prosePaused).toBe(true);
    expect(app.fake.state.getRef(BRANCH)).toBe(headBefore);
    const stillPending = await app.repos.outbox.listPending(app.projectId);
    expect(stillPending.map((row) => row.kind)).toContain("submission.apply");
    expect((await app.repos.submissions.getById(submissionId))?.state).toBe("applying");
    expect((await app.repos.workItems.getById(workItemId))?.status).toBe("applying");

    // Clearing divergence resumes the backlog by itself; nothing was lost.
    await app.repos.projects
      .clearDivergenceStatement({
        projectId: app.projectId,
        reason: { state: "cleared" },
        at: new Date().toISOString(),
      })
      .run();
    const resumed = await app.coordinator.drainOutbox();

    expect(resumed.prosePaused).toBeUndefined();
    expect(resumed.committed).toBeGreaterThan(0);
    expect(app.fake.state.getRef(BRANCH)).not.toBe(headBefore);
    expect(app.fake.fileAtHead(CHAPTER_1.path)).toContain(REPLACEMENT);
    expect((await app.repos.submissions.getById(submissionId))?.state).toBe("applied");
  });

  it("still drains non-prose rows while diverged", async () => {
    const app = await harness({ deferDrain: true });
    const author = await devLogin(app, "reg-author", "contributor");
    const created = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload({ body: "A note." }), { Cookie: author }),
    );
    expect(created.status).toBe(202);
    const { annotationId } = (await created.json()) as { annotationId: string };

    await divergeProject(app);
    const drained = await app.coordinator.drainOutbox();

    // Annotations record intent ABOUT prose; refusing them would turn a
    // repository problem into a total outage for people who cannot fix it.
    expect(drained.committed).toBeGreaterThan(0);
    expect(
      app.fake.fileAtHead(`.authorbot/annotations/${annotationId}/annotation.md`),
    ).toContain(annotationId);
  });
});

// ---------------------------------------------------------------------------

describe("the coordinator serializes refresh against drain (contract §5)", () => {
  /**
   * The defect: drain.ts chained drains per project, but `refreshProjection`
   * called `reconcileProjection` with no chain, no lock and no
   * `blockConcurrencyWhile`. A Durable Object does not serialize concurrent
   * `fetch` invocations across awaits that are not storage operations, and the
   * refresh awaits dozens of GitHub blob fetches — so `/refresh` (webhook) and
   * `/drain` (mutation) interleaved freely. A refresh pinned at H1 resuming
   * after a drain committed H2 saw `snapshotRevision < current.revision`,
   * declared `revision-regressed`, and 403'd every submission project-wide
   * until a maintainer cleared it, with nothing actually wrong.
   */
  it("does not start the drain's commit while a refresh is mid-snapshot", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = true;

    let defer = false;
    const app = await harness({
      deferDrain: () => defer,
      wrapReader: (reader: GitHubBookRepoReader): BookRepoReader => ({
        readSnapshot: async (): Promise<BookRepoSnapshot> => {
          order.push("snapshot:start");
          if (gated) await gate;
          const snapshot = await reader.readSnapshot();
          order.push("snapshot:end");
          return snapshot;
        },
        readHeadCommit: () => reader.readHeadCommit(),
        readTextFile: (path: string) => reader.readTextFile(path),
      }),
      wrapWriter: (writer) => ({
        ...writer,
        commitFiles: async (input) => {
          order.push("commit:start");
          const result = await writer.commitFiles(input);
          order.push("commit:end");
          return result;
        },
        readFile: (branch: string, path: string) => writer.readFile?.(branch, path) ?? Promise.resolve(null),
        resolveHead: (branch: string) => writer.resolveHead?.(branch) ?? Promise.resolve(null),
      }),
    });

    const workItemId = await openWorkItem(app);
    defer = true;
    await claimAndSubmit(app, workItemId);
    order.length = 0;

    const refreshing = app.coordinator.refreshProjection();
    await tick();
    expect(order).toEqual(["snapshot:start"]);

    const draining = app.coordinator.drainOutbox();
    // Give the drain every chance to interleave: without serialization it
    // reaches `commitFiles` here, while the refresh is still suspended.
    await tick();
    await tick();
    await tick();
    expect(order).toEqual(["snapshot:start"]);

    gated = false;
    release?.();
    await refreshing;
    await draining;

    // The refresh finished completely before the drain committed anything.
    expect(order.indexOf("snapshot:end")).toBeLessThan(order.indexOf("commit:start"));
    // And the project was not falsely marked diverged by the interleaving.
    expect((await app.repos.projects.getById(app.projectId))?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------

describe("re-anchoring uses the snapshot's bytes, not a fresh read", () => {
  /**
   * The defect: `reconcileProjection` classified and projected from one
   * consistent snapshot, then called `readSource` → `readTextFile`, which
   * re-resolved the branch head. A push landing mid-pass produced a re-anchor
   * computed against one commit's text while `revision` and `blockIds` came
   * from another's — a decision recorded at a revision that never contained
   * that text, persisted as an append-only audit row a later converging pass
   * does not undo. The snapshot already holds every matched file's bytes.
   */
  it("never calls readTextFile during a reconciliation that re-anchors", async () => {
    const textFileReads: string[] = [];
    const app = await harness({
      wrapReader: (reader: GitHubBookRepoReader): BookRepoReader => ({
        readSnapshot: () => reader.readSnapshot(),
        readHeadCommit: () => reader.readHeadCommit(),
        readTextFile: (path: string) => {
          textFileReads.push(path);
          return reader.readTextFile(path);
        },
      }),
    });

    // An external edit to a projected chapter — the path that re-anchors.
    const edited = (app.fake.fileAtHead(CHAPTER_1.path) as string).replace(
      "where nobody respectable ever looks.",
      "where nobody respectable ever bothers to look.",
    );
    expect(edited).not.toBe(app.fake.fileAtHead(CHAPTER_1.path));
    await app.fake.externalCommit({ [CHAPTER_1.path]: edited });

    textFileReads.length = 0;
    const result = await app.coordinator.refreshProjection();

    expect(result.outcome).toBe("projected");
    expect(result.reconcile?.externalEdits.length).toBeGreaterThan(0);
    // The whole pass came from one tree.
    expect(textFileReads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the projection reads the branch the writer commits to", () => {
  /**
   * The defect: the reader's branch came from the `DEFAULT_BRANCH` binding
   * while every commit targeted `projects.default_branch` from D1, and nothing
   * reconciled the two after the first-boot seed. Changing the binding after
   * seeding moved the reader while the writer stayed pinned: commits on one
   * branch, projection built from another.
   */
  it("asks for a reader on projects.default_branch, not the configured one", async () => {
    const requested: string[] = [];
    const app = await harness();
    const original = app.git.readerFor;
    app.git.readerFor = (branch: string): BookRepoReader => {
      requested.push(branch);
      return (original as (b: string) => BookRepoReader)(branch);
    };

    await app.coordinator.refreshProjection();

    const project = await app.repos.projects.getById(app.projectId);
    expect(requested).toContain(project?.defaultBranch);
  });
});

// ---------------------------------------------------------------------------

describe("divergence is never declared from a snapshot that went stale", () => {
  /**
   * Defence in depth behind the serialization fix: a `revision-regressed`
   * finding blocks prose writes project-wide until a maintainer intervenes, so
   * it must not be declared on evidence the snapshot itself undermines. If the
   * branch head moved while the pass was reading, the classification compared
   * a snapshot from one commit against a projection a later commit may already
   * have advanced.
   */
  it("leaves the projection stale instead of diverging when the head moved mid-pass", async () => {
    const app = await harness();

    // A genuinely regressed revision — the finding the guard must not act on
    // when the snapshot it came from is already behind the branch.
    const regressed = (app.fake.fileAtHead(CHAPTER_1.path) as string).replace(
      `revision: ${String(CHAPTER_1.revision)}`,
      "revision: 1",
    );
    await app.fake.externalCommit({ [CHAPTER_1.path]: regressed });

    // Read the snapshot, then let another commit land before reconciling it.
    const snapshot = await app.git.reader.readSnapshot();
    await app.fake.externalCommit({ "story/notes.md": "Later, unrelated.\n" });

    const { reconcileProjection } = await import("../../src/reconcile.js");
    const project = await app.repos.projects.getById(app.projectId);
    const result = await reconcileProjection(
      { db: app.db, repos: app.repos, clock: { now: () => new Date() } },
      project as NonNullable<typeof project>,
      app.git.reader,
      { correlationId: "regression", snapshot },
    );

    expect(result.outcome).toBe("snapshot-stale");
    const after = await app.repos.projects.getById(app.projectId);
    expect(after?.status).toBe("active");
    // Still owed a refresh, so the next pass decides from a consistent read.
    expect(after?.projectionStale).toBe(true);
  });

  it("still diverges on a real regression when the snapshot is current", async () => {
    const app = await harness();
    const regressed = (app.fake.fileAtHead(CHAPTER_1.path) as string).replace(
      `revision: ${String(CHAPTER_1.revision)}`,
      "revision: 1",
    );
    await app.fake.externalCommit({ [CHAPTER_1.path]: regressed });

    const result = await app.coordinator.refreshProjection();

    expect(result.outcome).toBe("diverged");
    expect((await app.repos.projects.getById(app.projectId))?.status).toBe("diverged");
  });
});
