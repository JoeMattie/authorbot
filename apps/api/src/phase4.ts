/**
 * Phase 4 routes (Phase 4 contract §2–§4): lease claim/renew/release with
 * lazy expiry, the §15.3 task bundle, and the submission command feeding the
 * §5 apply pipeline (`submission.apply` outbox rows drained by the
 * repo-coordinator processor with the injected `submission-applier.ts`).
 *
 * Concurrency: every command runs in the SAME per-project serial queue as the
 * Phase 3 commands; the partial unique index `idx_leases_active_work_item` is
 * the cross-isolate arbiter that makes two simultaneous claims produce
 * exactly one 201 (contract §2), and work-item status changes use the
 * NULL-abort compare-and-swap so a raced batch rolls back atomically.
 *
 * Lease tokens: minted here, returned exactly once in the claim bundle
 * (idempotent replays store a redacted body), stored as SHA-256 hashes only,
 * compared in constant time, never logged.
 *
 * Documented ambiguity resolutions:
 * - The task bundle's `document` is the chapter AT CLAIM TIME (current
 *   projected revision) — historical revisions are not reconstructable from
 *   the projection; the bundle base becomes the submission's base and the §5
 *   rebase/conflict policy covers later movement. Its `{ baseRevision,
 *   baseContentHash }` pair is recorded in the claim's audit event (keyed by
 *   the lease id, written atomically with the lease) — that is "the lease's
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
  isUniqueConstraintError,
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
import { DEFAULT_ACCEPTANCE_CRITERIA } from "@authorbot/repo-coordinator";
import { parseChapterMarkdown, scanSafety } from "@authorbot/markdown";
import { chapterFrontmatterSchema } from "@authorbot/schemas";
import { z } from "zod";
import { authOf, requireProjectScope, type AuthServices } from "./auth.js";
import type { AppDeps, AppEnv, Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";
import { mintLeaseToken, verifyLeaseToken } from "./leases.js";
import { problem } from "./problems.js";
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

/** Redaction hook for the claim idempotency middleware (token returned once). */
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

