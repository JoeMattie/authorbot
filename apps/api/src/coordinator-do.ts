/**
 * `ProjectCoordinator` Durable Object - the Cloudflare wrapper around
 * coordinator.ts (Phase 5 contract §5, design §6.2). One instance per project
 * id (`idFromName(projectId)`), so every Git-touching operation for a project
 * is serialized regardless of how many isolates are serving requests.
 *
 * Two deliberate shape choices:
 *
 * 1. **Classic `fetch`/`alarm` Durable Object, not RPC.** The RPC style needs
 *    `extends DurableObject` from `cloudflare:workers`, a module that only
 *    resolves inside workerd - importing it would make this file unloadable
 *    in the Node test suite and force the whole coordinator behind
 *    `@cloudflare/vitest-pool-workers`. The contract asks for deterministic
 *    default-suite tests, so the wire protocol is a handful of internal POST
 *    routes instead.
 * 2. **Structural binding types, not `@cloudflare/workers-types`.** This
 *    package compiles with `types: ["node"]` (see tsconfig.json); the same
 *    approach `D1DatabaseLike` already takes. The interfaces below are the
 *    exact subset of `DurableObjectState`/`DurableObjectNamespace` used.
 *
 * The DO holds no operational state: D1 is the source of truth, and the only
 * thing in DO storage is the projection-stale flag plus the alarm itself, so
 * a DO reset loses nothing but a scheduled wakeup (which the next request
 * re-arms via `ensureAlarm`).
 */
import { wrapD1Database, type D1DatabaseLike, type SqlDatabase } from "@authorbot/database";
import {
  coordinatorAlarmMsFromEnv,
  createCoordinatorGit,
  createProjectCoordinator,
  gitIntegrationStatus,
  type AlarmScheduler,
  type CoordinatorBindings,
  type CoordinatorGit,
  type CoordinatorStore,
  type ProjectCoordinator,
} from "./coordinator.js";
import type { RepositorySourceReadResult } from "./deps.js";

/** The `DurableObjectState` subset the coordinator uses. */
export interface DurableObjectStateLike {
  storage: AlarmScheduler & CoordinatorStore;
}

/** The `DurableObjectStub` subset callers use. */
export interface DurableObjectStubLike {
  fetch(input: string, init?: { method?: string; body?: string }): Promise<Response>;
}

/** The `DurableObjectNamespace` subset callers use. */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

/** Bindings visible to the Durable Object (a superset of the coordinator's). */
export interface CoordinatorDoBindings extends CoordinatorBindings {
  DB: D1DatabaseLike;
  COORDINATOR_ALARM_SECONDS?: string;
}

/**
 * Internal origin for stub requests. Durable Object `fetch` requires an
 * absolute URL but never resolves it over the network - nothing leaves the
 * account.
 */
export const COORDINATOR_ORIGIN = "https://coordinator.authorbot.internal";

/** Test-only injection points; never supplied by the Cloudflare runtime. */
export interface CoordinatorDoOverrides {
  db?: SqlDatabase;
  git?: CoordinatorGit | null;
}

/** Storage key recording which project this instance was created for. */
export const PROJECT_ID_KEY = "project-id";

export type CoordinatorAction = "drain" | "refresh" | "source" | "sweep" | "stale" | "status";

const ACTIONS: readonly CoordinatorAction[] = [
  "drain",
  "refresh",
  "source",
  "sweep",
  "stale",
  "status",
];

function isAction(value: string): value is CoordinatorAction {
  return (ACTIONS as readonly string[]).includes(value);
}

export class ProjectCoordinatorDurableObject {
  readonly #state: DurableObjectStateLike;
  readonly #env: CoordinatorDoBindings;
  /**
   * Built lazily and cached per project id: the coordinator owns a drain
   * chain and the GitHub auth token cache, so rebuilding it per request would
   * throw both away. One DO instance only ever sees one project id, but the
   * map keeps that an assertion rather than an assumption.
   */
  readonly #coordinators = new Map<string, ProjectCoordinator>();
  readonly #overrides: CoordinatorDoOverrides;

  /**
   * Workerd constructs this with `(state, env)`. The third parameter is a
   * test seam: it lets the Node suite hand in an already-wrapped
   * better-sqlite3 database and a fake-GitHub reader/writer pair, so the
   * routing, alarm, and eviction-recovery paths are covered without workerd.
   * It is never passed in production - the runtime supplies two arguments.
   */
  constructor(
    state: DurableObjectStateLike,
    env: CoordinatorDoBindings,
    overrides: CoordinatorDoOverrides = {},
  ) {
    this.#state = state;
    this.#env = env;
    this.#overrides = overrides;
  }

