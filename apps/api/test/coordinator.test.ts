/**
 * ProjectCoordinator (Phase 5 contract §5), including the exit criteria it
 * owns: "Coordinator serialization holds under concurrent mutations;
 * duplicate drains commit once."
 *
 * The suite drives the coordinator directly over better-sqlite3 and the
 * in-process fake GitHub - no workerd, no network, no timers - because the
 * properties under test (a commit happening exactly once, commits forming a
 * single parent chain) need deterministic interleaving, and a workerd pool
 * would make them flaky without making them stronger. The Durable Object
 * wrapper is covered separately through a fake `DurableObjectState`, so the
 * request routing and the alarm-after-eviction path are exercised too.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { applyMigrations, openSqliteDatabase } from "@authorbot/database/testing";
import { GitHubBookRepoReader, GitHubBookRepoWriter } from "@authorbot/git-github";
import { createFakeGitHub, type FakeGitHub } from "@authorbot/git-github/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coordinatorAlarmMsFromEnv,
  createCoordinatorGit,
  createProjectCoordinator,
  gitIntegrationStatus,
  parseRepoCoordinates,
  DEFAULT_COORDINATOR_ALARM_SECONDS,
  type AlarmScheduler,
  type CoordinatorGit,
  type CoordinatorStore,
  type ProjectCoordinator,
} from "../src/coordinator.js";
import {
  ProjectCoordinatorDurableObject,
  callCoordinator,
  callCoordinatorListFileHistory,
  callCoordinatorListTextFiles,
  callCoordinatorReadTextFile,
  callCoordinatorReadTextFileAtCommit,
  COORDINATOR_ORIGIN,
  PROJECT_ID_KEY,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
} from "../src/coordinator-do.js";
import { mirrorModeFromBindings } from "../src/worker.js";
import {
  claimWorkItem,
  createReadyWorkItem,
  makePhase4Harness,
  type Phase4Harness,
} from "./phase4-helpers.js";
import {
  devLogin,
  jsonRequest,
  makeHarness,
  validAnnotationPayload,
  CHAPTER_ID,
  MIGRATIONS_DIR,
  type TestHarness,
} from "./helpers.js";

const OWNER = "JoeMattie";
const REPO = "causal-projector";
const FULL_NAME = `${OWNER}/${REPO}`;
const EXAMPLE_REPO = fileURLToPath(new URL("../../../examples/book-repo", import.meta.url));

/** Read examples/book-repo into the flat path→content map the fake seeds from. */
async function exampleRepoFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files[relative(EXAMPLE_REPO, full).split("\\").join("/")] = await readFile(full, "utf8");
      }
    }
  };
  await walk(EXAMPLE_REPO);
  return files;
}

/**
 * A fake GitHub plus the real reader/writer aimed at it. `requireAuth: false`
 * keeps these tests about coordination rather than about the auth layer, which
 * has its own suite in @authorbot/git-github.
 */
async function makeGit(
  files: Record<string, string> = { "README.md": "# book\n" },
): Promise<{ fake: FakeGitHub; git: CoordinatorGit }> {
  const fake = await createFakeGitHub({
    owner: OWNER,
    repo: REPO,
    defaultBranch: "main",
    requireAuth: false,
    files,
  });
  const reader = new GitHubBookRepoReader({
    owner: OWNER,
    repo: REPO,
    branch: "main",
    fetch: fake.fetch,
  });
  const writer = new GitHubBookRepoWriter({
    repo: FULL_NAME,
    tokens: async () => "ghs_fake_installation_token",
    fetchImpl: fake.fetch,
  });
  return { fake, git: { reader, writer } };
}

/** In-memory stand-in for the `DurableObjectStorage` subset the DO uses. */
class FakeDoStorage implements AlarmScheduler, CoordinatorStore {
  #alarm: number | null = null;
  readonly #values = new Map<string, unknown>();
  /** Every `setAlarm` call, so rescheduling can be asserted on. */
  readonly setAlarmCalls: number[] = [];