const releaseCommandSchema = z.strictObject({
  leaseId: z.string().min(1).optional(),
});

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
   * violation → the whole batch aborts) when the row is not in `from` — the
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
   * `ready`, `lease_expired` emitted — only when this call actually won.
   */
  const lazilyExpire = async (lease: LeaseRecord): Promise<void> => {
    const ts = now();
    const won = await repos.leases.expire(lease.id, ts);
    if (won !== 1) {
      return;
    }
    await deps.db.batch([
      deps.db
        .prepare(`UPDATE work_items SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'leased'`)
        .bind(ts, lease.workItemId),
      appendEventStatement(lease.projectId, "lease_expired", {
        leaseId: lease.id,
        workItemId: lease.workItemId,
      }),
    ]);
  };

  /** Chapter source via the configured reader (bundle + base verification). */
  const readChapterSource = async (chapter: ChapterProjectionRecord): Promise<string | null> => {
    if (deps.reader?.readTextFile === undefined) {
      return null;
    }
    return deps.reader.readTextFile(chapter.path);
  };

  // ---- claim (contract §2, §3) ---------------------------------------------

  app.post("/v1/projects/:projectId/work-items/:workItemId/claim", auth, claimIdem, async (c) => {
    const guard = await requireProjectScope(c, services, "work:claim");
    if ("response" in guard) {
      return guard.response;
    }
    const a = authOf(c);

    return serialize(guard.project.id, async () => {
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

      const target = bundleTarget(workItem);
      const submissionType = requiredSubmissionType(workItem.type);
      const bundle = {
        workItem: {
          id: workItem.id,
          type: workItem.type,
          acceptanceCriteria: [...DEFAULT_ACCEPTANCE_CRITERIA],
          priority: workItem.priority,
        },
        lease: {
          id: lease.id,
          token: minted.token,
          expiresAt: lease.expiresAt,
          maxExpiresAt: lease.maxExpiresAt,
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
        statements.push(
          repos.leases.expireForWorkItemStatement(workItem.id, timestamp),
          appendEventStatement(guard.project.id, "lease_expired", {
            leaseId: activeLease.id,
            workItemId: workItem.id,
          }),
        );
      }
      statements.push(
        workItemCas(workItem.id, claimable.priorLeaseExpired ? "leased" : "ready", "leased", timestamp),
        repos.leases.claimStatement(lease),
        // The claim audit event doubles as the durable record of the lease's
        // task-bundle base (module docs) — target_id is the lease id.
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
        if (isUniqueConstraintError(error)) {
          // Lost the cross-isolate race on idx_leases_active_work_item.
          const holderLease = await repos.leases.getActiveByWorkItem(workItem.id);
          if (holderLease !== null && holderLease.id !== lease.id) {
            const holder = await repos.actors.getById(holderLease.actorId);
            return problem(c, "lease-held", {
              detail: "work item is already leased",
              holder: holder?.displayName ?? "unknown",
              expiresAt: holderLease.expiresAt,
            });
          }
        }
        if (isConstraintError(error)) {
          // Work-item status CAS aborted: a rival command moved the item.
          const fresh = await repos.workItems.getById(workItem.id);
          if (fresh !== null && fresh.status !== "ready" && fresh.status !== "leased") {
            return problem(c, "state-conflict", {
              detail: `work item is no longer claimable (status "${fresh.status}")`,
            });
          }
        }
        throw error;
      }
      return c.json(bundle, 201);
    });
  });

  // ---- renew (contract §2) --------------------------------------------------

  app.post("/v1/projects/:projectId/work-items/:workItemId/lease/renew", auth, idem, async (c) => {
    const guard = await requireProjectScope(c, services, "work:claim");
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
      await deps.db.batch([
        repos.leases.renewStatement(lease.id, renewable.expiresAt, timestamp),
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
          expiresAt: renewable.expiresAt,
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      ]);
      return c.json(responseBody, 200);
    });
  });

  // ---- release (contract §2: holder or maintainer) --------------------------

  app.post("/v1/projects/:projectId/work-items/:workItemId/lease/release", auth, idem, async (c) => {
    const guard = await requireProjectScope(c, services, null);
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
    const guard = await requireProjectScope(c, services, "submissions:write");
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
      const bundleBase = await claimBundleBase(lease.id);
      if (bundleBase === null) {
        return problem(c, "state-conflict", { detail: "lease has no recorded task bundle" });
      }
      const baseCheck = checkSubmissionBase(bundleBase, command);
      if (!baseCheck.allowed) {
        return problem(c, "submission-base-mismatch", { detail: baseCheck.message });
      }
      // 9. Phase 0 prose safety on `content` (schema/size already enforced).
      const findings = contentSafetyFindings(command.content);
      if (findings.length > 0) {
        return problem(c, "unsafe-content", { findings });
      }

      // Retention (contract §6): submission rows — including `content` — are
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
        // The accepted submission consumes the lease (module docs).
        repos.leases.releaseStatement(lease.id, timestamp),
        ...command202.statements.slice(1),
        appendEventStatement(guard.project.id, "submission_received", {
          submissionId,
          workItemId: workItem.id,
          type: command.type,
        }),
        ...ctx.claimStatements(c, 202, responseBody),
      ];
      try {
        await deps.db.batch(batch);
      } catch (error) {
        // The work-item CAS aborted: a rival command (cancel/expiry sweep in
        // another isolate) moved the item off `leased` after our read.
        if (isConstraintError(error)) {
          const fresh = await repos.workItems.getById(workItem.id);
          if (fresh !== null && fresh.status !== "leased") {
            return problem(c, "state-conflict", {
              detail: `work item in status "${fresh.status}" cannot accept a submission`,
            });
          }
        }
        throw error;
      }
      await ctx.notifyMutation(guard.project.id);
      return c.json(responseBody, 202);
    });
  });

  /**
   * The `{ baseRevision, baseContentHash }` recorded by the claim's audit
   * event (target_id = lease id) — "the lease's bundle" of contract §4.
   */
  const claimBundleBase = async (
    leaseId: string,
  ): Promise<{ baseRevision: number; baseContentHash: string } | null> => {
    const row = await deps.db
      .prepare(
        `SELECT metadata FROM audit_events
         WHERE action = 'work_item.claim' AND target_id = ? ORDER BY id LIMIT 1`,
      )
      .bind(leaseId)
      .first();
    if (!row || typeof row["metadata"] !== "string") {
      return null;
    }
    try {
      const metadata = JSON.parse(row["metadata"]) as {
        baseRevision?: unknown;
        baseContentHash?: unknown;
      };
      if (typeof metadata.baseRevision === "number" && typeof metadata.baseContentHash === "string") {
        return { baseRevision: metadata.baseRevision, baseContentHash: metadata.baseContentHash };
      }
    } catch {
      /* fall through */
    }
    return null;
  };
}

/**
 * Phase 0 prose safety on submission content (contract §4): no raw HTML, no
 * forbidden URL schemes — and no authorbot marker-like comments, which the
 * patch engine rejects rather than escapes (clients strip markers from
 * bundle-derived bodies with `stripBlockMarkers` before submitting).
 */
export function contentSafetyFindings(content: string): string[] {
  const findings: string[] = [];
  if (content.includes("<!--") && /authorbot:/i.test(content)) {
    findings.push("authorbot comments are not allowed in submission content");
  }
  const scan = scanSafety(parseChapterMarkdown(content).ast);
  if (scan.rawHtml.length > 0) {
    findings.push("raw HTML is forbidden in submission content");
  }
  for (const url of scan.forbiddenUrls) {
    findings.push(`URL scheme "${url.scheme}" is forbidden`);
  }
  return findings;
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
