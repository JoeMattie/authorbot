/**
 * createApp (Phase 2 contract §3, §4, §5): the Hono application with all
 * business wiring, runtime-agnostic. The Worker entry (src/worker.ts) builds
 * deps from bindings; tests build them from Node fakes (better-sqlite3).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import {
  createRepositories,
  isUniqueConstraintError,
  type ProjectRecord,
  type Repositories,
  type SqlStatement,
} from "@authorbot/database";
import {
  authorizeAnnotationWithdraw,
  createAnnotationCommandSchema,
  createReplyCommandSchema,
  resolveSessionExpiry,
  resolveTokenExpiry,
  roleSchema,
  roleScopes,
  toTimestamp,
  AGENT_TOKEN_PREFIX,
} from "@authorbot/domain";
import { apiRoleScopes, mintAgentTokenApiCommandSchema } from "./api-scopes.js";
import { parseRuleEntries } from "./rules.js";
import { annotationCollabJson, registerPhase3Routes } from "./phase3.js";
import { parseChapterMarkdown, scanSafety } from "@authorbot/markdown";
import { z } from "zod";
import {
  authOf,
  optionalAuth,
  requireAuth,
  requireProjectScope,
  type AuthServices,
} from "./auth.js";
import { cors } from "./cors.js";
import { csrfOriginAllowed, isValidReturnTo } from "./origins.js";
import { randomBase64Url, sha256Hex, timingSafeEqual, hmacSha256Hex } from "./crypto.js";
import { SYSTEM_CLOCK, type AppDeps, type AppEnv, type Clock } from "./deps.js";
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
import { rebuildProjection, type RebuildResult } from "./projection/rebuild.js";
import { seedProject } from "./seed.js";
import {
  clearOauthStateCookieHeader,
  oauthStateCookieHeader,
  packOauthState,
  unpackOauthState,
  OAUTH_STATE_COOKIE,
  sessionCookieHeader,
  signSessionCookieValue,
} from "./sessions.js";
import { getCookie } from "hono/cookie";

/** The app plus the handles tests and the Worker entry need. */
export interface AuthorbotApi {
  app: Hono<AppEnv>;
  repos: Repositories;
  /** Idempotent: seed project/maintainer, then rebuild when a reader exists. */
  bootstrap(): Promise<{ project: ProjectRecord; rebuild: RebuildResult | null }>;
  /** Rebuild the projection now (null when no reader is configured). */
  rebuild(correlationId?: string): Promise<RebuildResult | null>;
}

/** Contract-shaped entry point: deps in, Hono app out. */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  return createApi(deps).app;
}

