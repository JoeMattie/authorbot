/**
 * Phase 7 routes: the author-facing access control surface (Phase 7 contract,
 * "Author-facing access control" - Seeing, Restricting, Moderating, Revoking).
 *
 * "Phase 2 built memberships, roles, and revocable agent tokens; Phase 6 added
 * a settings view. Neither gave an author a way to *see* who can touch their
 * book or to stop them."
 *
 * Every route here is maintainer-only except the rate-limit documentation, and
 * every action records an audit event - including the ones that are themselves
 * about access, because "who locked this book, and when" is exactly the
 * question the audit view exists to answer.
 *
 * ## What this module does NOT do
 *
 * It does not enforce the policy. Enforcement lives at the single choke point
 * in `requireProjectScope` (see access-control.ts) so that a route added next
 * year inherits it without anyone remembering to ask. This module writes the
 * state that gate reads, and reads it back for display.
 *
 * ## Nothing here deletes content
 *
 * The contract's closing line for the section is load-bearing: "An author who
 * wants a contribution reverted uses the normal editorial path; access control
 * governs who may act next, not what already happened." Removing a
 * collaborator revokes their sessions, releases their leases, and rejects their
 * in-flight submissions - and leaves every annotation, vote, reply, and commit
 * trailer they ever produced exactly where it is.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import type {
  ActorRecord,
  PendingAnnotationRecord,
  ProjectRecord,
  Repositories,
  SqlStatement,
} from "@authorbot/database";
import { roleSchema, type Role } from "@authorbot/domain";
import { z } from "zod";
import { accessStateJson, loadAccessState } from "./access-control.js";
import {
  apiRoleScopes,
  capabilityProjectionJson,
  tokenCapabilityProjection,
  type ApiScope,
} from "./api-scopes.js";
import {
  authOf,
  requireHumanSession,
  requireProjectScope,
  type AuthServices,
} from "./auth.js";
import type { AppDeps, AppEnv, Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";
import { actorJson, agentTokenJson } from "./json.js";
import { revokeLeaseForActorStatements } from "./leases.js";
import { problem } from "./problems.js";
import { rateLimitsJson } from "./rate-limit.js";
import type { ProjectSerializer } from "./serializer.js";

/**
 * What each role means, in the words the contract asks for: "with the scope
 * consequences stated in plain language rather than as scope names".
 *
 * Served alongside every role list and every role change, so the settings view
 * never has to keep its own copy in sync with what the server actually grants.
 */
export const ROLE_CONSEQUENCES: Readonly<Record<Role, string>> = Object.freeze({
  reader:
    "Can read chapters and annotations. Cannot comment, suggest, vote, or edit anything.",
  contributor:
    "Everything a reader can do, plus writing comments and suggestions and voting on other people's suggestions. Cannot claim work items or submit prose.",
  editor:
    "Everything a contributor can do, plus claiming work items from the queue and submitting rewritten prose. This is the role an author's working agents normally hold.",
  maintainer:
    "Everything an editor can do, plus changing book settings and governance rules, minting and revoking agent tokens, changing other people's roles, removing collaborators, freezing the book, and approving queued annotations. Give this only to people you would trust with the repository itself.",
});

const reasonSchema = z.string().min(1).max(2000);

const freezeSchema = z.strictObject({ reason: reasonSchema });
const unfreezeSchema = z.strictObject({ reason: reasonSchema.optional() });
const pauseAgentsSchema = z.strictObject({ reason: reasonSchema });
const resumeAgentsSchema = z.strictObject({ reason: reasonSchema.optional() });
const roleChangeSchema = z.strictObject({
  role: roleSchema,
  reason: reasonSchema.optional(),
});
const removeCollaboratorSchema = z.strictObject({ reason: reasonSchema.optional() });
const revokeAllTokensSchema = z.strictObject({ reason: reasonSchema });
const rejectPendingSchema = z.strictObject({ reason: reasonSchema.optional() });
const bulkModerationSchema = z.strictObject({
  action: z.enum(["approve", "reject"]),
  ids: z.array(z.string().min(1)).min(1).max(200),
  reason: reasonSchema.optional(),
});

export interface Phase7Context {
  app: Hono<AppEnv>;
  deps: AppDeps;
  repos: Repositories;
  clock: Clock;
  services: AuthServices;
  auth: MiddlewareHandler<AppEnv>;
  idem: MiddlewareHandler<AppEnv>;
  serialize: ProjectSerializer;
  claimStatements(c: Context<AppEnv>, status: number, body: unknown): SqlStatement[];
  commandStatements(input: {
    project: ProjectRecord;
    correlationId: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    outboxKind: string;
    outboxPayload: unknown;
    metadata?: unknown;
  }): { operationId: string; statements: SqlStatement[] };
  readJson(c: Context<AppEnv>): Promise<unknown | Response>;
  parseLimit(c: Context<AppEnv>): number | Response;
  notifyMutation(projectId: string): Promise<void>;
  now(): string;
}

/** Canonical actor ref (matches auth.ts; kept in step by the attribution tests). */
export function actorRefOf(actor: { id: string; externalIdentity: string | null }): string {
  return actor.externalIdentity ?? `system:actor-${actor.id}`;
}

/**
 * The revocation cascade (Phase 7 contract "Revoking").
 *
 * "Removing a collaborator or revoking a token [takes] effect on the *next
 * request* - not on session expiry. Specifically, revocation must: invalidate
 * that actor's sessions, not merely their membership; release any lease they
 * hold, returning the work item to `ready` …; reject in-flight submissions from
 * the revoked actor; leave their prior contributions intact."
 *
 * All of it in ONE batch, for the reason every other command in this codebase
 * batches: a revocation that killed the sessions but failed before releasing
 * the lease would report success while leaving a work item stranded for four
 * hours, and the operator would have no way to tell which half had run.
 *
 * What is deliberately absent: any statement that touches `annotations`,
 * `votes`, `replies`, or `decisions`. Attribution and history are permanent
 * records, not access grants.
 */
