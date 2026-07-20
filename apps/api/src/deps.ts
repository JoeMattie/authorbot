/**
 * Dependency wiring for `createApp` (Phase 2 contract §1, §6). Everything the
 * app needs is injected so the same business wiring runs under Cloudflare
 * Workers (src/worker.ts builds deps from bindings) and Node tests (deps from
 * better-sqlite3 + fakes).
 */
import type { SqlDatabase, Repositories, ActorRecord, ProjectMembershipRecord } from "@authorbot/database";
import type { Role, Scope } from "@authorbot/domain";
import type { IdentityProvider } from "./identity/provider.js";
import type { IdempotencyClaim } from "./idempotency.js";
import type { BookRepoReader } from "./projection/reader.js";

export interface Clock {
  now(): Date;
}

export type AuthMode = "dev" | "github";

/** Mirror processing mode (contract §5): inline in dev/tests, queue-only otherwise. */
export type MirrorMode = "inline" | "queue";

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
   * Exact origins allowed for CORS, CSRF, and OAuth `return_to` (Phase 2b
   * contract §3). Parsed/validated at boot from ALLOWED_ORIGINS; empty means
   * same-origin deployment (no CORS headers, SameSite=Lax session cookie).
   */
  allowedOrigins?: string[];
  /**
   * Serve annotation/reply reads to credential-less requests (Phase 2b
   * contract §2.1). The API-side mirror of the book's
   * `publication.show_public_annotations`; set via PUBLIC_ANNOTATIONS=true.
   * Default false: anonymous reads stay 401.
   */
  publicAnnotations?: boolean;
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
  /**
   * Called after any mutation that enqueued an outbox row — the
   * repo-coordinator processor is wired here later. Optional; a rejection is
   * swallowed (the operation stays observable via GET .../operations/{id}).
   */
  onMutationCommitted?: (projectId: string) => Promise<void>;
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
  scopes: Scope[];
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