export function createApi(deps: AppDeps): AuthorbotApi {
  const repos = createRepositories(deps.db);
  const clock: Clock = deps.clock ?? SYSTEM_CLOCK;

  // Boot-time rule validation (Phase 3 contract §3): invalid RULES_JSON
  // throws here — never degrades to the default at runtime.
  const rules = parseRuleEntries(deps.config.rulesJson);

  let cachedProject: ProjectRecord | null = null;
  const getProject = async (): Promise<ProjectRecord | null> => {
    if (cachedProject === null) {
      cachedProject = await repos.projects.getBySlug(deps.config.projectSlug);
    }
    return cachedProject;
  };

  const allowedOrigins = deps.config.allowedOrigins ?? [];
  /** Cross-origin site configured → SameSite=None session cookie (2b §3). */
  const cookieOptions = { crossOrigin: allowedOrigins.length > 0 };

  const services: AuthServices & { repos: Repositories; clock: Clock } = {
    repos,
    clock,
    sessionSecret: deps.config.sessionSecret,
    allowedOrigins,
    getProject,
  };

  const rebuild = async (correlationId?: string): Promise<RebuildResult | null> => {
    if (deps.reader === undefined) {
      return null;
    }
    const project = await getProject();
    if (project === null) {
      return null;
    }
    return rebuildProjection(
      { db: deps.db, repos, clock },
      project,
      deps.reader,
      correlationId ?? uuidv7(clock.now()),
    );
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

  const app = new Hono<AppEnv>();

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

  // CORS (Phase 2b contract §3): exact-origin allow-list, credentialed,
  // preflight short-circuit. Pass-through when ALLOWED_ORIGINS is empty.
  app.use("*", cors(allowedOrigins));

  app.onError((error, c) => {
    // Never echo internals (they may contain SQL values); the correlation id
    // is the log key.
    void error;
    return problem(c as Context<AppEnv>, "internal");
  });

  app.notFound((c) => problem(c as Context<AppEnv>, "not-found"));

  const auth = requireAuth(services);
  const idem = idempotency(services);

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
      return requireProjectScope(c, services, "annotations:read");
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
    // MIRROR_MODE=queue (contract §5): outbox rows are recorded but not
    // drained in-process — a later drain (Phase 5 Durable Object alarm, or a
    // manual `InlineMirror.drain`) picks them up.
    if (deps.onMutationCommitted === undefined || deps.config.mirrorMode === "queue") {
      return;
    }
    try {
      await deps.onMutationCommitted(projectId);
    } catch {
      // The mirror processor failing must not fail the 202 — the operation
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
    // Require a JSON content type before parsing (Phase 2b §3 defense in
    // depth): a cross-site `text/plain` "simple request" (no CORS preflight)
    // must never reach a JSON handler; declaring application/json forces a
    // preflight that the exact-origin CORS allow-list controls.
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

  // ---- identity ------------------------------------------------------------

  app.get("/v1/me", auth, async (c) => {
    const a = authOf(c);
    return c.json({
      actor: actorJson(a.actor),
      memberships: a.membership !== null ? [membershipJson(a.membership)] : [],
      scopes: a.scopes,
      authKind: a.kind,
    });
  });

  app.get("/v1/projects/:projectId", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "chapters:read");
    if ("response" in guard) {
      return guard.response;
    }
    return c.json(projectJson(guard.project));
  });

  app.get("/v1/projects/:projectId/members", auth, async (c) => {
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
    const guard = await requireProjectScope(c, services, "tokens:manage");
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

    const tokenRecord = {
      id: tokenId,
      projectId: guard.project.id,
      actorId: agentActorId,
      name: command.name,
      tokenHash,
      scopes: [...command.scopes],
      createdBy: a.actor.id,
      createdAt: timestamp,
      expiresAt: expiry.expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    };

    const responseBody = { ...agentTokenJson(tokenRecord), token: plaintext };
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
      repos.auditEvents.insertStatement({
        id: uuidv7(clock.now()),
        projectId: guard.project.id,
        actorId: a.actor.id,
        action: "agent_token.mint",
        targetType: "agent_token",
        targetId: tokenId,
        correlationId: c.get("correlationId"),
        metadata: { name: command.name, scopes: command.scopes, expiresAt: expiry.expiresAt },
        createdAt: timestamp,
      }),
    ];
    // Atomic idempotency claim (stored body is redacted — never the token):
    // a same-key retry can never mint a second actor/token pair.
    statements.push(...claimStatements(c, 201, responseBody));
    await deps.db.batch(statements);

    return c.json(responseBody, 201);
  });

  app.delete("/v1/projects/:projectId/agent-tokens/:tokenId", auth, idem, async (c) => {
    const guard = await requireProjectScope(c, services, "tokens:manage");
    if ("response" in guard) {
      return guard.response;
    }
    const token = await repos.agentTokens.getById(c.req.param("tokenId"));
    if (token === null || token.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown agent token" });
    }
    const timestamp = now();
    await deps.db.batch([
      repos.agentTokens.revokeStatement(token.id, timestamp),
      repos.auditEvents.insertStatement({
        id: uuidv7(clock.now()),
        projectId: guard.project.id,
        actorId: authOf(c).actor.id,
        action: "agent_token.revoke",
        targetType: "agent_token",
        targetId: token.id,
        correlationId: c.get("correlationId"),
        metadata: null,
        createdAt: timestamp,
      }),
      ...claimStatements(c, 204, null),
    ]);
    return c.body(null, 204);
  });

  // ---- chapters --------------------------------------------------------------

  app.get("/v1/projects/:projectId/chapters", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "chapters:read");
    if ("response" in guard) {
      return guard.response;
    }
    const limit = parseLimit(c);
    if (limit instanceof Response) {
      return limit;
    }
    const cursor = c.req.query("cursor") ?? "";
    const chapters = (await repos.chapters.listByProject(guard.project.id))
      .filter((chapter) => chapter.id > cursor)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit);
    return c.json(page(chapters, limit, (ch) => chapterJson(ch)));
  });

  app.get("/v1/projects/:projectId/chapters/:chapterId", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "chapters:read");
    if ("response" in guard) {
      return guard.response;
    }
    const chapter = await repos.chapters.getById(c.req.param("chapterId"));
    if (chapter === null || chapter.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown chapter" });
    }
    return c.json(chapterJson(chapter));
  });

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
    const cursor = c.req.query("cursor");
    const annotations = await repos.annotations.listByChapter(chapter.id, {
      limit,
      ...(cursor !== undefined ? { afterId: cursor } : {}),
    });
    // Phase 3 contract §2/§6: embed aggregate vote tallies (public: counts
    // only) plus the create_work_item decision badge; members also see their
    // own current vote (`myVote`). The viewer id is null for anonymous reads.
    const viewerActorId = c.get("auth")?.actor.id ?? null;
    const items = await Promise.all(
      annotations.map((a) => annotationCollabJson(repos, a, viewerActorId)),
    );
    const last = annotations[annotations.length - 1];
    return c.json({
      items,
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
    const viewerActorId = c.get("auth")?.actor.id ?? null;
    return c.json(await annotationCollabJson(repos, annotation, viewerActorId));
  });

  app.post(
    "/v1/projects/:projectId/chapters/:chapterId/annotations",
    auth,
    idem,
    async (c) => {
      const guard = await requireProjectScope(c, services, "annotations:write");
      if ("response" in guard) {
        return guard.response;
      }
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
        // the rebuild, so this check works from the DB alone — including on
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
  // (API-backed)") — the read complement of the POST below, same page
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
    const guard = await requireProjectScope(c, services, "annotations:write");
    if ("response" in guard) {
      return guard.response;
    }
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
    if (annotation === null || annotation.projectId !== guard.project.id) {
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

  app.post("/v1/projects/:projectId/annotations/:annotationId/withdraw", auth, idem, async (c) => {
    const guard = await requireProjectScope(c, services, "annotations:write");
    if ("response" in guard) {
      return guard.response;
    }
    const annotation = await repos.annotations.getById(c.req.param("annotationId"));
    if (annotation === null || annotation.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown annotation" });
    }
    if (annotation.status === "pending_git") {
      return problem(c, "state-conflict", {
        detail: "annotation is still being committed; retry once its operation completes",
      });
    }

    const a = authOf(c);
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
        // The withdrawing actor (author or maintainer) — credited in the
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
    // Git) and the withdraw can be retried — previously the premature flip
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
    const guard = await requireProjectScope(c, services, "chapters:read");
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
      // ignored / still in flight) are ignored (exit criterion 4) — but a
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

    if (event !== "push" || deps.reader === undefined) {
      await repos.webhookDeliveries.setStatus(rowId, "ignored", now());
      return c.json({ duplicate: false, rebuilt: false, event });
    }

    try {
      const result = await rebuild(c.get("correlationId"));
      await repos.webhookDeliveries.setStatus(rowId, "processed", now());
      return c.json({ duplicate: false, redelivery, rebuilt: result !== null, counts: result });
    } catch {
      await repos.webhookDeliveries.setStatus(rowId, "failed", now());
      return problem(c, "internal", { detail: "projection rebuild failed" });
    }
  });

  // ---- identity providers -------------------------------------------------------

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
      // CSRF (Phase 2b contract §3): this route sits before requireAuth (it
      // mints the session), so it applies the same Origin/Referer check the
      // auth middleware applies to cookie-authenticated mutations — otherwise
      // any web page could drive a login CSRF against a developer's local API
      // and destructively replace membership rows.
      const csrfOk = csrfOriginAllowed(
        c.req.header("origin"),
        c.req.header("referer"),
        new URL(c.req.url).origin,
        allowedOrigins,
      );
      if (!csrfOk) {
        return problem(c, "csrf-origin-mismatch", {
          detail:
            "dev login requires an Origin or Referer header matching an allowed origin",
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
        // revocation) replaces the membership — the unique (project, actor)
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
          cookieOptions,
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
      // return_to (Phase 2b contract §3): only URLs inside ALLOWED_ORIGINS or
      // the API's own origin (the same-origin deployment; mirrors the CSRF
      // check) may round-trip through the state cookie — never
      // javascript:/data: schemes, never a foreign host (open redirect).
      const returnToRaw = c.req.query("return_to");
      let returnTo: string | null = null;
      if (returnToRaw !== undefined && returnToRaw.length > 0) {
        if (!isValidReturnTo(returnToRaw, new URL(c.req.url).origin, allowedOrigins)) {
          return problem(c, "validation-failed", {
            detail: "return_to must be an absolute http(s) URL within an allowed origin",
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
          cookieOptions,
        ),
      );
      c.header("Set-Cookie", clearOauthStateCookieHeader(), { append: true });
      // Re-validate the (signed) return_to before redirecting: defense in
      // depth against config changes between start and callback.
      const destination =
        statePayload.returnTo !== null &&
        isValidReturnTo(statePayload.returnTo, new URL(c.req.url).origin, allowedOrigins)
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
    rules,
    auth,
    maybeAuth,
    idem,
    requireReadOrPublic,
    claimStatements,
    commandStatements,
    readJson,
    parseLimit,
    notifyMutation,
    now,
  });

  return { app, repos, bootstrap, rebuild };
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