  async getAlarm(): Promise<number | null> {
    return this.#alarm;
  }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.#alarm = scheduledTime;
    this.setAlarmCalls.push(scheduledTime);
  }
  async get<T>(key: string): Promise<T | undefined> {
    return this.#values.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.#values.delete(key);
  }
  /** Simulate an eviction: state survives, the in-memory instance does not. */
  clearAlarm(): void {
    this.#alarm = null;
  }
}

async function createAnnotation(harness: TestHarness, cookie: string): Promise<string> {
  const response = await harness.app.request(
    `/v1/projects/${harness.projectId}/chapters/${CHAPTER_ID}/annotations`,
    jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie }),
  );
  if (response.status !== 202) {
    throw new Error(`create annotation failed with ${String(response.status)}`);
  }
  const body = (await response.json()) as { annotationId: string };
  return body.annotationId;
}

/**
 * The DO's `DB` binding is never read in these tests - the database arrives
 * through the override seam - so a throwing stand-in proves that.
 */
const UNUSED_D1 = new Proxy(
  {},
  {
    get(): never {
      throw new Error("the D1 binding must not be touched when a db override is supplied");
    },
  },
) as never;

/** Commit shas on the branch, oldest first. */
async function commitChain(fake: FakeGitHub): Promise<string[]> {
  return [...fake.state.history("main")].reverse();
}

describe("coordinator: outbox drain", () => {
  let harness: TestHarness;
  let cookie: string;
  let fake: FakeGitHub;
  let gitUnderTest: CoordinatorGit;
  let coordinator: ProjectCoordinator;

  beforeEach(async () => {
    harness = await makeHarness({ config: { mirrorMode: "queue" } });
    cookie = await devLogin(harness, "carla-contrib", "contributor");
    const built = await makeGit();
    fake = built.fake;
    gitUnderTest = built.git;
    coordinator = createProjectCoordinator({
      projectId: harness.projectId,
      db: harness.db,
      git: built.git,
    });
  });
  afterEach(() => harness.close());

  it("commits a queued annotation and reports it as committed", async () => {
    await createAnnotation(harness, cookie);

    const result = await coordinator.drainOutbox();

    expect(result.skipped).toBeUndefined();
    expect(result.drained).toBe(1);
    expect(result.committed).toBe(1);
    expect(result.failed).toBe(0);
    // Content, not just status: the artifact is really in the tree.
    const paths = fake.state.listTree(
      fake.state.getCommit(fake.state.getRef("main") ?? "")?.tree ?? "",
      true,
    );
    expect(paths.some((entry) => entry.path.startsWith(".authorbot/annotations/"))).toBe(true);
  });

  it("duplicate drain commits once (exit criterion 4)", async () => {
    await createAnnotation(harness, cookie);

    const first = await coordinator.drainOutbox();
    const commitsAfterFirst = await commitChain(fake);
    const second = await coordinator.drainOutbox();
    const commitsAfterSecond = await commitChain(fake);

    expect(first.committed).toBe(1);
    // The second drain finds nothing to claim - the outbox row is `done`.
    expect(second.drained).toBe(0);
    expect(commitsAfterSecond).toEqual(commitsAfterFirst);
  });

  it("serializes overlapping drains: never two commits in flight at once", async () => {
    // The property the Durable Object exists to provide, asserted directly.
    // Outcome-level assertions cannot see it: the writer retries on 422, so
    // two racing drains still end up with two commits on one chain. This
    // instruments the writer instead and asserts the observed peak
    // concurrency is 1 - a drain that overlaps fails here even though its
    // commits would look fine.
    let inFlight = 0;
    let peak = 0;
    const original = gitUnderTest.writer.commitFiles.bind(gitUnderTest.writer);
    gitUnderTest.writer.commitFiles = async (input) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        // Yield so a genuinely concurrent drain has room to interleave.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return await original(input);
      } finally {
        inFlight -= 1;
      }
    };

    await createAnnotation(harness, cookie);
    await createAnnotation(harness, cookie);
    await Promise.all([coordinator.drainOutbox(), coordinator.drainOutbox()]);

    expect(peak).toBe(1);
  });

  it("concurrent drains of the same backlog commit each row once", async () => {
    await createAnnotation(harness, cookie);
    await createAnnotation(harness, cookie);

    // Both start before either finishes: the drain chain must serialize them.
    const [a, b] = await Promise.all([coordinator.drainOutbox(), coordinator.drainOutbox()]);

    expect(a.committed + b.committed).toBe(2);
    const rows = await harness.db
      .prepare(`SELECT status FROM outbox WHERE project_id = ?`)
      .bind(harness.projectId)
      .all();
    expect(rows.map((row) => String(row["status"]))).toEqual(["done", "done"]);
  });

  it("concurrent mutations produce ordered, non-overlapping commits", async () => {
    // Three annotations queued, then drained: every commit must land on a
    // single parent chain (no forked history, no lost update). This is the
    // property the Durable Object exists to provide.
    await createAnnotation(harness, cookie);
    await createAnnotation(harness, cookie);
    await createAnnotation(harness, cookie);

    await Promise.all([
      coordinator.drainOutbox(),
      coordinator.drainOutbox(),
      coordinator.drainOutbox(),
    ]);

    const chain = await commitChain(fake);
    // seed commit + one per annotation, in one unbroken parent chain.
    expect(chain).toHaveLength(4);
    for (let i = 1; i < chain.length; i += 1) {
      const commit = fake.state.getCommit(chain[i] as string);
      expect(commit?.parents).toEqual([chain[i - 1]]);
    }
    // Every ref update was a fast-forward: no commit was ever clobbered.
    const uniqueTrees = new Set(chain.map((sha) => fake.state.getCommit(sha)?.tree));
    expect(uniqueTrees.size).toBe(chain.length);
  });

  it("a crash leftover is replayed, not double-committed", async () => {
    await createAnnotation(harness, cookie);
    // Simulate a drain that died after claiming the row.
    await harness.db
      .prepare(`UPDATE outbox SET status = 'processing' WHERE project_id = ?`)
      .bind(harness.projectId)
      .run();

    const result = await coordinator.drainOutbox();
    const chain = await commitChain(fake);

    expect(result.committed).toBe(1);
    expect(chain).toHaveLength(2); // seed + exactly one recovery commit
  });
});

