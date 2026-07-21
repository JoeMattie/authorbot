/**
 * Regressions on the Worker's maintenance wiring and on what
 * `gitIntegration: "configured"` is allowed to mean.
 */
import { describe, expect, it } from "vitest";
import { applyMigrations, openSqliteDatabase } from "@authorbot/database";
import { gitIntegrationStatus } from "../src/coordinator.js";
import { runScheduledMaintenance } from "../src/worker.js";
import type { WorkerBindings } from "../src/worker.js";
import { MIGRATIONS_DIR } from "./integration/phase5-helpers.js";

const PKCS8 = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";
const PKCS1 = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";

describe("the maintenance loop is self-starting (contract §5)", () => {
  /**
   * The defect: the periodic alarm was armed ONLY by `ensureAlarm()` inside
   * the Durable Object's `fetch`, and `fetch` was reached from exactly two
   * places - `onMutationCommitted` (MIRROR_MODE=durable only) and the verified
   * GitHub push webhook. The live deployment runs `queue` with no GitHub App,
   * so the DO was never contacted, no alarm was ever set, and
   * `sweepExpiredLeases` never ran in production despite §5 requiring it. The
   * DO cannot self-bootstrap either: an alarm firing before any request has
   * recorded a project id returns without rescheduling.
   */
  async function seededBindings(): Promise<{
    bindings: WorkerBindings;
    calls: string[];
    close: () => void;
  }> {
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, MIGRATIONS_DIR);
    await db
      .prepare(
        `INSERT INTO projects (id, slug, repo, default_branch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .bind(
        "0190f300-7045-7b2d-9d91-95b3c8228b54",
        "causal-projector",
        "JoeMattie/causal-projector",
        "main",
        "2026-07-19T12:00:00.000Z",
        "2026-07-19T12:00:00.000Z",
      )
      .run();

    const calls: string[] = [];
    const bindings = {
      // The cron path only needs D1 and the namespace; it deliberately does
      // NOT go through `configFromBindings`, so unrelated configuration
      // (AUTH_MODE, OAuth vars) cannot break maintenance.
      DB: db as unknown as WorkerBindings["DB"],
      PROJECT_SLUG: "causal-projector",
      COORDINATOR: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: (input: string) => {
            calls.push(new URL(input).pathname);
            return Promise.resolve(new Response("{}", { status: 200 }));
          },
        }),
      },
    } as unknown as WorkerBindings;
    return { bindings, calls, close: () => db.close() };
  }

  it("pokes the coordinator on a cron tick, which is what arms the alarm", async () => {
    const { bindings, calls, close } = await seededBindings();
    try {
      await runScheduledMaintenance(bindings);
      // `sweep` reaches the DO's fetch, and every fetch runs `ensureAlarm()`.
      expect(calls).toEqual([
        "/projects/0190f300-7045-7b2d-9d91-95b3c8228b54/sweep",
      ]);
    } finally {
      close();
    }
  });

  it("is a no-op before the project is seeded, rather than throwing", async () => {
    const db = openSqliteDatabase(":memory:");
    try {
      await applyMigrations(db, MIGRATIONS_DIR);
      const calls: string[] = [];
      await runScheduledMaintenance({
        DB: db as unknown as WorkerBindings["DB"],
        PROJECT_SLUG: "causal-projector",
        COORDINATOR: {
          idFromName: (name: string) => name,
          get: () => ({
            fetch: (input: string) => {
              calls.push(input);
              return Promise.resolve(new Response("{}"));
            },
          }),
        },
      } as unknown as WorkerBindings);
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("the worker exports a scheduled handler for the cron trigger to reach", async () => {
    const entry = (await import("../src/worker.js")).default as {
      scheduled?: unknown;
      fetch?: unknown;
    };
    expect(typeof entry.scheduled).toBe("function");
    expect(typeof entry.fetch).toBe("function");
  });
});

describe("createCoordinatorGit can build a reader for any branch", () => {
  /**
   * The reader's branch used to be fixed at construction from
   * `DEFAULT_BRANCH`, while every commit targeted `projects.default_branch`.
   * `readerFor` is what lets the refresh path ask for the branch the project
   * row names, so one value is authoritative.
   */
  it("honours the requested branch rather than the DEFAULT_BRANCH binding", async () => {
    const { createCoordinatorGit } = await import("../src/coordinator.js");
    const git = createCoordinatorGit({
      PROJECT_REPO: "JoeMattie/causal-projector",
      DEFAULT_BRANCH: "trunk",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: PKCS8,
      GITHUB_INSTALLATION_ID: "2",
    });
    expect(git).not.toBeNull();
    const reader = git?.readerFor?.("release-2") as unknown as { branch: string };
    expect(reader.branch).toBe("release-2");
    // The binding still supplies the fallback reader.
    expect((git?.reader as unknown as { branch: string }).branch).toBe("trunk");
  });
});

describe('gitIntegration "configured" means usable, not merely present', () => {
  /**
   * The defect: the status was a presence-only check on three env names, so a
   * PKCS#1 key, an App ID pasted into the Installation ID slot, or any other
   * typo reported `configured`. The operator guide uses this value as the
   * pre-flight gate before flipping MIRROR_MODE to durable on a live
   * deployment - the operator saw green and the failure then surfaced only as
   * git_operations rows going to conflict inside the DO, where nothing logs
   * the reason.
   */
  it("still reports unconfigured and incomplete as before", () => {
    expect(gitIntegrationStatus({})).toBe("unconfigured");
    expect(gitIntegrationStatus({ GITHUB_APP_ID: "1" })).toBe("incomplete");
  });

  it("reports configured only for a numeric id pair and a PKCS#8 key", () => {
    expect(
      gitIntegrationStatus({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: PKCS8,
        GITHUB_INSTALLATION_ID: "2",
      }),
    ).toBe("configured");
  });

  it("reports invalid for a PKCS#1 key - the single most likely setup mistake", () => {
    expect(
      gitIntegrationStatus({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: PKCS1,
        GITHUB_INSTALLATION_ID: "2",
      }),
    ).toBe("invalid");
  });

  it("reports invalid for non-numeric ids", () => {
    expect(
      gitIntegrationStatus({
        GITHUB_APP_ID: "not-a-number",
        GITHUB_APP_PRIVATE_KEY: PKCS8,
        GITHUB_INSTALLATION_ID: "2",
      }),
    ).toBe("invalid");
    expect(
      gitIntegrationStatus({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: PKCS8,
        GITHUB_INSTALLATION_ID: "also-not-a-number",
      }),
    ).toBe("invalid");
  });

  it("reports invalid for a key that is not a PEM at all", () => {
    expect(
      gitIntegrationStatus({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "hello world",
        GITHUB_INSTALLATION_ID: "2",
      }),
    ).toBe("invalid");
  });
});