export async function revocationCascadeStatements(input: {
  deps: AppDeps;
  repos: Repositories;
  clock: Clock;
  projectId: string;
  /** The actor losing access. */
  actorId: string;
  at: string;
}): Promise<{
  statements: SqlStatement[];
  releasedLeases: { leaseId: string; workItemId: string }[];
  rejectedSubmissions: string[];
}> {
  const { deps, repos, projectId, actorId, at } = input;
  const statements: SqlStatement[] = [];

  // 1. Sessions. Not "their membership is gone so the next auth will fail" -
  //    an agent token's actor has no session, and a human's cookie is a live
  //    credential that must stop working on the next request regardless of
  //    what the membership row now says.
  statements.push(repos.humanSessions.revokeAllForActorStatement(actorId, at));

  // 2. Leases. Released, not expired: see revokeLeaseForActorStatements.
  const leases = await repos.leases.listActiveByActor(projectId, actorId);
  const releasedLeases = leases.map((lease) => ({
    leaseId: lease.id,
    workItemId: lease.workItemId,
  }));
  for (const lease of leases) {
    statements.push(
      ...revokeLeaseForActorStatements(deps.db, {
        projectId,
        leaseId: lease.id,
        workItemId: lease.workItemId,
        now: at,
      }),
    );
  }

  // 3. In-flight submissions.
  const inFlight = await repos.submissions.listInFlightByActor(projectId, actorId);
  const rejectedSubmissions = inFlight.map((s) => s.id);
  for (const submission of inFlight) {
    statements.push(
      repos.submissions.transitionStateStatement(submission.id, submission.state, "rejected", at),
    );
    // The queued apply must not land after the author lost access. Failing the
    // outbox row is what actually stops it: transitioning the submission alone
    // would leave the processor holding a payload it still intends to commit.
    if (submission.gitOperationId !== null) {
      statements.push(
        deps.db
          .prepare(
            `UPDATE outbox SET status = 'failed', processed_at = ?
              WHERE git_operation_id = ? AND status IN ('pending', 'processing')`,
          )
          .bind(at, submission.gitOperationId),
      );
    }
    // And the work item goes back to the queue rather than sitting in
    // `applying` forever waiting for a submission that will never be applied.
    statements.push(
      deps.db
        .prepare(
          `UPDATE work_items SET status = 'ready', updated_at = ?
            WHERE id = ? AND status IN ('applying', 'submitted')`,
        )
        .bind(at, submission.workItemId),
    );
  }

  return { statements, releasedLeases, rejectedSubmissions };
}