describe("coordinator: absent GitHub credentials (the live deployment's state)", () => {
  let harness: TestHarness;
  let cookie: string;
  let coordinator: ProjectCoordinator;

  beforeEach(async () => {
    harness = await makeHarness({ config: { mirrorMode: "queue" } });
    cookie = await devLogin(harness, "carla-contrib", "contributor");
    coordinator = createProjectCoordinator({
      projectId: harness.projectId,
      db: harness.db,
      git: null,
    });
  });
  afterEach(() => harness.close());

  it("reports gitIntegration unconfigured", () => {
    expect(coordinator.gitIntegration).toBe("unconfigured");
  });

  it("leaves queued outbox rows untouched rather than burning attempts", async () => {
    await createAnnotation(harness, cookie);

    const result = await coordinator.drainOutbox();

    expect(result.skipped).toBe("git-unconfigured");
    expect(result.drained).toBe(0);
    const rows = await harness.db
      .prepare(`SELECT status, attempts FROM outbox WHERE project_id = ?`)
      .bind(harness.projectId)
      .all();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.["status"])).toBe("pending");
    expect(Number(rows[0]?.["attempts"])).toBe(0);
  });

  it("skips projection refresh", async () => {
    const result = await coordinator.refreshProjection();
    expect(result.skipped).toBe("git-unconfigured");
    expect(result.rebuild).toBeNull();
  });

  it("still sweeps expired leases on the alarm (Phase 4 §2 in production)", async () => {
    const storage = new FakeDoStorage();
    const withAlarms = createProjectCoordinator({
      projectId: harness.projectId,
      db: harness.db,
      git: null,
      alarms: storage,
      alarmIntervalMs: 60_000,
    });

    const result = await withAlarms.alarm();

    expect(result.errors).toEqual([]);
    expect(result.sweep).toEqual({ expired: 0 }); // ran, found nothing
    expect(result.drain.skipped).toBe("git-unconfigured");
    expect(result.rescheduledFor).not.toBeNull();
  });

  it("/v1/projects/{id} reports gitIntegration unconfigured", async () => {
    const response = await harness.app.request(`/v1/projects/${harness.projectId}`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { gitIntegration: string };
    expect(body.gitIntegration).toBe("unconfigured");
  });
});

