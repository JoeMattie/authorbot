/**
 * Dependency wiring for `createApp` (Phase 2 contract §1, §6). Everything the
 * app needs is injected so the same business wiring runs under Cloudflare
 * Workers (src/worker.ts builds deps from bindings) and Node tests (deps from
 * better-sqlite3 + fakes).
 */
import type { SqlDatabase, Repositories, ActorRecord, ProjectMembershipRecord } from "@authorbot/database";
import type { LeaseConfig, Role } from "@authorbot/domain";
import type { ApiScope } from "./api-scopes.js";
import type { IdentityProvider } from "./identity/provider.js";
import type { IdempotencyClaim } from "./idempotency.js";
import type { BookRepoReader } from "./projection/reader.js";
import type { ProjectionRefresher } from "./reconcile.js";

export type RepositorySourceReadResult =
  | { outcome: "found"; source: string }
  | { outcome: "not-found" }
  | { outcome: "unavailable" };

/** Repository reads routed through the project coordinator in production. */
export interface RepositorySourceReader {
  readTextFile(projectId: string, path: string): Promise<RepositorySourceReadResult>;
}

export interface Clock {
  now(): Date;
}

export type AuthMode = "dev" | "github";

/**
 * Mirror processing mode (Phase 2 contract §5, Phase 5 contract §5):
 *
 * - `inline` - drain in-process right after the command's batch (dev/tests).
 * - `queue` - record outbox rows and drain later, out of band. The deployed
 *   Worker runs this today.
 * - `durable` - hand the drain to the project's `ProjectCoordinator` Durable
 *   Object after the batch commits (production, Phase 5).
 */
export type MirrorMode = "inline" | "queue" | "durable";

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Absolute callback URL registered with the OAuth app. */
  redirectUri: string;
}

/** Env/binding-derived configuration (contract §6). */
export interface AppConfig {
  authMode: AuthMode;
  /** HMAC key for session cookies and OAuth state cookies. Never logged. */
  sessionSecret: string;
  /** HMAC key for GitHub webhook signatures. Never logged. */
  webhookSecret: string;
  projectSlug: string;
  /** Repository coordinates, e.g. `JoeMattie/causal-projector`. */
  projectRepo: string;
  /** Initial maintainer actor ref, e.g. `github:JoeMattie`. */
  initialMaintainer: string;
  defaultBranch?: string;
  github?: GitHubOAuthConfig;
  mirrorMode?: MirrorMode;
  /**
   * Route prefix the API is served under (ADR-0019 §6), e.g. `/my-book` for a
   * book at `example.com/my-book/` whose API answers at `/my-book/v1/*`.
   * Normalized/validated at boot from `API_BASE_PATH`; absent or `""` mounts
   * the API at the origin root. Must match the site's `publication.api_url`.
   */
  basePath?: string;
  /**
   * Serve annotation/reply reads to credential-less requests (Phase 2b
   * contract §2.1). The API-side mirror of the book's
   * `publication.show_public_annotations`; set via PUBLIC_ANNOTATIONS=true.
   * Default false: anonymous reads stay 401.
   */
  publicAnnotations?: boolean;
  /**
   * Rule configuration (Phase 3 contract §3): the JSON text of the
   * `authorbot.instance/v1` `rules` mapping, from the RULES_JSON env.
   * Validated at boot (`createApi` throws on invalid input); absent selects
   * the design §25 default rule.
   */
  rulesJson?: string;
  /**
   * Lease timing configuration (Phase 4 contract §2): parsed/validated at
   * boot from the `LEASE_*` env (ISO-8601 durations) by `leaseConfigFromEnv`;
   * absent selects the design §25 defaults (PT30M/PT30M/PT4H/PT5M).
   */
  leaseConfig?: LeaseConfig;
  /**
   * GitHub App credential status (Phase 5 contract §2), surfaced by
   * `GET /v1/projects/{id}` as `gitIntegration`. Absent means the same as
   * `"unconfigured"`: no repository access, reads keep working, outbox rows
   * accumulate for a later drain. Only the *status* ever leaves this process
   * - no credential value is stored here.
   */
  gitIntegration?: "configured" | "unconfigured" | "incomplete" | "invalid";
  /** SSE new-row poll interval (ms). Default 1000; tests shrink it. */
  ssePollMs?: number;
  /** SSE heartbeat-comment interval (ms). Contract §5: default 15000. */
  sseHeartbeatMs?: number;
  /**
   * Server-side cap on one SSE connection's lifetime (ms). Default 5 minutes
   * (`DEFAULT_SSE_MAX_LIFETIME_MS`); clients resume transparently via
   * `Last-Event-ID`, so this is invisible except as a periodic reconnect.
   */
  sseMaxLifetimeMs?: number;
  /**
   * Concurrent SSE connections one client address may hold, per isolate.
   * Default `DEFAULT_SSE_MAX_STREAMS_PER_CLIENT`.
   */
  sseMaxStreamsPerClient?: number;
  /**
   * HMAC key for CI publication callbacks (`POST /v1/publications`). Absent
   * falls back to `webhookSecret` for compatibility - see publications.ts.
   */
  publicationSecret?: string;
}

