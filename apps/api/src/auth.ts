/**
 * Authentication middleware (Phase 2 contract §3): Bearer agent tokens
 * (SHA-256 lookup, constant-time hash comparison, expiry/revocation checks,
 * throttled last_used updates) and HMAC-signed session cookies. Sets the
 * `auth` context variable; membership and effective scopes are resolved here
 * so handlers only declare the scope they require.
 *
 * No credential fragment ever reaches a log, an error message, or a problem
 * response.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { ProjectRecord, Repositories } from "@authorbot/database";
import {
  checkTokenActive,
  isAgentTokenFormat,
  shouldUpdateLastUsed,
  toTimestamp,
} from "@authorbot/domain";
import { apiEffectiveScopes, apiRoleScopes, type ApiScope } from "./api-scopes.js";
import { sha256Hex, timingSafeEqual } from "./crypto.js";
import type { AppEnv, AuthContext, Clock } from "./deps.js";
import { csrfOriginAllowed } from "./origins.js";
import { problem } from "./problems.js";
import { SESSION_COOKIE, verifySessionCookieValue } from "./sessions.js";

export interface AuthServices {
  repos: Repositories;
  clock: Clock;
  sessionSecret: string;
  getProject(): Promise<ProjectRecord | null>;
}

/** Methods exempt from the CSRF origin check (no state change). */
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function actorRefOf(actor: { id: string; externalIdentity: string | null }): string {
  // Every actor this API creates has an external identity; the fallback keeps
  // the ref shape for rows created out of band.
  return actor.externalIdentity ?? `system:actor-${actor.id}`;
}

async function authenticateBearer(
  services: AuthServices,
  presented: string,
): Promise<AuthContext | null> {
  if (!isAgentTokenFormat(presented)) {
    return null;
  }
  const hash = await sha256Hex(presented);
  const token = await services.repos.agentTokens.getByTokenHash(hash);
  // Belt and braces: the unique-index lookup already matched, but compare
  // digests in constant time as the authorization decision.
  if (token === null || !timingSafeEqual(hash, token.tokenHash)) {
    return null;
  }
  const now = services.clock.now();
  if (!checkTokenActive(token, now).allowed) {
    return null;
  }
  const project = await services.getProject();
  if (project === null || token.projectId !== project.id) {
    return null;
  }
  const actor = await services.repos.actors.getById(token.actorId);
  if (actor === null || actor.status !== "active") {
    return null;
  }
  if (shouldUpdateLastUsed(token.lastUsedAt, now)) {
    await services.repos.agentTokens.touchLastUsed(token.id, toTimestamp(now));
  }
  const membershipRow = await services.repos.projectMemberships.getByProjectAndActor(
    project.id,
    actor.id,
  );
  const membership = membershipRow !== null && membershipRow.revokedAt === null ? membershipRow : null;
  return {
    kind: "token",
    actor,
    actorRef: actorRefOf(actor),
    membership,
    role: membership?.role ?? null,
    scopes: membership !== null ? apiEffectiveScopes(token.scopes, membership.role) : [],
    tokenId: token.id,
  };
}

async function authenticateSession(
  services: AuthServices,
  cookieValue: string | undefined,
): Promise<AuthContext | null> {
  const sessionId = await verifySessionCookieValue(services.sessionSecret, cookieValue);
  if (sessionId === null) {
    return null;
  }
  const sessionHash = await sha256Hex(sessionId);
  const session = await services.repos.humanSessions.getBySessionHash(sessionHash);
  if (session === null || session.revokedAt !== null) {
    return null;
  }
  const now = services.clock.now();
  if (now.getTime() >= Date.parse(session.expiresAt)) {
    return null;
  }
  const actor = await services.repos.actors.getById(session.actorId);
  if (actor === null || actor.status !== "active") {
    return null;
  }
  const project = await services.getProject();
  const membershipRow =
    project === null
      ? null
      : await services.repos.projectMemberships.getByProjectAndActor(project.id, actor.id);
  const membership = membershipRow !== null && membershipRow.revokedAt === null ? membershipRow : null;
  return {
    kind: "session",
    actor,
    actorRef: actorRefOf(actor),
    membership,
    role: membership?.role ?? null,
    scopes: membership !== null ? [...apiRoleScopes(membership.role)] : [],
    sessionId: session.id,
  };
}