describe("coordinator: lease sweeping", () => {
  let harness: Phase4Harness;
  let coordinator: ProjectCoordinator;

  beforeEach(async () => {
    // The real Phase 4 path: a ready work item claimed through the API, then
    // the clock pushed past the lease expiry. Hand-inserted lease rows would
    // test the sweep against a schema of the test's own invention.
    harness = await makePhase4Harness({ config: { mirrorMode: "queue" } });
    coordinator = createProjectCoordinator({
      projectId: harness.projectId,
      db: harness.db,
      clock: harness.clock,
      git: null,
    });
  });
  afterEach(() => harness.close());

  async function leasedWorkItem(): Promise<string> {
    const cookie = await devLogin(harness, "wanda-worker", "editor");
    const { workItemId } = await createReadyWorkItem(harness);
    const claim = await claimWorkItem(harness, { cookie }, workItemId);
    expect(claim.status).toBe(201);
    return workItemId;
  }

  it("does nothing while the lease is live", async () => {
    const workItemId = await leasedWorkItem();

    expect(await coordinator.sweepLeases()).toEqual({ expired: 0 });
    const item = await harness.repos.workItems.getById(workItemId);
    expect(item?.status).toBe("leased");
  });

  it("expires the lease and returns the work item to ready", async () => {
    const workItemId = await leasedWorkItem();
    harness.clock.advanceMs(31 * 60 * 1000); // past the PT30M default

    const result = await coordinator.sweepLeases();

    expect(result.expired).toBe(1);
    const item = await harness.repos.workItems.getById(workItemId);
    expect(item?.status).toBe("ready");
  });

  it("is idempotent: a second sweep expires nothing and emits no second event", async () => {
    await leasedWorkItem();
    harness.clock.advanceMs(31 * 60 * 1000);

    await coordinator.sweepLeases();
    const second = await coordinator.sweepLeases();

    expect(second.expired).toBe(0);
    const events = await harness.db
      .prepare(`SELECT id FROM events WHERE project_id = ? AND type = 'lease_expired'`)
      .bind(harness.projectId)
      .all();
    expect(events).toHaveLength(1);
  });
});

describe("coordinator: projection refresh", () => {
  let harness: TestHarness;
  let coordinator: ProjectCoordinator;

  beforeEach(async () => {
    // No FakeReader: the projection comes from GitHub through the coordinator.
    harness = await makeHarness({ config: { mirrorMode: "queue" }, reader: null });
    const built = await makeGit(await exampleRepoFiles());
    coordinator = createProjectCoordinator({
      projectId: harness.projectId,
      db: harness.db,
      git: built.git,
    });
  });
  afterEach(() => harness.close());

  it("projects chapters read back from GitHub", async () => {
    const result = await coordinator.refreshProjection();

    expect(result.skipped).toBeUndefined();
    expect(result.rebuild?.chapters ?? 0).toBeGreaterThan(0);
    const chapters = await harness.db
      .prepare(`SELECT id FROM chapters WHERE project_id = ?`)
      .bind(harness.projectId)
      .all();
    expect(chapters.length).toBeGreaterThan(0);
  });

  it("onlyIfStale skips until the projection is marked stale, then clears it", async () => {
    const skipped = await coordinator.refreshProjection({ onlyIfStale: true });
    expect(skipped.skipped).toBe("not-stale");

    await coordinator.markProjectionStale();
    const flagged = await harness.repos.projects.getById(harness.projectId);
    expect(flagged?.projectionStale).toBe(true);

    const ran = await coordinator.refreshProjection({ onlyIfStale: true });
    expect(ran.skipped).toBeUndefined();
    const cleared = await harness.repos.projects.getById(harness.projectId);
    expect(cleared?.projectionStale).toBe(false);
  });

  it("is idempotent: a second refresh over an unchanged repository changes nothing", async () => {
    await coordinator.refreshProjection();
    const before = await harness.db
      .prepare(`SELECT id, revision, content_hash FROM chapters WHERE project_id = ? ORDER BY id`)
      .bind(harness.projectId)
      .all();

    await coordinator.refreshProjection();
    const after = await harness.db
      .prepare(`SELECT id, revision, content_hash FROM chapters WHERE project_id = ? ORDER BY id`)
      .bind(harness.projectId)
      .all();

    expect(after).toEqual(before);
  });
});

