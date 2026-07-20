/**
 * Phase 5 storage layer (contract §6, design §14.5/§17.3): the `publications`
 * and `publication_deliveries` tables, and the projection/divergence columns
 * added to `projects` by migration 0005.
 *
 * These sit below the API tests deliberately: the tricky parts are SQL-level
 * (a partial-update upsert, a compare-and-swap on `updated_at`, a guarded
 * status transition), and each of them has a plausible wrong version that the
 * HTTP tests would not distinguish.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteAdapter } from "../src/adapters/better-sqlite3.js";
import type { Repositories } from "../src/repositories/index.js";
import type { ProjectRecord } from "../src/records.js";
import { seedBasics, uuidv7, NOW } from "./helpers.js";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

describe("migration 0005 project columns", () => {
  let db: SqliteAdapter;
  let repos: Repositories;
  let project: ProjectRecord;

  beforeEach(async () => {
    ({ db, repos, project } = await seedBasics());
  });
  afterEach(() => db.close());

  it("defaults reproduce pre-Phase-5 behaviour exactly", async () => {
    const row = await repos.projects.getById(project.id);
    expect(row).toMatchObject({
      status: "active",
      projectionStale: false,
      projectedCommit: null,
      divergenceReason: null,
      divergedAt: null,
    });
  });

  it("marks stale, then clears only when nothing raced the refresh", async () => {
    await repos.projects.markProjectionStaleStatement(project.id, "2026-07-19T18:01:00Z").run();
    const stale = await repos.projects.getById(project.id);
    expect(stale?.projectionStale).toBe(true);

    await repos.projects
      .completeProjectionRefreshStatement({
        projectId: project.id,
        projectedCommit: COMMIT_A,
        observedUpdatedAt: stale?.updatedAt ?? "",
        at: "2026-07-19T18:02:00Z",
      })
      .run();
    const done = await repos.projects.getById(project.id);
    expect(done?.projectionStale).toBe(false);
    expect(done?.projectedCommit).toBe(COMMIT_A);
  });

  it("a push that lands mid-refresh keeps the projection stale", async () => {
    // The refresh reads the row…
    const observed = await repos.projects.getById(project.id);
    // …a push arrives and marks it stale…
    await repos.projects.markProjectionStaleStatement(project.id, "2026-07-19T18:03:00Z").run();
    // …and only then does the refresh (holding a pre-push snapshot) complete.
    await repos.projects
      .completeProjectionRefreshStatement({
        projectId: project.id,
        projectedCommit: COMMIT_A,
        observedUpdatedAt: observed?.updatedAt ?? "",
        at: "2026-07-19T18:04:00Z",
      })
      .run();

    const row = await repos.projects.getById(project.id);
    // The commit it did project is recorded, but the flag survives so the
    // newer push is not silently dropped.
    expect(row?.projectedCommit).toBe(COMMIT_A);
    expect(row?.projectionStale).toBe(true);
  });

  it("keeps the FIRST detection timestamp while refreshing the reason", async () => {
    await repos.projects
      .markDivergedStatement({
        projectId: project.id,
        reason: { findings: [{ kind: "revision-regressed" }] },
        at: "2026-07-19T18:05:00Z",
      })
      .run();
    await repos.projects
      .markDivergedStatement({
        projectId: project.id,
        reason: { findings: [{ kind: "anchor-blocks-vanished" }] },
        at: "2026-07-19T18:06:00Z",
      })
      .run();

    const row = await repos.projects.getById(project.id);
    expect(row?.status).toBe("diverged");
    // When it broke, not when we last noticed.
    expect(row?.divergedAt).toBe("2026-07-19T18:05:00Z");
    const reason = row?.divergenceReason as { findings: { kind: string }[] };
    expect(reason.findings[0]?.kind).toBe("anchor-blocks-vanished");
  });

  it("clearing is guarded on the diverged state", async () => {
    const noop = await repos.projects
      .clearDivergenceStatement({ projectId: project.id, reason: { state: "cleared" }, at: NOW })
      .run();
    expect(noop.changes).toBe(0);

    await repos.projects
      .markDivergedStatement({ projectId: project.id, reason: { findings: [] }, at: NOW })
      .run();
    const cleared = await repos.projects
      .clearDivergenceStatement({ projectId: project.id, reason: { state: "cleared" }, at: NOW })
      .run();
    expect(cleared.changes).toBe(1);

    const row = await repos.projects.getById(project.id);
    expect(row?.status).toBe("active");
    expect(row?.divergedAt).toBeNull();

    // Second clear is a no-op — two maintainers racing produce one clearing.
    const again = await repos.projects
      .clearDivergenceStatement({ projectId: project.id, reason: { state: "cleared" }, at: NOW })
      .run();
    expect(again.changes).toBe(0);
  });
});

describe("publications repository (design §17.3)", () => {
  let db: SqliteAdapter;
  let repos: Repositories;
  let project: ProjectRecord;

  beforeEach(async () => {
    ({ db, repos, project } = await seedBasics());
  });
  afterEach(() => db.close());

  const upsert = async (
    input: Partial<Parameters<Repositories["publications"]["upsert"]>[0]> & {
      integratedCommit: string;
      buildStatus: "queued" | "building" | "succeeded" | "failed";
    },
  ): Promise<void> => {
    const existing = await repos.publications.getByCommit(project.id, input.integratedCommit);
    await repos.publications.upsert({
      id: existing?.id ?? uuidv7(),
      projectId: project.id,
      lastDeliveryId: null,
      at: NOW,
      ...input,
    });
  };

  it("an omitted field keeps the stored value; an explicit null clears it", async () => {
    await upsert({
      integratedCommit: COMMIT_A,
      buildStatus: "succeeded",
      deployedCommit: COMMIT_A,
      publicUrl: "https://example.test/book",
    });

    // Omitted → keep. This is the case a naive upsert gets wrong: a
    // `building` callback for the next commit would blank the live URL.
    await upsert({ integratedCommit: COMMIT_A, buildStatus: "building" });
    let row = await repos.publications.getByCommit(project.id, COMMIT_A);
    expect(row?.publicUrl).toBe("https://example.test/book");
    expect(row?.deployedCommit).toBe(COMMIT_A);
    expect(row?.buildStatus).toBe("building");

    // Explicit null → clear. CI saying "this is no longer deployed" must be
    // distinguishable from CI saying nothing.
    await upsert({ integratedCommit: COMMIT_A, buildStatus: "failed", publicUrl: null });
    row = await repos.publications.getByCommit(project.id, COMMIT_A);
    expect(row?.publicUrl).toBeNull();
    expect(row?.deployedCommit).toBe(COMMIT_A);
  });

  it("one row per integrated commit", async () => {
    await upsert({ integratedCommit: COMMIT_A, buildStatus: "queued" });
    await upsert({ integratedCommit: COMMIT_A, buildStatus: "succeeded" });
    await upsert({ integratedCommit: COMMIT_B, buildStatus: "queued" });
    const rows = await repos.publications.listByProject(project.id);
    expect(rows).toHaveLength(2);
  });

  it("getLatestDeployed ignores builds that never deployed", async () => {
    await upsert({
      integratedCommit: COMMIT_A,
      buildStatus: "succeeded",
      deployedCommit: COMMIT_A,
      deployedAt: "2026-07-19T09:00:00Z",
      at: "2026-07-19T09:00:00Z",
    });
    // Distinct `at`: within one millisecond the id tiebreak is random, so an
    // equal-timestamp fixture would assert an ordering the schema does not
    // promise (and this test flaked for exactly that reason).
    await upsert({
      integratedCommit: COMMIT_B,
      buildStatus: "building",
      at: "2026-07-19T09:05:00Z",
    });

    expect((await repos.publications.getLatestDeployed(project.id))?.integratedCommit).toBe(
      COMMIT_A,
    );
    // …while `getLatest` still shows the newest thing CI touched.
    expect((await repos.publications.getLatest(project.id))?.integratedCommit).toBe(COMMIT_B);
  });

  it("rejects an unknown build status at the database boundary", async () => {
    await expect(
      repos.publications.upsert({
        id: uuidv7(),
        projectId: project.id,
        integratedCommit: COMMIT_A,
        // A value the API schema would reject, forced past it.
        buildStatus: "deployed-probably" as never,
        lastDeliveryId: null,
        at: NOW,
      }),
    ).rejects.toThrow();
  });

  it("delivery ids are unique per project", async () => {
    const record = {
      projectId: project.id,
      deliveryId: "ci-1",
      publicationId: null,
      status: "received" as const,
      receivedAt: NOW,
      processedAt: null,
    };
    await repos.publicationDeliveries.insert({ id: uuidv7(), ...record });
    await expect(
      repos.publicationDeliveries.insert({ id: uuidv7(), ...record }),
    ).rejects.toThrow();
  });
});
