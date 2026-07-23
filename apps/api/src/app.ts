/**
 * createApp (Phase 2 contract §3, §4, §5): the Hono application with all
 * business wiring, runtime-agnostic. The Worker entry (src/worker.ts) builds
 * deps from bindings; tests build them from Node fakes (better-sqlite3).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import {
  createRepositories,
  isConstraintError,
  isUniqueConstraintError,
  type AgentTokenRecord,
  type AnnotationRecord,
  type ProjectRecord,
  type Repositories,
  type SqlStatement,
} from "@authorbot/database";
import {
  authorizeAnnotationWithdraw,
  createAnnotationCommandSchema,
  createReplyCommandSchema,
  isWorkItemTerminal,
  legacyScopeShadow,
  resolveSessionExpiry,
  resolveTokenExpiry,
  roleSchema,
  roleScopes,
  toTimestamp,
  withdrawReplyCommandSchema,
  AGENT_TOKEN_PREFIX,
  WORK_ITEM_STATUSES,
} from "@authorbot/domain";
import {
  apiRoleScopes,
  capabilityProjectionJson,
  mintAgentTokenApiCommandSchema,
  replaceAgentTokenCapabilitiesApiCommandSchema,
  tokenCapabilityProjection,
} from "./api-scopes.js";
import { parseRuleEntries, resolveRuleEntries, type RuleEntry } from "./rules.js";
import { registerSettingsRoutes } from "./settings.js";
import { annotationCollabJson, registerPhase3Routes } from "./phase3.js";
import { redactClaimBundle, registerPhase4Routes } from "./phase4.js";
import { registerChapterSubmissionRoutes } from "./chapter-submissions.js";
import { registerRevisionProposalRoutes } from "./revision-proposals.js";
import { registerChapterHistoryRoutes } from "./chapter-history.js";
import { registerStoryBibleRoutes } from "./story-bible.js";
import {
  pendingAnnotationJson,
  registerPhase7Routes,
  revocationCascadeStatements,
} from "./phase7.js";
import { loadAccessState } from "./access-control.js";
import { createProjectSerializer } from "./serializer.js";
import { parseChapterMarkdown, scanSafety, stripBlockMarkers } from "@authorbot/markdown";
import { chapterFrontmatterSchema } from "@authorbot/schemas";
import { z } from "zod";
import {
  authOf,
  hasEditorialAuthority,
  optionalAuth,
  requireAuth,
  requireHumanSession,
  requireProjectScope,
  type AuthServices,
} from "./auth.js";
import { normalizeBasePath } from "./base-path.js";
import { csrfOriginAllowed, isValidReturnTo } from "./origins.js";
import { randomBase64Url, sha256Hex, timingSafeEqual, hmacSha256Hex } from "./crypto.js";
import {
  readRepositoryText,
  SYSTEM_CLOCK,
  type AppDeps,
  type AppEnv,
  type Clock,
} from "./deps.js";
import { uuidv7 } from "./ids.js";
import { idempotency } from "./idempotency.js";
import {
  actorJson,
  agentTokenJson,
  annotationJson,
  chapterJson,
  membershipJson,
  operationJson,
  page,
  projectJson,
  replyJson,
} from "./json.js";
import { problem } from "./problems.js";
import { type RebuildResult } from "./projection/rebuild.js";
import {
  clearDivergence,
  divergenceFindingsOf,
  isDiverged,
  markStaleAndRequestRefresh,
  reconcileProjection,
  type ReconcileContext,
  type ReconcileOptions,
  type ReconcileResult,
} from "./reconcile.js";
import { publicationStatusJson, registerPublicationRoutes } from "./publications.js";
import { seedProject } from "./seed.js";
import {
  clearOauthStateCookieHeader,
  oauthStateCookieHeader,
  packOauthState,
  unpackOauthState,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  clearSessionCookieHeader,
  sessionCookieHeader,
  signSessionCookieValue,
  verifySessionCookieValue,
} from "./sessions.js";
import { getCookie } from "hono/cookie";

/**
 * Body of `POST /v1/projects/{id}/divergence/clear` (Phase 5 §6). The reason
 * is mandatory and stored on the project row plus the audit event: a recovery
 * that nobody can explain later is how a divergence becomes folklore.
 */
const clearDivergenceSchema = z.strictObject({
  reason: z.string().min(1).max(2000),
  /** Re-project the repository as truth (default true). */
  resync: z.boolean().optional(),
});

/** Derived once from the domain state machine, never maintained as a UI list. */
const ACTIVE_WORK_ITEM_STATUSES = WORK_ITEM_STATUSES.filter(
  (status) => !isWorkItemTerminal(status),
);

/** The app plus the handles tests and the Worker entry need. */
export interface AuthorbotApi {
  app: Hono<AppEnv>;
  repos: Repositories;
  /** Idempotent: seed project/maintainer, then rebuild when a reader exists. */
  bootstrap(): Promise<{ project: ProjectRecord; rebuild: RebuildResult | null }>;
  /** Rebuild the projection now (null when no reader is configured). */
  rebuild(correlationId?: string): Promise<RebuildResult | null>;
  /**
   * Phase 5 §6: one reconciliation pass - classify the repository snapshot,
   * then diverge or project + re-anchor. The `ProjectCoordinator` Durable
   * Object calls this for its `refreshProjection()`; `rebuild()` is the thin
   * Phase 2-shaped wrapper over it.
   */
  reconcile(options?: Partial<ReconcileOptions>): Promise<ReconcileResult | null>;
}

/** Contract-shaped entry point: deps in, Hono app out. */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  return createApi(deps).app;
}