describe("coordinator: alarms", () => {
  let harness: TestHarness;
  let storage: FakeDoStorage;

  beforeEach(async () => {
    harness = await makeHarness({ config: { mirrorMode: "queue" } });
    storage = new FakeDoStorage();
  });
  afterEach(() => harness.close());

  function build(overrides: { git?: CoordinatorGit | null } = {}): ProjectCoordinator {
    return createProjectCoordinator({
      projectId: harness.projectId,
      db: harness.db,
      git: overrides.git ?? null,
      alarms: storage,
      alarmIntervalMs: 60_000,
      clock: { now: () => new Date("2026-07-19T12:00:00Z") },
    });
  }

  it("ensureAlarm schedules once and is idempotent", async () => {
    const coordinator = build();

    const first = await coordinator.ensureAlarm();
    const second = await coordinator.ensureAlarm();

    expect(first).toBe(new Date("2026-07-19T12:01:00Z").getTime());
    expect(second).toBe(first);
    expect(storage.setAlarmCalls).toHaveLength(1);
  });

  it("the alarm reschedules itself", async () => {
    const coordinator = build();

    await coordinator.alarm();
    await coordinator.alarm();

    expect(storage.setAlarmCalls).toHaveLength(2);
    expect(storage.setAlarmCalls[1]).toBe(new Date("2026-07-19T12:01:00Z").getTime());
  });

  it("a failing step is reported but never stops the reschedule", async () => {
    // A writer that always throws: the drain fails, the sweep and the
    // reschedule must still happen. A GitHub outage must not silently end a
    // project's maintenance loop.
    const exploding = {
      reader: {
        readSnapshot: async (): Promise<never> => {
          throw new Error("reader unavailable");
        },
        readTextFile: async (): Promise<string | null> => null,
      },
      writer: {
        commitFiles: async (): Promise<never> => {
          throw new Error("github unavailable");
        },
        resolveHead: async (): Promise<never> => {
          throw new Error("github unavailable");
        },
      },
    } as unknown as CoordinatorGit;
    const coordinator = build({ git: exploding });
    await harness.repos.projects
      .markProjectionStaleStatement(harness.projectId, "2026-07-19T12:00:00Z")
      .run();

    const result = await coordinator.alarm();

    expect(result.rescheduledFor).toBe(new Date("2026-07-19T12:01:00Z").getTime());
    expect(result.errors.some((message) => message.startsWith("refreshProjection:"))).toBe(true);
    // Never echoes anything but the error's own message.
    expect(result.errors.join(" ")).not.toContain("ghs_");
  });

  it("alarmMs parsing: default, override, and boot-time rejection", () => {
    expect(coordinatorAlarmMsFromEnv(undefined)).toBe(DEFAULT_COORDINATOR_ALARM_SECONDS * 1000);
    expect(coordinatorAlarmMsFromEnv("")).toBe(DEFAULT_COORDINATOR_ALARM_SECONDS * 1000);
    expect(coordinatorAlarmMsFromEnv("120")).toBe(120_000);
    for (const bad of ["0", "-1", "1.5", "abc", "999999999"]) {
      expect(() => coordinatorAlarmMsFromEnv(bad)).toThrow(/COORDINATOR_ALARM_SECONDS/);
    }
  });
});

