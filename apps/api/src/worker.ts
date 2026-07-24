/**
 * Cloudflare Worker entry (Phase 2 contract §6, Phase 5 contract §5). Builds
 * `AppDeps` from bindings and serves the app.
 *
 * Projection rebuild is deliberately NOT done here even once the GitHub
 * reader exists: a rebuild on the request path would make every cold isolate
 * pay a full repository read before serving anything. All repository access
 * belongs to the `ProjectCoordinator` Durable Object (contract §5: "All
 * Git-touching work goes through it"), which refreshes on its alarm when a
 * webhook marks the projection stale - so `deps.reader` stays undefined in
 * the Worker and `bootstrap()` behaves exactly as it does today.
 *
 * Secrets (`SESSION_SECRET`, `WEBHOOK_SECRET`, `GITHUB_CLIENT_SECRET`,
 * `GITHUB_APP_PRIVATE_KEY`) come from `wrangler secret put` - never from vars
 * or code, never logged, never returned in a response.
 */
import { wrapD1Database, type D1DatabaseLike } from "@authorbot/database";
import { createApi, type AuthorbotApi } from "./app.js";
import { coordinatorAlarmMsFromEnv, gitIntegrationStatus } from "./coordinator.js";
import {
  callCoordinator,
  callCoordinatorListTextFiles,
  callCoordinatorListFileHistory,
  callCoordinatorReadTextFile,
  callCoordinatorReadTextFileAtCommit,
  type DurableObjectNamespaceLike,
} from "./coordinator-do.js";
import type { AppConfig, AppDeps, MirrorMode } from "./deps.js";
import { createDevIdentityProvider, type IdentityProvider } from "./identity/provider.js";
import { createGitHubIdentityProvider } from "./identity/github.js";
import { leaseConfigFromEnv } from "./leases.js";
import { normalizeBasePath } from "./base-path.js";

export interface WorkerBindings {
  DB: D1DatabaseLike;
  AUTH_MODE?: string;
  /**
   * Second, independent guard for dev auth (must be the string "true").
   * AUTH_MODE=dev mounts the unauthenticated `POST /v1/dev/login`; requiring
   * this extra flag means a deployment cannot end up with dev auth through a
   * single misconfigured variable.
   */
  DEV_LOGIN_ENABLED?: string;
  SESSION_SECRET?: string;
  WEBHOOK_SECRET?: string;
  /**
   * HMAC key for CI publication callbacks. Optional: absent falls back to
   * `WEBHOOK_SECRET` so an existing deployment keeps reporting through the
   * rotation. Set it - the two secrets live in different trust domains
   * (GitHub's webhook config vs. the book repo's Actions secrets), and sharing
   * one lets either forge the other's requests.
   */
  PUBLICATION_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_REDIRECT_URI?: string;
  PROJECT_SLUG?: string;
  PROJECT_REPO?: string;
  INITIAL_MAINTAINER?: string;
  DEFAULT_BRANCH?: string;
  MIRROR_MODE?: string;
  /**
   * Route prefix the API is served under (ADR-0019 §6), e.g. `/my-book` when
   * the book lives at `example.com/my-book/`. Optional: absent (or `/`) mounts
   * the API at the origin root. Must match the site's `publication.api_url`.
   */
  API_BASE_PATH?: string;
  /**
   * "true" to serve annotation/reply reads anonymously (Phase 2b §2.1) - the
   * API-side mirror of the book's `publication.show_public_annotations`.
   */
  PUBLIC_ANNOTATIONS?: string;
  /**
   * Rule configuration (Phase 3 contract §3): JSON text of the
   * `authorbot.instance/v1` `rules` mapping. Validated at boot; absent
   * selects the design §25 default rule.
   */
  RULES_JSON?: string;
  /**
   * Lease timing overrides (Phase 4 contract §2), ISO-8601 durations, e.g.
   * `PT30M`. Validated at boot - a malformed value throws, never degrades.
   */
  LEASE_DURATION?: string;
  LEASE_RENEWAL_DURATION?: string;
  LEASE_MAX_TOTAL_DURATION?: string;
  LEASE_RENEWAL_PROMPT_BEFORE?: string;
  /**
   * `ProjectCoordinator` Durable Object namespace (Phase 5 contract §5).
   * Required by `MIRROR_MODE=durable`; absent otherwise.
   */
  COORDINATOR?: DurableObjectNamespaceLike;
  /**
   * Coordinator alarm cadence in seconds (default 60). Validated at boot -
   * a malformed value throws rather than silently disabling the periodic
   * backlog drain and lease sweep.
   */
  COORDINATOR_ALARM_SECONDS?: string;
  /**
   * GitHub App credentials (Phase 5 contract §2). All three or none: a
   * partially configured app reports `gitIntegration: "incomplete"` and does
   * no Git work, rather than half-working. `GITHUB_APP_PRIVATE_KEY` is a
   * PKCS#8 PEM set with `wrangler secret put`; its value is never logged,
   * persisted, or returned in any response.
   */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
}

