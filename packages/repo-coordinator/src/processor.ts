/**
 * Outbox processor (Phase 2 contract §5, design §20.1/§20.2).
 *
 * `drain(projectId)` claims outbox rows for one project in insertion order
 * and walks each row's git operation `queued → preparing → committing →
 * committed`, with bounded retries (`conflict → queued`, max 3 attempts)
 * and `failed` as the terminal error state. After a successful commit one
 * atomic batch marks the operation `committed` (+ commit SHA), moves the
 * mirrored record out of `pending_git`, and marks the outbox row `done`.
 *
 * Crash recovery: rows left `processing` by a crashed drain are resumed
 * first (single drainer per project); operations already `committed` are
 * finalized without re-committing, and `LocalGitAdapter` deduplicates
 * commits by the `Authorbot-Operation` trailer, so re-running after a crash
 * at any point between states is idempotent.
 */
import {
  createRepositories,
  type AnnotationRecord,
  type DecisionRecord,
  type GitOperationRecord,
  type OutboxRecord,
  type Repositories,
  type SqlDatabase,
  type SqlStatement,
  type SubmissionRecord,
  type WorkItemRecord,
} from "@authorbot/database";
import {
  MAX_GIT_ATTEMPTS,
  toTimestamp,
  transitionGitOperation,
  type GitOperationState,
} from "@authorbot/domain";
import { appendAttributionEntry, attributionFilePath } from "./attribution-artifact.js";
import { applyChapterFrontmatterUpdate } from "./chapter-artifact.js";
import { renderDecisionArtifact } from "./decision-artifact.js";
import { renderAnnotationArtifact, renderReplyArtifact, type RenderedFile } from "./render.js";
import {
  DEFAULT_CONFLICT_ACCEPTANCE_CRITERIA,
  renderWorkItemArtifact,
  type WorkItemCompletion,
} from "./work-item-artifact.js";
import {
  ACTOR_TRAILER,
  ANNOTATION_TRAILER,
  BASE_REVISION_TRAILER,
  isGitWriteError,
  OPERATION_TRAILER,
  WORK_ITEM_TRAILER,
  type BookRepoWriter,
  type CommitFile,
} from "./writer.js";