describe("ProjectCoordinator Durable Object wrapper", () => {
  let harness: TestHarness;
  let storage: FakeDoStorage;
  let object: ProjectCoordinatorDurableObject;

  beforeEach(async () => {
    harness = await makeHarness({ config: { mirrorMode: "queue" } });
    storage = new FakeDoStorage();
    const state: DurableObjectStateLike = { storage };
    // No GITHUB_APP_* bindings: the DO is exercised in the live deployment's
    // unconfigured state, where it must still route and still sweep.
    object = new ProjectCoordinatorDurableObject(
      state,
      {
        DB: UNUSED_D1,
        PROJECT_REPO: FULL_NAME,
        DEFAULT_BRANCH: "main",
        COORDINATOR_ALARM_SECONDS: "30",
      },
      { db: harness.db },
    );
  });
  afterEach(() => harness.close());

  const call = async (action: string): Promise<Response> =>
    object.fetch(
      new Request(`${COORDINATOR_ORIGIN}/projects/${harness.projectId}/${action}`, {
        method: "POST",
      }),
    );

  it("routes status, sweep, drain, refresh and stale", async () => {
    expect((await call("status")).status).toBe(200);
    expect(await (await call("status")).json()).toEqual({
      projectId: harness.projectId,
      gitIntegration: "unconfigured",
    });
    expect(await (await call("sweep")).json()).toEqual({ expired: 0 });
    expect(((await (await call("drain")).json()) as { skipped: string }).skipped).toBe(
      "git-unconfigured",
    );
    expect(await (await call("stale")).json()).toEqual({ stale: true });
    const project = await harness.repos.projects.getById(harness.projectId);
    expect(project?.projectionStale).toBe(true);
    expect(await (await call("source?path=chapters%2Fmissing.md")).json()).toEqual({
      outcome: "unavailable",
    });
    expect(await (await call("history?path=chapters%2Fmissing.md")).json()).toEqual({
      outcome: "unavailable",
    });
    expect(await (await call("source-page?glob=story%2Fcharacters%2F*.md&limit=5")).json()).toEqual({
      outcome: "unavailable",
    });
  });

  it("reads repository source through the Worker-to-coordinator boundary", async () => {
    const source = "# A production draft\n";
    const built = await makeGit({ "chapters/draft.md": source });
    const configured = new ProjectCoordinatorDurableObject(
      { storage: new FakeDoStorage() },
      { DB: UNUSED_D1, PROJECT_REPO: FULL_NAME, DEFAULT_BRANCH: "main" },
      { db: harness.db, git: built.git },
    );
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (input: string, init?: { method?: string }) =>
          configured.fetch(new Request(input, { method: init?.method ?? "GET" })),
      }),
    };

    await expect(
      callCoordinatorReadTextFile(namespace, harness.projectId, "chapters/draft.md"),
    ).resolves.toEqual({ outcome: "found", source });
    await expect(
      callCoordinatorReadTextFile(namespace, harness.projectId, "chapters/absent.md"),
    ).resolves.toEqual({ outcome: "not-found" });
  });

  it("pages configured-glob sources through one coordinator action", async () => {
    const built = await makeGit({
      "story/characters/a.md": "A\n",
      "story/characters/b.md": "B\n",
      "story/characters/c.md": "C\n",
    });
    const configured = new ProjectCoordinatorDurableObject(
      { storage: new FakeDoStorage() },
      { DB: UNUSED_D1, PROJECT_REPO: FULL_NAME, DEFAULT_BRANCH: "main" },
      { db: harness.db, git: built.git },
    );
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (input: string, init?: { method?: string }) =>
          configured.fetch(new Request(input, { method: init?.method ?? "GET" })),
      }),
    };

    const first = await callCoordinatorListTextFiles(
      namespace,
      harness.projectId,
      "story/characters/*.md",
      { limit: 2 },
    );
    expect(first).toMatchObject({
      outcome: "found",
      files: [
        { path: "story/characters/a.md", source: "A\n" },
        { path: "story/characters/b.md", source: "B\n" },
      ],
      nextAfter: "story/characters/b.md",
    });
    if (first.outcome !== "found" || first.nextAfter === null) {
      throw new Error("expected a second source page");
    }
    await expect(
      callCoordinatorListTextFiles(
        namespace,
        harness.projectId,
        "story/characters/*.md",
        { after: first.nextAfter, limit: 2 },
      ),
    ).resolves.toMatchObject({
      outcome: "found",
      files: [{ path: "story/characters/c.md", source: "C\n" }],
      nextAfter: null,
    });
  });

  it("pages history metadata and reads only the selected historical snapshot", async () => {
    const path = "chapters/draft.md";
    const firstSource = "# First production draft\n";
    const built = await makeGit({ [path]: firstSource });
    const firstCommit = built.fake.state.getRef("main") as string;
    const secondSource = "# Second production draft\n";
    const secondCommit = await built.fake.state.commitFiles({
      branch: "main",
      files: { [path]: secondSource },
      message: "Revise production draft",
    });
    const configured = new ProjectCoordinatorDurableObject(
      { storage: new FakeDoStorage() },
      { DB: UNUSED_D1, PROJECT_REPO: FULL_NAME, DEFAULT_BRANCH: "main" },
      { db: harness.db, git: built.git },
    );
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (input: string, init?: { method?: string }) =>
          configured.fetch(new Request(input, { method: init?.method ?? "GET" })),
      }),
    };

    const history = await callCoordinatorListFileHistory(
      namespace,
      harness.projectId,
      path,
      { limit: 10 },
    );
    expect(history).toMatchObject({ outcome: "found", page: 1, hasMore: false });
    if (history.outcome === "found") {
      expect(history.entries.map((entry) => entry.commitSha)).toEqual([secondCommit, firstCommit]);
    }
    await expect(
      callCoordinatorReadTextFileAtCommit(namespace, harness.projectId, path, firstCommit),
    ).resolves.toEqual({ outcome: "found", source: firstSource });
    await expect(
      callCoordinatorReadTextFileAtCommit(namespace, harness.projectId, path, secondCommit),
    ).resolves.toEqual({ outcome: "found", source: secondSource });
  });

  it("404s an unknown action rather than guessing", async () => {
    expect((await call("delete-everything")).status).toBe(404);
  });

  it("arms the alarm on first traffic and records the project id", async () => {
    await call("status");

    expect(storage.setAlarmCalls).toHaveLength(1);
    expect(await storage.get<string>(PROJECT_ID_KEY)).toBe(harness.projectId);
  });

  it("an alarm after an eviction recovers the project from storage and sweeps", async () => {
    await call("status");
    storage.clearAlarm();

    // A brand new instance over the same storage: exactly what an eviction
    // leaves behind. It has never been poked, so only storage can tell it
    // which project to sweep.
    const revived = new ProjectCoordinatorDurableObject(
      { storage },
      { DB: UNUSED_D1, PROJECT_REPO: FULL_NAME },
      { db: harness.db },
    );
    await revived.alarm();

    // Rescheduled: the maintenance loop restarted itself.
    expect(storage.setAlarmCalls.length).toBeGreaterThan(1);
  });

  it("an alarm on an instance that never learned a project id lapses quietly", async () => {
    const fresh = new ProjectCoordinatorDurableObject(
      { storage: new FakeDoStorage() },
      { DB: UNUSED_D1, PROJECT_REPO: FULL_NAME },
      { db: harness.db },
    );
    await expect(fresh.alarm()).resolves.toBeUndefined();
  });

  it("callCoordinator reaches the object through a namespace stub", async () => {
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (input: string, init?: { method?: string }) =>
          object.fetch(new Request(input, { method: init?.method ?? "GET" })),
      }),
    };

    const body = (await callCoordinator(namespace, harness.projectId, "status")) as {
      gitIntegration: string;
    };

    expect(body.gitIntegration).toBe("unconfigured");
  });
});