export function registerPhase7Routes(ctx: Phase7Context): void {
  const { app, deps, repos, clock, services, auth, idem, serialize, now } = ctx;

  const auditStatement = (input: {
    projectId: string;
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    correlationId: string;
    metadata?: unknown;
  }): SqlStatement =>
    repos.auditEvents.insertStatement({
      id: uuidv7(clock.now()),
      projectId: input.projectId,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      correlationId: input.correlationId,
      metadata: input.metadata ?? null,
      createdAt: now(),
    });

  const requireMaintainer = (c: Context<AppEnv>): Response | null => {
    if (authOf(c).role !== "maintainer") {
      return problem(c, "forbidden", {
        detail: "only a maintainer may read or change this book's access control",
      });
    }
    return null;
  };

  /**
   * Guard for the maintainer control plane: project match, membership, scope,
   * the agent pause, and rate limits - but NOT the freeze, because a freeze
   * that blocked its own reversal would be a one-way door. Callers use the
   * session-only wrapper below before entering this guard.
   */
  const controlGuard = (
    c: Context<AppEnv>,
    scope: ApiScope = "chapters:read",
  ): Promise<{ project: ProjectRecord } | { response: Response }> =>
    requireProjectScope(c, services, scope, {
      surface: "control",
      capability: null,
    });

  /** Every project-control surface requires an ambient human session. */
  const humanControlGuard = async (
    c: Context<AppEnv>,
    scope: ApiScope = "chapters:read",
  ): Promise<{ project: ProjectRecord } | { response: Response }> => {
    const denied = requireHumanSession(c);
    if (denied !== null) return { response: denied };
    return controlGuard(c, scope);
  };

  /** Exact maintainer moderation authority, including legacy source tagging. */
  const moderationGuard = (
    c: Context<AppEnv>,
    surface: "control" | "collaboration" = "control",
  ): Promise<{ project: ProjectRecord } | { response: Response }> =>
    requireProjectScope(c, services, "annotations:write", {
      surface,
      capability: null,
      editorial: {
        capabilities: ["feedback:moderate"],
        legacyAction: "feedback:moderate",
      },
    });

  /** The same guard, but frozen with the book (moderation approval commits). */
  const collaborationGuard = (
    c: Context<AppEnv>,
    scope: ApiScope = "chapters:read",
  ): Promise<{ project: ProjectRecord } | { response: Response }> =>
    requireProjectScope(c, services, scope, { capability: null });

  // =========================================================================
  // Seeing (contract "Seeing")
  // =========================================================================

  /**
   * Who has access, their role, when they joined, who added them, and when they
   * last acted.
   *
   * `addedBy` is read from the audit log rather than from a column on the
   * membership. That is honest about what the system actually knows: Phase 2
   * created memberships without recording an author, so for a membership older
   * than this phase the answer is genuinely unknown and the field is `null`
   * rather than a plausible guess. Every membership created or changed from
   * here on leaves a `member.*` event that fills it in.
   */
  app.get("/v1/projects/:projectId/collaborators", auth, async (c) => {
    const guard = await humanControlGuard(c);
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;

    const includeRemoved = c.req.query("includeRemoved") === "true";
    const memberships = (await repos.projectMemberships.listByProject(guard.project.id)).filter(
      (m) => includeRemoved || m.revokedAt === null,
    );

    // Resolved once for the whole list rather than per row: `addedBy` comes
    // from a scan of the audit log, and doing that scan per collaborator would
    // make listing a fifty-person book fifty scans.
    const addedBy = await addedByMap(repos, guard.project.id);

    const items = await Promise.all(
      memberships.map(async (m) => {
        const [actor, lastActedAt] = await Promise.all([
          repos.actors.getById(m.actorId),
          repos.auditEvents.lastActedAt(guard.project.id, m.actorId),
        ]);
        return {
          membershipId: m.id,
          actorId: m.actorId,
          actor: actor === null ? null : actorJson(actor),
          role: m.role,
          roleMeans: ROLE_CONSEQUENCES[m.role],
          scopes: [...apiRoleScopes(m.role)],
          joinedAt: m.createdAt,
          removedAt: m.revokedAt,
          addedByActorId: addedBy.get(m.actorId) ?? null,
          lastActedAt,
          /**
           * An agent actor is a token's identity, not a person's. Surfaced so
           * the collaborator list can say so plainly instead of showing a
           * machine beside the humans with no way to tell them apart.
           */
          isAgent: actor?.type === "agent",
          ownerActorId: actor?.ownerActorId ?? null,
        };
      }),
    );
    return c.json({ items, roleConsequences: ROLE_CONSEQUENCES });
  });

  /**
   * Agent tokens: "name, scopes, owning human, created and last-used times,
   * expiry. Tokens are never re-displayable - only their metadata."
   *
   * `agentTokenJson` has never serialized `tokenHash`, and this route adds
   * nothing to it. There is no code path in the system that can return a token
   * value after the mint response that created it.
   */
  app.get("/v1/projects/:projectId/agent-tokens", auth, async (c) => {
    const guard = await humanControlGuard(c);
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;

    const includeRevoked = c.req.query("includeRevoked") === "true";
    const tokens = (await repos.agentTokens.listByProject(guard.project.id)).filter(
      (t) => includeRevoked || t.revokedAt === null,
    );
    const nowMs = clock.now().getTime();
    const items = await Promise.all(
      tokens.map(async (t) => {
        const [owner, membership] = await Promise.all([
          repos.actors.getById(t.createdBy),
          repos.projectMemberships.getByProjectAndActor(guard.project.id, t.actorId),
        ]);
        const role = membership?.revokedAt === null ? membership.role : null;
        const projection = tokenCapabilityProjection(t, role);
        return {
          ...agentTokenJson(t),
          ...capabilityProjectionJson(projection),
          /** The human who minted it - the "owning human" of the contract. */
          owner: owner === null ? null : actorJson(owner),
          /**
           * The membership role, which is half of the token's effective
           * authority (effective scopes = token.scopes ∩ role bundle). Shown
           * because reading the token's scopes alone would overstate what it
           * can do - and because an agent working a `locked` book is exactly
           * the one holding `maintainer` here.
           */
          role,
          expired: Date.parse(t.expiresAt) <= nowMs,
        };
      }),
    );
    return c.json({ items });
  });

  /**
   * The readable activity view (contract "Seeing": "'who changed this and when'
   * is answerable without a runbook").
   *
   * Newest first, filterable by actor and action. `actor` accepts either an
   * actor id or an external identity (`github:avery`), because the id is what
   * the database stores and the handle is what a person knows.
   */
  app.get("/v1/projects/:projectId/audit", auth, async (c) => {
    const guard = await humanControlGuard(c);
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;

    const limit = ctx.parseLimit(c);
    if (limit instanceof Response) return limit;

    const actorParam = c.req.query("actor");
    let actorId: string | null = null;
    if (actorParam !== undefined && actorParam.length > 0) {
      const byIdentity = await repos.actors.getByExternalIdentity(actorParam);
      actorId = byIdentity?.id ?? actorParam;
    }
    const action = c.req.query("action") ?? null;
    const cursor = c.req.query("cursor") ?? null;

    const events = await repos.auditEvents.listRecent(guard.project.id, {
      actorId,
      action,
      limit,
      beforeId: cursor,
    });
    // Actor display names are resolved once per distinct actor rather than per
    // row: an audit page is usually one actor doing many things.
    const actors = new Map<string, ActorRecord | null>();
    for (const event of events) {
      if (event.actorId !== null && !actors.has(event.actorId)) {
        actors.set(event.actorId, await repos.actors.getById(event.actorId));
      }
    }
    const last = events[events.length - 1];
    return c.json({
      items: events.map((e) => {
        const actor = e.actorId === null ? null : (actors.get(e.actorId) ?? null);
        return {
          id: e.id,
          at: e.createdAt,
          action: e.action,
          actorId: e.actorId,
          actorName: actor?.displayName ?? null,
          actorIdentity: actor?.externalIdentity ?? null,
          actorType: actor?.type ?? null,
          targetType: e.targetType,
          targetId: e.targetId,
          correlationId: e.correlationId,
          metadata: e.metadata,
        };
      }),
      nextCursor: events.length === limit && last !== undefined ? last.id : null,
    });
  });

  /**
   * The current access state. Member-readable rather than maintainer-only: a
   * contributor who gets a 423 deserves to be able to see that the book is
   * locked rather than concluding the API is broken. The reason strings are
   * included because a freeze reason is written by a maintainer FOR the people
   * it affects.
   */
  app.get("/v1/projects/:projectId/access", auth, async (c) => {
    const guard = await humanControlGuard(c);
    if ("response" in guard) return guard.response;
    const state = await loadAccessState(repos, guard.project.id);
    return c.json({
      ...accessStateJson(state),
      pendingModerationCount: state.requiresApproval
        ? await repos.pendingAnnotations.countPending(guard.project.id)
        : 0,
    });
  });

  /** The documented ceilings (exit criterion 1). Readable by any member. */
  app.get("/v1/projects/:projectId/rate-limits", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "chapters:read", {
      editorial: { capabilities: ["chapters:read"] },
    });
    if ("response" in guard) return guard.response;
    return c.json(rateLimitsJson());
  });

  // =========================================================================
  // Restricting: freeze and pause agents (contract "Restricting")
  // =========================================================================

  /**
   * Freeze / unfreeze.
   *
   * A reason is REQUIRED to freeze and optional to unfreeze, which is not an
   * oversight: freezing is the act someone will need explained an hour later
   * (and it is the act that stops everyone else working), while unfreezing is
   * self-explanatory - the emergency is over.
   */
  const freezeRoute = (frozen: boolean) => async (c: Context<AppEnv>) => {
    // `members:manage`, not `chapters:read`: the freeze is the book's stop
    // button, and a credential that can press it can also stop everyone else.
    const guard = await humanControlGuard(c, "members:manage");
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;
    const body = await ctx.readJson(c);
    if (body instanceof Response) return body;
    const parsed = (frozen ? freezeSchema : unfreezeSchema).safeParse(body ?? {});
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const reason = (parsed.data as { reason?: string }).reason ?? null;
    const a = authOf(c);
    const at = now();

    return serialize(guard.project.id, async () => {
      const before = await loadAccessState(repos, guard.project.id);
      if (before.frozen === frozen) {
        // Idempotent by state, not by key: re-freezing an already frozen book
        // must not rewrite who froze it and why. The first freeze is the one
        // that matters.
        const responseBody = {
          ...accessStateJson(before),
          changed: false,
          correlationId: c.get("correlationId"),
        };
        const claims = ctx.claimStatements(c, 200, responseBody);
        if (claims.length > 0) await deps.db.batch(claims);
        return c.json(responseBody, 200);
      }

      const state = {
        ...before,
        frozen,
        frozenAt: frozen ? at : null,
        frozenByActorId: frozen ? a.actor.id : null,
        freezeReason: frozen ? reason : null,
      };
      const responseBody = {
        ...accessStateJson(state),
        changed: true,
        correlationId: c.get("correlationId"),
      };
      await deps.db.batch([
        repos.projectAccessControls.setFreezeStatement({
          projectId: guard.project.id,
          frozenAt: frozen ? at : null,
          actorId: a.actor.id,
          reason,
          at,
        }),
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: frozen ? "project.freeze" : "project.unfreeze",
          targetType: "project",
          targetId: guard.project.id,
          correlationId: c.get("correlationId"),
          metadata: { reason },
        }),
        repos.events.appendStatement({
          projectId: guard.project.id,
          /**
           * NO `reason` in the payload.
           *
           * The event feed is served by `requireReadOrPublic`, which on a
           * deployment with `PUBLIC_ANNOTATIONS=true` answers a caller holding
           * no credential at all - while `GET /access`, which carries the same
           * reason, correctly 401s that caller. A freeze reason is incident
           * prose written by a maintainer in a hurry ("rotating the leaked
           * token tok_…"), so publishing it to the internet is a disclosure the
           * author never agreed to. The fact that the book froze is not
           * sensitive and is what a listening client needs; the reason stays in
           * the audit row and in `/access`, both of which require membership.
           */
          type: frozen ? "project_frozen" : "project_unfrozen",
          payload: {},
          createdAt: at,
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      ]);
      return c.json(responseBody, 200);
    });
  };

  /**
   * Requeue a git operation that ran out of retries.
   *
   * The outbox exists so an accepted write is never lost, but a `failed`
   * operation had no way back: the content sat in `pending_git` and nothing
   * retried it. Availability failures no longer spend the retry budget at all
   * (the processor defers them instead), so reaching `failed` now means a
   * bounded number of genuine attempts were made - and after the operator has
   * dealt with whatever caused it, there has to be a way to say "try again".
   *
   * Deliberately narrow: it only moves a `failed` operation back to `queued`
   * and its outbox row back to `pending`. It re-runs the existing plan; it
   * does not rewrite it. An operation that failed because its content is
   * invalid will fail again, which is the honest outcome.
   *
   * COLLABORATION surface, not control: requeuing puts a payload back on the
   * path to a commit, and access-control.ts applies exactly this reasoning to
   * moderation approval - "approval commits new content, which is the thing the
   * freeze exists to stop". A retry accepted during a freeze would have the
   * mirror committing while the author was still looking, which is precisely
   * what they pressed the stop button to prevent. The operation is not lost:
   * it stays `failed` and can be requeued the moment the freeze lifts.
   */
  app.post(
    "/v1/projects/:projectId/operations/:operationId/retry",
    auth,
    idem,
    async (c: Context<AppEnv>) => {
      const sessionOnly = requireHumanSession(c);
      if (sessionOnly !== null) return sessionOnly;
      const guard = await collaborationGuard(c);
      if ("response" in guard) return guard.response;
      const denied = requireMaintainer(c);
      if (denied !== null) return denied;

      const operationId = c.req.param("operationId") ?? "";
      const op = await repos.gitOperations.getById(operationId);
      if (op === null || op.projectId !== guard.project.id) {
        return problem(c, "not-found", { detail: "unknown operation" });
      }
      if (op.state !== "failed") {
        return problem(c, "state-conflict", {
          detail: `operation is ${op.state}; only a failed operation can be requeued`,
        });
      }
      const row = await repos.outbox.getByGitOperationId(operationId);
      if (row === null) {
        return problem(c, "state-conflict", {
          detail: "the operation has no outbox row, so there is no work to requeue",
        });
      }

      const a = authOf(c);
      const at = now();
      return serialize(guard.project.id, async () => {
        const responseBody = {
          operationId,
          state: "queued",
          correlationId: c.get("correlationId"),
        };
        await deps.db.batch([
          repos.gitOperations.updateStateStatement(operationId, {
            state: "queued",
            updatedAt: at,
            attempts: 0,
            error: null,
          }),
          repos.outbox.markPendingStatement(row.id),
          auditStatement({
            projectId: guard.project.id,
            actorId: a.actor.id,
            action: "operation.retry",
            targetType: "git_operation",
            targetId: operationId,
            correlationId: c.get("correlationId"),
            metadata: { previousError: op.error },
          }),
          ...ctx.claimStatements(c, 202, responseBody),
        ]);
        await ctx.notifyMutation(guard.project.id);
        return c.json(responseBody, 202);
      });
    },
  );

  app.post("/v1/projects/:projectId/access/freeze", auth, idem, freezeRoute(true));
  app.post("/v1/projects/:projectId/access/unfreeze", auth, idem, freezeRoute(false));

  /**
   * Pause / resume agents.
   *
   * "Agents are the population most likely to misbehave at volume, and an
   * author should be able to stop them without dismantling their human
   * collaboration." Nothing is revoked: every token keeps its identity, its
   * scopes, its expiry, and its history, and resuming restores all of it. The
   * destructive sibling is `agent-tokens/revoke-all` below.
   */
  const pauseRoute = (paused: boolean) => async (c: Context<AppEnv>) => {
    // Pausing agents is a statement about credentials, so it is gated on the
    // credential scope: `tokens:manage`.
    const guard = await humanControlGuard(c, "tokens:manage");
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;
    const body = await ctx.readJson(c);
    if (body instanceof Response) return body;
    const parsed = (paused ? pauseAgentsSchema : resumeAgentsSchema).safeParse(body ?? {});
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const reason = (parsed.data as { reason?: string }).reason ?? null;
    const a = authOf(c);
    const at = now();

    return serialize(guard.project.id, async () => {
      const before = await loadAccessState(repos, guard.project.id);
      if (before.agentsPaused === paused) {
        const responseBody = {
          ...accessStateJson(before),
          changed: false,
          correlationId: c.get("correlationId"),
        };
        const claims = ctx.claimStatements(c, 200, responseBody);
        if (claims.length > 0) await deps.db.batch(claims);
        return c.json(responseBody, 200);
      }
      const state = {
        ...before,
        agentsPaused: paused,
        agentsPausedAt: paused ? at : null,
        agentsPausedByActorId: paused ? a.actor.id : null,
        agentsPauseReason: paused ? reason : null,
      };
      const affected = await repos.agentTokens.listActiveByProject(guard.project.id);
      const responseBody = {
        ...accessStateJson(state),
        changed: true,
        affectedTokens: affected.length,
        correlationId: c.get("correlationId"),
      };
      await deps.db.batch([
        repos.projectAccessControls.setAgentsPausedStatement({
          projectId: guard.project.id,
          pausedAt: paused ? at : null,
          actorId: a.actor.id,
          reason,
          at,
        }),
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: paused ? "agents.pause" : "agents.resume",
          targetType: "project",
          targetId: guard.project.id,
          correlationId: c.get("correlationId"),
          metadata: { reason, affectedTokens: affected.length },
        }),
        repos.events.appendStatement({
          projectId: guard.project.id,
          type: paused ? "agents_paused" : "agents_resumed",
          /** No `reason`, for the same disclosure reason as `project_frozen`. */
          payload: { affectedTokens: affected.length },
          createdAt: at,
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      ]);
      return c.json(responseBody, 200);
    });
  };

  app.post("/v1/projects/:projectId/access/pause-agents", auth, idem, pauseRoute(true));
  app.post("/v1/projects/:projectId/access/resume-agents", auth, idem, pauseRoute(false));

  // =========================================================================
  // Restricting: roles (contract "Restricting" - "Change a role")
  // =========================================================================

  /**
   * Change a collaborator's role.
   *
   * Two guard rails, both about not locking the author out of their own book:
   * the last maintainer cannot be demoted, and a maintainer cannot demote
   * themselves while they are the only one. A book with no maintainer has no
   * one who can mint a token, change a setting, or lift a freeze - and no path
   * back that does not involve a database console, which is the thing this
   * whole section exists to make unnecessary.
   *
   * This is also the route that grants an author's agent the maintainer role so
   * it keeps working under `locked`. That is deliberate and it is a decision
   * the author makes explicitly, which is exactly the contract's point: "a
   * deliberate grant rather than an implicit inheritance from their owner".
   */
  app.patch("/v1/projects/:projectId/collaborators/:actorId", auth, idem, async (c) => {
    const guard = await humanControlGuard(c, "members:manage");
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;
    const body = await ctx.readJson(c);
    if (body instanceof Response) return body;
    const parsed = roleChangeSchema.safeParse(body);
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const targetActorId = c.req.param("actorId");
    const a = authOf(c);

    return serialize(guard.project.id, async () => {
      const membership = await repos.projectMemberships.getByProjectAndActor(
        guard.project.id,
        targetActorId,
      );
      if (membership === null || membership.revokedAt !== null) {
        return problem(c, "not-found", { detail: "unknown collaborator" });
      }
      if (membership.role === parsed.data.role) {
        const responseBody = {
          actorId: targetActorId,
          role: membership.role,
          roleMeans: ROLE_CONSEQUENCES[membership.role],
          changed: false,
          correlationId: c.get("correlationId"),
        };
        const claims = ctx.claimStatements(c, 200, responseBody);
        if (claims.length > 0) await deps.db.batch(claims);
        return c.json(responseBody, 200);
      }
      if (membership.role === "maintainer" && parsed.data.role !== "maintainer") {
        const remaining = await countMaintainers(repos, guard.project.id, targetActorId);
        if (remaining.total === 0) {
          return problem(c, "domain-rule-failed", {
            detail:
              "this is the book's last maintainer. Promote someone else to maintainer first - a book with no maintainer cannot change its own settings, tokens, roles, or freeze.",
          });
        }
        if (remaining.human === 0 && (await isHumanActor(repos, targetActorId))) {
          return problem(c, "domain-rule-failed", {
            detail:
              "this is the book's last human maintainer. Promote another person to maintainer first - the remaining maintainers are agents, and a book administered only by agents has no one who can revoke them.",
          });
        }
      }

      const at = now();
      const previousRole = membership.role;
      const responseBody = {
        actorId: targetActorId,
        role: parsed.data.role,
        previousRole,
        roleMeans: ROLE_CONSEQUENCES[parsed.data.role],
        scopes: [...apiRoleScopes(parsed.data.role)],
        changed: true,
        correlationId: c.get("correlationId"),
      };
      await deps.db.batch([
        deps.db
          .prepare(`UPDATE project_memberships SET role = ?, scopes = ? WHERE id = ?`)
          .bind(
            parsed.data.role,
            JSON.stringify([...apiRoleScopes(parsed.data.role)]),
            membership.id,
          ),
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: "member.role_change",
          targetType: "membership",
          targetId: targetActorId,
          correlationId: c.get("correlationId"),
          metadata: {
            membershipId: membership.id,
            from: previousRole,
            to: parsed.data.role,
            reason: parsed.data.reason ?? null,
          },
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      ]);
      return c.json(responseBody, 200);
    });
  });

  // =========================================================================
  // Revoking (contract "Revoking")
  // =========================================================================

  /**
   * Remove a collaborator.
   *
   * Effective on the next request: the membership is revoked AND the actor's
   * sessions are killed in the same batch, so the cookie in their browser stops
   * authenticating immediately rather than at its seven-day expiry. Their
   * leases are released, their in-flight submissions rejected, and everything
   * they already contributed is left untouched.
   */
  app.delete("/v1/projects/:projectId/collaborators/:actorId", auth, idem, async (c) => {
    const guard = await humanControlGuard(c, "members:manage");
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;
    const body = await ctx.readJson(c).catch(() => null);
    const parsed = removeCollaboratorSchema.safeParse(
      body instanceof Response || body === null ? {} : (body ?? {}),
    );
    const reason = parsed.success ? (parsed.data.reason ?? null) : null;
    const targetActorId = c.req.param("actorId");
    const a = authOf(c);

    return serialize(guard.project.id, async () => {
      const membership = await repos.projectMemberships.getByProjectAndActor(
        guard.project.id,
        targetActorId,
      );
      if (membership === null || membership.revokedAt !== null) {
        return problem(c, "not-found", { detail: "unknown collaborator" });
      }
      if (membership.role === "maintainer") {
        const remaining = await countMaintainers(repos, guard.project.id, targetActorId);
        if (remaining.total === 0) {
          return problem(c, "domain-rule-failed", {
            detail:
              "this is the book's last maintainer and cannot be removed. Promote someone else to maintainer first.",
          });
        }
        if (remaining.human === 0 && (await isHumanActor(repos, targetActorId))) {
          return problem(c, "domain-rule-failed", {
            detail:
              "this is the book's last human maintainer and cannot be removed. Promote another person to maintainer first - the remaining maintainers are agents, and a book administered only by agents has no one who can revoke them.",
          });
        }
      }

      const at = now();
      const cascade = await revocationCascadeStatements({
        deps,
        repos,
        clock,
        projectId: guard.project.id,
        actorId: targetActorId,
        at,
      });

      // Any agent token this actor OWNS is revoked with them. A departing
      // collaborator's agents are their agents; leaving them running would make
      // the removal cosmetic.
      const ownedTokens = (await repos.agentTokens.listActiveByProject(guard.project.id)).filter(
        (t) => t.createdBy === targetActorId,
      );

      const responseBody = {
        actorId: targetActorId,
        removed: true,
        sessionsInvalidated: true,
        leasesReleased: cascade.releasedLeases,
        submissionsRejected: cascade.rejectedSubmissions,
        agentTokensRevoked: ownedTokens.map((t) => t.id),
        /** Said plainly, because the interface must not imply otherwise. */
        contributionsRetained: true,
        correlationId: c.get("correlationId"),
      };

      await deps.db.batch([
        repos.projectMemberships.revokeStatement(membership.id, at),
        ...cascade.statements,
        ...ownedTokens.map((t) => repos.agentTokens.revokeStatement(t.id, at)),
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: "member.remove",
          targetType: "membership",
          targetId: targetActorId,
          correlationId: c.get("correlationId"),
          metadata: {
            membershipId: membership.id,
            role: membership.role,
            reason,
            leasesReleased: cascade.releasedLeases.length,
            submissionsRejected: cascade.rejectedSubmissions.length,
            agentTokensRevoked: ownedTokens.length,
          },
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      ]);
      return c.json(responseBody, 200);
    });
  });

  /**
   * Revoke every agent token at once, "for a suspected leak".
   *
   * One statement revokes them all (see `revokeAllForProjectStatement`) so
   * there is no window in which the leaked token is the one not yet reached,
   * and each token's holder gets the full revocation cascade - a leaked token
   * mid-submission must not get its edit committed after the alarm was raised.
   */
  app.post("/v1/projects/:projectId/agent-tokens/revoke-all", auth, idem, async (c) => {
    const guard = await humanControlGuard(c, "tokens:manage");
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;
    const body = await ctx.readJson(c);
    if (body instanceof Response) return body;
    const parsed = revokeAllTokensSchema.safeParse(body);
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const a = authOf(c);

    return serialize(guard.project.id, async () => {
      const at = now();
      const tokens = await repos.agentTokens.listActiveByProject(guard.project.id);
      const statements: SqlStatement[] = [
        repos.agentTokens.revokeAllForProjectStatement(guard.project.id, at),
      ];
      const released: { leaseId: string; workItemId: string }[] = [];
      const rejected: string[] = [];
      for (const token of tokens) {
        const cascade = await revocationCascadeStatements({
          deps,
          repos,
          clock,
          projectId: guard.project.id,
          actorId: token.actorId,
          at,
        });
        statements.push(...cascade.statements);
        released.push(...cascade.releasedLeases);
        rejected.push(...cascade.rejectedSubmissions);
      }

      const responseBody = {
        revoked: tokens.map((t) => ({ id: t.id, name: t.name })),
        leasesReleased: released,
        submissionsRejected: rejected,
        contributionsRetained: true,
        correlationId: c.get("correlationId"),
      };
      statements.push(
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: "agent_token.revoke_all",
          targetType: "project",
          targetId: guard.project.id,
          correlationId: c.get("correlationId"),
          metadata: {
            reason: parsed.data.reason,
            revoked: tokens.length,
            leasesReleased: released.length,
            submissionsRejected: rejected.length,
          },
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      );
      await deps.db.batch(statements);
      return c.json(responseBody, 200);
    });
  });

  // =========================================================================
  // Moderating (contract "Moderating")
  // =========================================================================

  /**
   * The queue: "the comment, its target passage, the author's history with this
   * book, and approve / reject actions".
   */
  app.get("/v1/projects/:projectId/moderation/queue", auth, async (c) => {
    const guard = await moderationGuard(c);
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;
    const limit = ctx.parseLimit(c);
    if (limit instanceof Response) return limit;

    const statusParam = c.req.query("status") ?? "pending";
    const statusParsed = z.enum(["pending", "approved", "rejected", "all"]).safeParse(statusParam);
    if (!statusParsed.success) {
      return problem(c, "validation-failed", {
        detail: "status must be one of pending, approved, rejected, all",
      });
    }
    const cursor = c.req.query("cursor");
    const rows = await repos.pendingAnnotations.listByProject(guard.project.id, {
      ...(statusParsed.data === "all" ? {} : { status: statusParsed.data }),
      limit,
      ...(cursor !== undefined ? { afterId: cursor } : {}),
    });

    const items = await Promise.all(
      rows.map(async (row) => {
        const [author, chapter, history] = await Promise.all([
          repos.actors.getById(row.authorActorId),
          repos.chapters.getById(row.chapterId),
          repos.pendingAnnotations.authorHistory(guard.project.id, row.authorActorId),
        ]);
        return {
          ...pendingAnnotationJson(row),
          author: author === null ? null : actorJson(author),
          chapter:
            chapter === null
              ? null
              : { id: chapter.id, title: chapter.title, slug: chapter.slug, revision: chapter.revision },
          /**
           * "the author's history with this book" - how many of their previous
           * submissions were approved and how many rejected. A moderator
           * looking at their tenth spam comment should be able to see that it
           * is the tenth.
           */
          authorHistory: history,
        };
      }),
    );
    const last = rows[rows.length - 1];
    return c.json({
      items,
      nextCursor: rows.length === limit && last !== undefined ? last.id : null,
      pendingCount: await repos.pendingAnnotations.countPending(guard.project.id),
    });
  });

  /**
   * Approve one queued annotation.
   *
   * This is the moment the comment becomes durable: it is INSERTed into
   * `annotations` (carrying the queue row's id forward, so the author's link
   * keeps working) and an ordinary `annotation.create` outbox row is enqueued.
   * From here it is indistinguishable from an annotation written under a
   * permissive policy - same mirroring, same votes, same rules - which is
   * precisely the contract's "approval mirrors it to Git as a normal
   * annotation".
   *
   * Attribution stays with the SUBMITTER, not the approving maintainer: the
   * outbox payload carries the author's actor ref, so the commit trailer
   * credits the person who wrote the words.
   *
   * ## The anchor is re-checked here, not trusted from the queue row
   *
   * `POST .../annotations` enforces two things unconditionally (contract §4):
   * the submitted `chapterRevision` must match the projected revision, and a
   * non-chapter-scoped `target.blockId` must exist in that revision. A queued
   * annotation satisfied both WHEN IT WAS WRITTEN - and then sat in the queue
   * while the chapter kept moving. Approving it without re-asking would commit
   * an annotation anchored at revision 4 into a book at revision 7, pointing at
   * a block id that may no longer exist: a permanent, mirrored record that the
   * create path would have refused outright. The queue delays the write; it
   * does not exempt it.
   *
   * A stale anchor is reported as its own outcome rather than a generic
   * failure, because it is recoverable in a way "author unknown" is not - the
   * author can re-anchor and resubmit, and in bulk the other 199 items must not
   * be held hostage to it.
   */
  const approveOne = async (input: {
    c: Context<AppEnv>;
    project: ProjectRecord;
    pending: PendingAnnotationRecord;
    approverActorId: string;
    correlationId: string;
    at: string;
  }): Promise<
    | { statements: SqlStatement[]; operationId: string }
    | { problem: Response; outcome: "author-unknown" | "stale-anchor" }
  > => {
    const { c, project, pending, approverActorId, correlationId, at } = input;
    const author = await repos.actors.getById(pending.authorActorId);
    if (author === null) {
      return {
        outcome: "author-unknown",
        problem: problem(c, "state-conflict", { detail: "annotation author is unknown" }),
      };
    }

    const chapter = await repos.chapters.getById(pending.chapterId);
    if (chapter === null || chapter.projectId !== project.id) {
      return {
        outcome: "stale-anchor",
        problem: problem(c, "state-conflict", {
          detail: "the chapter this annotation targets no longer exists",
        }),
      };
    }
    if (pending.chapterRevision !== chapter.revision) {
      return {
        outcome: "stale-anchor",
        problem: problem(c, "revision-conflict", {
          detail: `this annotation was queued against chapter revision ${pending.chapterRevision}; the chapter is now at revision ${chapter.revision}. Approving it would commit an annotation anchored to text that has since changed.`,
          projectedRevision: chapter.revision,
          queuedRevision: pending.chapterRevision,
        }),
      };
    }
    if (pending.scope !== "chapter") {
      const blockId = (pending.target as { blockId?: unknown } | null)?.blockId;
      if (typeof blockId !== "string" || !chapter.blockIds.includes(blockId)) {
        return {
          outcome: "stale-anchor",
          problem: problem(c, "unknown-block", {
            detail: `block ${String(blockId)} does not exist in chapter revision ${chapter.revision}`,
          }),
        };
      }
    }
    const command = ctx.commandStatements({
      project,
      correlationId,
      actorId: approverActorId,
      action: "annotation.approve",
      targetType: "annotation",
      targetId: pending.id,
      outboxKind: "annotation.create",
      outboxPayload: {
        type: "annotation.create",
        annotationId: pending.id,
        chapterId: pending.chapterId,
        actorRef: actorRefOf(author),
      },
      metadata: {
        kind: pending.kind,
        scope: pending.scope,
        chapterId: pending.chapterId,
        moderated: true,
        authorActorId: pending.authorActorId,
      },
    });
    return {
      operationId: command.operationId,
      statements: [
        command.statements[0] as SqlStatement, // git operation first (FK)
        repos.annotations.insertStatement({
          id: pending.id,
          projectId: project.id,
          chapterId: pending.chapterId,
          kind: pending.kind,
          scope: pending.scope,
          chapterRevision: pending.chapterRevision,
          target: pending.target ?? null,
          authorActorId: pending.authorActorId,
          body: pending.body,
          status: "pending_git",
          gitOperationId: command.operationId,
          supersededBy: null,
          // The ORIGINAL submission time, not the approval time. When the
          // comment was written is a fact about the comment; when it was
          // approved is recorded separately on the queue row and in the audit
          // event. Overwriting the first with the second would silently
          // reorder a thread against the chapter it discusses.
          createdAt: pending.createdAt,
          updatedAt: at,
        }),
        ...command.statements.slice(1),
        repos.pendingAnnotations.resolveStatement({
          id: pending.id,
          status: "approved",
          reviewedByActorId: approverActorId,
          reviewedAt: at,
          rejectionReason: null,
          approvedAnnotationId: pending.id,
        }),
        repos.events.appendStatement({
          projectId: project.id,
          type: "annotation_created",
          payload: {
            annotationId: pending.id,
            chapterId: pending.chapterId,
            kind: pending.kind,
            scope: pending.scope,
            moderated: true,
          },
          createdAt: at,
        }),
      ],
    };
  };

  app.post("/v1/projects/:projectId/moderation/:pendingId/approve", auth, idem, async (c) => {
    // Collaboration surface: approving commits new content, which is exactly
    // what a freeze exists to stop.
    const guard = await moderationGuard(c, "collaboration");
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;
    const a = authOf(c);

    return serialize(guard.project.id, async () => {
      const pending = await repos.pendingAnnotations.getById(c.req.param("pendingId"));
      if (pending === null || pending.projectId !== guard.project.id) {
        return problem(c, "not-found", { detail: "unknown queued annotation" });
      }
      if (pending.status !== "pending") {
        return problem(c, "moderation-already-reviewed", {
          detail: `this annotation was already ${pending.status}`,
          status: pending.status,
        });
      }
      const at = now();
      const correlationId = c.get("correlationId") ?? "";
      const built = await approveOne({
        c,
        project: guard.project,
        pending,
        approverActorId: a.actor.id,
        correlationId,
        at,
      });
      if ("problem" in built) return built.problem;

      const responseBody = {
        pendingId: pending.id,
        annotationId: pending.id,
        operationId: built.operationId,
        status: "queued",
        correlationId,
      };
      await deps.db.batch([
        ...built.statements,
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: "moderation.approve",
          targetType: "annotation",
          targetId: pending.id,
          correlationId,
          metadata: { authorActorId: pending.authorActorId },
        }),
        ...ctx.claimStatements(c, 202, responseBody),
      ]);
      await ctx.notifyMutation(guard.project.id);
      return c.json(responseBody, 202);
    });
  });

  /**
   * Reject one queued annotation.
   *
   * "Rejection takes an optional reason, notifies nobody, and retains the
   * record in the database (never in Git) so a mistake is recoverable and a
   * pattern of abuse is visible."
   *
   * Nothing is written to Git and nothing is deleted - the row's status
   * changes, its reviewer and reason are recorded, and that is all. Because the
   * annotation never entered `annotations`, there was never anything in the
   * repository to leave a trace in, which is what makes exit criterion 10's
   * "rejection leaves no trace in the repository" true by construction rather
   * than by cleanup.
   *
   * Control surface: rejecting is database-only and is part of looking at what
   * went wrong, so a freeze does not block it.
   */
  app.post("/v1/projects/:projectId/moderation/:pendingId/reject", auth, idem, async (c) => {
    const guard = await moderationGuard(c);
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;
    const body = await ctx.readJson(c);
    if (body instanceof Response) return body;
    const parsed = rejectPendingSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const a = authOf(c);

    return serialize(guard.project.id, async () => {
      const pending = await repos.pendingAnnotations.getById(c.req.param("pendingId"));
      if (pending === null || pending.projectId !== guard.project.id) {
        return problem(c, "not-found", { detail: "unknown queued annotation" });
      }
      if (pending.status !== "pending") {
        return problem(c, "moderation-already-reviewed", {
          detail: `this annotation was already ${pending.status}`,
          status: pending.status,
        });
      }
      const at = now();
      const responseBody = {
        pendingId: pending.id,
        status: "rejected",
        retained: true,
        correlationId: c.get("correlationId"),
      };
      await deps.db.batch([
        repos.pendingAnnotations.resolveStatement({
          id: pending.id,
          status: "rejected",
          reviewedByActorId: a.actor.id,
          reviewedAt: at,
          rejectionReason: parsed.data.reason ?? null,
          approvedAnnotationId: null,
        }),
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: "moderation.reject",
          targetType: "annotation",
          targetId: pending.id,
          correlationId: c.get("correlationId"),
          metadata: {
            authorActorId: pending.authorActorId,
            reason: parsed.data.reason ?? null,
          },
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      ]);
      return c.json(responseBody, 200);
    });
  });

  /**
   * Bulk approve / bulk reject, "because a moderation queue nobody can clear is
   * a moderation queue nobody uses".
   *
   * Per-item outcomes rather than all-or-nothing: in a queue of two hundred,
   * one row already reviewed by a co-maintainer must not fail the other
   * hundred and ninety-nine. Each item reports its own result and the response
   * summarises.
   *
   * Bulk approve is gated as a collaboration write (it commits); bulk reject is
   * control-plane, matching the single-item routes.
   */
  app.post("/v1/projects/:projectId/moderation/bulk", auth, idem, async (c) => {
    const body = await ctx.readJson(c);
    if (body instanceof Response) return body;
    const parsed = bulkModerationSchema.safeParse(body);
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const guard = await moderationGuard(
      c,
      parsed.data.action === "approve" ? "collaboration" : "control",
    );
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;
    const a = authOf(c);

    return serialize(guard.project.id, async () => {
      const at = now();
      const correlationId = c.get("correlationId") ?? "";
      const statements: SqlStatement[] = [];
      const results: { pendingId: string; outcome: string; annotationId?: string }[] = [];
      let approved = 0;
      let rejected = 0;

      for (const id of parsed.data.ids) {
        const pending = await repos.pendingAnnotations.getById(id);
        if (pending === null || pending.projectId !== guard.project.id) {
          results.push({ pendingId: id, outcome: "not-found" });
          continue;
        }
        if (pending.status !== "pending") {
          results.push({ pendingId: id, outcome: `already-${pending.status}` });
          continue;
        }
        if (parsed.data.action === "approve") {
          const built = await approveOne({
            c,
            project: guard.project,
            pending,
            approverActorId: a.actor.id,
            correlationId,
            at,
          });
          if ("problem" in built) {
            // Per-item, never fatal: one annotation whose chapter moved on must
            // not fail the other hundred and ninety-nine.
            results.push({ pendingId: id, outcome: built.outcome });
            continue;
          }
          statements.push(...built.statements);
          results.push({ pendingId: id, outcome: "approved", annotationId: pending.id });
          approved += 1;
        } else {
          statements.push(
            repos.pendingAnnotations.resolveStatement({
              id: pending.id,
              status: "rejected",
              reviewedByActorId: a.actor.id,
              reviewedAt: at,
              rejectionReason: parsed.data.reason ?? null,
              approvedAnnotationId: null,
            }),
          );
          results.push({ pendingId: id, outcome: "rejected" });
          rejected += 1;
        }
      }

      const responseBody = {
        action: parsed.data.action,
        approved,
        rejected,
        results,
        correlationId,
      };
      statements.push(
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: parsed.data.action === "approve" ? "moderation.bulk_approve" : "moderation.bulk_reject",
          targetType: "project",
          targetId: guard.project.id,
          correlationId,
          metadata: { requested: parsed.data.ids.length, approved, rejected },
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      );
      await deps.db.batch(statements);
      if (approved > 0) await ctx.notifyMutation(guard.project.id);
      return c.json(responseBody, 200);
    });
  });
}

