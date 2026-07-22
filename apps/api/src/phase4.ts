/**
 * Phase 4 routes (Phase 4 contract §2-§4): lease claim/recover/renew/release
 * with lazy expiry, the §15.3 task bundle, and the submission command feeding
 * the §5 apply pipeline (`submission.apply` outbox rows drained by the
 * repo-coordinator processor with the injected `submission-applier.ts`).
 *
 * Concurrency: every command runs in the SAME per-project serial queue as the
 * Phase 3 commands; the partial unique index `idx_leases_active_work_item` is
 * the cross-isolate arbiter that makes two simultaneous claims produce
 * exactly one 201 (contract §2), and work-item status changes use the
 * NULL-abort compare-and-swap so a raced batch rolls back atomically.
 *
 * Lease tokens: minted here, returned exactly once per claim or
 * credential-bound recovery issuance (idempotent replays store a redacted
 * body), stored as SHA-256 hashes only, compared in constant time, never
 * logged.
 *
 * Documented ambiguity resolutions:
 * - The task bundle's `document` is the chapter AT CLAIM TIME (current
 *   projected revision) - historical revisions are not reconstructable from
 *   the projection; the bundle base becomes the submission's base and the §5
 *   rebase/conflict policy covers later movement. Its `{ baseRevision,
 *   baseContentHash }` pair is recorded in the claim's audit event (keyed by
 *   the lease id, written atomically with the lease) - that is "the lease's
 *   bundle" the §4 verification order checks against.
 * - Claim/renew/release/expiry write NO Git artifacts: leases are
 *   operational-only (design §13) and a `leased` status in Git could not
 *   survive a rebuild that intentionally drops leases (contract §6).
 * - The lease is released (slot freed) in the accepted submission's own
 *   batch: after `leased → submitted → applying` nothing may consume it, and
 *   a later re-claim of the item must not collide with a dead-but-active row.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  isConstraintError,
  type ChapterProjectionRecord,
  type LeaseRecord,
  type ProjectRecord,
  type Repositories,
  type SqlStatement,
  type WorkItemRecord,
} from "@authorbot/database";
import {
  DEFAULT_LEASE_CONFIG,
  SUBMISSION_SCHEMA_IDS,
  checkLeaseActive,
  checkLeaseRenewable,
  checkSubmissionBase,
  checkSubmissionTypeMatches,
  checkWorkItemClaimable,
  isLeaseExpired,
  renewalPromptAt,
  requiredSubmissionType,
  resolveLeaseExpiry,
  submitWorkCommandSchema,
  type LeaseConfig,
} from "@authorbot/domain";
import {
  DEFAULT_ACCEPTANCE_CRITERIA,
  DEFAULT_CONFLICT_ACCEPTANCE_CRITERIA,
} from "@authorbot/repo-coordinator";
import { parseChapterMarkdown, parseProseMarkdown, scanSafety } from "@authorbot/markdown";
import type { WorkItemType } from "@authorbot/schemas";
import { chapterFrontmatterSchema } from "@authorbot/schemas";
import { z } from "zod";
import { authOf, requireProjectScope, type AuthServices } from "./auth.js";
import {
  readRepositoryText,
  type AppDeps,
  type AppEnv,
  type AuthContext,
  type Clock,
} from "./deps.js";
import { uuidv7 } from "./ids.js";
import {
  expireLeaseForWorkItemStatements,
  expireLeaseStatements,
  mintLeaseToken,
  verifyLeaseToken,
} from "./leases.js";
import { problem } from "./problems.js";
import { proseWriteBlocked } from "./reconcile.js";
import { sha256Hex } from "./crypto.js";
import type { ProjectSerializer } from "./serializer.js";

/** Outbox kind the submission command enqueues (repo-coordinator vocabulary). */
export const SUBMISSION_APPLY_KIND = "submission.apply";

export interface Phase4Context {
  app: Hono<AppEnv>;
  deps: AppDeps;
  repos: Repositories;
  clock: Clock;
  services: AuthServices;
  auth: MiddlewareHandler<AppEnv>;
  idem: MiddlewareHandler<AppEnv>;
  /** Idempotency middleware whose stored replay body redacts `lease.token`. */
  claimIdem: MiddlewareHandler<AppEnv>;
  serialize: ProjectSerializer;
  leaseConfig?: LeaseConfig | undefined;
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
  notifyMutation(projectId: string): Promise<void>;
  now(): string;
}

/** Redaction hook for claim/recovery idempotency (each token returned once). */
export function redactClaimBundle(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "lease" in body) {
    const bundle = body as Record<string, unknown>;
    const lease = bundle["lease"];
    if (typeof lease === "object" && lease !== null && "token" in lease) {
      const { token: _token, ...rest } = lease as Record<string, unknown>;
      return { ...bundle, lease: { ...rest, tokenRedacted: true } };
    }
  }
  return body;
}

const renewCommandSchema = z.strictObject({
  leaseId: z.string().min(1),
  leaseToken: z.string().min(1),
});

const recoverCommandSchema = z.strictObject({
  leaseId: z.string().min(1),
});

const releaseCommandSchema = z.strictObject({
  leaseId: z.string().min(1).optional(),
});

/**
 * A non-reversible binding to the exact credential that claimed a lease.
 * Session and agent-token row ids are not plaintext secrets, but hashing the
 * typed id keeps even those operational identifiers out of readable audit
 * metadata. The lease-token plaintext is never an input here.
 */