describe("MIRROR_MODE=durable end to end", () => {
  let harness: TestHarness;
  let fake: FakeGitHub;

  beforeEach(async () => {
    harness = await makeHarness({ config: { mirrorMode: "durable" } });
    const built = await makeGit();
    fake = built.fake;
    const storage = new FakeDoStorage();
    const object = new ProjectCoordinatorDurableObject(
      { storage },
      { DB: UNUSED_D1, PROJECT_REPO: FULL_NAME, DEFAULT_BRANCH: "main" },
      { db: harness.db, git: built.git },
    );
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (input: string, init?: { method?: string }) =>
          object.fetch(new Request(input, { method: init?.method ?? "GET" })),
      }),
    };
    // Exactly the production wiring from worker.ts: after the command's batch
    // commits, ask the project's coordinator to drain.
    harness.setMutationHook(async (projectId) => {
      await callCoordinator(namespace, projectId, "drain");
    });
  });
  afterEach(() => harness.close());

  it("a single annotation POST lands as a real commit (exit criterion 1)", async () => {
    const cookie = await devLogin(harness, "carla-contrib", "contributor");

    await createAnnotation(harness, cookie);

    const chain = await commitChain(fake);
    expect(chain).toHaveLength(2); // seed + the annotation commit
    const operations = await harness.db
      .prepare(`SELECT state, commit_sha FROM git_operations WHERE project_id = ?`)
      .bind(harness.projectId)
      .all();
    expect(String(operations[0]?.["state"])).toBe("committed");
    expect(String(operations[0]?.["commit_sha"])).toBe(chain[1]);
  });

  it("concurrent mutations serialize into one commit chain, one commit each", async () => {
    const cookies = await Promise.all([
      devLogin(harness, "one", "contributor"),
      devLogin(harness, "two", "contributor"),
      devLogin(harness, "three", "contributor"),
    ]);

    await Promise.all(cookies.map((cookie) => createAnnotation(harness, cookie)));

    const chain = await commitChain(fake);
    expect(chain).toHaveLength(4);
    for (let i = 1; i < chain.length; i += 1) {
      expect(fake.state.getCommit(chain[i] as string)?.parents).toEqual([chain[i - 1]]);
    }
    const pending = await harness.db
      .prepare(`SELECT id FROM outbox WHERE project_id = ? AND status != 'done'`)
      .bind(harness.projectId)
      .all();
    expect(pending).toHaveLength(0);
  });
});