/**
 * A queued annotation as JSON. Shaped like `annotationJson` where the fields
 * coincide so a client can render one card for both, with `moderation` naming
 * the difference - that is the "badged as awaiting review" of the contract.
 */
export function pendingAnnotationJson(p: PendingAnnotationRecord): Record<string, unknown> {
  return {
    id: p.id,
    projectId: p.projectId,
    chapterId: p.chapterId,
    kind: p.kind,
    scope: p.scope,
    chapterRevision: p.chapterRevision,
    target: p.target,
    authorActorId: p.authorActorId,
    body: p.body,
    /**
     * Deliberately NOT one of the `annotations.status` values: a queued row is
     * not an annotation in any state, and giving it a status from that
     * vocabulary would invite a client to treat it as one.
     */
    moderation: {
      state: p.status,
      reviewedByActorId: p.reviewedByActorId,
      reviewedAt: p.reviewedAt,
      rejectionReason: p.rejectionReason,
    },
    /** Never mirrored to Git while pending; there is nothing to point at. */
    gitOperationId: null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * Live maintainers other than `excludingActorId`, counted twice: in total, and
 * restricted to HUMAN actors.
 *
 * The human count exists because "the book still has a maintainer" turned out
 * to be too weak a guard rail. An author's agent may legitimately hold the
 * maintainer role (that is how a `locked` book stays annotatable), and the
 * total-count check was happy to let the last human maintainer be demoted or
 * removed as long as such an agent remained - leaving a book administered
 * exclusively by a machine, with the person who wrote it locked out and no way
 * back that does not involve a database console. That is the exact outcome
 * every other guard rail in this section exists to prevent, so it is checked
 * for the population that matters rather than for the row count.
 */
async function countMaintainers(
  repos: Repositories,
  projectId: string,
  excludingActorId: string,
): Promise<{ total: number; human: number }> {
  const memberships = await repos.projectMemberships.listByProject(projectId);
  const others = memberships.filter(
    (m) => m.revokedAt === null && m.role === "maintainer" && m.actorId !== excludingActorId,
  );
  const actors = await Promise.all(others.map((m) => repos.actors.getById(m.actorId)));
  return {
    total: others.length,
    // An actor row that has vanished is not evidence of a human maintainer.
    human: actors.filter((a) => a !== null && a.type === "human").length,
  };
}

/** True when this actor is a person rather than an agent token's identity. */
async function isHumanActor(repos: Repositories, actorId: string): Promise<boolean> {
  const actor = await repos.actors.getById(actorId);
  return actor !== null && actor.type === "human";
}

/**
 * Who granted each membership, from the audit log's `member.add` events.
 *
 * Deliberately narrow. Only `member.add` counts - a later `member.role_change`
 * says who CHANGED the role, which is a different fact, and reporting it as
 * "added by" would be quietly wrong in exactly the case an author is vetting.
 *
 * The answer is `null` whenever nobody granted the membership: a membership
 * created before this phase, the seeded initial maintainer, and a dev-mode
 * self-login all genuinely have no granting actor. Null is the honest answer
 * there, and a plausible-looking guess would be worse than an empty column in a
 * view whose whole purpose is vetting.
 */
async function addedByMap(
  repos: Repositories,
  projectId: string,
): Promise<Map<string, string>> {
  const events = await repos.auditEvents.listRecent(projectId, {
    action: "member.add",
    limit: 500,
  });
  const map = new Map<string, string>();
  // Newest-first, so iterating forward and letting earlier entries win leaves
  // the FIRST grant in place - the one that actually added them.
  for (const event of events) {
    if (event.targetId !== null && event.actorId !== null) {
      map.set(event.targetId, event.actorId);
    }
  }
  return map;
}

function issueList(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