  #coordinatorFor(projectId: string): ProjectCoordinator {
    const existing = this.#coordinators.get(projectId);
    if (existing !== undefined) {
      return existing;
    }
    const git =
      this.#overrides.git !== undefined ? this.#overrides.git : createCoordinatorGit(this.#env);
    const coordinator = createProjectCoordinator({
      projectId,
      db: this.#overrides.db ?? wrapD1Database(this.#env.DB),
      git,
      // With an injected pair the status follows the pair; otherwise it is
      // read from the bindings so "incomplete" stays distinguishable from
      // "unconfigured".
      ...(this.#overrides.git === undefined
        ? { gitIntegration: gitIntegrationStatus(this.#env) }
        : {}),
      alarms: this.#state.storage,
      alarmIntervalMs: coordinatorAlarmMsFromEnv(this.#env.COORDINATOR_ALARM_SECONDS),
    });
    this.#coordinators.set(projectId, coordinator);
    return coordinator;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/projects\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const rawAction = match?.[2];
    const rawProjectId = match?.[1];
    if (rawAction === undefined || rawProjectId === undefined || !isAction(rawAction)) {
      return json({ error: "unknown coordinator action" }, 404);
    }
    const projectId = decodeURIComponent(rawProjectId);
    const coordinator = this.#coordinatorFor(projectId);
    // Remember which project this instance owns: `idFromName` is one-way, so
    // without this an alarm that fires after an eviction has no project to
    // sweep leases for. Scheduling bookkeeping only - never operational state.
    await this.#state.storage.put(PROJECT_ID_KEY, projectId);
    // Self-healing schedule: any traffic re-arms the periodic alarm, so a DO
    // that lost its alarm (reset, first ever request) starts sweeping again
    // without operator action.
    await coordinator.ensureAlarm();

    switch (rawAction) {
      case "drain":
        return json(await coordinator.drainOutbox());
      case "refresh":
        return json(await coordinator.refreshProjection());
      case "source": {
        const path = url.searchParams.get("path");
        if (path === null || path.length === 0 || path.length > 2048) {
          return json({ error: "invalid repository source path" }, 400);
        }
        return json(await coordinator.readTextFile(path));
      }
      case "sweep":
        return json(await coordinator.sweepLeases());
      case "stale": {
        await coordinator.markProjectionStale();
        return json({ stale: true });
      }
      case "status":
        return json({ projectId, gitIntegration: coordinator.gitIntegration });
    }
  }

  /**
   * Periodic maintenance (contract §5): sweep expired leases, drain any
   * outbox backlog, refresh the projection if a webhook marked it stale, then
   * reschedule. `ProjectCoordinator.alarm()` swallows per-step failures and
   * always reschedules, so one bad GitHub response cannot silently end the
   * project's maintenance loop.
   *
   * `idFromName` is one-way, so after an eviction the in-memory map is empty;
   * the project id is recovered from storage and the coordinator rebuilt.
   */
  async alarm(): Promise<void> {
    if (this.#coordinators.size === 0) {
      const projectId = await this.#state.storage.get<string>(PROJECT_ID_KEY);
      if (projectId === undefined) {
        // Never poked and nothing recorded: no project to work on. Let the
        // alarm lapse rather than spin on an empty instance; the next request
        // re-arms it through `ensureAlarm`.
        return;
      }
      this.#coordinatorFor(projectId);
    }
    for (const coordinator of this.#coordinators.values()) {
      await coordinator.alarm();
    }
  }
}

/** Wrangler binds the class under this name (see wrangler.jsonc). */
export { ProjectCoordinatorDurableObject as ProjectCoordinator };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Client side (Worker → DO)
// ---------------------------------------------------------------------------

/** Get the stub for a project's coordinator. */
export function coordinatorStub(
  namespace: DurableObjectNamespaceLike,
  projectId: string,
): DurableObjectStubLike {
  return namespace.get(namespace.idFromName(projectId));
}

/**
 * Ask a project's coordinator to run one action. Returns the parsed JSON body,
 * or throws - callers on the request path (`notifyMutation`) already treat a
 * mirror failure as non-fatal, since the operation stays observable through
 * `GET /v1/projects/{id}/operations/{operationId}`.
 */
export async function callCoordinator(
  namespace: DurableObjectNamespaceLike,
  projectId: string,
  action: CoordinatorAction,
): Promise<unknown> {
  const stub = coordinatorStub(namespace, projectId);
  const response = await stub.fetch(
    `${COORDINATOR_ORIGIN}/projects/${encodeURIComponent(projectId)}/${action}`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(`coordinator ${action} failed with ${String(response.status)}`);
  }
  return (await response.json()) as unknown;
}

/** Read one repository file through the project's coordinator. */
export async function callCoordinatorReadTextFile(
  namespace: DurableObjectNamespaceLike,
  projectId: string,
  path: string,
): Promise<RepositorySourceReadResult> {
  const stub = coordinatorStub(namespace, projectId);
  const url = new URL(
    `${COORDINATOR_ORIGIN}/projects/${encodeURIComponent(projectId)}/source`,
  );
  url.searchParams.set("path", path);
  const response = await stub.fetch(url.toString(), { method: "POST" });
  if (!response.ok) {
    throw new Error(`coordinator source failed with ${String(response.status)}`);
  }
  const body = (await response.json()) as unknown;
  if (
    typeof body !== "object" ||
    body === null ||
    !("outcome" in body) ||
    (body.outcome !== "not-found" &&
      body.outcome !== "unavailable" &&
      !(body.outcome === "found" && "source" in body && typeof body.source === "string"))
  ) {
    throw new Error("coordinator source returned an invalid response");
  }
  return body as RepositorySourceReadResult;
}