function required(bindings: WorkerBindings, name: keyof WorkerBindings): string {
  const value = bindings[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required binding ${String(name)}`);
  }
  return value;
}

export function configFromBindings(bindings: WorkerBindings): AppConfig {
  const authMode = bindings.AUTH_MODE;
  if (authMode !== "dev" && authMode !== "github") {
    // Explicit by design: a deployment must never fall back to dev auth.
    throw new Error(`AUTH_MODE must be "dev" or "github"`);
  }
  if (authMode === "dev" && bindings.DEV_LOGIN_ENABLED !== "true") {
    // Defense in depth: dev auth (the unauthenticated /v1/dev/login) requires
    // a second, independent opt-in so it cannot ship through AUTH_MODE alone.
    throw new Error(
      `AUTH_MODE=dev requires DEV_LOGIN_ENABLED=true (dev login must never reach a deployment)`,
    );
  }
  const config: AppConfig = {
    authMode,
    sessionSecret: required(bindings, "SESSION_SECRET"),
    webhookSecret: required(bindings, "WEBHOOK_SECRET"),
    projectSlug: required(bindings, "PROJECT_SLUG"),
    projectRepo: required(bindings, "PROJECT_REPO"),
    initialMaintainer: required(bindings, "INITIAL_MAINTAINER"),
    mirrorMode: mirrorModeFromBindings(bindings),
    // Boot-time validation (ADR-0019 §6): a malformed base path throws here
    // rather than serving the API somewhere the site never looks.
    basePath: normalizeBasePath(bindings.API_BASE_PATH),
    publicAnnotations: bindings.PUBLIC_ANNOTATIONS === "true",
  };
  if (bindings.PUBLICATION_SECRET !== undefined && bindings.PUBLICATION_SECRET.length > 0) {
    config.publicationSecret = bindings.PUBLICATION_SECRET;
  }
  if (bindings.RULES_JSON !== undefined && bindings.RULES_JSON.length > 0) {
    config.rulesJson = bindings.RULES_JSON;
  }
  // Boot-time LEASE_* validation (Phase 4 contract §2): throws on invalid.
  config.leaseConfig = leaseConfigFromEnv({
    LEASE_DURATION: bindings.LEASE_DURATION,
    LEASE_RENEWAL_DURATION: bindings.LEASE_RENEWAL_DURATION,
    LEASE_MAX_TOTAL_DURATION: bindings.LEASE_MAX_TOTAL_DURATION,
    LEASE_RENEWAL_PROMPT_BEFORE: bindings.LEASE_RENEWAL_PROMPT_BEFORE,
  });
  if (bindings.DEFAULT_BRANCH !== undefined && bindings.DEFAULT_BRANCH.length > 0) {
    config.defaultBranch = bindings.DEFAULT_BRANCH;
  }
  if (authMode === "github") {
    config.github = {
      clientId: required(bindings, "GITHUB_CLIENT_ID"),
      clientSecret: required(bindings, "GITHUB_CLIENT_SECRET"),
      redirectUri: required(bindings, "GITHUB_REDIRECT_URI"),
    };
  }
  // Boot-time COORDINATOR_ALARM_SECONDS validation (contract §5): throws on
  // anything that is not a sane positive integer.
  coordinatorAlarmMsFromEnv(bindings.COORDINATOR_ALARM_SECONDS);
  // Status only: which of the three credential names are present. Reading the
  // credentials themselves happens inside the Durable Object.
  config.gitIntegration = gitIntegrationStatus(bindings);
  return config;
}

/**
 * `MIRROR_MODE` (Phase 2 contract §5 + Phase 5 contract §5). Unknown values
 * fall back to `queue` - the safe mode that records work without attempting
 * it - but `durable` without a `COORDINATOR` binding is a misconfiguration
 * that must fail the boot, not silently degrade to a deployment whose outbox
 * never drains.
 */
export function mirrorModeFromBindings(bindings: WorkerBindings): MirrorMode {
  if (bindings.MIRROR_MODE === "inline") {
    return "inline";
  }
  if (bindings.MIRROR_MODE === "durable") {
    if (bindings.COORDINATOR === undefined) {
      throw new Error(
        "MIRROR_MODE=durable requires the COORDINATOR Durable Object binding (see wrangler.jsonc)",
      );
    }
    return "durable";
  }
  return "queue";
}

/**
 * Provider selection shared by every entry point (worker and Node dev
 * server): fail closed - a github-mode deployment without OAuth configuration
 * must throw, never fall back to dev auth (which would mount the
 * unauthenticated /v1/dev/login).
 */
export function identityProviderFor(config: AppConfig): IdentityProvider {
  if (config.authMode === "github") {
    if (config.github === undefined) {
      throw new Error("AUTH_MODE=github requires GitHub OAuth configuration");
    }
    return createGitHubIdentityProvider(config.github);
  }
  return createDevIdentityProvider();
}

interface WorkerState {
  api: AuthorbotApi;
  bootstrapped: Promise<unknown>;
}

/**
 * Worker runtime with retryable bootstrap: a failed bootstrap (e.g. a
 * transient D1 error, or losing a first-boot seed race before the seed became
 * conflict-tolerant) is NOT cached - the failing request gets a 500 and the
 * next request rebuilds state and retries, instead of poisoning the isolate
 * for its whole lifetime.
 */
export function createWorkerRuntime(
  buildApi: (bindings: WorkerBindings) => AuthorbotApi = defaultBuildApi,
): { fetch(request: Request, env: WorkerBindings): Promise<Response> } {
  let state: WorkerState | null = null;

  const getState = (bindings: WorkerBindings): WorkerState => {
    if (state === null) {
      const api = buildApi(bindings);
      state = { api, bootstrapped: api.bootstrap() };
    }
    return state;
  };

  return {
    async fetch(request: Request, env: WorkerBindings): Promise<Response> {
      let current: WorkerState;
      try {
        current = getState(env);
        await current.bootstrapped;
      } catch (error) {
        // Do not cache the failure: reset so the next request retries.
        state = null;
        void error; // never echo internals
        return internalProblem();
      }
      return current.api.app.fetch(request);
    },
  };
}

function defaultBuildApi(bindings: WorkerBindings): AuthorbotApi {
  const config = configFromBindings(bindings);
  const deps: AppDeps = {
    db: wrapD1Database(bindings.DB),
    config,
    identityProvider: identityProviderFor(config),
  };
  const coordinator = bindings.COORDINATOR;
  if (config.mirrorMode === "durable" && coordinator !== undefined) {
    // Post-commit drain (contract §5): the command's D1 batch has already
    // landed, so the coordinator reads a committed outbox row. A failure here
    // is swallowed by `notifyMutation` - the row stays `pending` and the next
    // mutation or the 60s alarm drains it, so a coordinator hiccup costs
    // latency, not work.
    deps.onMutationCommitted = async (projectId: string): Promise<void> => {
      await callCoordinator(coordinator, projectId, "drain");
    };
  }
  if (coordinator !== undefined) {
    deps.repositorySourceReader = {
      readTextFile: async (projectId, path) =>
        callCoordinatorReadTextFile(coordinator, projectId, path),
      listTextFiles: async (projectId, glob, options) =>
        callCoordinatorListTextFiles(coordinator, projectId, glob, options),
    };
    deps.repositoryHistoryReader = {
      listFileHistory: async (projectId, path, options) =>
        callCoordinatorListFileHistory(coordinator, projectId, path, options),
      readTextFileAtCommit: async (projectId, path, commitSha) =>
        callCoordinatorReadTextFileAtCommit(coordinator, projectId, path, commitSha),
    };
    // Webhook-driven reconciliation (contract §6) - wired whenever the
    // binding exists, independently of MIRROR_MODE, because a `push` must be
    // reconciled even on a deployment that still queues its own writes.
    // `markStaleAndRequestRefresh` has already committed the stale flag by the
    // time this runs, so a failure here only delays the refresh to the next
    // alarm; the webhook still answers 2xx and GitHub does not redeliver.
    deps.projectionRefresher = {
      requestProjectionRefresh: async (request): Promise<void> => {
        await callCoordinator(coordinator, request.projectId, "refresh");
      },
    };
  }
  return createApi(deps);
}

/**
 * Cron entry (contract §5). The periodic alarm is armed only by
 * `ensureAlarm()` inside the Durable Object's `fetch`, and `fetch` is reached
 * from exactly two places: `onMutationCommitted` (MIRROR_MODE=durable only)
 * and the GitHub push webhook. A deployment running `queue` without a GitHub
 * App - which is what the live deployment is - therefore never contacted the
 * DO at all, so no alarm was ever set and `sweepExpiredLeases` never ran in
 * production, despite §5 requiring it ("sweeps expired leases (Phase 4 §2
 * requires this in production)"). The DO cannot self-bootstrap either: an
 * alarm that fires before any request has recorded a project id returns
 * without rescheduling.
 *
 * A cron poke closes that: it runs the sweep AND, through the same
 * `fetch` path, calls `ensureAlarm()`, so the maintenance loop is
 * self-starting independent of MIRROR_MODE and of whether GitHub credentials
 * exist. Failures are swallowed and logged nowhere sensitive - a cron that
 * throws is retried on its own schedule, and the alarm remains the primary
 * loop once armed.
 */
export async function runScheduledMaintenance(env: WorkerBindings): Promise<void> {
  const coordinator = env.COORDINATOR;
  if (coordinator === undefined) {
    return;
  }
  const slug = env.PROJECT_SLUG;
  if (slug === undefined || slug.length === 0) {
    return;
  }
  const db = wrapD1Database(env.DB);
  // The DO is keyed by project id, which only D1 knows; the cron has no
  // request context to derive it from. Deliberately not via
  // `configFromBindings`: a cron must not fail on unrelated configuration
  // (OAuth vars, AUTH_MODE) when all it needs is the project's identity.
  const row = await db
    .prepare(`SELECT id FROM projects WHERE slug = ?`)
    .bind(slug)
    .first();
  const projectId = row === null ? null : String(row["id"]);
  if (projectId === null) {
    // Not yet seeded: the first request bootstraps the project, and the next
    // cron tick finds it. Nothing to maintain in the meantime.
    return;
  }
  await callCoordinator(coordinator, projectId, "sweep");
}

function internalProblem(): Response {
  return new Response(
    JSON.stringify({
      type: "urn:authorbot:problem:internal",
      title: "Internal error",
      status: 500,
      code: "internal",
    }),
    { status: 500, headers: { "Content-Type": "application/problem+json; charset=utf-8" } },
  );
}

/**
 * Durable Object class export (contract §5). Wrangler resolves
 * `durable_objects.bindings[].class_name` against this entry module, so the
 * class must be re-exported here even though it lives in coordinator-do.ts.
 */
export { ProjectCoordinator } from "./coordinator-do.js";

const runtime = createWorkerRuntime();

export default {
  fetch: (request: Request, env: WorkerBindings): Promise<Response> =>
    runtime.fetch(request, env),
  /**
   * `triggers.crons` entry point (see wrangler.jsonc). This is what arms the
   * coordinator's periodic alarm on a deployment that receives neither
   * durable-mode mutations nor GitHub webhooks.
   */
  scheduled: async (_event: unknown, env: WorkerBindings): Promise<void> => {
    await runScheduledMaintenance(env);
  },
};