/** Require a valid credential; sets `auth` or responds 401. */
export function requireAuth(services: AuthServices): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    let auth: AuthContext | null = null;
    if (authorization !== undefined) {
      const [scheme, ...rest] = authorization.split(" ");
      if (scheme?.toLowerCase() !== "bearer" || rest.length !== 1) {
        return problem(c, "unauthorized", { detail: "malformed Authorization header" });
      }
      auth = await authenticateBearer(services, rest[0] as string);
      if (auth === null) {
        return problem(c, "unauthorized", { detail: "invalid, expired, or revoked token" });
      }
    } else {
      auth = await authenticateSession(services, getCookie(c, SESSION_COOKIE));
      if (auth === null) {
        return problem(c, "unauthorized", { detail: "missing or invalid credential" });
      }
      // CSRF (ADR-0019 §3 — retained after CORS removal): cookie-authenticated
      // mutations must present an Origin (or Referer) matching the API's own
      // origin; missing/foreign fails closed. Bearer requests are exempt (no
      // ambient credential) — they took the branch above.
      if (!CSRF_SAFE_METHODS.has(c.req.method)) {
        const apiOrigin = new URL(c.req.url).origin;
        const ok = csrfOriginAllowed(
          c.req.header("origin"),
          c.req.header("referer"),
          apiOrigin,
        );
        if (!ok) {
          return problem(c, "csrf-origin-mismatch", {
            detail:
              "cookie-authenticated mutations require an Origin or Referer header " +
              "matching this API's own origin",
          });
        }
      }
    }
    c.set("auth", auth);
    await next();
  };
}

/**
 * Optional authentication (Phase 2b public reads): a request presenting a
 * credential goes through the full `requireAuth` pipeline (invalid
 * credentials still 401); a credential-less request proceeds anonymously with
 * no `auth` context set. Handlers behind this middleware decide whether an
 * anonymous read is allowed (e.g. `PUBLIC_ANNOTATIONS`).
 */
export function optionalAuth(services: AuthServices): MiddlewareHandler<AppEnv> {
  const required = requireAuth(services);
  return async (c, next) => {
    const hasCredential =
      c.req.header("authorization") !== undefined || getCookie(c, SESSION_COOKIE) !== undefined;
    if (!hasCredential) {
      await next();
      return;
    }
    return required(c, next);
  };
}

/** The authenticated context (only valid after `requireAuth`). */
export function authOf(c: Context<AppEnv>): AuthContext {
  const auth = c.get("auth");
  if (auth === undefined) {
    throw new Error("authOf called on a route without requireAuth");
  }
  return auth;
}

/**
 * Guard: `{projectId}` must match the configured project (contract §4;
 * the path accepts the project UUID or its slug) — 404 otherwise — and the
 * actor must hold `scope` through an unrevoked membership — 403 otherwise.
 */
export async function requireProjectScope(
  c: Context<AppEnv>,
  services: AuthServices,
  scope: ApiScope | null,
): Promise<{ project: ProjectRecord } | { response: Response }> {
  const project = await services.getProject();
  const param = c.req.param("projectId");
  if (project === null || (param !== project.id && param !== project.slug)) {
    return { response: problem(c, "not-found", { detail: "unknown project" }) };
  }
  const auth = authOf(c);
  if (auth.membership === null) {
    return {
      response: problem(c, "forbidden", { detail: "actor is not a member of this project" }),
    };
  }
  if (scope !== null && !auth.scopes.includes(scope)) {
    return {
      response: problem(c, "forbidden", { detail: `actor lacks required scope "${scope}"` }),
    };
  }
  return { project };
}