async function recoveryBindingOf(auth: AuthContext): Promise<string | null> {
  const credentialId = auth.kind === "session" ? auth.sessionId : auth.tokenId;
  if (credentialId === undefined) {
    return null;
  }
  return sha256Hex(`authorbot:lease-recovery:${auth.kind}:${credentialId}`);
}

export function registerPhase4Routes(ctx: Phase4Context): void {
  const { app, deps, repos, clock, services, auth, idem, claimIdem, serialize, now } = ctx;
  const leaseConfig = ctx.leaseConfig ?? DEFAULT_LEASE_CONFIG;

  const appendEventStatement = (projectId: string, type: string, payload: unknown): SqlStatement =>
    repos.events.appendStatement({ projectId, type, payload, createdAt: now() });

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

  /**
   * Work-item status compare-and-swap: sets status to NULL (NOT NULL
   * violation → the whole batch aborts) when the row is not in `from` - the
   * same cross-isolate backstop pattern as `annotations.casStatusStatement`.
   */
  const workItemCas = (id: string, from: string, to: string, updatedAt: string): SqlStatement =>
    deps.db
      .prepare(
        `UPDATE work_items
           SET status = CASE WHEN status = ? THEN ? ELSE NULL END,
               updated_at = ?
         WHERE id = ?`,
      )
      .bind(from, to, updatedAt, id);

  const findWorkItem = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
  ): Promise<WorkItemRecord | Response> => {
    const workItem = await repos.workItems.getById(c.req.param("workItemId") ?? "");
    if (workItem === null || workItem.projectId !== project.id) {
      return problem(c, "not-found", { detail: "unknown work item" });
    }
    return workItem;
  };

  /**
   * Lazy expiry of one lease (contract §2 "enforced lazily on every
   * lease-relevant command"): single-winner conditional end, item back to
   * `ready`, `lease_expired` emitted - only when this call actually won, and
   * all three in ONE atomic batch (see `expireLeaseStatements`). Splitting
   * the revocation from the work-item reset used to leave a crash window in
   * which the item was stranded `leased` with an empty lease slot forever.
   */
  const lazilyExpire = async (lease: LeaseRecord): Promise<void> => {
    await deps.db.batch(
      expireLeaseStatements(deps.db, {
        projectId: lease.projectId,
        leaseId: lease.id,
        workItemId: lease.workItemId,
        now: now(),
      }),
    );
  };

  /** Chapter source via the configured reader (bundle + base verification). */
  const readChapterSource = async (chapter: ChapterProjectionRecord): Promise<string | null> => {
    const read = await readRepositoryText(deps, chapter.projectId, chapter.path);
    return read.outcome === "found" ? read.source : null;
  };

  /** Immutable metadata written atomically with a claim (keyed by lease id). */
  const claimAuditMetadata = async (
    projectId: string,
    leaseId: string,
  ): Promise<Record<string, unknown> | null> => {
    const row = await deps.db
      .prepare(
        `SELECT metadata FROM audit_events
         WHERE project_id = ? AND action = 'work_item.claim' AND target_id = ?
         ORDER BY id LIMIT 1`,
      )
      .bind(projectId, leaseId)
      .first();
    if (!row || typeof row["metadata"] !== "string") {
      return null;
    }
    try {
      const metadata = JSON.parse(row["metadata"]) as unknown;
      return typeof metadata === "object" && metadata !== null
        ? (metadata as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  // ---- claim (contract §2, §3) ---------------------------------------------

  app.post("/v1/projects/:projectId/work-items/:workItemId/claim", auth, claimIdem, async (c) => {
    const guard = await requireProjectScope(c, services, "work:claim", {
      editorial: { capabilities: ["work:claim"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const a = authOf(c);
    const recoveryBinding = await recoveryBindingOf(a);
    if (recoveryBinding === null) {
      return problem(c, "internal", { detail: "authenticated credential has no stable binding" });
    }

    /**
     * Sentinel for "a rival command won a compare-and-swap under us, but the
     * item is still claimable" - the caller re-runs the whole attempt once
     * against fresh state (see the claim route's retry below).
     */
    const RETRY = Symbol("retry-claim");

    const attemptClaim = async (): Promise<Response | typeof RETRY> => {
      const workItem = await findWorkItem(c, guard.project);
      if (workItem instanceof Response) {
        return workItem;
      }

      const activeLease = await repos.leases.getActiveByWorkItem(workItem.id);
      const claimable = checkWorkItemClaimable(workItem.status, activeLease, clock.now());
      if (!claimable.allowed) {
        if (claimable.reason === "lease-held" && activeLease !== null) {
          const holder = await repos.actors.getById(activeLease.actorId);
          return problem(c, "lease-held", {
            detail: "work item is already leased",
            holder: holder?.displayName ?? "unknown",
            expiresAt: activeLease.expiresAt,
          });
        }
        return problem(c, "state-conflict", { detail: claimable.message });
      }

      // Build the §15.3 bundle from the projection + the chapter source.
      const chapter = await repos.chapters.getById(workItem.chapterId);
      if (chapter === null || chapter.projectId !== guard.project.id) {
        return problem(c, "state-conflict", { detail: "chapter projection row is missing" });
      }
      const source = await readChapterSource(chapter);
      if (source === null) {
        return problem(c, "internal", {
          detail: "chapter source unavailable (no repository reader configured)",
        });
      }
      const parsed = parseChapterMarkdown(source);
      const fm = chapterFrontmatterSchema.safeParse(parsed.frontmatter);
      if (!fm.success || fm.data.id !== chapter.id) {
        return problem(c, "state-conflict", { detail: "chapter source failed validation" });
      }
      if (fm.data.revision !== chapter.revision) {
        return problem(c, "state-conflict", {
          detail: "chapter projection and repository are out of sync; retry after rebuild",
        });
      }
      const contentHash = `sha256:${await sha256Hex(source)}`;
      const annotation = await repos.annotations.getById(workItem.sourceAnnotationId);

      const timestamp = now();
      const minted = await mintLeaseToken();
      const expiry = resolveLeaseExpiry(clock.now(), leaseConfig);
      const lease: LeaseRecord = {
        id: uuidv7(clock.now()),
        projectId: guard.project.id,
        workItemId: workItem.id,
        actorId: a.actor.id,
        tokenHash: minted.tokenHash,
        issuedAt: timestamp,
        expiresAt: expiry.expiresAt,
        maxExpiresAt: expiry.maxExpiresAt,
        renewalCount: 0,
        releasedAt: null,
        revokedAt: null,
      };

      const submissionType = requiredSubmissionType(workItem.type);
      // Contract §3: `target` is absent for chapter scope. `resolve_conflict`
      // items inherit the originating range selector on their row, but they
      // are submitted as a whole chapter - advertising a span would tell the
      // claimant to edit one sentence of a document they must merge.
      const target = submissionType === "chapter_replacement" ? null : bundleTarget(workItem);
      const bundle = {
        workItem: {
          id: workItem.id,
          type: workItem.type,
          acceptanceCriteria: [...acceptanceCriteriaFor(workItem.type)],
          priority: workItem.priority,
        },
        lease: {
          id: lease.id,
          token: minted.token,
          expiresAt: lease.expiresAt,
          maxExpiresAt: lease.maxExpiresAt,
          renewalPromptAt: renewalPromptAt(lease, leaseConfig),
        },
        document: {
          chapterId: chapter.id,
          revision: chapter.revision,
          contentHash,
          source,
        },
        ...(target === null ? {} : { target }),
        context: {
          annotationBody: annotation?.body ?? "",
          chapterSummary: fm.data.summary ?? fm.data.title,
          storyRefs: [...(fm.data.character_refs ?? []), ...(fm.data.timeline_refs ?? [])],
        },
        submissionSchema: submissionType === null ? null : SUBMISSION_SCHEMA_IDS[submissionType],
      };

      const statements: SqlStatement[] = [];
      if (claimable.priorLeaseExpired && activeLease !== null) {
        // Contract §2: expire the stale lease in the same serialized batch.
        // The `lease_expired` event is GUARDED by the same predicate as the
        // revocation, so losing that race emits nothing rather than claiming
        // an expiry that another command actually performed.
        statements.push(
          ...expireLeaseForWorkItemStatements(deps.db, {
            projectId: guard.project.id,
            leaseId: activeLease.id,
            workItemId: workItem.id,
            now: timestamp,
          }),
        );
      }
      statements.push(
        // Order matters: the lease INSERT runs BEFORE the work-item CAS so a
        // cross-isolate claim race aborts on the partial unique index
        // `idx_leases_active_work_item` - a UNIQUE violation the catch below
        // maps to the contract's 409 `lease-held`. With the CAS first the
        // batch aborted on a NOT NULL violation instead, which carries no
        // information about who won and used to surface as a 500.
        repos.leases.claimStatement(lease),
        workItemCas(workItem.id, claimable.priorLeaseExpired ? "leased" : "ready", "leased", timestamp),
        // The claim audit event doubles as the durable record of the lease's
        // task-bundle base (module docs) - target_id is the lease id.
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: "work_item.claim",
          targetType: "lease",
          targetId: lease.id,
          correlationId: c.get("correlationId"),
          metadata: {
            workItemId: workItem.id,
            baseRevision: chapter.revision,
            baseContentHash: contentHash,
            recoveryBinding,
          },
        }),
        appendEventStatement(guard.project.id, "work_item_leased", {
          workItemId: workItem.id,
          leaseId: lease.id,
          expiresAt: lease.expiresAt,
        }),
        ...ctx.claimStatements(c, 201, bundle),
      );

      try {
        await deps.db.batch(statements);
      } catch (error) {
        if (!isConstraintError(error)) {
          throw error;
        }
        // ANY constraint abort here means a rival command committed between
        // our read and our write - the unique index on the lease INSERT, or
        // the NOT NULL abort of the work-item CAS. Both are ordinary
        // contention, never a 500: contract §2 requires the loser of two
        // simultaneous claims to see 409 `lease-held`.
        const holderLease = await repos.leases.getActiveByWorkItem(workItem.id);
        if (holderLease !== null && holderLease.id !== lease.id) {
          if (checkLeaseActive(holderLease, clock.now()).allowed) {
            const holder = await repos.actors.getById(holderLease.actorId);
            return problem(c, "lease-held", {
              detail: "work item is already leased",
              holder: holder?.displayName ?? "unknown",
              expiresAt: holderLease.expiresAt,
            });
          }
          // The rival's lease is already expired - the item is claimable
          // again, so re-run rather than reporting a conflict that is not one.
          return RETRY;
        }
        const fresh = await repos.workItems.getById(workItem.id);
        if (fresh === null) {
          return problem(c, "not-found", { detail: "unknown work item" });
        }
        if (fresh.status !== "ready" && fresh.status !== "leased") {
          return problem(c, "state-conflict", {
            detail: `work item is no longer claimable (status "${fresh.status}")`,
          });
        }
        // Claimable status with no live lease holding the slot: a sweep or a
        // rival expiry moved the item under us. Re-read and try again.
        return RETRY;
      }
      return c.json(bundle, 201);
    };

    return serialize(guard.project.id, async () => {
      // One retry only: each attempt either commits, returns a typed problem,
      // or observes a genuinely still-claimable item. A second RETRY means
      // sustained contention rather than a transient interleaving.
      const first = await attemptClaim();
      if (first !== RETRY) {
        return first;
      }
      const second = await attemptClaim();
      if (second !== RETRY) {
        return second;
      }
      return problem(c, "state-conflict", {
        detail: "work item is being claimed concurrently; retry",
      });
    });
  });

  // ---- recover token (Phase 11 slice 2B: memory-only browser secrets) ------

  interface RecoveryPreflight {
    project: ProjectRecord;
    actor: AuthContext;
    workItem: WorkItemRecord;
    lease: LeaseRecord;
  }

  const recoveryPreflights = new WeakMap<Request, RecoveryPreflight>();

  /**
   * Recovery authorization must run before idempotency lookup. Idempotency
   * rows are actor-scoped, while recovery is deliberately bound to one exact
   * session/token credential; letting the middleware replay first would let a
   * second session for the same actor bypass both the current scope check and
   * the credential binding (albeit with the token redacted).
   */
  const authorizeRecoveryBeforeReplay: MiddlewareHandler<AppEnv> = async (c, next) => {
    const guard = await requireProjectScope(c, services, "work:claim", {
      editorial: { capabilities: ["work:claim"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const body = await ctx.readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = recoverCommandSchema.safeParse(body);
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const actor = authOf(c);
    const presentedBinding = await recoveryBindingOf(actor);
    if (presentedBinding === null) {
      return problem(c, "internal", { detail: "authenticated credential has no stable binding" });
    }
    const workItem = await findWorkItem(c, guard.project);
    if (workItem instanceof Response) {
      return workItem;
    }
    const lease = await repos.leases.getById(parsed.data.leaseId);
    if (
      lease === null ||
      lease.workItemId !== workItem.id ||
      lease.projectId !== guard.project.id
    ) {
      return problem(c, "not-found", { detail: "unknown lease" });
    }
    if (lease.actorId !== actor.actor.id) {
      return problem(c, "forbidden", {
        detail: "only the current lease holder may recover its token",
      });
    }
    const claimMetadata = await claimAuditMetadata(guard.project.id, lease.id);
    const storedBinding = claimMetadata?.["recoveryBinding"];
    if (typeof storedBinding !== "string") {
      return problem(c, "state-conflict", {
        detail:
          "this lease predates credential-bound recovery; release it and claim the work again",
      });
    }
    if (storedBinding !== presentedBinding) {
      return problem(c, "forbidden", {
        detail: "only the credential that claimed this lease may recover its token",
      });
    }

    recoveryPreflights.set(c.req.raw, {
      project: guard.project,
      actor,
      workItem,
      lease,
    });
    try {
      await next();
    } finally {
      recoveryPreflights.delete(c.req.raw);
    }
  };

  app.post(
    "/v1/projects/:projectId/work-items/:workItemId/lease/recover",
    auth,
    authorizeRecoveryBeforeReplay,
    claimIdem,
    async (c) => {
      const preflight = recoveryPreflights.get(c.req.raw);
      if (preflight === undefined) {
        return problem(c, "internal", { detail: "lease recovery authorization was not evaluated" });
      }
      const { project, actor: a, workItem, lease } = preflight;

      return serialize(project.id, async () => {
        // Recovery cannot revive or extend a lease. Expiration is enforced
        // before minting, with the same lazy-expiry side effect as renewal.
        if (isLeaseExpired(lease, clock.now())) {
          await lazilyExpire(lease);
          return problem(c, "lease-expired", { detail: "lease has expired" });
        }
        const active = checkLeaseActive(lease, clock.now());
        if (!active.allowed) {
          return problem(c, "lease-inactive", { detail: active.message });
        }
        if (workItem.status !== "leased") {
          return problem(c, "state-conflict", {
            detail: `work item in status "${workItem.status}" has no recoverable lease`,
          });
        }

        const replacement = await mintLeaseToken();
        const timestamp = now();
        const responseBody = {
          workItemId: workItem.id,
          lease: {
            id: lease.id,
            token: replacement.token,
            expiresAt: lease.expiresAt,
            maxExpiresAt: lease.maxExpiresAt,
            renewalCount: lease.renewalCount,
            renewalPromptAt: renewalPromptAt(lease, leaseConfig),
          },
          correlationId: c.get("correlationId"),
        };

        try {
          await deps.db.batch([
            repos.leases.rotateTokenCasStatement(
              lease.id,
              lease.tokenHash,
              lease.expiresAt,
              lease.renewalCount,
              replacement.tokenHash,
              timestamp,
            ),
            auditStatement({
              projectId: project.id,
              actorId: a.actor.id,
              action: "lease.recover",
              targetType: "lease",
              targetId: lease.id,
              correlationId: c.get("correlationId"),
              metadata: { workItemId: workItem.id },
            }),
            appendEventStatement(project.id, "lease_recovered", {
              leaseId: lease.id,
              workItemId: workItem.id,
              correlationId: c.get("correlationId"),
            }),
            ...ctx.claimStatements(c, 200, responseBody),
          ]);
        } catch (error) {
          if (!isConstraintError(error)) {
            throw error;
          }

          // A concurrent replay of this exact request may have won on the
          // idempotency key. Let the middleware return its stored, redacted
          // response instead of mislabelling that success as a token race.
          const key = c.req.header("idempotency-key");
          if (
            key !== undefined &&
            (await repos.idempotencyKeys.get(project.id, a.actor.id, key)) !== null
          ) {
            throw error;
          }

          const fresh = await repos.leases.getById(lease.id);
          if (fresh === null) {
            return problem(c, "not-found", { detail: "unknown lease" });
          }
          if (isLeaseExpired(fresh, clock.now())) {
            await lazilyExpire(fresh);
            return problem(c, "lease-expired", { detail: "lease has expired" });
          }
          const freshActive = checkLeaseActive(fresh, clock.now());
          if (!freshActive.allowed) {
            return problem(c, "lease-inactive", { detail: freshActive.message });
          }
          return problem(c, "state-conflict", {
            detail:
              "lease changed before recovery committed; retry from authoritative state",
          });
        }

        return c.json(responseBody, 200);
      });
    },
  );

  // ---- renew (contract §2) --------------------------------------------------

  app.post("/v1/projects/:projectId/work-items/:workItemId/lease/renew", auth, idem, async (c) => {
    const guard = await requireProjectScope(c, services, "work:claim", {
      editorial: { capabilities: ["work:claim"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const body = await ctx.readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = renewCommandSchema.safeParse(body);
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }

    return serialize(guard.project.id, async () => {
      const workItem = await findWorkItem(c, guard.project);
      if (workItem instanceof Response) {
        return workItem;
      }
      const lease = await repos.leases.getById(parsed.data.leaseId);
      if (lease === null || lease.workItemId !== workItem.id || lease.projectId !== guard.project.id) {
        return problem(c, "not-found", { detail: "unknown lease" });
      }
      if (lease.actorId !== authOf(c).actor.id) {
        return problem(c, "forbidden", { detail: "only the lease holder may renew" });
      }
      if (!(await verifyLeaseToken(parsed.data.leaseToken, lease.tokenHash))) {
        return problem(c, "lease-token-invalid", { detail: "lease token does not match" });
      }
      // Lazy expiry BEFORE renewability (contract §2: renewing an expired
      // lease is a 409, and the item returns to ready as a side effect).
      if (isLeaseExpired(lease, clock.now())) {
        await lazilyExpire(lease);
        return problem(c, "lease-expired", { detail: "lease has expired" });
      }
      const active = checkLeaseActive(lease, clock.now());
      if (!active.allowed) {
        return problem(c, "lease-inactive", { detail: active.message });
      }
      const renewable = checkLeaseRenewable(lease, clock.now(), leaseConfig);
      if (!renewable.allowed) {
        if (renewable.reason === "max-total-exceeded") {
          return problem(c, "lease-max-total-exceeded", { detail: renewable.message });
        }
        return problem(c, "lease-inactive", { detail: renewable.message });
      }

      const timestamp = now();
      const responseBody = {
        leaseId: lease.id,
        workItemId: workItem.id,
        expiresAt: renewable.expiresAt,
        maxExpiresAt: lease.maxExpiresAt,
        renewalCount: lease.renewalCount + 1,
        renewalPromptAt: renewalPromptAt({ ...lease, expiresAt: renewable.expiresAt }, leaseConfig),
        correlationId: c.get("correlationId"),
      };
      try {
        await deps.db.batch([
          // NULL-abort CAS, not a bare conditional UPDATE: the checks above
          // read the lease, and a release/revoke/expiry OR recovery-token
          // rotation committed by another isolate in between would otherwise
          // leave this handler returning 200 for a stale capability. The abort
          // makes the whole batch atomic with the liveness and token checks.
          repos.leases.renewCasStatement(
            lease.id,
            lease.tokenHash,
            renewable.expiresAt,
            timestamp,
          ),
          auditStatement({
            projectId: guard.project.id,
            actorId: lease.actorId,
            action: "lease.renew",
            targetType: "lease",
            targetId: lease.id,
            correlationId: c.get("correlationId"),
            metadata: { workItemId: workItem.id, expiresAt: renewable.expiresAt },
          }),
          appendEventStatement(guard.project.id, "lease_renewed", {
            leaseId: lease.id,
            workItemId: workItem.id,
            expiresAt: responseBody.expiresAt,
            maxExpiresAt: responseBody.maxExpiresAt,
            renewalCount: responseBody.renewalCount,
            renewalPromptAt: responseBody.renewalPromptAt,
          }),
          ...ctx.claimStatements(c, 200, responseBody),
        ]);
      } catch (error) {
        if (!isConstraintError(error)) {
          throw error;
        }
        // Re-read to name the reason honestly (contract §2/§8.2: replaced
        // token, expired, released, revoked, and max-total are all rejected).
        const fresh = await repos.leases.getById(lease.id);
        if (fresh === null) {
          return problem(c, "not-found", { detail: "unknown lease" });
        }
        if (fresh.tokenHash !== lease.tokenHash) {
          return problem(c, "lease-token-invalid", {
            detail: "lease token was replaced before the renewal committed",
          });
        }
        if (isLeaseExpired(fresh, clock.now())) {
          await lazilyExpire(fresh);
          return problem(c, "lease-expired", { detail: "lease has expired" });
        }
        const freshActive = checkLeaseActive(fresh, clock.now());
        return problem(c, "lease-inactive", {
          detail: freshActive.allowed
            ? "lease could not be renewed; it is no longer renewable"
            : freshActive.message,
        });
      }
      return c.json(responseBody, 200);
    });
  });

  // ---- release (contract §2: holder or maintainer) --------------------------

  app.post("/v1/projects/:projectId/work-items/:workItemId/lease/release", auth, idem, async (c) => {
    const guard = await requireProjectScope(c, services, "work:claim", {
      editorial: { capabilities: ["work:claim"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const body = await ctx.readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = releaseCommandSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }

    return serialize(guard.project.id, async () => {
      const workItem = await findWorkItem(c, guard.project);
      if (workItem instanceof Response) {
        return workItem;
      }
      const lease = await repos.leases.getActiveByWorkItem(workItem.id);
      if (lease === null || (parsed.data.leaseId !== undefined && lease.id !== parsed.data.leaseId)) {
        return problem(c, "state-conflict", { detail: "work item has no active lease" });
      }
      const a = authOf(c);
      const isHolder = lease.actorId === a.actor.id;
      const isMaintainer = a.role === "maintainer";
      if (!isHolder && !isMaintainer) {
        return problem(c, "forbidden", {
          detail: "only the lease holder or a maintainer may release a lease",
        });
      }

      // An expired-but-unswept lease is expired, not released (honest events).
      if (isLeaseExpired(lease, clock.now())) {
        await lazilyExpire(lease);
        const fresh = await repos.workItems.getById(workItem.id);
        const responseBody = {
          workItemId: workItem.id,
          leaseId: lease.id,
          status: fresh?.status ?? "ready",
          expired: true,
          correlationId: c.get("correlationId"),
        };
        await deps.db.batch([...ctx.claimStatements(c, 200, responseBody)]);
        return c.json(responseBody, 200);
      }

      const timestamp = now();
      const responseBody = {
        workItemId: workItem.id,
        leaseId: lease.id,
        status: "ready",
        expired: false,
        correlationId: c.get("correlationId"),
      };
      await deps.db.batch([
        repos.leases.releaseStatement(lease.id, timestamp),
        workItemCas(workItem.id, "leased", "ready", timestamp),
        auditStatement({
          projectId: guard.project.id,
          actorId: a.actor.id,
          action: "lease.release",
          targetType: "lease",
          targetId: lease.id,
          correlationId: c.get("correlationId"),
          metadata: { workItemId: workItem.id, byMaintainer: !isHolder },
        }),
        appendEventStatement(guard.project.id, "lease_released", {
          leaseId: lease.id,
          workItemId: workItem.id,
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      ]);
      return c.json(responseBody, 200);
    });
  });

  // ---- submissions (contract §4) --------------------------------------------

  app.post("/v1/projects/:projectId/work-items/:workItemId/submissions", auth, idem, async (c) => {
    const guard = await requireProjectScope(c, services, "submissions:write", {
      editorial: { capabilities: ["work:submit"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const body = await ctx.readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = submitWorkCommandSchema.safeParse(
      typeof body === "object" && body !== null
        ? { ...body, workItemId: c.req.param("workItemId") }
        : body,
    );
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const command = parsed.data;

    return serialize(guard.project.id, async () => {
      const a = authOf(c);

      // Phase 5 §6 / design §14.5: a diverged repository blocks PROSE writes.
      // Checked inside the serializer and re-read from the row, not from the
      // cached project the guard returned - divergence is set by a webhook
      // reconciliation that can land between this request's auth check and
      // its command, and a submission accepted against a projection known to
      // disagree with the repository is precisely the clobber this refuses.
      //
      // Only this route is gated. Annotations, replies, votes, and the lease
      // lifecycle record *intent about* prose rather than rewriting it, so
      // refusing them would turn a repository problem into a total outage for
      // collaborators who have no way to fix it.
      const currentProject = await repos.projects.getById(guard.project.id);
      if (currentProject !== null) {
        const blocked = proseWriteBlocked(c, currentProject);
        if (blocked !== null) {
          return blocked;
        }
      }

      const workItem = await findWorkItem(c, guard.project);
      if (workItem instanceof Response) {
        return workItem;
      }

      // Contract §4 verification order, each with a stable problem type:
      // 1. lease exists …
      const lease = await repos.leases.getById(command.leaseId);
      if (lease === null || lease.workItemId !== workItem.id || lease.projectId !== guard.project.id) {
        return problem(c, "not-found", { detail: "unknown lease" });
      }
      // 2. … holder …
      if (lease.actorId !== a.actor.id) {
        return problem(c, "forbidden", { detail: "submitting actor does not hold this lease" });
      }
      // 3. … token hash (constant time) …
      if (!(await verifyLeaseToken(command.leaseToken, lease.tokenHash))) {
        return problem(c, "lease-token-invalid", { detail: "lease token does not match" });
      }
      // 4. … not expired (lazy expiry enforced) …
      if (isLeaseExpired(lease, clock.now())) {
        await lazilyExpire(lease);
        return problem(c, "lease-expired", { detail: "lease has expired" });
      }
      // 5. … not released/revoked.
      const active = checkLeaseActive(lease, clock.now());
      if (!active.allowed) {
        return problem(c, "lease-inactive", { detail: active.message });
      }
      // 6. Work item is `leased`.
      if (workItem.status !== "leased") {
        return problem(c, "state-conflict", {
          detail: `work item in status "${workItem.status}" cannot accept a submission`,
        });
      }
      // 7. Submission type matches the work-item type.
      const typeCheck = checkSubmissionTypeMatches(workItem.type, command.type);
      if (!typeCheck.allowed) {
        return problem(
          c,
          typeCheck.reason === "submission-not-supported"
            ? "submission-not-supported"
            : "submission-type-mismatch",
          { detail: typeCheck.message },
        );
      }
      // 8. baseRevision + baseContentHash match the lease's bundle.
      const bundleBase = await claimBundleBase(guard.project.id, lease.id);
      if (bundleBase === null) {
        return problem(c, "state-conflict", { detail: "lease has no recorded task bundle" });
      }
      const baseCheck = checkSubmissionBase(bundleBase, command);
      if (!baseCheck.allowed) {
        return problem(c, "submission-base-mismatch", { detail: baseCheck.message });
      }
      // 9. Payload shape + Phase 0 prose safety on `content` (size/emptiness
      // already enforced by the schema).
      //
      // Shape first: a range replacement must be single-line inline text. The
      // patch engine refuses newlines outright, and without this check a
      // multi-line payload (a human pressing Enter in the /work/ textarea, or
      // any API client) was accepted with 202 and only refused at apply time
      // - where the refusal was laundered into a "the chapter changed
      // underneath it" conflict, burning the work item and committing a
      // spurious resolve_conflict artifact to Git on an UNMOVED base.
      if (command.type === "range_replacement" && /[\r\n]/.test(command.content)) {
        return problem(c, "validation-failed", {
          issues: [
            {
              path: "content",
              message: "a range replacement must be single-line inline text (no line breaks)",
            },
          ],
        });
      }
      const findings = contentSafetyFindings(command.content);
      if (findings.length > 0) {
        return problem(c, "unsafe-content", { findings });
      }

      // Retention (contract §6): submission rows - including `content` - are
      // DB-only and retained until completion/conflict resolution plus 7
      // days. Documented policy; no purge job exists yet in Phase 4.
      const timestamp = now();
      const submissionId = uuidv7(clock.now());
      const correlationId = c.get("correlationId");
      const command202 = ctx.commandStatements({
        project: guard.project,
        correlationId,
        actorId: a.actor.id,
        action: "submission.create",
        targetType: "submission",
        targetId: submissionId,
        outboxKind: SUBMISSION_APPLY_KIND,
        // Shape pinned by the repo-coordinator's SubmissionApplyPayload; the
        // processor persists its resolved outcome onto this payload later.
        outboxPayload: { submissionId, workItemId: workItem.id },
        metadata: { workItemId: workItem.id, type: command.type, leaseId: lease.id },
      });

      const responseBody = {
        submissionId,
        operationId: command202.operationId,
        correlationId,
        status: "queued",
      };
      const batch: SqlStatement[] = [
        command202.statements[0] as SqlStatement, // git operation first (FK)
        repos.submissions.insertStatement({
          id: submissionId,
          projectId: guard.project.id,
          workItemId: workItem.id,
          leaseId: lease.id,
          actorId: a.actor.id,
          type: command.type,
          baseRevision: command.baseRevision,
          baseContentHash: command.baseContentHash,
          content: command.content,
          summary: command.summary ?? null,
          notes: command.notes ?? null,
          // received → applying happens INSIDE this command (contract §4:
          // "leased → submitted → applying in the command"): the row lands
          // already `applying`, and the processor's finalize batch moves it
          // to `applied`/`conflicted` with a state-guarded transition.
          state: "applying",
          gitOperationId: command202.operationId,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
        // leased → submitted → applying in the command (contract §4); the two
        // §9.5 edges collapse to one stored status inside this atomic batch.
        workItemCas(workItem.id, "leased", "applying", timestamp),
        // The accepted submission consumes the lease (module docs) - as a
        // NULL-abort CAS requiring the lease to still be LIVE and retain the
        // token hash verified above at write time.
        // The work-item CAS alone is not enough: it proves only that the item
        // is `leased`, not that THIS lease holds it. Between the liveness
        // check above and this batch another isolate can expire this lease
        // and hand the item to a new claimant, leaving the item `leased`
        // again - the CAS would pass, this release would silently change 0
        // rows, and an expired lease's edit would be applied while the fresh
        // holder's lease stayed active against a completed item.
        repos.leases.consumeForSubmissionStatement(
          lease.id,
          lease.tokenHash,
          timestamp,
          timestamp,
        ),
        ...command202.statements.slice(1),
        appendEventStatement(guard.project.id, "submission_received", {
          submissionId,
          operationId: command202.operationId,
          workItemId: workItem.id,
          type: command.type,
          correlationId,
        }),
        ...ctx.claimStatements(c, 202, responseBody),
      ];
      try {
        await deps.db.batch(batch);
      } catch (error) {
        // A work-item or lease CAS aborted: another isolate changed the item,
        // ended the lease, or rotated its token after our read.
        if (isConstraintError(error)) {
          // Either CAS may have aborted. Report whichever precondition
          // actually broke, and never surface contention as a 500.
          const freshLease = await repos.leases.getById(lease.id);
          if (freshLease !== null && freshLease.tokenHash !== lease.tokenHash) {
            return problem(c, "lease-token-invalid", {
              detail: "lease token was replaced before the submission committed",
            });
          }
          if (freshLease !== null && isLeaseExpired(freshLease, clock.now())) {
            await lazilyExpire(freshLease);
            return problem(c, "lease-expired", { detail: "lease has expired" });
          }
          if (freshLease !== null) {
            const freshActive = checkLeaseActive(freshLease, clock.now());
            if (!freshActive.allowed) {
              return problem(c, "lease-inactive", { detail: freshActive.message });
            }
          }
          const fresh = await repos.workItems.getById(workItem.id);
          return problem(c, "state-conflict", {
            detail: `work item in status "${fresh?.status ?? "unknown"}" cannot accept a submission`,
          });
        }
        throw error;
      }
      await ctx.notifyMutation(guard.project.id);
      return c.json(responseBody, 202);
    });
  });

  /**
   * The `{ baseRevision, baseContentHash }` recorded by the claim's audit
   * event (target_id = lease id) - "the lease's bundle" of contract §4.
   */
  const claimBundleBase = async (
    projectId: string,
    leaseId: string,
  ): Promise<{ baseRevision: number; baseContentHash: string } | null> => {
    const metadata = await claimAuditMetadata(projectId, leaseId);
    if (metadata === null) {
      return null;
    }
    if (
      typeof metadata["baseRevision"] === "number" &&
      typeof metadata["baseContentHash"] === "string"
    ) {
      return {
        baseRevision: metadata["baseRevision"],
        baseContentHash: metadata["baseContentHash"],
      };
    }
    return null;
  };
}

/**
 * Phase 0 prose safety on submission content (contract §4): no raw HTML, no
 * forbidden URL schemes - and no authorbot marker-like comments, which the
 * patch engine rejects rather than escapes (clients strip markers from
 * bundle-derived bodies with `stripBlockMarkers` before submitting).
 */
export function contentSafetyFindings(content: string): string[] {
  const findings: string[] = [];
  if (content.includes("<!--") && /authorbot:/i.test(content)) {
    findings.push("authorbot comments are not allowed in submission content");
  }
  // `parseProseMarkdown`, NOT `parseChapterMarkdown`: submission content is
  // chapter BODY text. A frontmatter-aware parse hid every payload that began
  // with a `---` fence - raw `<script>` and `javascript:` URLs alike - inside
  // an unvisited `yaml` node, so the request was accepted with 202 instead of
  // the contract-mandated 422 and the payload was persisted verbatim and
  // committed into `.authorbot/work-items/<id>.md` unescaped.
  const scan = scanSafety(parseProseMarkdown(content).ast);
  if (scan.rawHtml.length > 0) {
    findings.push("raw HTML is forbidden in submission content");
  }
  for (const url of scan.forbiddenUrls) {
    findings.push(`URL scheme "${url.scheme}" is forbidden`);
  }
  return findings;
}

/**
 * The §15.3 bundle's acceptance criteria for a work-item type - the SAME
 * criteria the Git artifact for that type carries.
 *
 * `resolve_conflict` items are rendered with the merge criteria ("never
 * discard either silently"); handing their claimant the range-editing
 * defaults instead told them to "change only the selected span" while the
 * bundle simultaneously demanded a whole-chapter merge submission. That is
 * the one work type whose failure mode is silent loss of one side of a
 * conflict, so artifact and bundle must not disagree.
 */
function acceptanceCriteriaFor(type: WorkItemType): readonly string[] {
  return type === "resolve_conflict"
    ? DEFAULT_CONFLICT_ACCEPTANCE_CRITERIA
    : DEFAULT_ACCEPTANCE_CRITERIA;
}

/** §15.3 `target` (absent for chapter scope / target-less items). */
function bundleTarget(
  workItem: WorkItemRecord,
): { blockId: string; exact?: string; start?: number; end?: number } | null {
  const target = workItem.target as {
    blockId?: unknown;
    textPosition?: { start?: unknown; end?: unknown };
    textQuote?: { exact?: unknown };
  } | null;
  if (target === null || typeof target !== "object" || typeof target.blockId !== "string") {
    return null;
  }
  const exact = target.textQuote?.exact;
  const start = target.textPosition?.start;
  const end = target.textPosition?.end;
  return {
    blockId: target.blockId,
    ...(typeof exact === "string" ? { exact } : {}),
    ...(typeof start === "number" ? { start } : {}),
    ...(typeof end === "number" ? { end } : {}),
  };
}

function issueList(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