describe("coordinator wiring from bindings", () => {
  it("gitIntegrationStatus distinguishes unconfigured, incomplete and configured", () => {
    expect(gitIntegrationStatus({})).toBe("unconfigured");
    expect(gitIntegrationStatus({ GITHUB_APP_ID: "1" })).toBe("incomplete");
    expect(
      gitIntegrationStatus({
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
        GITHUB_INSTALLATION_ID: "2",
      }),
    ).toBe("configured");
  });

  it("createCoordinatorGit returns null without complete credentials", () => {
    expect(createCoordinatorGit({ PROJECT_REPO: FULL_NAME })).toBeNull();
    expect(createCoordinatorGit({ PROJECT_REPO: FULL_NAME, GITHUB_APP_ID: "1" })).toBeNull();
  });

  it("parseRepoCoordinates rejects anything that is not owner/name", () => {
    expect(parseRepoCoordinates(FULL_NAME)).toEqual({ owner: OWNER, repo: REPO });
    for (const bad of ["nope", "a/b/c", "/b", "a/"]) {
      expect(() => parseRepoCoordinates(bad)).toThrow(/PROJECT_REPO/);
    }
  });

  it("MIRROR_MODE=durable requires the COORDINATOR binding", () => {
    const namespace = { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response("") }) };
    expect(() =>
      mirrorModeFromBindings({ DB: undefined as unknown as never, MIRROR_MODE: "durable" }),
    ).toThrow(/COORDINATOR/);
    expect(
      mirrorModeFromBindings({
        DB: undefined as unknown as never,
        MIRROR_MODE: "durable",
        COORDINATOR: namespace as unknown as never,
      }),
    ).toBe("durable");
  });

  it("MIRROR_MODE keeps its existing meanings (the live deployment runs queue)", () => {
    const bindings = { DB: undefined as unknown as never };
    expect(mirrorModeFromBindings({ ...bindings, MIRROR_MODE: "queue" })).toBe("queue");
    expect(mirrorModeFromBindings({ ...bindings, MIRROR_MODE: "inline" })).toBe("inline");
    expect(mirrorModeFromBindings(bindings)).toBe("queue");
    // An unrecognised value degrades to the safe mode, never to durable.
    expect(mirrorModeFromBindings({ ...bindings, MIRROR_MODE: "nonsense" })).toBe("queue");
  });
});

describe("migrations sanity", () => {
  it("the test database applies cleanly (guards the harness itself)", async () => {
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, MIGRATIONS_DIR);
    db.close();
  });
});