/** Outbox row kinds this processor understands (the API writes these). */
export const OUTBOX_KINDS = [
  "annotation.create",
  "reply.create",
  "annotation.withdraw",
  "decision.create",
  "decision.update",
  "work_item.update",
  "submission.apply",
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/**
 * Artifact actor reference credited when no acting actor is supplied — rule
 * crossings are performed by the rule engine itself (design §13).
 */
export const SYSTEM_RULE_ENGINE_REF = "system:rule-engine";

/**
 * Artifact actor reference recorded as `created_by` of `resolve_conflict`
 * work items — the apply pipeline itself creates them (design §12.6).
 */
export const SYSTEM_APPLY_REF = "system:authorbot";

/** Payload for `annotation.create` outbox rows. */
export interface AnnotationCreatePayload {
  annotationId: string;
}

/** Payload for `reply.create` outbox rows. */
export interface ReplyCreatePayload {
  replyId: string;
}

/**
 * Payload for `annotation.withdraw` outbox rows. `actorId` is the actor who
 * performed the withdrawal (author or maintainer) and is credited in the
 * commit's `Authorbot-Actor` trailer; it defaults to the annotation author.
 */
export interface AnnotationWithdrawPayload {
  annotationId: string;
  actorId?: string;
}

/**
 * Payload for `decision.create` (Phase 3 contract §4) and `decision.update`
 * outbox rows.
 *
 * `decision.create` renders the decision YAML and — when the decision row
 * carries a `workItemId` — the linked work-item Markdown **in the same
 * commit** (one crossing = one logical mutation = one commit). This covers
 * rule crossings, force-creates, and work-item cancellations (whose override
 * decision also references the work item, re-rendering it with its new
 * status).
 *
 * `decision.update` re-renders the decision YAML alone — the
 * `support_changed` mark/clear path (design §11.3); no new decision row
 * exists, so only the `result` line of the artifact changes.
 *
 * - `actorId`: the acting actor (maintainer overrides), credited in the
 *   `Authorbot-Actor` trailer; defaults to `system:rule-engine`.
 * - `createdByActorId`: the actor recorded as the work item's `created_by`
 *   frontmatter. Omitted for rule crossings (`system:rule-engine`); set to
 *   the maintainer for force-creates. Rows that re-render a force-created
 *   work item must pass the *original* creator here so re-renders stay
 *   byte-identical outside the `status` line (`work_items` has no
 *   `created_by` column — flagged to the database owner).
 */
export interface DecisionCreatePayload {
  decisionId: string;
  actorId?: string;
  createdByActorId?: string;
}

/** Payload for `decision.update` outbox rows (see {@link DecisionCreatePayload}). */
export interface DecisionUpdatePayload {
  decisionId: string;
  actorId?: string;
}

/**
 * Payload for `work_item.update` outbox rows: re-render the work-item
 * Markdown after a status change that carries no decision of its own
 * (Phase 4 lease transitions; Phase 3 cancels normally ride the cancel
 * decision's `decision.create` row instead). See
 * {@link DecisionCreatePayload} for `actorId`/`createdByActorId`.
 */
export interface WorkItemUpdatePayload {
  workItemId: string;
  actorId?: string;
  createdByActorId?: string;
}

/**
 * Payload for `submission.apply` outbox rows (Phase 4 contract §5) —
 * written by the submit command in the same batch that transitions the
 * work item `leased → submitted → applying`.
 *
 * The actual patching happens at **drain time** via the injected
 * {@link SubmissionApplier} (the patch engine and current-source access live
 * in the API layer): the applier re-runs on every commit attempt, so a
 * non-fast-forward retry re-resolves against the branch head instead of
 * committing a stale result. The chosen outcome is persisted back onto this
 * payload (`resolved`) *before* the commit, which makes crash recovery
 * finalize exactly the outcome that was committed.
 *
 * - `createdByActorId`: original creator of the work item for byte-stable
 *   re-renders (see {@link DecisionCreatePayload}); the *submitting* actor is
 *   read from the submission row itself.
 */
export interface SubmissionApplyPayload {
  submissionId: string;
  workItemId: string;
  createdByActorId?: string;
}

/** Everything the applier needs to patch or detect a conflict. */
export interface SubmissionApplyContext {
  branch: string;
  submission: SubmissionRecord;
  workItem: WorkItemRecord;
  annotation: AnnotationRecord;
  /** Git-operation attempt this invocation belongs to. */
  attempt: number;
}

/**
 * Result of one apply attempt (design §12.6):
 *
 * - `applied` — the submission maps cleanly onto the current chapter (equal
 *   base revision, or a deterministic §10.2 steps 1–4 rebase with no
 *   overlap). `patchedSource` is the full chapter file with the new body but
 *   the frontmatter still at the prior revision; the processor performs the
 *   revision bump + author credit and stages the atomic multi-file commit.
 * - `conflict` — ambiguous/overlapping/absent target: the newer chapter is
 *   NEVER overwritten. The processor renders the both-texts
 *   `resolve_conflict` artifact, re-renders the original item as `conflict`,
 *   and inserts the conflict work-item row in the finalize batch.
 */
export type SubmissionApplyOutcome =
  | {
      result: "applied";
      /** Repo-relative chapter path, e.g. `chapters/01-signal.md`. */
      chapterPath: string;
      /** Full patched chapter source (frontmatter at the prior revision). */
      patchedSource: string;
      /** Revision the apply produces (prior revision + 1). */
      newRevision: number;
      /** Valid block ids of the patched chapter (projection row update). */
      blockIds: string[];
    }
  | {
      result: "conflict";
      /** Deterministic, human-readable reason (artifact + event). */
      reason: string;
      /** Current text at the target — the conflict artifact's Original text. */
      currentText: string;
      /** Chapter revision the conflict was detected against. */
      currentRevision: number;
      /** Fresh UUIDv7 for the new resolve_conflict work item. */
      conflictWorkItemId: string;
    };

/** Drain-time patch hook, injected by the API layer (module split, §6.2). */
export interface SubmissionApplier {
  apply(context: SubmissionApplyContext): Promise<SubmissionApplyOutcome>;
}

export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

export interface CreateProcessorOptions {
  db: SqlDatabase;
  writer: BookRepoWriter;
  /** Injectable time source (defaults to the system clock). */
  clock?: Clock;
  /** Maximum commit attempts per operation (default 3, contract §5). */
  maxAttempts?: number;
  /**
   * Required to process `submission.apply` rows (Phase 4). Without it such
   * rows fail with a clear error instead of guessing.
   */
  submissionApplier?: SubmissionApplier;
}

export interface DrainRowOutcome {
  outboxId: string;
  gitOperationId: string | null;
  result: "committed" | "failed";
  commitSha?: string;
  error?: string;
}

export interface DrainResult {
  outcomes: DrainRowOutcome[];
}

export interface Processor {
  /** Drain the project's outbox serially, oldest row first. */
  drain(projectId: string): Promise<DrainResult>;
}

/** Guard against state-machine bugs looping forever within one row. */
const MAX_STATE_STEPS = 32;

export function createProcessor(options: CreateProcessorOptions): Processor {
  const db = options.db;
  const writer = options.writer;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const maxAttempts = options.maxAttempts ?? MAX_GIT_ATTEMPTS;
  const applier = options.submissionApplier;
  const repos = createRepositories(db);
  const now = (): string => toTimestamp(clock.now());

  async function drain(projectId: string): Promise<DrainResult> {
    const outcomes: DrainRowOutcome[] = [];

    // Resume rows a crashed drain left `processing` (single drainer per
    // project: any processing row at drain entry is a crash leftover).
    const stuck = await db
      .prepare(
        `SELECT id FROM outbox WHERE project_id = ? AND status = 'processing'
         ORDER BY created_at, id`,
      )
      .bind(projectId)
      .all();
    for (const stuckRow of stuck) {
      const row = await repos.outbox.getById(String(stuckRow["id"]));
      if (row) {
        outcomes.push(await processRow(row));
      }
    }

    // Claim and process pending rows in insertion order.
    for (;;) {
      const row = await repos.outbox.nextPending(projectId);
      if (!row) break;
      const claimed = await repos.outbox.markProcessing(row.id);
      if (!claimed) continue; // raced away; nextPending will move on
      outcomes.push(await processRow({ ...row, status: "processing", attempts: row.attempts + 1 }));
    }

    return { outcomes };
  }

  async function processRow(row: OutboxRecord): Promise<DrainRowOutcome> {
    if (row.gitOperationId === null) {
      await repos.outbox.markFailed(row.id, now());
      return outcome(row, "failed", { error: "outbox row has no git operation" });
    }
    let op = await repos.gitOperations.getById(row.gitOperationId);
    if (!op) {
      await repos.outbox.markFailed(row.id, now());
      return outcome(row, "failed", { error: `git operation ${row.gitOperationId} not found` });
    }

    for (let step = 0; step < MAX_STATE_STEPS; step++) {
      switch (op.state) {
        case "committed":
        case "verified": {
          // Crash-recovery path: commit exists, record/outbox not yet final.
          const sync = await buildSyncStatements(row, op.commitSha);
          await db.batch([
            ...sync,
            completionEventStatement(row, op),
            repos.outbox.markDoneStatement(row.id, now()),
          ]);
          return outcome(row, "committed", op.commitSha === null ? {} : { commitSha: op.commitSha });
        }
        case "failed": {
          await repos.outbox.markFailed(row.id, now());
          return outcome(row, "failed", op.error === null ? {} : { error: op.error });
        }
        case "conflict": {
          const retry = transitionGitOperation(op, "queued", maxAttempts);
          if (!retry.allowed) {
            return failOperation(row, op, op.error ?? "git operation retries exhausted");
          }
          // Clear the recorded conflict error on requeue: the row is being
          // retried, and a later success must not report a stale error.
          op = await persistTransition(op, "queued", retry.next.attempts, null);
          continue;
        }
        case "queued": {
          const t = transitionGitOperation(op, "preparing", maxAttempts);
          if (!t.allowed) return failOperation(row, op, t.message);
          op = await persistTransition(op, "preparing", t.next.attempts);
          continue;
        }
        case "preparing": {
          const t = transitionGitOperation(op, "committing", maxAttempts);
          if (!t.allowed) return failOperation(row, op, t.message);
          op = await persistTransition(op, "committing", t.next.attempts);
          continue;
        }
        case "committing": {
          let plan: CommitPlan;
          try {
            plan = await buildCommitPlan(row, op);
          } catch (error) {
            return failOperation(row, op, errorMessage(error));
          }
          let commitSha: string;
          try {
            const result = await writer.commitFiles({
              branch: plan.branch,
              ...(op.expectedHead === null ? {} : { expectedHeadOverride: op.expectedHead }),
              files: plan.files,
              message: plan.message,
              trailers: plan.trailers,
            });
            commitSha = result.commitSha;
          } catch (error) {
            if (isGitWriteError(error) && error.retryable) {
              const t = transitionGitOperation(op, "conflict", maxAttempts);
              if (!t.allowed) return failOperation(row, op, t.message);
              op = await persistTransition(op, "conflict", t.next.attempts, error.message);
              continue; // the `conflict` case decides retry vs exhaustion
            }
            return failOperation(row, op, errorMessage(error));
          }
          // One atomic batch: operation committed (+SHA), record synced
          // (status leaves `pending_git`), outbox row done (contract §5).
          const ts = now();
          await db.batch([
            repos.gitOperations.updateStateStatement(op.id, {
              state: "committed",
              updatedAt: ts,
              commitSha,
              // Explicitly clear any error left by earlier conflict attempts:
              // a committed operation must never report a stale failure.
              error: null,
            }),
            ...(await buildSyncStatements(row, commitSha)),
            completionEventStatement(row, op),
            repos.outbox.markDoneStatement(row.id, ts),
          ]);
          return outcome(row, "committed", { commitSha });
        }
      }
    }
    return failOperation(row, op, `git operation ${op.id} exceeded ${MAX_STATE_STEPS} state steps`);
  }

  /** Mark the operation `failed` (if a legal transition remains) and the outbox row failed. */
  async function failOperation(
    row: OutboxRecord,
    op: GitOperationRecord,
    error: string,
  ): Promise<DrainRowOutcome> {
    const t = transitionGitOperation(op, "failed", maxAttempts);
    if (t.allowed) {
      await repos.gitOperations.updateState(op.id, {
        state: "failed",
        updatedAt: now(),
        error,
      });
    }
    await repos.outbox.markFailed(row.id, now());
    return outcome(row, "failed", { error });
  }

  async function persistTransition(
    op: GitOperationRecord,
    state: GitOperationState,
    attempts: number,
    /** Omitted: keep the stored error; `null`: clear it; string: set it. */
    error?: string | null,
  ): Promise<GitOperationRecord> {
    await repos.gitOperations.updateState(op.id, {
      state,
      updatedAt: now(),
      attempts,
      ...(error === undefined ? {} : { error }),
    });
    return { ...op, state, attempts, error: error === undefined ? op.error : error };
  }

  interface CommitPlan {
    branch: string;
    files: CommitFile[];
    message: string;
    trailers: Record<string, string>;
  }

  async function buildCommitPlan(row: OutboxRecord, op: GitOperationRecord): Promise<CommitPlan> {
    const project = await repos.projects.getById(row.projectId);
    if (!project) throw new Error(`project ${row.projectId} not found`);
    const branch = project.defaultBranch;
    const kind = parseKind(row);

    if (kind === "annotation.create" || kind === "annotation.withdraw") {
      const payload = parseAnnotationPayload(row);
      const annotation = await mustAnnotation(payload.annotationId);
      const authorRef = await actorRef(annotation.authorActorId);
      const isWithdraw = kind === "annotation.withdraw";
      const actingRef = isWithdraw
        ? await actorRef(payload.actorId ?? annotation.authorActorId)
        : authorRef;
      const file = renderAnnotationArtifact({
        id: annotation.id,
        kind: annotation.kind,
        scope: annotation.scope,
        chapterId: annotation.chapterId,
        chapterRevision: annotation.chapterRevision,
        author: authorRef,
        status: isWithdraw ? "withdrawn" : "open",
        createdAt: annotation.createdAt,
        ...(annotation.target === null ? {} : { target: annotation.target }),
        body: annotation.body,
      });
      return {
        branch,
        files: [file],
        message: isWithdraw
          ? `Withdraw annotation ${annotation.id}`
          : `Create annotation ${annotation.id}`,
        trailers: {
          [ACTOR_TRAILER]: actingRef,
          [ANNOTATION_TRAILER]: annotation.id,
          [OPERATION_TRAILER]: op.id,
        },
      };
    }

    if (kind === "decision.create" || kind === "decision.update") {
      const payload = parseDecisionPayload(row);
      const decision = await mustDecision(payload.decisionId);
      const actingRef =
        payload.actorId === undefined ? SYSTEM_RULE_ENGINE_REF : await actorRef(payload.actorId);
      const files: RenderedFile[] = [renderDecisionFile(decision)];
      const trailers: Record<string, string> = {
        [ACTOR_TRAILER]: actingRef,
        [ANNOTATION_TRAILER]: decision.sourceAnnotationId,
      };
      let message =
        kind === "decision.create"
          ? `Record decision ${decision.id}`
          : `Update decision ${decision.id}`;
      // One crossing = one commit: the create row also renders the linked
      // work item so both artifacts land as one logical mutation (task/
      // contract §4). Cancel decisions re-render the item with its new
      // status the same way.
      if (kind === "decision.create" && decision.workItemId !== null) {
        const workItem = await mustWorkItem(decision.workItemId);
        files.push(await renderWorkItemFile(workItem, payload.createdByActorId));
        trailers[WORK_ITEM_TRAILER] = workItem.id;
        message =
          workItem.status === "ready"
            ? `Create work item ${workItem.id}`
            : `Update work item ${workItem.id}`;
      }
      trailers[OPERATION_TRAILER] = op.id;
      return { branch, files, message, trailers };
    }

    if (kind === "submission.apply") {
      return buildSubmissionApplyPlan(row, op, branch);
    }

    if (kind === "work_item.update") {
      const payload = parseWorkItemPayload(row);
      const workItem = await mustWorkItem(payload.workItemId);
      const actingRef =
        payload.actorId === undefined ? SYSTEM_RULE_ENGINE_REF : await actorRef(payload.actorId);
      return {
        branch,
        files: [await renderWorkItemFile(workItem, payload.createdByActorId)],
        message: `Update work item ${workItem.id}`,
        trailers: {
          [ACTOR_TRAILER]: actingRef,
          [ANNOTATION_TRAILER]: workItem.sourceAnnotationId,
          [WORK_ITEM_TRAILER]: workItem.id,
          [OPERATION_TRAILER]: op.id,
        },
      };
    }

    // reply.create
    const payload = parseReplyPayload(row);
    const reply = await repos.replies.getById(payload.replyId);
    if (!reply) throw new Error(`reply ${payload.replyId} not found`);
    const authorRef2 = await actorRef(reply.authorActorId);
    const file = renderReplyArtifact({
      id: reply.id,
      annotationId: reply.annotationId,
      parentReplyId: reply.parentReplyId,
      author: authorRef2,
      createdAt: reply.createdAt,
      body: reply.body,
    });
    return {
      branch,
      files: [file],
      message: `Create reply ${reply.id}`,
      trailers: {
        [ACTOR_TRAILER]: authorRef2,
        [ANNOTATION_TRAILER]: reply.annotationId,
        [OPERATION_TRAILER]: op.id,
      },
    };
  }

  /**
   * Build the atomic apply/conflict commit for a `submission.apply` row
   * (Phase 4 contract §5, design §12.6, §14.2). Invokes the applier unless a
   * persisted outcome for this very attempt exists (crash recovery), persists
   * the outcome onto the payload BEFORE committing, then stages either:
   *
   * - applied: chapter file (revision bumped, author credited), work item
   *   `completed` + Completion metadata, annotation `accepted`, attribution
   *   append — ONE commit with the §14.3 trailer set; or
   * - conflict: original work item re-rendered `conflict` + the both-texts
   *   `resolve_conflict` artifact — the chapter is never touched.
   */
  async function buildSubmissionApplyPlan(
    row: OutboxRecord,
    op: GitOperationRecord,
    branch: string,
  ): Promise<CommitPlan> {
    const payload = parseSubmissionApplyPayload(row);
    const workItem = await mustWorkItem(payload.workItemId);
    const submission = await mustSubmission(payload.submissionId);
    if (submission.workItemId !== workItem.id) {
      throw new Error(`submission ${submission.id} does not belong to work item ${workItem.id}`);
    }
    const annotation = await mustAnnotation(workItem.sourceAnnotationId);
    const submitterRef = await actorRef(submission.actorId);

    let resolved = readResolved(row);
    if (resolved === null || resolved.attempt !== op.attempts) {
      // New attempt (or first): resolve against the current head. A reused
      // outcome (same attempt) means a crash between persist and finalize —
      // the commit, if it landed, matched exactly this outcome.
      if (applier === undefined) {
        throw new Error(
          "submission.apply requires a SubmissionApplier (createProcessor({ submissionApplier }))",
        );
      }
      const outcome = await applier.apply({
        branch,
        submission,
        workItem,
        annotation,
        attempt: op.attempts,
      });
      resolved = {
        attempt: op.attempts,
        outcome: await resolveOutcome(outcome, workItem, submitterRef),
      };
      await persistResolved(row, resolved);
    }

    const trailers: Record<string, string> = {
      [ACTOR_TRAILER]: submitterRef,
      [WORK_ITEM_TRAILER]: workItem.id,
      [ANNOTATION_TRAILER]: workItem.sourceAnnotationId,
      [BASE_REVISION_TRAILER]: String(submission.baseRevision),
      [OPERATION_TRAILER]: op.id,
    };

    if (resolved.outcome.result === "applied") {
      const outcome = resolved.outcome;
      const completion: WorkItemCompletion = {
        submissionId: submission.id,
        appliedRevision: outcome.newRevision,
        completedAt: outcome.completedAt,
        completedBy: submitterRef,
      };
      // The attribution append re-reads the committed file on every attempt;
      // appendAttributionEntry is idempotent, so a replay over an
      // already-landed commit converges on identical bytes.
      const prior = await mustReadFile(branch, attributionFilePath(workItem.chapterId));
      const attribution = appendAttributionEntry(prior, workItem.chapterId, {
        revision: outcome.newRevision,
        actor: submitterRef,
        workItemId: workItem.id,
      });
      return {
        branch,
        files: [
          { path: outcome.chapterPath, content: outcome.content },
          await renderWorkItemFile(workItem, payload.createdByActorId, {
            status: "completed",
            completion,
          }),
          await renderAnnotationWithStatus(annotation, "accepted"),
          attribution.file,
        ],
        message: `Apply work item ${workItem.id}`,
        trailers,
      };
    }

    const outcome = resolved.outcome;
    return {
      branch,
      files: [
        await renderWorkItemFile(workItem, payload.createdByActorId, { status: "conflict" }),
        renderConflictArtifact(workItem, submission, outcome),
      ],
      message: `Record conflict on work item ${workItem.id}`,
      trailers,
    };
  }

  /** Turn an applier outcome into the persisted, commit-ready form. */
  async function resolveOutcome(
    outcome: SubmissionApplyOutcome,
    workItem: WorkItemRecord,
    submitterRef: string,
  ): Promise<ResolvedApply["outcome"]> {
    if (outcome.result === "applied") {
      const updated = applyChapterFrontmatterUpdate(outcome.patchedSource, {
        revision: outcome.newRevision,
        author: submitterRef,
      });
      if (updated.frontmatter.id !== workItem.chapterId) {
        throw new Error(
          `applier returned chapter ${updated.frontmatter.id}, expected ${workItem.chapterId}`,
        );
      }
      return {
        result: "applied",
        chapterPath: outcome.chapterPath,
        content: updated.content,
        newRevision: outcome.newRevision,
        contentHash: await sha256Hash(updated.content),
        blockIds: outcome.blockIds,
        completedAt: now(),
      };
    }
    const ts = now();
    return {
      result: "conflict",
      reason: outcome.reason,
      currentText: outcome.currentText,
      conflictWorkItem: {
        id: outcome.conflictWorkItemId,
        projectId: workItem.projectId,
        type: "resolve_conflict",
        status: "ready",
        sourceAnnotationId: workItem.sourceAnnotationId,
        chapterId: workItem.chapterId,
        baseRevision: outcome.currentRevision,
        target: workItem.target,
        priority: workItem.priority,
        createdAt: ts,
        updatedAt: ts,
      },
    };
  }

  /** The §13 both-texts conflict artifact (module docs in work-item-artifact). */
  function renderConflictArtifact(
    workItem: WorkItemRecord,
    submission: SubmissionRecord,
    outcome: Extract<ResolvedApply["outcome"], { result: "conflict" }>,
  ): RenderedFile {
    const conflict = outcome.conflictWorkItem;
    return renderWorkItemArtifact({
      id: conflict.id,
      type: "resolve_conflict",
      status: "ready",
      sourceAnnotationId: conflict.sourceAnnotationId,
      chapterId: conflict.chapterId,
      baseRevision: conflict.baseRevision,
      priority: conflict.priority,
      createdBy: SYSTEM_APPLY_REF,
      createdAt: conflict.createdAt,
      context:
        `Submission ${submission.id} (\`${submission.type}\`) for work item ` +
        `${workItem.id} could not be applied: ${outcome.reason}. The chapter moved from ` +
        `revision ${submission.baseRevision} to revision ${conflict.baseRevision} while the ` +
        `work was in flight. Merge the submitted change (Requested change) into the current ` +
        `text (Original text) and submit the merged chapter.`,
      originalText: outcome.currentText,
      requestedChange:
        `The change below was submitted against revision ${submission.baseRevision}. ` +
        `Merge it with the current text shown in the Original text section.`,
      submittedText: submission.content,
      acceptanceCriteria: DEFAULT_CONFLICT_ACCEPTANCE_CRITERIA,
    });
  }

  /** Re-render an annotation artifact with an explicit status. */
  async function renderAnnotationWithStatus(
    annotation: AnnotationRecord,
    status: "accepted",
  ): Promise<RenderedFile> {
    const authorRef = await actorRef(annotation.authorActorId);
    return renderAnnotationArtifact({
      id: annotation.id,
      kind: annotation.kind,
      scope: annotation.scope,
      chapterId: annotation.chapterId,
      chapterRevision: annotation.chapterRevision,
      author: authorRef,
      status,
      createdAt: annotation.createdAt,
      ...(annotation.target === null ? {} : { target: annotation.target }),
      body: annotation.body,
    });
  }

  /** Reads via the writer are mandatory for apply rows (writer.ts docs). */
  async function mustReadFile(branch: string, filePath: string): Promise<string | null> {
    if (writer.readFile === undefined) {
      throw new Error(
        "submission.apply requires a writer with readFile (prior attribution artifact); " +
          "LocalGitAdapter provides it, the GitHub adapter gains it in Phase 5",
      );
    }
    return writer.readFile(branch, filePath);
  }

  function readResolved(row: OutboxRecord): ResolvedApply | null {
    const payload = row.payload as { resolved?: ResolvedApply | null } | null;
    const resolved = payload?.resolved;
    if (resolved === undefined || resolved === null) return null;
    if (typeof resolved.attempt !== "number" || typeof resolved.outcome !== "object") {
      throw new Error(`outbox row ${row.id}: malformed resolved apply outcome`);
    }
    return resolved;
  }

  /**
   * Persist the resolved outcome onto the outbox payload before committing,
   * so crash recovery finalizes exactly what was committed (never re-running
   * the applier over its own landed commit).
   */
  async function persistResolved(row: OutboxRecord, resolved: ResolvedApply): Promise<void> {
    const payload = { ...(row.payload as Record<string, unknown>), resolved };
    await db
      .prepare(`UPDATE outbox SET payload = ? WHERE id = ?`)
      .bind(JSON.stringify(payload), row.id)
      .run();
    row.payload = payload;
  }

  /** Finalize statements for a committed `submission.apply` row. */
  async function submissionApplySyncStatements(
    row: OutboxRecord,
    commitSha: string | null,
    ts: string,
  ): Promise<SqlStatement[]> {
    const payload = parseSubmissionApplyPayload(row);
    const resolved = readResolved(row);
    if (resolved === null) {
      throw new Error(`outbox row ${row.id}: committed submission.apply has no resolved outcome`);
    }
    const workItem = await mustWorkItem(payload.workItemId);
    if (resolved.outcome.result === "applied") {
      const outcome = resolved.outcome;
      const statements: SqlStatement[] = [
        repos.workItems.updateStatusStatement(workItem.id, "completed", ts),
        repos.annotations.updateStatusStatement(workItem.sourceAnnotationId, "accepted", ts),
        repos.submissions.transitionStateStatement(payload.submissionId, "applying", "applied", ts),
      ];
      const chapter = await repos.chapters.getById(workItem.chapterId);
      if (chapter !== null) {
        statements.push(
          repos.chapters.upsertStatement({
            ...chapter,
            revision: outcome.newRevision,
            contentHash: outcome.contentHash,
            blockIds: outcome.blockIds,
            headCommit: commitSha ?? chapter.headCommit,
            updatedAt: ts,
          }),
        );
      }
      statements.push(
        repos.events.appendStatement({
          projectId: row.projectId,
          type: "work_item_completed",
          payload: {
            workItemId: workItem.id,
            submissionId: payload.submissionId,
            chapterId: workItem.chapterId,
            revision: outcome.newRevision,
          },
          createdAt: ts,
        }),
      );
      return statements;
    }
    const outcome = resolved.outcome;
    const statements: SqlStatement[] = [
      repos.workItems.updateStatusStatement(workItem.id, "conflict", ts),
      repos.submissions.transitionStateStatement(payload.submissionId, "applying", "conflicted", ts),
    ];
    // Idempotent insert: a crash-recovery replay must not violate the PK.
    const existing = await repos.workItems.getById(outcome.conflictWorkItem.id);
    if (existing === null) {
      statements.push(repos.workItems.insertStatement(outcome.conflictWorkItem));
    }
    statements.push(
      repos.events.appendStatement({
        projectId: row.projectId,
        type: "work_item_conflict",
        payload: {
          workItemId: workItem.id,
          submissionId: payload.submissionId,
          chapterId: workItem.chapterId,
          conflictWorkItemId: outcome.conflictWorkItem.id,
          reason: outcome.reason,
        },
        createdAt: ts,
      }),
    );
    return statements;
  }

  /**
   * The `operation_completed` feed event (contract §5): appended in the same
   * finalize batch that marks the operation committed and the outbox row done,
   * so the stream reflects `pending_git → committed` transitions.
   */
  function completionEventStatement(row: OutboxRecord, op: GitOperationRecord): SqlStatement {
    return repos.events.appendStatement({
      projectId: row.projectId,
      type: "operation_completed",
      payload: { operationId: op.id, kind: row.kind },
      createdAt: now(),
    });
  }

  /** Statements that move the mirrored record out of `pending_git` (idempotent). */
  async function buildSyncStatements(
    row: OutboxRecord,
    commitSha: string | null,
  ): Promise<SqlStatement[]> {
    const kind = parseKind(row);
    const ts = now();
    if (kind === "submission.apply") {
      return submissionApplySyncStatements(row, commitSha, ts);
    }
    if (kind === "annotation.create") {
      const payload = parseAnnotationPayload(row);
      return [repos.annotations.updateStatusStatement(payload.annotationId, "open", ts)];
    }
    if (kind === "annotation.withdraw") {
      const payload = parseAnnotationPayload(row);
      return [repos.annotations.updateStatusStatement(payload.annotationId, "withdrawn", ts)];
    }
    if (kind === "reply.create") {
      const payload = parseReplyPayload(row);
      return [repos.replies.updateStatusStatement(payload.replyId, "open", ts)];
    }
    // Decision and work-item rows have no `pending_git`-style mirror state
    // (their DB rows are final at command time, Phase 3 contract §4): the
    // finalize batch only marks the operation committed and the row done.
    return [];
  }

  /** Render the decision YAML from its projection row (contract §4). */
  function renderDecisionFile(decision: DecisionRecord): RenderedFile {
    return renderDecisionArtifact({
      id: decision.id,
      sourceAnnotationId: decision.sourceAnnotationId,
      rule: decision.rule,
      ruleVersion: decision.ruleVersion,
      metrics: decision.metrics,
      result: decision.result,
      supportChanged: decision.supportChanged,
      workItemId: decision.workItemId,
      effectiveAt: decision.createdAt,
      overrideReason: decision.overrideReason,
    });
  }

  /**
   * Render the work-item Markdown from its projection row plus its source
   * annotation (Context = annotation body per Phase 3 contract §4; Original
   * text = the target snapshot's quote). Deterministic per work item so a
   * status re-render changes only the frontmatter `status` line.
   */
  async function renderWorkItemFile(
    workItem: WorkItemRecord,
    createdByActorId: string | undefined,
    overrides: {
      /** Status to render before the row transition lands (apply finalize). */
      status?: WorkItemRecord["status"];
      completion?: WorkItemCompletion;
    } = {},
  ): Promise<RenderedFile> {
    const annotation = await mustAnnotation(workItem.sourceAnnotationId);
    const createdBy =
      createdByActorId === undefined ? SYSTEM_RULE_ENGINE_REF : await actorRef(createdByActorId);
    return renderWorkItemArtifact({
      id: workItem.id,
      type: workItem.type,
      status: overrides.status ?? workItem.status,
      sourceAnnotationId: workItem.sourceAnnotationId,
      chapterId: workItem.chapterId,
      baseRevision: workItem.baseRevision,
      priority: workItem.priority,
      createdBy,
      createdAt: workItem.createdAt,
      context: annotation.body,
      originalText: quoteExact(workItem.target),
      // The voted proposal is the annotation body, which the contract pins
      // to the Context section; Requested change references it rather than
      // duplicating the prose (design §13: "without pretending it is
      // already the final prose").
      requestedChange: `Apply the change proposed in suggestion ${workItem.sourceAnnotationId} (see Context).`,
      ...(overrides.completion === undefined ? {} : { completion: overrides.completion }),
    });
  }

  async function mustAnnotation(id: string): Promise<AnnotationRecord> {
    const annotation = await repos.annotations.getById(id);
    if (!annotation) throw new Error(`annotation ${id} not found`);
    return annotation;
  }

  async function mustDecision(id: string): Promise<DecisionRecord> {
    const decision = await repos.decisions.getById(id);
    if (!decision) throw new Error(`decision ${id} not found`);
    return decision;
  }

  async function mustWorkItem(id: string): Promise<WorkItemRecord> {
    const workItem = await repos.workItems.getById(id);
    if (!workItem) throw new Error(`work item ${id} not found`);
    return workItem;
  }

  async function mustSubmission(id: string): Promise<SubmissionRecord> {
    const submission = await repos.submissions.getById(id);
    if (!submission) throw new Error(`submission ${id} not found`);
    return submission;
  }

  /** Resolve an actor id to its artifact actor reference (`github:octocat`). */
  async function actorRef(actorId: string): Promise<string> {
    const actor = await repos.actors.getById(actorId);
    if (!actor) throw new Error(`actor ${actorId} not found`);
    if (actor.externalIdentity === null) {
      throw new Error(`actor ${actorId} has no external identity for artifact attribution`);
    }
    return actor.externalIdentity;
  }

  return { drain };
}

function outcome(
  row: OutboxRecord,
  result: DrainRowOutcome["result"],
  extra: { commitSha?: string; error?: string },
): DrainRowOutcome {
  return { outboxId: row.id, gitOperationId: row.gitOperationId, result, ...extra };
}

function parseKind(row: OutboxRecord): OutboxKind {
  if ((OUTBOX_KINDS as readonly string[]).includes(row.kind)) {
    return row.kind as OutboxKind;
  }
  throw new Error(`unknown outbox kind: ${JSON.stringify(row.kind)}`);
}

function parseAnnotationPayload(row: OutboxRecord): AnnotationWithdrawPayload {
  const payload = row.payload as Partial<AnnotationWithdrawPayload> | null;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.annotationId !== "string" ||
    (payload.actorId !== undefined && typeof payload.actorId !== "string")
  ) {
    throw new Error(`outbox row ${row.id}: malformed ${row.kind} payload`);
  }
  return payload as AnnotationWithdrawPayload;
}