export interface AppDeps {
  db: SqlDatabase;
  config: AppConfig;
  identityProvider: IdentityProvider;
  clock?: Clock;
  /**
   * Book repository reader for projection rebuild (boot, webhook, tests).
   * Absent when the deployment has no repository access yet (the Worker
   * before Phase 5): rebuilds are skipped, reads still work.
   */
  reader?: BookRepoReader;
  /** Production source-read seam owned by the per-project coordinator. */
  repositorySourceReader?: RepositorySourceReader;
  /**
   * Called after any mutation that enqueued an outbox row - the
   * repo-coordinator processor is wired here later. Optional; a rejection is
   * swallowed (the operation stays observable via GET .../operations/{id}).
   */
  onMutationCommitted?: (projectId: string) => Promise<void>;
  /**
   * Phase 5 contract §6: where a verified `push` webhook sends its request for
   * a projection refresh. The API never imports the `ProjectCoordinator`
   * Durable Object - it asks through this seam, so the refresh happens
   * somewhere serialized without the app depending on the coordinator module.
   *
   * Absent is a supported deployment: the webhook still marks the projection
   * stale durably, and the refresh happens on the next drain/alarm/boot.
   */
  projectionRefresher?: ProjectionRefresher;
}

/** Authenticated request context set by the auth middleware. */
export interface AuthContext {
  kind: "session" | "token";
  actor: ActorRecord;
  /** Canonical actor ref (`<namespace>:<identifier>`) for domain rules and audit. */
  actorRef: string;
  membership: ProjectMembershipRecord | null;
  role: Role | null;
  /** Effective scopes: role bundle for sessions, token ∩ bundle for tokens. */
  scopes: ApiScope[];
  /** Present for token auth. */
  tokenId?: string;
  /** Present for session auth. */
  sessionId?: string;
}

/** Internal per-app state shared across requests. */
export interface AppState {
  deps: AppDeps;
  repos: Repositories;
  clock: Clock;
  /** Cached configured project row (single project per deployment). */
  projectId: string | null;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

/** Read a repository file through the local reader or production seam. */
export async function readRepositoryText(
  deps: Pick<AppDeps, "reader" | "repositorySourceReader">,
  projectId: string,
  path: string,
): Promise<RepositorySourceReadResult> {
  if (deps.reader?.readTextFile !== undefined) {
    const source = await deps.reader.readTextFile(path);
    return source === null ? { outcome: "not-found" } : { outcome: "found", source };
  }
  if (deps.repositorySourceReader !== undefined) {
    return deps.repositorySourceReader.readTextFile(projectId, path);
  }
  return { outcome: "unavailable" };
}

/** Hono environment: per-request variables set by middleware. */
export type AppEnv = {
  Variables: {
    correlationId: string;
    auth?: AuthContext;
    /**
     * Set by the idempotency middleware on first-attempt mutations: the
     * handler batches `claim(status, body)` with its command statements so
     * the key claim and stored response commit atomically with the mutation.
     */
    idempotency?: IdempotencyClaim;
  };
};
