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
import type { AgentTokenRecord, ProjectRecord, Repositories } from "@authorbot/database";
import {
  checkTokenActive,
  isAgentTokenFormat,
  shouldUpdateLastUsed,
  toTimestamp,
} from "@authorbot/domain";
import type {
  EditorialCapability,
  LegacyCompatibilityAction,
  PolicyCapability,
} from "@authorbot/domain";
import {
  SAFE_METHODS,
  capabilityForScope,
  checkWriteGate,
  loadAccessState,
  policyAdmitsNonMember,
  writeGateProblem,
  type AccessState,
  type WriteSurface,
} from "./access-control.js";
import {
  sessionCapabilityProjection,
  tokenCapabilityProjection,
  type ApiScope,
} from "./api-scopes.js";
import { sha256Hex, timingSafeEqual } from "./crypto.js";
import { consumeRateLimit, rateLimitClassFor, rateLimitedProblem } from "./rate-limit.js";
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
  let token: AgentTokenRecord | null;
  try {
    token = await services.repos.agentTokens.getByTokenHash(hash);
  } catch {
    // A malformed JSON grant or an unknown capability mode is an invalid
    // credential, never an excuse to fall back to the legacy shadow column.
    return null;
  }
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
  const projection = tokenCapabilityProjection(token, membership?.role ?? null);
  return {
    kind: "token",
    actor,
    actorRef: actorRefOf(actor),
    membership,
    role: membership?.role ?? null,
    ...projection,
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
  const projection = sessionCapabilityProjection(membership?.role ?? null);
  return {
    kind: "session",
    actor,
    actorRef: actorRefOf(actor),
    membership,
    role: membership?.role ?? null,
    ...projection,
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
      // CSRF (ADR-0019 §3 - retained after CORS removal): cookie-authenticated
      // mutations must present an Origin (or Referer) matching the API's own
      // origin; missing/foreign fails closed. Bearer requests are exempt (no
      // ambient credential) - they took the branch above.
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

/** Token-management is an ambient-session control surface, never delegable. */
export function requireHumanSession(
  c: Context<AppEnv>,
  detail = "agent-token credentials cannot manage agent tokens",
): Response | null {
  if (authOf(c).kind === "token") {
    return problem(c, "forbidden", { detail });
  }
  return null;
}

/**
 * Options a route uses to describe the kind of write it is (Phase 7).
 *
 * Both default to the conservative answer, so a route that says nothing gets
 * the strictest treatment: gated by the freeze, and policy-gated according to
 * whatever its required scope implies.
 */
export interface ProjectGuardOptions {
  /**
   * `control` marks the maintainer control plane - settings, freeze, pause,
   * role changes, revocations, moderation rejection - which a freeze must not
   * refuse, because a freeze that blocked its own reversal would be a one-way
   * door. Everything else is `collaboration` and is frozen with the book.
   */
  surface?: WriteSurface;
  /**
   * Override the policy capability that would be derived from `scope`. Used by
   * the routes whose scope does not describe what they do - moderation
   * approval requires `annotations:write` on a maintainer but is not a
   * collaborator annotating, and lease release is holder-or-maintainer with no
   * scope at all.
   */
  capability?: PolicyCapability | null;
  /**
   * Require an actual membership even when the policy would admit a signed-in
   * non-member.
   *
   * Used by reply creation. `open` and `approval-gated` widen who may START a
   * thread on the book - "any signed-in GitHub user may comment/suggest" - and
   * Phase 7 supplies a moderation queue for exactly one object type, the
   * annotation. Admitting non-members into reply threads too would create a
   * second unmoderated write path on a book whose author chose moderation,
   * which is the one thing `approval-gated` is supposed to prevent.
   */
  requireMembership?: boolean;
  /**
   * Skip the rate limiter. Never used by a request-driven route; reserved for
   * internal/system-driven calls that reach the guard without a client behind
   * them.
   */
  skipRateLimit?: boolean;
  /**
   * Exact Phase 11 editorial authority for this endpoint. Every named
   * capability is required, so callers include prerequisite reads here too.
   *
   * Canonical tokens and human sessions use their canonical effective set.
   * Legacy tokens retain the ordinary `scope` argument's old meaning; the
   * three old maintainer-only compatibility actions must additionally name
   * their source-tagged action so they cannot masquerade as canonical grants.
   */
  editorial?: EditorialGuardRequirement;
}

export interface EditorialGuardRequirement {
  capabilities: readonly EditorialCapability[];
  legacyAction?: LegacyCompatibilityAction;
}

/** Credential-only half of the exact editorial guard (project gates live below). */
export function hasEditorialAuthority(
  auth: AuthContext,
  legacyScope: ApiScope | null,
  requirement: EditorialGuardRequirement,
): boolean {
  if (auth.kind === "token" && auth.capabilityMode === "legacy") {
    if (legacyScope === null || !auth.scopes.includes(legacyScope)) {
      return false;
    }
    return (
      requirement.legacyAction === undefined ||
      auth.legacyEffectiveActions.some(
        ({ action }) => action === requirement.legacyAction,
      )
    );
  }

  return requirement.capabilities.every((capability) =>
    auth.effectiveCapabilities.includes(capability),
  );
}

/**
 * Guard: `{projectId}` must match the configured project (contract §4;
 * the path accepts the project UUID or its slug) - 404 otherwise - and the
 * actor must hold `scope` through an unrevoked membership - 403 otherwise.
 *
 * Phase 7 adds four gates to the same choke point, applied to unsafe methods
 * only (reads pass through untouched, which is what makes "reads and the
 * published site are provably unaffected" structural rather than audited):
 *
 *   1. **Freeze** - refuses collaboration writes from everyone, maintainers
 *      included.
 *   2. **Agent pause** - refuses every agent-token write, control plane
 *      included, while human collaborators keep working.
 *   3. **Annotation policy** - `locked` admits only maintainers (including an
 *      author's agent holding a maintainer-role membership); `open` and
 *      `approval-gated` additionally admit a signed-in non-member to
 *      annotation writes; `collaborators-only` is the Phase 2 behaviour.
 *   4. **Rate limits** - per actor and per token, `429` + `Retry-After`.
 *
 * The membership requirement is relaxed for exactly one case - a signed-in
 * human writing an annotation to an `open` or `approval-gated` book - and the
 * scope check is relaxed with it, because a non-member has no membership and
 * therefore no scopes to hold.
 */
export async function requireProjectScope(
  c: Context<AppEnv>,
  services: AuthServices,
  scope: ApiScope | null,
  options: ProjectGuardOptions = {},
): Promise<{ project: ProjectRecord; access?: AccessState } | { response: Response }> {
  const project = await services.getProject();
  const param = c.req.param("projectId");
  if (project === null || (param !== project.id && param !== project.slug)) {
    return { response: problem(c, "not-found", { detail: "unknown project" }) };
  }
  const auth = authOf(c);
  const method = c.req.method;
  const mutating = !SAFE_METHODS.has(method);

  // The access state is read for mutations (where every gate applies) and for
  // reads by a NON-member (where a permissive policy may be the only thing
  // admitting them). A member's GET - the overwhelmingly common case - pays
  // nothing: it can neither be gated nor widened.
  const access =
    mutating || auth.membership === null
      ? await loadAccessState(services.repos, project.id)
      : null;
  const surface: WriteSurface = options.surface ?? "collaboration";
  const capability =
    options.capability !== undefined ? options.capability : capabilityForScope(scope);

  const admitsNonMember =
    options.requireMembership !== true &&
    access !== null &&
    policyAdmitsNonMember({ state: access, auth, capability, mutating, scope });

  if (auth.membership === null && !admitsNonMember) {
    return {
      response: problem(c, "forbidden", { detail: "actor is not a member of this project" }),
    };
  }
  if (!admitsNonMember) {
    if (
      options.editorial !== undefined &&
      !hasEditorialAuthority(auth, scope, options.editorial)
    ) {
      return {
        response: problem(c, "forbidden", {
          detail:
            "actor lacks required editorial capabilities: " +
            options.editorial.capabilities.join(", "),
        }),
      };
    }
    if (
      options.editorial === undefined &&
      scope !== null &&
      !auth.scopes.includes(scope)
    ) {
      return {
        response: problem(c, "forbidden", {
          detail: `actor lacks required scope "${scope}"`,
        }),
      };
    }
  }

  if (access !== null && mutating) {
    const denial = checkWriteGate({
      state: access,
      auth,
      method,
      surface,
      capability,
      role: auth.role,
    });
    if (denial !== null) {
      return { response: writeGateProblem(c, access, denial) };
    }

    if (options.skipRateLimit !== true) {
      const outcome = await consumeRateLimit(
        { repos: services.repos, clock: services.clock },
        auth,
        rateLimitClassFor({ capability, surface }),
      );
      if (!outcome.allowed) {
        return { response: rateLimitedProblem(c, outcome) };
      }
    }
  }

  return access === null ? { project } : { project, access };
}