function parseReplyPayload(row: OutboxRecord): ReplyCreatePayload {
  const payload = row.payload as Partial<ReplyCreatePayload> | null;
  if (payload === null || typeof payload !== "object" || typeof payload.replyId !== "string") {
    throw new Error(`outbox row ${row.id}: malformed ${row.kind} payload`);
  }
  return payload as ReplyCreatePayload;
}

function parseDecisionPayload(row: OutboxRecord): DecisionCreatePayload {
  const payload = row.payload as Partial<DecisionCreatePayload> | null;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.decisionId !== "string" ||
    (payload.actorId !== undefined && typeof payload.actorId !== "string") ||
    (payload.createdByActorId !== undefined && typeof payload.createdByActorId !== "string")
  ) {
    throw new Error(`outbox row ${row.id}: malformed ${row.kind} payload`);
  }
  return payload as DecisionCreatePayload;
}

/**
 * The persisted apply outcome (`payload.resolved` of a `submission.apply`
 * outbox row): everything needed to rebuild the exact commit plan and the
 * finalize batch without re-invoking the applier. `attempt` binds the
 * outcome to one git-operation attempt — a retry (new attempt) re-resolves,
 * a crash-recovery replay (same attempt) reuses.
 */
interface ResolvedApply {
  attempt: number;
  outcome:
    | {
        result: "applied";
        chapterPath: string;
        /** Final chapter bytes (revision bumped, author credited). */
        content: string;
        newRevision: number;
        /** `sha256:<hex>` of `content` (chapters projection row). */
        contentHash: string;
        blockIds: string[];
        /** Timestamp rendered into the artifact's Completion section. */
        completedAt: string;
      }
    | {
        result: "conflict";
        reason: string;
        currentText: string;
        /** The fully-formed resolve_conflict row inserted at finalize. */
        conflictWorkItem: WorkItemRecord;
      };
}