export function createApi(deps: AppDeps): AuthorbotApi {
  const repos = createRepositories(deps.db);
  const clock: Clock = deps.clock ?? SYSTEM_CLOCK;

  // Boot-time rule validation (Phase 3 contract §3): invalid RULES_JSON
  // throws here - never degrades to the default at runtime. Phase 6 §3.6
  // makes these the BOOTSTRAP layer: a book that declares `governance.rules`
  // in its own `book.yml` overrides them, resolved per request below.
  const bootstrapRules = parseRuleEntries(deps.config.rulesJson);

  /**
   * The rules in force for a project right now (Phase 6 §3.6). Resolved per
   * request rather than cached at boot, because "a rule edit takes effect on
   * the next vote" is a requirement - a cache would make it take effect on the
   * next deploy instead. The read is one indexed primary-key lookup on a table
   * with one row per project, inside a command that is already writing.
   */
  const rulesFor = async (projectId: string): Promise<RuleEntry[]> => {
    const row = await repos.bookConfigs.get(projectId);
    return resolveRuleEntries(row?.config ?? null, bootstrapRules);
  };

  let cachedProject: ProjectRecord | null = null;
  const getProject = async (): Promise<ProjectRecord | null> => {
    if (cachedProject === null) {
      cachedProject = await repos.projects.getBySlug(deps.config.projectSlug);
    }
    return cachedProject;
  };

  // Base path (ADR-0019 §6): re-normalized here rather than trusted, so the
  // Node dev server and tests get the same validation the Worker boot does.
  const basePath = normalizeBasePath(deps.config.basePath);

  const services: AuthServices & { repos: Repositories; clock: Clock } = {
    repos,
    clock,
    sessionSecret: deps.config.sessionSecret,
    getProject,
  };

  const reconcileCtx = (): ReconcileContext => ({ db: deps.db, repos, clock });

  /**
   * Phase 5 §6: every projection write now goes through reconciliation, which
   * classifies the snapshot before applying it. `rebuild()` keeps its Phase 2
   * signature (boot, tests, the webhook) and returns null when the pass
   * refused to project - no reader, no project, or a diverged repository.
   */
  const reconcile = async (
    options: Partial<ReconcileOptions> = {},
  ): Promise<ReconcileResult | null> => {
    const project = await getProject();
    if (project === null) {
      return null;
    }
    // Re-read: `getProject` caches, and divergence/staleness live on the row.
    const fresh = (await repos.projects.getById(project.id)) ?? project;
    cachedProject = fresh;
    return reconcileProjection(reconcileCtx(), fresh, deps.reader, {
      correlationId: options.correlationId ?? uuidv7(clock.now()),
      ...(options.acceptRepository !== undefined
        ? { acceptRepository: options.acceptRepository }
        : {}),
      ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
    });
  };

  const rebuild = async (correlationId?: string): Promise<RebuildResult | null> => {
    if (deps.reader === undefined) {
      return null;
    }
    const result = await reconcile(
      correlationId !== undefined ? { correlationId } : {},
    );
    return result?.rebuild ?? null;
  };

  const bootstrap = async (): Promise<{
    project: ProjectRecord;
    rebuild: RebuildResult | null;
  }> => {
    const project = await seedProject(repos, deps.config, clock);
    cachedProject = project;
    const result = await rebuild();
    return { project, rebuild: result };
  };

  // Every route below is registered relative to the base path (ADR-0019 §6):
  // with `API_BASE_PATH=/my-book`, `/v1/me` is served at `/my-book/v1/me`.
  // An empty base path leaves the routing table exactly as it was.
  const app = basePath === "" ? new Hono<AppEnv>() : new Hono<AppEnv>().basePath(basePath);

  // ---- cross-cutting middleware -------------------------------------------

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-correlation-id");
    const correlationId =
      incoming !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(incoming)
        ? incoming
        : uuidv7(clock.now());
    c.set("correlationId", correlationId);
    await next();
    c.res.headers.set("X-Correlation-Id", correlationId);
  });

  // No CORS middleware, by design (ADR-0019 §1): the API is same-origin with
  // the site it serves, so no `Access-Control-*` header is ever emitted and a
  // cross-origin browser request fails at the browser - the correct outcome.

  app.onError((error, c) => {
    // Never echo internals (they may contain SQL values); the correlation id
    // is the log key.
    void error;
    return problem(c as Context<AppEnv>, "internal");
  });

  app.notFound((c) => problem(c as Context<AppEnv>, "not-found"));

  const auth = requireAuth(services);
  const idem = idempotency(services);

  // One per-project serial command queue shared by the Phase 3 and Phase 4
  // command handlers (mutually serialized; see serializer.ts).
  const serialize = createProjectSerializer();

  /**
   * Anonymous read support (Phase 2b contract §2.1: "Public visibility
   * follows publication.show_public_annotations"): when the deployment sets
   * PUBLIC_ANNOTATIONS=true (the API-side mirror of the book's
   * `publication.show_public_annotations`), credential-less GETs on the
   * annotation read routes are served read-only. Requests presenting a
   * credential still go through the full auth + membership + scope checks.
   */
  const publicAnnotations = deps.config.publicAnnotations === true;
  const maybeAuth = optionalAuth(services);
  const requireReadOrPublic = async (
    c: Context<AppEnv>,
  ): Promise<{ project: ProjectRecord } | { response: Response }> => {
    if (c.get("auth") !== undefined) {
      // Kind authority is applied after rows are loaded. A mixed collection
      // may legitimately expose comments but not suggestions (or vice versa),
      // so the old umbrella cannot decide admission up front.
      return requireProjectScope(c, services, null);
    }
    if (!publicAnnotations) {
      return {
        response: problem(c, "unauthorized", { detail: "missing or invalid credential" }),
      };
    }
    const project = await getProject();
    const param = c.req.param("projectId");
    if (project === null || (param !== project.id && param !== project.slug)) {
      return { response: problem(c, "not-found", { detail: "unknown project" }) };
    }
    return { project };
  };

  const feedbackReadCapability = (
    kind: "comment" | "suggestion",
  ): "comments:read" | "suggestions:read" =>
    kind === "comment" ? "comments:read" : "suggestions:read";

  /** Exact kind read, after `requireReadOrPublic` has admitted the request. */
  const canReadFeedbackKind = (
    c: Context<AppEnv>,
    kind: "comment" | "suggestion",
  ): boolean => {
    const requestAuth = c.get("auth");
    if (requestAuth === undefined) return true;
    // An open/approval-gated policy may admit a signed-in human nonmember.
    // Reaching this point means the project guard already proved that policy.
    if (requestAuth.kind === "session" && requestAuth.membership === null) return true;
    return hasEditorialAuthority(requestAuth, "annotations:read", {
      capabilities: [feedbackReadCapability(kind)],
    });
  };

  const requireFeedbackKindRead = (
    c: Context<AppEnv>,
    kind: "comment" | "suggestion",
  ): Response | null => {
    if (canReadFeedbackKind(c, kind)) return null;
    return problem(c, "forbidden", {
      detail: `actor lacks required editorial capability "${feedbackReadCapability(kind)}"`,
    });
  };

  /**
   * Filter before forming the caller's page. Reading a raw page and filtering
   * afterward would let a denied kind consume slots and move the cursor,
   * leaking its presence while producing short or empty pages.
   */
  const listReadableAnnotations = async (
    c: Context<AppEnv>,
    chapterId: string,
    limit: number,
    afterId: string,
  ): Promise<AnnotationRecord[]> => {
    const visible: AnnotationRecord[] = [];
    let cursor = afterId;
    const batchSize = Math.max(limit, 100);
    while (visible.length < limit) {
      const batch = await repos.annotations.listByChapter(chapterId, {
        limit: batchSize,
        afterId: cursor,
      });
      if (batch.length === 0) break;
      for (const annotation of batch) {
        if (canReadFeedbackKind(c, annotation.kind)) {
          visible.push(annotation);
          if (visible.length === limit) break;
        }
      }
      if (visible.length === limit || batch.length < batchSize) break;
      cursor = batch[batch.length - 1]?.id ?? cursor;
    }
    return visible;
  };

  const now = (): string => toTimestamp(clock.now());

  /**
   * Atomic idempotency claim (contract §4): the statement claiming the key
   * and storing the response, to be batched WITH the command statements so a
   * same-key retry replays instead of re-executing (see idempotency.ts).
   */
  const claimStatements = (c: Context<AppEnv>, status: number, body: unknown): SqlStatement[] => {
    const handle = c.get("idempotency");
    if (handle === undefined) {
      return [];
    }
    handle.claimed = true;
    return [handle.claim(status, body)];
  };

  /** git_operations + outbox + audit_events rows for one 202 command. */
  const commandStatements = (input: {
    project: ProjectRecord;
    correlationId: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    outboxKind: string;
    outboxPayload: unknown;
    metadata?: unknown;
  }): { operationId: string; statements: SqlStatement[] } => {
    const operationId = uuidv7(clock.now());
    const timestamp = now();
    return {
      operationId,
      statements: [
        repos.gitOperations.insertStatement({
          id: operationId,
          projectId: input.project.id,
          correlationId: input.correlationId,
          expectedHead: null,
          state: "queued",
          attempts: 0,
          commitSha: null,
          error: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
        repos.outbox.insertStatement({
          id: uuidv7(clock.now()),
          projectId: input.project.id,
          gitOperationId: operationId,
          kind: input.outboxKind,
          payload: input.outboxPayload,
          status: "pending",
          attempts: 0,
          createdAt: timestamp,
          processedAt: null,
        }),
        repos.auditEvents.insertStatement({
          id: uuidv7(clock.now()),
          projectId: input.project.id,
          actorId: input.actorId,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          correlationId: input.correlationId,
          metadata: input.metadata ?? null,
          createdAt: timestamp,
        }),
      ],
    };
  };

  const notifyMutation = async (projectId: string): Promise<void> => {
    // MIRROR_MODE=queue (Phase 2 contract §5): outbox rows are recorded but
    // not drained here - a later drain (the coordinator alarm, or a manual
    // `InlineMirror.drain`) picks them up. `inline` drains in-process;
    // `durable` (Phase 5 contract §5) asks the project's Durable Object to
    // drain now that the batch has committed. Both go through the same hook.
    if (deps.onMutationCommitted === undefined || deps.config.mirrorMode === "queue") {
      return;
    }
    try {
      await deps.onMutationCommitted(projectId);
    } catch {
      // The mirror processor failing must not fail the 202 - the operation
      // remains observable via GET .../operations/{operationId}.
    }
  };

  /** Markdown safety findings for a body (Phase 0 rules; contract §4). */
  const bodySafetyFindings = (body: string): string[] => {
    const scan = scanSafety(parseChapterMarkdown(body).ast);
    const findings: string[] = [];
    if (scan.rawHtml.length > 0) {
      findings.push("raw HTML is forbidden in annotation bodies");
    }
    for (const url of scan.forbiddenUrls) {
      findings.push(`URL scheme "${url.scheme}" is forbidden`);
    }
    return findings;
  };

  const readJson = async (c: Context<AppEnv>): Promise<unknown | Response> => {
    // Require a JSON content type before parsing (defense in depth): a
    // cross-site `text/plain` "simple request" is exactly the shape that
    // crosses origins without a preflight, so a JSON handler must never
    // accept one. With CORS removed (ADR-0019) the browser blocks the
    // response regardless; this keeps the request from being processed.
    const contentType = c.req.header("content-type") ?? "";
    if (!/^application\/json\s*(;|$)/i.test(contentType.trim())) {
      return problem(c, "bad-request", {
        detail: "request body must be application/json",
      });
    }
    try {
      return (await c.req.json()) as unknown;
    } catch {
      return problem(c, "bad-request", { detail: "request body must be valid JSON" });
    }
  };

  const parseLimit = (c: Context<AppEnv>): number | Response => {
    const raw = c.req.query("limit");
    if (raw === undefined) {
      return 50;
    }
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return problem(c, "validation-failed", { detail: "limit must be an integer in 1..200" });
    }
    return limit;
  };

  // ---- health --------------------------------------------------------------

  /**
   * Whether this deployment can actually do the work it was set up to do.
   *
   * Unauthenticated on purpose, because the one caller that most needs it has
   * no credential: `create-authorbot` finishes by checking the API before it
   * switches a book's collaboration controls on, and it makes that check as an
   * anonymous stranger.
   *
   * Without this, the only signal available was "does /v1/me refuse me?" - and
   * a Worker with no usable GitHub App refuses anonymous callers exactly as
   * correctly as a healthy one. That is how a release shipped in which
   * collaboration was switched on over an integration that could not commit,
   * could not project, and could not read the book's own book.yml: every
   * read-only route answered perfectly, so the wizard reported success.
   *
   * A status word and nothing else. No credential, no configuration, no
   * identifier: `gitIntegration` says whether the app is usable, never what it
   * is. That is the whole reason this can be public.
   */
  app.get("/v1/health", async (c) => {
    return c.json({
      status: "ok",
      gitIntegration: deps.config.gitIntegration ?? "unconfigured",
    });
  });

  // ---- identity ------------------------------------------------------------

  app.get("/v1/me", auth, async (c) => {
    const a = authOf(c);
    return c.json({
      actor: actorJson(a.actor),
      memberships: a.membership !== null ? [membershipJson(a.membership)] : [],
      scopes: a.scopes,
      authKind: a.kind,
      ...capabilityProjectionJson(a),
    });
  });

  app.get("/v1/projects/:projectId", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "chapters:read", {
      editorial: { capabilities: ["chapters:read"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    // `gitIntegration` (Phase 5 contract §2) makes the degraded state
    // visible: `unconfigured` is a deployment with no GitHub App, where
    // reads work and mutations queue rather than commit. Status only - no
    // credential value is ever exposed.
    //
    // Phase 5 §6 adds the rest of the operator's picture: whether the
    // projection is behind the repository, whether the repository diverged,
    // and - the design §17.3 point - whether what is DEPLOYED is what was
    // integrated. Read the row fresh rather than using the cached one: all
    // three move without a request ever touching this handler.
    const project = (await repos.projects.getById(guard.project.id)) ?? guard.project;
    const [latest, latestDeployed] = await Promise.all([
      repos.publications.getLatest(project.id),
      repos.publications.getLatestDeployed(project.id),
    ]);
    const findings = divergenceFindingsOf(project);
    return c.json({
      ...projectJson(project),
      gitIntegration: deps.config.gitIntegration ?? "unconfigured",
      projection: {
        commit: project.projectedCommit,
        stale: project.projectionStale,
      },
      divergence: isDiverged(project)
        ? {
            state: "diverged",
            divergedAt: project.divergedAt,
            kinds: [...new Set(findings.map((f) => f.kind))].sort(),
            chapters: findings.map((f) => ({
              chapterId: f.chapterId,
              path: f.chapterPath,
              kind: f.kind,
              projectedRevision: f.projectedRevision,
              snapshotRevision: f.snapshotRevision,
            })),
          }
        : { state: "ok" },
      publication: publicationStatusJson(project, latest, latestDeployed),
    });
  });

  /**
   * Divergence recovery (Phase 5 §6). Maintainer-only, audited, and - by
   * default - resynchronizing: clearing the flag alone would leave the
   * projection and the repository still disagreeing, so the very next push
   * would diverge again. `resync` (default true) accepts the repository as
   * truth, re-projects it, and re-anchors, which is the only action that
   * actually ends the divergence. `resync: false` exists for the maintainer
   * who intends to fix the repository instead and just wants writes open.
   */
  app.post("/v1/projects/:projectId/divergence/clear", auth, async (c) => {
    const sessionOnly = requireHumanSession(c);
    if (sessionOnly !== null) return sessionOnly;
    const guard = await requireProjectScope(c, services, "chapters:read");
    if ("response" in guard) {
      return guard.response;
    }
    const a = authOf(c);
    if (a.role !== "maintainer") {
      return problem(c, "forbidden", { detail: "only a maintainer may clear divergence" });
    }
    const body = await readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = clearDivergenceSchema.safeParse(body);
    if (!parsed.success) {
      return problem(c, "validation-failed", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const project = (await repos.projects.getById(guard.project.id)) ?? guard.project;
    if (!isDiverged(project)) {
      return problem(c, "state-conflict", { detail: "project is not diverged" });
    }
    const outcome = await clearDivergence(reconcileCtx(), project, {
      reason: parsed.data.reason,
      actorId: a.actor.id,
      correlationId: c.get("correlationId"),
    });
    cachedProject = null;
    let resync: ReconcileResult | null = null;
    if (parsed.data.resync !== false) {
      resync = await reconcile({
        correlationId: c.get("correlationId"),
        acceptRepository: true,
      });
    }
    return c.json({
      cleared: outcome.cleared,
      clearedFindings: outcome.priorFindings,
      resync:
        resync === null
          ? null
          : {
              outcome: resync.outcome,
              rebuild: resync.rebuild,
              reanchored: resync.reanchored,
              projectedCommit: resync.projectedCommit,
            },
    });
  });

  app.get("/v1/projects/:projectId/members", auth, async (c) => {
    const sessionOnly = requireHumanSession(c);
    if (sessionOnly !== null) return sessionOnly;
    const guard = await requireProjectScope(c, services, "chapters:read");
    if ("response" in guard) {
      return guard.response;
    }
    const limit = parseLimit(c);
    if (limit instanceof Response) {
      return limit;
    }
    const cursor = c.req.query("cursor") ?? "";
    const memberships = (await repos.projectMemberships.listByProject(guard.project.id))
      .filter((m) => m.revokedAt === null && m.id > cursor)
      .slice(0, limit);
    const actors = new Map<string, Record<string, unknown>>();
    for (const membership of memberships) {
      const actor = await repos.actors.getById(membership.actorId);
      if (actor !== null) {
        actors.set(membership.actorId, actorJson(actor));
      }
    }
    const body = page(memberships, limit, (m) => ({
      ...membershipJson(m),
      actor: actors.get(m.actorId) ?? null,
    }));
    return c.json(body);
  });

  // ---- agent tokens (maintainer) --------------------------------------------

  const mintIdem = idempotency(services, {
    redactStored: (body) => {
      if (typeof body === "object" && body !== null && "token" in body) {
        const { token: _token, ...rest } = body as Record<string, unknown>;
        return { ...rest, tokenRedacted: true };
      }
      return body;
    },
  });

  app.post("/v1/projects/:projectId/agent-tokens", auth, mintIdem, async (c) => {
    const sessionOnly = requireHumanSession(c);
    if (sessionOnly !== null) {
      return sessionOnly;
    }
    /**
     * CONTROL surface (Phase 7): a freeze must not block this.
     *
     * access-control.ts is explicit that "stop everything while I look" is
     * precisely the moment an author needs to revoke a token - and revoking the
     * leaked credential their agents were using is worth very little if they
     * cannot then mint the replacement those agents need to keep running. The
     * freeze already stops everything those credentials could DO; refusing to
     * issue one adds no safety and turns a freeze into an outage.
     */
    const guard = await requireProjectScope(c, services, "tokens:manage", {
      surface: "control",
    });
    if ("response" in guard) {
      return guard.response;
    }
    const body = await readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = mintAgentTokenApiCommandSchema.safeParse(body);
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const command = parsed.data;
    const expiry = resolveTokenExpiry(clock.now(), command.expiresInDays);
    if (!expiry.ok) {
      return problem(c, "validation-failed", { detail: "expiresInDays must be in 1..90" });
    }

    const a = authOf(c);
    const timestamp = now();
    const agentActorId = uuidv7(clock.now());
    const tokenId = uuidv7(clock.now());
    const plaintext = `${AGENT_TOKEN_PREFIX}${randomBase64Url(32)}`;
    const tokenHash = await sha256Hex(plaintext);
    const canonical = command.authorizationMode === "canonical";
    const capabilities = canonical ? command.capabilities : null;
    const tokenScopes = canonical
      ? legacyScopeShadow(command.capabilities)
      : command.scopes;

    const tokenRecord: AgentTokenRecord = {
      id: tokenId,
      projectId: guard.project.id,
      actorId: agentActorId,
      name: command.name,
      tokenHash,
      scopes: [...tokenScopes],
      capabilitiesV2: capabilities === null ? null : [...capabilities],
      capabilityMode: canonical ? "canonical" : "legacy",
      createdBy: a.actor.id,
      createdAt: timestamp,
      expiresAt: expiry.expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    };

    const projection = tokenCapabilityProjection(tokenRecord, "editor");
    const responseBody = {
      ...agentTokenJson(tokenRecord),
      ...capabilityProjectionJson(projection),
      token: plaintext,
    };
    const statements: SqlStatement[] = [
      repos.actors.insertStatement({
        id: agentActorId,
        type: "agent",
        displayName: command.name,
        externalIdentity: `agent:${agentActorId}`,
        ownerActorId: a.actor.id,
        status: "active",
        createdAt: timestamp,
      }),
      // Agent memberships are pinned to `editor`: token scopes are the real
      // control, and an agent can never hold tokens:manage / members:manage
      // (effective scopes = token ∩ role bundle, contract §3).
      repos.projectMemberships.insertStatement({
        id: uuidv7(clock.now()),
        projectId: guard.project.id,
        actorId: agentActorId,
        role: "editor",
        scopes: [...apiRoleScopes("editor")],
        createdAt: timestamp,
        revokedAt: null,
      }),
      repos.agentTokens.insertStatement(tokenRecord),
      // Phase 7 contract "Seeing": collaborators are listed with "who added
      // them". Minting is the one place a membership is granted BY someone
      // rather than self-served, so it is the one place that fact exists to be
      // recorded - and an agent appearing in the collaborator list with no
      // visible owner is exactly the thing an author is vetting for.
      repos.auditEvents.insertStatement({
        id: uuidv7(clock.now()),
        projectId: guard.project.id,
        actorId: a.actor.id,
        action: "member.add",
        targetType: "membership",
        targetId: agentActorId,
        correlationId: c.get("correlationId"),
        metadata: { role: "editor", via: "agent_token.mint", tokenId },
        createdAt: timestamp,
      }),
      repos.auditEvents.insertStatement({
        id: uuidv7(clock.now()),
        projectId: guard.project.id,
        actorId: a.actor.id,
        action: "agent_token.mint",
        targetType: "agent_token",
        targetId: tokenId,
        correlationId: c.get("correlationId"),
        metadata: {
          name: command.name,
          capabilityMode: tokenRecord.capabilityMode,
          capabilities: projection.grantedCapabilities,
          legacyScopes: tokenRecord.scopes,
          expiresAt: expiry.expiresAt,
        },
        createdAt: timestamp,
      }),
    ];
    // Atomic idempotency claim (stored body is redacted - never the token):
    // a same-key retry can never mint a second actor/token pair.
    statements.push(...claimStatements(c, 201, responseBody));
    await deps.db.batch(statements);

    return c.json(responseBody, 201);
  });

  app.put(
    "/v1/projects/:projectId/agent-tokens/:tokenId/capabilities",
    auth,
    idem,
    async (c) => {
      const sessionOnly = requireHumanSession(c);
      if (sessionOnly !== null) {
        return sessionOnly;
      }
      const guard = await requireProjectScope(c, services, "tokens:manage", {
        surface: "control",
      });
      if ("response" in guard) {
        return guard.response;
      }
      const body = await readJson(c);
      if (body instanceof Response) {
        return body;
      }
      const parsed = replaceAgentTokenCapabilitiesApiCommandSchema.safeParse(body);
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }

      return serialize(guard.project.id, async () => {
        const token = await repos.agentTokens.getById(c.req.param("tokenId"));
        if (token === null || token.projectId !== guard.project.id) {
          return problem(c, "not-found", { detail: "unknown agent token" });
        }
        if (
          token.revokedAt !== null ||
          Date.parse(token.expiresAt) <= clock.now().getTime()
        ) {
          return problem(c, "state-conflict", {
            detail: "only an active agent token's capabilities can be changed",
          });
        }

        const membership = await repos.projectMemberships.getByProjectAndActor(
          guard.project.id,
          token.actorId,
        );
        const role = membership?.revokedAt === null ? membership.role : null;
        const before = tokenCapabilityProjection(token, role);
        const capabilities = parsed.data.capabilities;
        const scopes = legacyScopeShadow(capabilities);
        const updated: AgentTokenRecord = {
          ...token,
          scopes: [...scopes],
          capabilitiesV2: [...capabilities],
          capabilityMode: "canonical",
        };
        const after = tokenCapabilityProjection(updated, role);
        const responseBody = {
          ...agentTokenJson(updated),
          ...capabilityProjectionJson(after),
          role,
        };
        const timestamp = now();
        try {
          await deps.db.batch([
            repos.agentTokens.setCapabilityStateCasStatement(
              token.id,
              {
                scopes: token.scopes,
                capabilitiesV2: token.capabilitiesV2 ?? null,
                capabilityMode: token.capabilityMode ?? "legacy",
              },
              {
                scopes,
                capabilitiesV2: capabilities,
                capabilityMode: "canonical",
              },
              timestamp,
            ),
            repos.auditEvents.insertStatement({
              id: uuidv7(clock.now()),
              projectId: guard.project.id,
              actorId: authOf(c).actor.id,
              action: "agent_token.capabilities.update",
              targetType: "agent_token",
              targetId: token.id,
              correlationId: c.get("correlationId"),
              metadata: {
                before: {
                  capabilityMode: before.capabilityMode,
                  capabilities: before.grantedCapabilities,
                  legacyEffectiveActions: before.legacyEffectiveActions,
                  legacyScopes: token.scopes,
                },
                after: {
                  capabilityMode: after.capabilityMode,
                  capabilities: after.grantedCapabilities,
                  legacyEffectiveActions: after.legacyEffectiveActions,
                  legacyScopes: updated.scopes,
                },
              },
              createdAt: timestamp,
            }),
            ...claimStatements(c, 200, responseBody),
          ]);
        } catch (error) {
          if (!isConstraintError(error)) throw error;
          const fresh = await repos.agentTokens.getById(token.id);
          if (fresh === null || fresh.projectId !== guard.project.id) {
            return problem(c, "not-found", { detail: "unknown agent token" });
          }
          if (
            fresh.revokedAt !== null ||
            Date.parse(fresh.expiresAt) <= clock.now().getTime()
          ) {
            return problem(c, "state-conflict", {
              detail: "only an active agent token's capabilities can be changed",
            });
          }
          const stateUnchanged =
            fresh.capabilityMode === token.capabilityMode &&
            JSON.stringify(fresh.scopes) === JSON.stringify(token.scopes) &&
            JSON.stringify(fresh.capabilitiesV2 ?? null) ===
              JSON.stringify(token.capabilitiesV2 ?? null);
          if (stateUnchanged) throw error;
          return problem(c, "state-conflict", {
            detail: "agent token capabilities changed concurrently; refresh and retry",
          });
        }
        return c.json(responseBody, 200);
      });
    },
  );

  app.delete("/v1/projects/:projectId/agent-tokens/:tokenId", auth, idem, async (c) => {
    const sessionOnly = requireHumanSession(c);
    if (sessionOnly !== null) {
      return sessionOnly;
    }
    /**
     * CONTROL surface: access-control.ts names "revoke a token" as one of the
     * things a freeze must not refuse. Before this it was the only one that
     * did - `agent-tokens/revoke-all` answered 200 under a freeze while
     * revoking ONE token answered 423, so an author looking at a single leaked
     * credential could either burn every agent they had or nothing at all.
     */
    const guard = await requireProjectScope(c, services, "tokens:manage", {
      surface: "control",
    });
    if ("response" in guard) {
      return guard.response;
    }
    const token = await repos.agentTokens.getById(c.req.param("tokenId"));
    if (token === null || token.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown agent token" });
    }
    const timestamp = now();
    /**
     * Phase 7 contract "Revoking": revoking a token takes effect on the NEXT
     * REQUEST and must release the holder's lease, reject their in-flight
     * submissions, and invalidate their sessions - while leaving everything
     * they already contributed in place.
     *
     * Before this phase the route flipped `revoked_at` and stopped. That did
     * stop the token authenticating, but it left any work item the agent held
     * stranded `leased` until its lease timed out - up to four hours, which is
     * the exact number the contract names as unacceptable.
     */
    const cascade = await revocationCascadeStatements({
      deps,
      repos,
      clock,
      projectId: guard.project.id,
      actorId: token.actorId,
      at: timestamp,
    });
    await deps.db.batch([
      repos.agentTokens.revokeStatement(token.id, timestamp),
      ...cascade.statements,
      repos.auditEvents.insertStatement({
        id: uuidv7(clock.now()),
        projectId: guard.project.id,
        actorId: authOf(c).actor.id,
        action: "agent_token.revoke",
        targetType: "agent_token",
        targetId: token.id,
        correlationId: c.get("correlationId"),
        metadata: {
          leasesReleased: cascade.releasedLeases.length,
          submissionsRejected: cascade.rejectedSubmissions.length,
        },
        createdAt: timestamp,
      }),
      ...claimStatements(c, 204, null),
    ]);
    return c.body(null, 204);
  });

  // ---- chapters --------------------------------------------------------------

  app.get("/v1/projects/:projectId/chapters", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "chapters:read", {
      editorial: { capabilities: ["chapters:read"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const limit = parseLimit(c);
    if (limit instanceof Response) {
      return limit;
    }
    const cursor = c.req.query("cursor") ?? "";
    const summaryPage = await repos.chapters.listSummariesByProject(
      guard.project.id,
      ACTIVE_WORK_ITEM_STATUSES,
      { limit, afterId: cursor },
    );
    const requestAuth = authOf(c);
    const canReadComments = hasEditorialAuthority(requestAuth, "annotations:read", {
      capabilities: ["comments:read"],
    });
    const canReadSuggestions = hasEditorialAuthority(requestAuth, "annotations:read", {
      capabilities: ["suggestions:read"],
    });
    const canReadWork = hasEditorialAuthority(requestAuth, "work:read", {
      capabilities: ["work:read"],
    });
    return c.json({
      items: summaryPage.items.map(({ chapter, activity }) => ({
        ...chapterJson(chapter),
        activity: {
          ...(canReadSuggestions
            ? {
                openSuggestions: activity.openSuggestions,
              }
            : {}),
          ...(canReadComments
            ? {
                openBlockComments: activity.openBlockComments,
                openChapterComments: activity.openChapterComments,
              }
            : {}),
          ...(canReadComments || canReadSuggestions
            ? {
                openReplies:
                  (canReadComments ? activity.openCommentReplies : 0) +
                  (canReadSuggestions ? activity.openSuggestionReplies : 0),
              }
            : {}),
          ...(canReadWork ? { openWorkItems: activity.openWorkItems } : {}),
        },
      })),
      nextCursor: summaryPage.hasMore
        ? (summaryPage.items[summaryPage.items.length - 1]?.chapter.id ?? null)
        : null,
    });
  });

  app.get("/v1/projects/:projectId/chapters/:chapterId", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "chapters:read", {
      editorial: { capabilities: ["chapters:read"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const chapter = await repos.chapters.getById(c.req.param("chapterId"));
    if (chapter === null || chapter.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown chapter" });
    }
    return c.json(chapterJson(chapter));
  });

  /**
   * A chapter's prose, marker-free, for the §3.5 composer.
   *
   * "Editing an existing chapter uses the same composer" - but the revise half
   * of `POST /v1/projects/{p}/chapter-submissions` requires a COMPLETE
   * replacement body plus the current `baseRevision`, and nothing in the API
   * let an editor read the current prose to populate that form. A revise had to
   * be written blind or sourced out-of-band from Git, which is the exact
   * problem Phase 6 exists to remove. The Phase 4 TaskBundle is not a
   * substitute: it is gated behind claiming a work item with a lease, and it
   * returns the raw file including block markers.
   *
   * Canonical credentials need `chapters:read`; legacy credentials keep the
   * historical `submissions:write` gate. The response is marker-stripped so
   * the body a client sends back is the body a human edited - marker reuse for
   * unchanged blocks is `applyChapterReplacement`'s job at drain time, not the
   * client's.
   */
  app.get("/v1/projects/:projectId/chapters/:chapterId/source", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "submissions:write", {
      editorial: { capabilities: ["chapters:read"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const chapter = await repos.chapters.getById(c.req.param("chapterId"));
    if (chapter === null || chapter.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown chapter" });
    }
    const read = await readRepositoryText(deps, guard.project.id, chapter.path);
    if (read.outcome === "unavailable") {
      return problem(c, "state-conflict", {
        detail:
          "this deployment has no repository reader configured, so chapter source cannot be read",
      });
    }
    if (read.outcome === "not-found") {
      return problem(c, "not-found", { detail: "chapter source not found at the branch head" });
    }
    const source = read.source;
    const parsed = parseChapterMarkdown(source);
    const fm = chapterFrontmatterSchema.safeParse(parsed.frontmatter);
    if (!fm.success) {
      return problem(c, "internal", {
        detail: "the chapter at the branch head does not have valid frontmatter",
      });
    }
    return c.json({
      chapterId: chapter.id,
      title: fm.data.title,
      summary: fm.data.summary ?? null,
      /** Send this straight back as `baseRevision` on the revise. */
      revision: fm.data.revision,
      /** Bind a revision proposal to these exact repository bytes. */
      contentHash: `sha256:${await sha256Hex(source)}`,
      status: fm.data.status,
      /**
       * Markdown as an author wrote it: no frontmatter, no marker syntax.
       * Trimmed of the blank lines the file format puts around the body, so
       * what a composer loads is what a composer would have saved - leading
       * and trailing blank lines carry no meaning in Markdown, and leaving
       * them in would make an untouched round trip look like an edit.
       */
      body: stripBlockMarkers(chapterBodyOf(source)).trim(),
      correlationId: c.get("correlationId"),
    });
  });

  /** A chapter file's prose, with the frontmatter block removed. */
  function chapterBodyOf(source: string): string {
    const normalized = source.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) return normalized;
    const close = normalized.indexOf("\n---\n", 3);
    return close === -1 ? normalized : normalized.slice(close + 5);
  }

  // ---- annotations -------------------------------------------------------------

  app.get("/v1/projects/:projectId/chapters/:chapterId/annotations", maybeAuth, async (c) => {
    const guard = await requireReadOrPublic(c);
    if ("response" in guard) {
      return guard.response;
    }
    const chapter = await repos.chapters.getById(c.req.param("chapterId"));
    if (chapter === null || chapter.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown chapter" });
    }
    const limit = parseLimit(c);
    if (limit instanceof Response) {
      return limit;
    }
    const cursor = c.req.query("cursor") ?? "";
    const annotations = await listReadableAnnotations(c, chapter.id, limit, cursor);
    // Phase 3 contract §2/§6: embed aggregate vote tallies (public: counts
    // only) plus the create_work_item decision badge; members also see their
    // own current vote (`myVote`). The member actor id is null for anonymous
    // readers and authenticated nonmembers.
    const requestAuth = c.get("auth");
    const viewerActorId = requestAuth?.actor.id ?? null;
    // Signed-in non-members may read annotations on open/approval-gated books,
    // but member-only decision prose and `myVote` stay behind membership.
    const memberActorId =
      requestAuth !== undefined && requestAuth.membership !== null
        ? requestAuth.actor.id
        : null;
    const items = await Promise.all(
      annotations.map((a) => annotationCollabJson(repos, a, memberActorId)),
    );
    const last = annotations[annotations.length - 1];

    /**
     * Phase 7 contract "Moderating": "A pending annotation is visible to its
     * author (badged as awaiting review) and to maintainers. It is invisible to
     * everyone else."
     *
     * Queued rows live in their own table and are merged in HERE rather than
     * being filtered out downstream, which is the safe direction: the default
     * for a reader who is neither the author nor a maintainer is that the row
     * was never fetched at all, so no future change to the serializer can leak
     * one. They are returned in a separate `pending` array rather than mixed
     * into `items` for the same reason - a client that knows nothing about
     * moderation cannot accidentally render an unapproved comment as an
     * approved one, and cursor paging over `items` stays a paging over real
     * annotations.
     */
    const canModerate =
      requestAuth !== undefined &&
      hasEditorialAuthority(requestAuth, "annotations:write", {
        capabilities: ["feedback:moderate"],
        legacyAction: "feedback:moderate",
      });
    let pending: Record<string, unknown>[] = [];
    if (viewerActorId !== null) {
      const queued = await repos.pendingAnnotations.listPendingByChapter(chapter.id);
      pending = queued
        .filter(
          (row) =>
            (canModerate || row.authorActorId === viewerActorId) &&
            canReadFeedbackKind(c, row.kind),
        )
        .map(pendingAnnotationJson);
    }

    return c.json({
      items,
      pending,
      nextCursor: annotations.length === limit && last !== undefined ? last.id : null,
    });
  });

  // Single-annotation read with the same collaboration embedding (contract
  // §2: "annotation list/get responses"). Anonymous read follows the same
  // public-annotations gate as the list.
  app.get("/v1/projects/:projectId/annotations/:annotationId", maybeAuth, async (c) => {
    const guard = await requireReadOrPublic(c);
    if ("response" in guard) {
      return guard.response;
    }
    const annotation = await repos.annotations.getById(c.req.param("annotationId"));
    if (annotation === null || annotation.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown annotation" });
    }
    const denied = requireFeedbackKindRead(c, annotation.kind);
    if (denied !== null) return denied;
    const requestAuth = c.get("auth");
    const memberActorId =
      requestAuth !== undefined && requestAuth.membership !== null
        ? requestAuth.actor.id
        : null;
    return c.json(await annotationCollabJson(repos, annotation, memberActorId));
  });

  app.post(
    "/v1/projects/:projectId/chapters/:chapterId/annotations",
    auth,
    idem,
    async (c) => {
      const body = await readJson(c);
      if (body instanceof Response) {
        return body;
      }
      const parsed = createAnnotationCommandSchema.safeParse(
        typeof body === "object" && body !== null
          ? { ...body, chapterId: c.req.param("chapterId") }
          : body,
      );
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }
      const command = parsed.data;
      const writeCapability =
        command.kind === "comment" ? "comments:write" : "suggestions:write";
      const guard = await requireProjectScope(c, services, "annotations:write", {
        editorial: { capabilities: ["chapters:read", writeCapability] },
      });
      if ("response" in guard) {
        return guard.response;
      }

      const findings = bodySafetyFindings(command.body);
      if (findings.length > 0) {
        return problem(c, "unsafe-content", { findings });
      }

      const chapter = await repos.chapters.getById(command.chapterId);
      if (chapter === null || chapter.projectId !== guard.project.id) {
        return problem(c, "not-found", { detail: "unknown chapter" });
      }
      if (command.chapterRevision !== chapter.revision) {
        return problem(c, "revision-conflict", {
          detail: `chapterRevision ${command.chapterRevision} does not match projected revision ${chapter.revision}`,
          projectedRevision: chapter.revision,
        });
      }
      if (command.scope !== "chapter") {
        // Contract §4 (unconditional): the blockId must exist in the
        // projected revision. Block ids are persisted on the chapter row by
        // the rebuild, so this check works from the DB alone - including on
        // reader-less instances sharing a DB a reader-ful instance rebuilt.
        if (!chapter.blockIds.includes(command.target.blockId)) {
          return problem(c, "unknown-block", {
            detail: `block ${command.target.blockId} does not exist in chapter revision ${chapter.revision}`,
          });
        }
      }

      const a = authOf(c);
      const annotationId = uuidv7(clock.now());
      const correlationId = c.get("correlationId");
      const timestamp = now();

      /**
       * Phase 7 contract "Moderating" - the whole point of `approval-gated`.
       *
       * "Pending annotations are not mirrored to Git. They live in the
       * operational database until approved. Committing unreviewed submissions
       * to the permanent record would put spam in the book's history forever,
       * where removing it means rewriting history."
       *
       * So this branch writes ONE row into `pending_annotations` and nothing
       * else: no `git_operations` row, no `outbox` row, no `annotations` row,
       * no `annotation_created` event. Everything that could carry the comment
       * toward a commit is simply not created, rather than created and
       * suppressed - the difference matters, because a suppressed outbox row is
       * one bug away from being drained.
       *
       * The three properties exit criterion 10 asks for follow structurally
       * rather than by enforcement: no votes (the `votes` foreign key points at
       * `annotations`, which this row is not in), no rule can fire (the engine
       * evaluates tallies over `annotations`), and no Git trace (there is no
       * operation to commit).
       *
       * Maintainers bypass the queue. "After a maintainer approves" describes
       * everyone else; asking an author to approve their own margin notes would
       * make `approval-gated` unusable for the person who chose it.
       */
      const access = "access" in guard && guard.access !== undefined
        ? guard.access
        : await loadAccessState(repos, guard.project.id);
      if (access.requiresApproval && a.role !== "maintainer") {
        const responseBody = {
          pendingId: annotationId,
          annotationId: null,
          status: "pending_review",
          /** Said plainly so a client can badge it without inferring. */
          moderation: {
            state: "pending",
            message:
              "this book reviews contributions before they appear. Your comment is visible to you and to the book's maintainers until one of them approves it.",
          },
          correlationId,
        };
        await deps.db.batch([
          repos.pendingAnnotations.insertStatement({
            id: annotationId,
            projectId: guard.project.id,
            chapterId: chapter.id,
            kind: command.kind,
            scope: command.scope,
            chapterRevision: command.chapterRevision,
            target: command.scope === "chapter" ? null : command.target,
            authorActorId: a.actor.id,
            body: command.body,
            status: "pending",
            reviewedByActorId: null,
            reviewedAt: null,
            rejectionReason: null,
            approvedAnnotationId: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
          // The submission itself is audited even though it is not published:
          // "a pattern of abuse is visible" needs the attempts recorded, not
          // only the moderator's verdicts.
          repos.auditEvents.insertStatement({
            id: uuidv7(clock.now()),
            projectId: guard.project.id,
            actorId: a.actor.id,
            action: "annotation.queued",
            targetType: "annotation",
            targetId: annotationId,
            correlationId,
            metadata: { kind: command.kind, scope: command.scope, chapterId: chapter.id },
            createdAt: timestamp,
          }),
          ...claimStatements(c, 202, responseBody),
        ]);
        // Deliberately NO notifyMutation: there is no outbox row to drain, and
        // waking the mirror for a write that must never reach Git would be, at
        // best, a lie to the operator reading the drain logs.
        return c.json(responseBody, 202);
      }

      const command202 = commandStatements({
        project: guard.project,
        correlationId,
        actorId: a.actor.id,
        action: "annotation.create",
        targetType: "annotation",
        targetId: annotationId,
        outboxKind: "annotation.create",
        outboxPayload: {
          type: "annotation.create",
          annotationId,
          chapterId: chapter.id,
          actorRef: a.actorRef,
        },
        metadata: { kind: command.kind, scope: command.scope, chapterId: chapter.id },
      });

      const responseBody = {
        operationId: command202.operationId,
        annotationId,
        correlationId,
        status: "queued",
      };
      await deps.db.batch([
        command202.statements[0] as SqlStatement, // git operation first (FK)
        repos.annotations.insertStatement({
          id: annotationId,
          projectId: guard.project.id,
          chapterId: chapter.id,
          kind: command.kind,
          scope: command.scope,
          chapterRevision: command.chapterRevision,
          target: command.scope === "chapter" ? null : command.target,
          authorActorId: a.actor.id,
          body: command.body,
          status: "pending_git",
          gitOperationId: command202.operationId,
          supersededBy: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
        ...command202.statements.slice(1),
        // Live feed (contract §5): a second viewer sees a newly created
        // suggestion appear without a manual reload.
        repos.events.appendStatement({
          projectId: guard.project.id,
          type: "annotation_created",
          payload: {
            annotationId,
            chapterId: chapter.id,
            kind: command.kind,
            scope: command.scope,
          },
          createdAt: timestamp,
        }),
        ...claimStatements(c, 202, responseBody),
      ]);
      await notifyMutation(guard.project.id);

      return c.json(responseBody, 202);
    },
  );

  // Threaded replies list (contract §2.3/§5: "reply → reload → both persist
  // (API-backed)") - the read complement of the POST below, same page
  // envelope as the annotations list. Anonymous read follows the same
  // public-annotations gate as the annotations list.
  app.get("/v1/projects/:projectId/annotations/:annotationId/replies", maybeAuth, async (c) => {
    const guard = await requireReadOrPublic(c);
    if ("response" in guard) {
      return guard.response;
    }
    const annotation = await repos.annotations.getById(c.req.param("annotationId"));
    if (annotation === null || annotation.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown annotation" });
    }
    const denied = requireFeedbackKindRead(c, annotation.kind);
    if (denied !== null) return denied;
    const limit = parseLimit(c);
    if (limit instanceof Response) {
      return limit;
    }
    const cursor = c.req.query("cursor");
    const replies = await repos.replies.listByAnnotation(annotation.id, {
      limit,
      ...(cursor !== undefined ? { afterId: cursor } : {}),
    });
    return c.json(page(replies, limit, replyJson));
  });

  app.post("/v1/projects/:projectId/annotations/:annotationId/replies", auth, idem, async (c) => {
    const body = await readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = createReplyCommandSchema.safeParse(
      typeof body === "object" && body !== null
        ? { ...body, annotationId: c.req.param("annotationId") }
        : body,
    );
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const command = parsed.data;

    const findings = bodySafetyFindings(command.body);
    if (findings.length > 0) {
      return problem(c, "unsafe-content", { findings });
    }

    const annotation = await repos.annotations.getById(command.annotationId);
    if (annotation === null) {
      return problem(c, "not-found", { detail: "unknown annotation" });
    }
    const parentReadCapability = feedbackReadCapability(annotation.kind);
    const requirements = {
      capabilities: ["replies:write", parentReadCapability],
    } as const;
    if (!hasEditorialAuthority(authOf(c), "annotations:write", requirements)) {
      return problem(c, "forbidden", {
        detail:
          "actor lacks required editorial capabilities: replies:write, " +
          parentReadCapability,
      });
    }
    // `requireMembership` (Phase 7): a permissive annotation policy widens who
    // may START a thread, not who may join one - see ProjectGuardOptions.
    const guard = await requireProjectScope(c, services, "annotations:write", {
      requireMembership: true,
      editorial: requirements,
    });
    if ("response" in guard) {
      return guard.response;
    }
    if (annotation.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown annotation" });
    }
    if (annotation.status !== "open" && annotation.status !== "pending_git") {
      return problem(c, "domain-rule-failed", {
        detail: `cannot reply to an annotation with status "${annotation.status}"`,
      });
    }
    if (command.parentReplyId !== undefined) {
      const parent = await repos.replies.getById(command.parentReplyId);
      if (parent === null || parent.annotationId !== annotation.id) {
        return problem(c, "domain-rule-failed", {
          detail: "parentReplyId does not reference a reply on this annotation",
        });
      }
    }

    const a = authOf(c);
    const replyId = uuidv7(clock.now());
    const correlationId = c.get("correlationId");
    const timestamp = now();
    const command202 = commandStatements({
      project: guard.project,
      correlationId,
      actorId: a.actor.id,
      action: "reply.create",
      targetType: "reply",
      targetId: replyId,
      outboxKind: "reply.create",
      outboxPayload: {
        type: "reply.create",
        replyId,
        annotationId: annotation.id,
        actorRef: a.actorRef,
      },
      metadata: { annotationId: annotation.id },
    });

    const responseBody = {
      operationId: command202.operationId,
      replyId,
      correlationId,
      status: "queued",
    };
    await deps.db.batch([
      command202.statements[0] as SqlStatement,
      repos.replies.insertStatement({
        id: replyId,
        projectId: guard.project.id,
        annotationId: annotation.id,
        parentReplyId: command.parentReplyId ?? null,
        authorActorId: a.actor.id,
        body: command.body,
        status: "pending_git",
        gitOperationId: command202.operationId,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      ...command202.statements.slice(1),
      ...claimStatements(c, 202, responseBody),
    ]);
    await notifyMutation(guard.project.id);

    return c.json(responseBody, 202);
  });

  app.post(
    "/v1/projects/:projectId/annotations/:annotationId/replies/:replyId/withdraw",
    auth,
    idem,
    async (c) => {
      const parsed = withdrawReplyCommandSchema.safeParse({
        annotationId: c.req.param("annotationId"),
        replyId: c.req.param("replyId"),
      });
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }
      const command = parsed.data;
      const reply = await repos.replies.getById(command.replyId);
      if (reply === null || reply.annotationId !== command.annotationId) {
        return problem(c, "not-found", { detail: "unknown reply" });
      }
      const annotation = await repos.annotations.getById(command.annotationId);
      if (annotation === null) {
        return problem(c, "not-found", { detail: "unknown reply" });
      }

      const a = authOf(c);
      const withdrawingOwn = reply.authorActorId === a.actor.id;
      const requirements = withdrawingOwn
        ? { capabilities: ["feedback:withdraw-own"] as const }
        : {
            capabilities: ["feedback:moderate"] as const,
            legacyAction: "feedback:moderate" as const,
          };
      if (!hasEditorialAuthority(a, "annotations:write", requirements)) {
        return problem(c, "forbidden", {
          detail: `actor lacks required editorial capability "${requirements.capabilities[0]}"`,
        });
      }
      const guard = await requireProjectScope(c, services, "annotations:write", {
        requireMembership: true,
        editorial: requirements,
      });
      if ("response" in guard) {
        return guard.response;
      }
      if (reply.projectId !== guard.project.id || annotation.projectId !== guard.project.id) {
        return problem(c, "not-found", { detail: "unknown reply" });
      }
      if (reply.status === "pending_git") {
        return problem(c, "state-conflict", {
          detail: "reply is still being committed; retry once its operation completes",
        });
      }
      if (reply.status !== "open") {
        return problem(c, "state-conflict", {
          detail: `reply with status "${reply.status}" cannot be withdrawn`,
        });
      }
      if (reply.gitOperationId !== null) {
        const inFlight = await repos.gitOperations.getById(reply.gitOperationId);
        if (
          inFlight !== null &&
          (inFlight.state === "queued" ||
            inFlight.state === "preparing" ||
            inFlight.state === "committing" ||
            inFlight.state === "conflict")
        ) {
          return problem(c, "state-conflict", {
            detail: "a git operation for this reply is still in flight; retry once it completes",
          });
        }
      }

      const correlationId = c.get("correlationId");
      const timestamp = now();
      const command202 = commandStatements({
        project: guard.project,
        correlationId,
        actorId: a.actor.id,
        action: "reply.withdraw",
        targetType: "reply",
        targetId: reply.id,
        outboxKind: "reply.withdraw",
        outboxPayload: {
          type: "reply.withdraw",
          replyId: reply.id,
          annotationId: annotation.id,
          actorId: a.actor.id,
          actorRef: a.actorRef,
        },
        metadata: { annotationId: annotation.id },
      });
      const responseBody = {
        operationId: command202.operationId,
        annotationId: annotation.id,
        replyId: reply.id,
        correlationId,
        status: "queued",
      };
      try {
        await deps.db.batch([
          command202.statements[0] as SqlStatement,
          repos.replies.setWithdrawalOperationStatement(
            reply.id,
            reply.gitOperationId,
            command202.operationId,
            timestamp,
          ),
          ...command202.statements.slice(1),
          ...claimStatements(c, 202, responseBody),
        ]);
      } catch (error) {
        if (isConstraintError(error)) {
          return problem(c, "state-conflict", {
            detail: "the reply changed while its withdrawal was being queued; refresh and retry",
          });
        }
        throw error;
      }
      await notifyMutation(guard.project.id);
      return c.json(responseBody, 202);
    },
  );

  app.post("/v1/projects/:projectId/annotations/:annotationId/withdraw", auth, idem, async (c) => {
    const annotation = await repos.annotations.getById(c.req.param("annotationId"));
    if (annotation === null) {
      return problem(c, "not-found", { detail: "unknown annotation" });
    }
    const a = authOf(c);
    const withdrawingOwn = annotation.authorActorId === a.actor.id;
    const requirements = withdrawingOwn
      ? { capabilities: ["feedback:withdraw-own"] as const }
      : {
          capabilities: ["feedback:moderate"] as const,
          legacyAction: "feedback:moderate" as const,
        };
    const policyMayAdmitNonmemberAuthor =
      withdrawingOwn && a.kind === "session" && a.membership === null;
    if (
      !policyMayAdmitNonmemberAuthor &&
      !hasEditorialAuthority(a, "annotations:write", requirements)
    ) {
      return problem(c, "forbidden", {
        detail: `actor lacks required editorial capability "${requirements.capabilities[0]}"`,
      });
    }
    const guard = await requireProjectScope(c, services, "annotations:write", {
      editorial: requirements,
    });
    if ("response" in guard) {
      return guard.response;
    }
    if (annotation.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown annotation" });
    }
    if (annotation.status === "pending_git") {
      return problem(c, "state-conflict", {
        detail: "annotation is still being committed; retry once its operation completes",
      });
    }

    const author = await repos.actors.getById(annotation.authorActorId);
    const decision = authorizeAnnotationWithdraw({
      annotationAuthor: author?.externalIdentity ?? `system:actor-${annotation.authorActorId}`,
      annotationStatus: annotation.status,
      actor: a.actorRef,
      actorRole: a.role ?? "reader",
    });
    if (!decision.allowed) {
      if (decision.reason === "not-author-or-maintainer") {
        return problem(c, "forbidden", { detail: decision.message });
      }
      return problem(c, "state-conflict", { detail: decision.message });
    }

    // Contract §5: the DB status flips to `withdrawn` only in the processor's
    // post-commit sync batch, so the row keeps reflecting Git. While a
    // withdraw operation is in flight the record still reads `open`; guard
    // against enqueuing a second withdraw for the same annotation.
    if (annotation.gitOperationId !== null) {
      const inFlight = await repos.gitOperations.getById(annotation.gitOperationId);
      if (
        inFlight !== null &&
        (inFlight.state === "queued" ||
          inFlight.state === "preparing" ||
          inFlight.state === "committing" ||
          inFlight.state === "conflict")
      ) {
        return problem(c, "state-conflict", {
          detail: "a git operation for this annotation is still in flight; retry once it completes",
        });
      }
    }

    const correlationId = c.get("correlationId");
    const timestamp = now();
    const command202 = commandStatements({
      project: guard.project,
      correlationId,
      actorId: a.actor.id,
      action: "annotation.withdraw",
      targetType: "annotation",
      targetId: annotation.id,
      outboxKind: "annotation.withdraw",
      outboxPayload: {
        type: "annotation.withdraw",
        annotationId: annotation.id,
        // The withdrawing actor (author or maintainer) - credited in the
        // commit's Authorbot-Actor trailer by the processor.
        actorId: a.actor.id,
        actorRef: a.actorRef,
      },
      metadata: null,
    });

    const responseBody = {
      operationId: command202.operationId,
      annotationId: annotation.id,
      correlationId,
      status: "queued",
    };
    // NOTE (contract §5): the record status is NOT flipped here. The
    // processor's post-commit sync batch sets `withdrawn` atomically with the
    // commit; on a failed operation the record stays `open` (consistent with
    // Git) and the withdraw can be retried - previously the premature flip
    // left a 409-blocked `withdrawn` row that the next rebuild silently
    // reverted to `open`, losing the accepted withdrawal.
    await deps.db.batch([
      command202.statements[0] as SqlStatement,
      repos.annotations.setGitOperationStatement(annotation.id, command202.operationId, timestamp),
      ...command202.statements.slice(1),
      ...claimStatements(c, 202, responseBody),
    ]);
    await notifyMutation(guard.project.id);

    return c.json(responseBody, 202);
  });

  // ---- operations ------------------------------------------------------------

  app.get("/v1/projects/:projectId/operations/:operationId", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "chapters:read", {
      editorial: { capabilities: ["chapters:read"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const operation = await repos.gitOperations.getById(c.req.param("operationId"));
    if (operation === null || operation.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown operation" });
    }
    return c.json(operationJson(operation));
  });

  // ---- webhook (unauthenticated; HMAC-verified) --------------------------------

  app.post("/v1/webhooks/github", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    if (signature === undefined || !signature.startsWith("sha256=")) {
      return problem(c, "unauthorized", { detail: "missing webhook signature" });
    }
    const expected = `sha256=${await hmacSha256Hex(deps.config.webhookSecret, rawBody)}`;
    if (!timingSafeEqual(signature, expected)) {
      return problem(c, "unauthorized", { detail: "invalid webhook signature" });
    }
    const deliveryId = c.req.header("x-github-delivery");
    if (deliveryId === undefined || deliveryId.length === 0) {
      return problem(c, "bad-request", { detail: "missing X-GitHub-Delivery header" });
    }
    const event = c.req.header("x-github-event") ?? "unknown";

    let rowId = uuidv7(clock.now());
    let redelivery = false;
    try {
      await repos.webhookDeliveries.insert({
        id: rowId,
        deliveryId,
        event,
        status: "received",
        receivedAt: now(),
        processedAt: null,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      // Duplicate delivery id. Successfully handled deliveries (processed /
      // ignored / still in flight) are ignored (exit criterion 4) - but a
      // delivery whose rebuild FAILED must be retryable via GitHub's
      // redelivery of the same id, otherwise the projection stays stale until
      // an unrelated future push.
      const prior = await repos.webhookDeliveries.getByDeliveryId(deliveryId);
      if (prior === null || prior.status !== "failed") {
        return c.json({ duplicate: true, rebuilt: false });
      }
      rowId = prior.id;
      redelivery = true;
    }

    if (event !== "push") {
      await repos.webhookDeliveries.setStatus(rowId, "ignored", now());
      return c.json({ duplicate: false, rebuilt: false, event });
    }

    // Contract §6: `push` ON THE DEFAULT BRANCH. A push to a feature branch
    // must not mark the projection stale - the projection tracks the default
    // branch, so a topic-branch push would schedule a refresh that finds
    // nothing new and, worse, could clear a stale flag a real push set.
    //
    // A payload with no `ref` is NOT filtered out: it means this is a shape
    // we do not recognize, and dropping a real push is worse than one
    // redundant refresh.
    const pushedRef = pushRef(rawBody);
    const projectRow = await getProject();
    const defaultBranch = projectRow?.defaultBranch ?? deps.config.defaultBranch ?? "main";
    if (pushedRef !== null && pushedRef !== `refs/heads/${defaultBranch}`) {
      await repos.webhookDeliveries.setStatus(rowId, "ignored", now());
      return c.json({ duplicate: false, rebuilt: false, event, ref: pushedRef });
    }

    // Phase 5 §6: mark stale FIRST, then ask for a refresh.
    //
    // The flag is the durable record that a push is owed a projection; the
    // refresh request is best-effort. Ordering them the other way - refresh,
    // then flag - loses the push whenever the refresh fails, because nothing
    // durable would remember it was ever needed. This runs even with no
    // reader configured (the deployed Worker's state today), so a deployment
    // that later gains repository access finds the backlog waiting rather
    // than silently starting from whatever the head happens to be then.
    const project = await getProject();
    if (project === null) {
      await repos.webhookDeliveries.setStatus(rowId, "ignored", now());
      return c.json({ duplicate: false, rebuilt: false, event, reason: "no project" });
    }
    cachedProject = null;
    const headCommit = pushHeadCommit(rawBody);
    const staleness = await markStaleAndRequestRefresh(
      reconcileCtx(),
      project,
      deps.projectionRefresher,
      {
        reason: "webhook-push",
        correlationId: c.get("correlationId"),
        deliveryId,
        ...(headCommit !== null ? { headCommit } : {}),
      },
    );

    // With a coordinator wired, the refresh belongs to it: doing it here as
    // well would run two concurrent projection writes for one push, exactly
    // the serialization the Durable Object exists to provide. Without one,
    // this handler stays the refresher - which is what the deployment does
    // today, so absent-coordinator behaviour is unchanged.
    if (staleness.delegated) {
      await repos.webhookDeliveries.setStatus(rowId, "processed", now());
      return c.json({
        duplicate: false,
        redelivery,
        rebuilt: false,
        refreshRequested: staleness.refreshRequested,
        stale: true,
      });
    }

    if (deps.reader === undefined) {
      await repos.webhookDeliveries.setStatus(rowId, "ignored", now());
      return c.json({ duplicate: false, rebuilt: false, event, stale: true });
    }

    try {
      const result = await reconcile({ correlationId: c.get("correlationId") });
      await repos.webhookDeliveries.setStatus(rowId, "processed", now());
      return c.json({
        duplicate: false,
        redelivery,
        rebuilt: result?.rebuild != null,
        counts: result?.rebuild ?? null,
        diverged: result?.outcome === "diverged",
        externalEdits: result?.externalEdits.length ?? 0,
        reanchored: result?.reanchored ?? { kept: 0, needsReanchor: 0 },
      });
    } catch {
      await repos.webhookDeliveries.setStatus(rowId, "failed", now());
      return problem(c, "internal", { detail: "projection rebuild failed" });
    }
  });

  // ---- identity providers -------------------------------------------------------

  /**
   * Ending a session.
   *
   * Registered for every auth mode, because until now there was no way to sign
   * out at all: two routes existed to create a session and none to end one, so
   * a reader on a shared machine stayed signed in until the cookie expired,
   * with nothing in the UI or the API able to help them.
   *
   * Both halves are needed. Clearing the cookie alone leaves a live row that
   * still authenticates anyone holding a copy of the value; revoking alone
   * leaves the browser presenting a dead cookie on every request. Revoke
   * first, then clear - a failure between the two leaves the session dead
   * rather than merely forgotten, which is the safe way round.
   *
   * Always 204, whether or not a live session was found: the caller learns
   * nothing about whether their cookie was real, and "sign me out" is
   * satisfied either way.
   */
  app.post("/v1/auth/logout", async (c) => {
    const sessionId = await verifySessionCookieValue(
      deps.config.sessionSecret,
      getCookie(c, SESSION_COOKIE),
    );
    if (sessionId !== null) {
      const session = await repos.humanSessions.getBySessionHash(await sha256Hex(sessionId));
      if (session !== null && session.revokedAt === null) {
        await repos.humanSessions.revoke(session.id, clock.now().toISOString());
      }
    }
    c.header("Set-Cookie", clearSessionCookieHeader(), { append: true });
    return c.body(null, 204);
  });

  if (deps.identityProvider.mode === "dev") {
    // Mounted ONLY in dev mode (contract §3): in github mode this route does
    // not exist and returns 404 by construction (ADR 0015).
    const devLoginSchema = z.strictObject({
      login: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, "must be a GitHub-style login"),
      role: roleSchema,
    });

    app.post("/v1/dev/login", async (c) => {
      // CSRF (ADR-0019 §3): this route sits before requireAuth (it mints the
      // session), so it applies the same Origin/Referer check the auth
      // middleware applies to cookie-authenticated mutations - otherwise any
      // web page could drive a login CSRF against a developer's local API and
      // destructively replace membership rows.
      const csrfOk = csrfOriginAllowed(
        c.req.header("origin"),
        c.req.header("referer"),
        new URL(c.req.url).origin,
      );
      if (!csrfOk) {
        return problem(c, "csrf-origin-mismatch", {
          detail:
            "dev login requires an Origin or Referer header matching this API's own origin",
        });
      }
      const body = await readJson(c);
      if (body instanceof Response) {
        return body;
      }
      const parsed = devLoginSchema.safeParse(body);
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }
      const project = await getProject();
      if (project === null) {
        return problem(c, "internal", { detail: "project not seeded" });
      }
      const { login, role } = parsed.data;
      const externalIdentity = `github:${login}`;
      const timestamp = now();

      let actor = await repos.actors.getByExternalIdentity(externalIdentity);
      if (actor === null) {
        actor = {
          id: uuidv7(clock.now()),
          type: "human",
          displayName: login,
          externalIdentity,
          ownerActorId: null,
          status: "active",
          createdAt: timestamp,
        };
        await repos.actors.insert(actor);
      }

      let membership = await repos.projectMemberships.getByProjectAndActor(
        project.id,
        actor.id,
      );
      const needsReplacement =
        membership !== null && (membership.revokedAt !== null || membership.role !== role);
      if (membership === null || needsReplacement) {
        const fresh = {
          id: uuidv7(clock.now()),
          projectId: project.id,
          actorId: actor.id,
          role,
          scopes: [...roleScopes(role)],
          createdAt: timestamp,
          revokedAt: null,
        };
        // Dev convenience: re-login with a different role (or after a
        // revocation) replaces the membership - the unique (project, actor)
        // index allows only one row per actor.
        if (membership !== null) {
          await deps.db
            .prepare(`DELETE FROM project_memberships WHERE id = ?`)
            .bind(membership.id)
            .run();
        }
        await repos.projectMemberships.insert(fresh);
        membership = fresh;
      }

      const sessionId = randomBase64Url(32);
      const sessionHash = await sha256Hex(sessionId);
      await deps.db.batch([
        repos.humanSessions.insertStatement({
          id: uuidv7(clock.now()),
          sessionHash,
          actorId: actor.id,
          createdAt: timestamp,
          expiresAt: sessionExpiry(clock),
          revokedAt: null,
        }),
        repos.auditEvents.insertStatement({
          id: uuidv7(clock.now()),
          projectId: project.id,
          actorId: actor.id,
          action: "session.login",
          targetType: "actor",
          targetId: actor.id,
          correlationId: c.get("correlationId"),
          metadata: { provider: "dev", role },
          createdAt: timestamp,
        }),
      ]);

      c.header(
        "Set-Cookie",
        sessionCookieHeader(
          await signSessionCookieValue(deps.config.sessionSecret, sessionId),
        ),
      );
      return c.json({
        actor: actorJson(actor),
        membership: membershipJson(membership),
        scopes: roleScopes(membership.role),
      });
    });
  } else {
    const provider = deps.identityProvider;

    app.get("/v1/auth/github", async (c) => {
      // return_to (ADR-0019 §4): only URLs within the API's own origin may
      // round-trip through the state cookie - never javascript:/data:
      // schemes, never a foreign host (open redirect).
      const returnToRaw = c.req.query("return_to");
      let returnTo: string | null = null;
      if (returnToRaw !== undefined && returnToRaw.length > 0) {
        if (!isValidReturnTo(returnToRaw, new URL(c.req.url).origin)) {
          return problem(c, "validation-failed", {
            detail: "return_to must be an absolute http(s) URL within this API's own origin",
          });
        }
        returnTo = returnToRaw;
      }
      const state = randomBase64Url(16);
      c.header(
        "Set-Cookie",
        oauthStateCookieHeader(
          await packOauthState(deps.config.sessionSecret, { state, returnTo }),
        ),
      );
      return c.redirect(provider.authorizeUrl(state), 302);
    });

    app.get("/v1/auth/github/callback", async (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const cookie = getCookie(c, OAUTH_STATE_COOKIE);
      if (code === undefined || state === undefined || cookie === undefined) {
        return problem(c, "unauthorized", { detail: "missing OAuth state or code" });
      }
      const statePayload = await unpackOauthState(deps.config.sessionSecret, cookie);
      if (statePayload === null || !timingSafeEqual(statePayload.state, state)) {
        return problem(c, "unauthorized", { detail: "OAuth state mismatch" });
      }

      let identity;
      try {
        identity = await provider.resolveCallback(code);
      } catch {
        return problem(c, "unauthorized", { detail: "GitHub OAuth exchange failed" });
      }

      const timestamp = now();
      let actor = await repos.actors.getByExternalIdentity(identity.externalIdentity);
      if (actor === null) {
        actor = {
          id: uuidv7(clock.now()),
          type: "human",
          displayName: identity.displayName,
          externalIdentity: identity.externalIdentity,
          ownerActorId: null,
          status: "active",
          createdAt: timestamp,
        };
        await repos.actors.insert(actor);
      }

      const project = await getProject();
      const sessionId = randomBase64Url(32);
      const sessionHash = await sha256Hex(sessionId);
      const statements: SqlStatement[] = [
        repos.humanSessions.insertStatement({
          id: uuidv7(clock.now()),
          sessionHash,
          actorId: actor.id,
          createdAt: timestamp,
          expiresAt: sessionExpiry(clock),
          revokedAt: null,
        }),
      ];
      if (project !== null) {
        statements.push(
          repos.auditEvents.insertStatement({
            id: uuidv7(clock.now()),
            projectId: project.id,
            actorId: actor.id,
            action: "session.login",
            targetType: "actor",
            targetId: actor.id,
            correlationId: c.get("correlationId"),
            metadata: { provider: "github" },
            createdAt: timestamp,
          }),
        );
      }
      await deps.db.batch(statements);

      c.header(
        "Set-Cookie",
        sessionCookieHeader(
          await signSessionCookieValue(deps.config.sessionSecret, sessionId),
        ),
      );
      c.header("Set-Cookie", clearOauthStateCookieHeader(), { append: true });
      // Re-validate the (signed) return_to before redirecting: defense in
      // depth against config changes between start and callback.
      const destination =
        statePayload.returnTo !== null &&
        isValidReturnTo(statePayload.returnTo, new URL(c.req.url).origin)
          ? statePayload.returnTo
          : "/";
      return c.redirect(destination, 302);
    });
  }

  // ---- Phase 3 routes (votes, decisions, work items, events) --------------
  registerPhase3Routes({
    app,
    deps,
    repos,
    clock,
    services,
    rules: rulesFor,
    auth,
    maybeAuth,
    idem,
    serialize,
    requireReadOrPublic,
    claimStatements,
    commandStatements,
    readJson,
    parseLimit,
    notifyMutation,
    now,
  });

  // ---- Phase 4 routes (leases, task bundles, submissions) ------------------
  registerPhase4Routes({
    app,
    deps,
    repos,
    clock,
    services,
    auth,
    idem,
    // Claim and recovery responses carry a return-once lease token: replays
    // store a redacted body (contract §2 "returned exactly once").
    claimIdem: idempotency(services, { redactStored: redactClaimBundle }),
    serialize,
    leaseConfig: deps.config.leaseConfig,
    claimStatements,
    commandStatements,
    readJson,
    notifyMutation,
    now,
  });

  // ---- Phase 6 routes (direct authoring, contract §3.5) --------------------
  registerChapterSubmissionRoutes({
    app,
    deps,
    repos,
    clock,
    services,
    auth,
    idem,
    serialize,
    claimStatements,
    commandStatements,
    readJson,
    notifyMutation,
  });

  // ---- Phase 11 routes (review-gated chapter and summary revisions) -------
  registerRevisionProposalRoutes({
    app,
    deps,
    repos,
    clock,
    services,
    auth,
    idem,
    serialize,
    claimStatements,
    commandStatements,
    readJson,
    parseLimit,
    notifyMutation,
    now,
  });

  registerChapterHistoryRoutes({
    app,
    deps,
    repos,
    clock,
    services,
    auth,
    idem,
    serialize,
    claimStatements,
    parseLimit,
    now,
  });

  // ---- authenticated story bible (bounded repository reads) --------------
  registerStoryBibleRoutes({ app, deps, repos, services, auth });

  // ---- Phase 6 routes (book settings + governance, contract §3.6) ---------
  registerSettingsRoutes({
    app,
    deps,
    repos,
    clock,
    services,
    auth,
    idem,
    serialize,
    bootstrapRules,
    requireProject: (c) => requireProjectScope(c, services, "chapters:read"),
    requireProjectWrite: (c) => requireProjectScope(c, services, "members:manage"),
    claimStatements,
    commandStatements,
    readJson,
    notifyMutation,
    now,
  });

  // ---- Phase 7 routes (author-facing access control) -----------------------
  registerPhase7Routes({
    app,
    deps,
    repos,
    clock,
    services,
    auth,
    idem,
    serialize,
    claimStatements,
    commandStatements,
    readJson,
    parseLimit,
    notifyMutation,
    now,
  });

  // ---- Phase 5 routes (publication tracking, design §17.3) -----------------
  registerPublicationRoutes({
    app,
    deps,
    repos,
    clock,
    getProject,
    auth,
    requireRead: async (c) => {
      const sessionOnly = requireHumanSession(c);
      if (sessionOnly !== null) return { response: sessionOnly };
      return requireProjectScope(c, services, "chapters:read");
    },
  });

  return { app, repos, bootstrap, rebuild, reconcile };
}

/** The `ref` a `push` payload names, when the payload has a recognizable one. */
function pushRef(rawBody: string): string | null {
  try {
    const payload = JSON.parse(rawBody) as { ref?: unknown };
    return typeof payload.ref === "string" && payload.ref.length > 0 ? payload.ref : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort head commit from a `push` payload, for the refresh request's
 * logs. Never trusted for correctness - the refresh always re-reads the ref -
 * so a malformed or unexpected payload just yields null.
 */
function pushHeadCommit(rawBody: string): string | null {
  try {
    const payload = JSON.parse(rawBody) as { after?: unknown };
    return typeof payload.after === "string" && /^[0-9a-f]{7,64}$/.test(payload.after)
      ? payload.after
      : null;
  } catch {
    return null;
  }
}

function sessionExpiry(clock: Clock): string {
  return resolveSessionExpiry(clock.now());
}

/** Zod error → safe, stable issue list for problem bodies. */
function issueList(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