function parseSubmissionApplyPayload(row: OutboxRecord): SubmissionApplyPayload {
  const payload = row.payload as Partial<SubmissionApplyPayload> | null;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.submissionId !== "string" ||
    typeof payload.workItemId !== "string" ||
    (payload.createdByActorId !== undefined && typeof payload.createdByActorId !== "string")
  ) {
    throw new Error(`outbox row ${row.id}: malformed ${row.kind} payload`);
  }
  return payload as SubmissionApplyPayload;
}

/** `sha256:<hex>` of the UTF-8 bytes (WebCrypto: Node and Workers). */
async function sha256Hash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function parseWorkItemPayload(row: OutboxRecord): WorkItemUpdatePayload {
  const payload = row.payload as Partial<WorkItemUpdatePayload> | null;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.workItemId !== "string" ||
    (payload.actorId !== undefined && typeof payload.actorId !== "string") ||
    (payload.createdByActorId !== undefined && typeof payload.createdByActorId !== "string")
  ) {
    throw new Error(`outbox row ${row.id}: malformed ${row.kind} payload`);
  }
  return payload as WorkItemUpdatePayload;
}

/** Extract the exact quote from a stored target snapshot, when present. */
function quoteExact(target: unknown): string {
  if (target === null || typeof target !== "object") return "";
  const textQuote = (target as { textQuote?: unknown }).textQuote;
  if (textQuote === null || typeof textQuote !== "object") return "";
  const exact = (textQuote as { exact?: unknown }).exact;
  return typeof exact === "string" ? exact : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
