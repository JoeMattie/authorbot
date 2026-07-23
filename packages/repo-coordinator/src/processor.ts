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
import { BOOK_CONFIG_PATH, mergeBookConfigArtifact } from "./book-config-artifact.js";
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
  CHAPTER_TRAILER,
  isGitWriteError,
  OPERATION_TRAILER,
  REVISION_PROPOSAL_TRAILER,
  WORK_ITEM_TRAILER,
  type BookRepoWriter,
  type CommitFile,
} from "./writer.js";

/** Outbox row kinds this processor understands (the API writes these). */
export const OUTBOX_KINDS = [
  "annotation.create",
  "reply.create",
  "reply.withdraw",
  "annotation.withdraw",
  "decision.create",
  "decision.update",
  "work_item.update",
  "submission.apply",
  "chapter.write",
  "repository_document.write",
  "book_config.update",
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/**
 * Artifact actor reference credited when no acting actor is supplied - rule
 * crossings are performed by the rule engine itself (design §13).
 */
export const SYSTEM_RULE_ENGINE_REF = "system:rule-engine";

/**
 * Artifact actor reference recorded as `created_by` of `resolve_conflict`
 * work items - the apply pipeline itself creates them (design §12.6).
 */
export const SYSTEM_APPLY_REF = "system:authorbot";

/**
 * Payload for `book_config.update` outbox rows (Phase 6 contract §3.6).
 *
 * `config` is the complete `authorbot.book/v1` document to write, not a patch:
 * the commit must be reproducible from the row alone, and a patch would have
 * to be replayed against whatever `book.yml` happens to be at HEAD when the
 * drain runs.
 *
 * `changed` is the list of dotted field paths the maintainer edited, used only
 * to write a commit message a human can read in `git log` without diffing.
 */
export interface BookConfigUpdatePayload {
  /** The maintainer who made the change; credited in `Authorbot-Actor`. */
  actorId: string;
  config: unknown;
  changed: string[];
  /**
   * The last committed config, restored to `book_configs` if this operation
   * dead-letters. Without it a failed settings commit strands the row in
   * `pending_git` forever: PATCH 409s on it, `projectBookConfig` defers to it,
   * and `resolveRuleEntries` keeps *enforcing* governance from a `book.yml`
   * that Git does not contain - the "second configuration store" §3.6 forbids.
   */
  previousConfig?: unknown;
  /** `source_commit` of {@link previousConfig}, restored alongside it. */
  previousSourceCommit?: string | null;
}

/** Payload for `annotation.create` outbox rows. */
export interface AnnotationCreatePayload {
  annotationId: string;
}

/** Payload for `reply.create` outbox rows. */
export interface ReplyCreatePayload {
  replyId: string;
}

/**
 * Payload for `reply.withdraw`. The acting actor may differ from the reply
 * author only for maintainer moderation and is credited in the commit trailer.
 */
export interface ReplyWithdrawPayload {
  replyId: string;
  actorId: string;
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
 * `decision.create` renders the decision YAML and the source annotation's
 * transitioned status, plus - when the decision row carries a `workItemId` -
 * the linked work-item Markdown **in the same commit** (one crossing = one
 * logical mutation = one commit). This covers rule crossings, force-creates,
 * rejects, reopens, and work-item cancellations (whose override decision also
 * references the work item, re-rendering it with its new status).
 *
 * `decision.update` re-renders the decision YAML alone - the
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
 *   `created_by` column - flagged to the database owner).
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
 * Payload for `submission.apply` outbox rows (Phase 4 contract §5) -
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
 * - `applied` - the submission maps cleanly onto the current chapter (equal
 *   base revision, or a deterministic §10.2 steps 1-4 rebase with no
 *   overlap). `patchedSource` is the full chapter file with the new body but
 *   the frontmatter still at the prior revision; the processor performs the
 *   revision bump + author credit and stages the atomic multi-file commit.
 * - `conflict` - ambiguous/overlapping/absent target: the newer chapter is
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
      /** Current text at the target - the conflict artifact's Original text. */
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

/** What a `chapter.write` row asks for (Phase 6 contract §3.5). */
export type ChapterWriteAction = "create" | "revise" | "publish" | "unpublish";

/**
 * Payload for `chapter.write` outbox rows - the direct authoring path
 * (Phase 6 contract §3.5, design §15.2 `chapter-submissions`).
 *
 * The row carries the author's *intent*, never rendered bytes: the chapter
 * file is composed at drain time by the injected {@link ChapterComposer},
 * against the current branch head, for exactly the reason `submission.apply`
 * resolves late. A create's slug and `order` and a revise's marker reuse all
 * depend on what is committed right now, and a plan computed at request time
 * would either clobber a chapter that landed in between or assign a slug that
 * is no longer free. `intent` is opaque here: the processor never interprets
 * it, so the vocabulary of the authoring path can grow without this package
 * learning about prose.
 */
export interface ChapterWritePayload {
  chapterId: string;
  action: ChapterWriteAction;
  /** Actor performing the write: commit trailer + attribution credit. */
  actorId: string;
  /**
   * Review proposal whose approved content this write applies. Omitted for
   * the existing direct-authoring path.
   */
  revisionProposalId?: string;
  /** Composer-defined author intent (title, body, baseRevision, …). */
  intent: Record<string, unknown>;
}

/** Apply one reviewed Outline, Timeline, or Character document proposal. */
export interface RepositoryDocumentWritePayload {
  revisionProposalId: string;
}

/** Everything the composer needs to render the chapter at branch head. */
export interface ChapterComposeContext {
  branch: string;
  projectId: string;
  payload: ChapterWritePayload;
  /** Artifact actor reference (`github:octocat`) of the writing actor. */
  actorRef: string;
  /** Human-readable token name for an agent actor; omitted for humans. */
  actorName?: string;
  /** Git-operation attempt this invocation belongs to. */
  attempt: number;
}

/**
 * The composed chapter file. A composer that cannot honour the intent
 * against the current head (stale base revision, slug taken, chapter gone)
 * throws: unlike a submission there is no second party whose text could be
 * lost, so the honest outcome is a failed operation the author retries, not
 * a conflict work item nobody asked for.
 */
export interface ChapterComposeOutcome {
  /** Repo-relative path, e.g. `chapters/0030-the-ridge.md`. */
  chapterPath: string;
  /** Full chapter file bytes: frontmatter + marked body, final. */
  content: string;
  slug: string;
  title: string;
  /** Current validated frontmatter summary after this write. */
  summary: string | null;
  /** Chapter frontmatter order persisted into the projection. */
  order: number;
  status: "draft" | "proposed" | "published" | "archived";
  /** Revision the composed file carries. */
  revision: number;
  /** `sha256:<hex>` of {@link content}. */
  contentHash: string;
  /** Valid block-marker ids in document order (projection row). */
  blockIds: string[];
  /** Commit subject line. */
  message: string;
}

/** Drain-time chapter renderer, injected by the API layer (Phase 6 §3.5). */
export interface ChapterComposer {
  compose(context: ChapterComposeContext): Promise<ChapterComposeOutcome>;
}

export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

/** Default ceiling on availability deferral before an operation is failed. */
const DEFAULT_MAX_DEFERRAL_MS = 60 * 60 * 1000;

export interface CreateProcessorOptions {
  db: SqlDatabase;
  writer: BookRepoWriter;
  /** Injectable time source (defaults to the system clock). */
  clock?: Clock;
  /** Maximum commit attempts per operation (default 3, contract §5). */
  maxAttempts?: number;
  /**
   * How long an operation may keep being deferred for GitHub availability
   * before it is failed instead (default 1 hour).
   *
   * Deferral exists so a transient outage does not burn the commit budget,
   * but it must still END. An operation that defers forever is invisible: it
   * is neither committed nor failed, so nothing surfaces it and nobody is
   * told the write never landed. Past this deadline it fails with an error
   * naming the cause, and an operator can requeue it once GitHub is back.
   */
  maxDeferralMs?: number;
  /**
   * Required to process `submission.apply` rows (Phase 4). Without it such
   * rows fail with a clear error instead of guessing.
   */
  submissionApplier?: SubmissionApplier;
  /**
   * Required to process `chapter.write` rows (Phase 6 contract §3.5).
   * Without it such rows fail with a clear error instead of guessing.
   */
  chapterComposer?: ChapterComposer;
  /**
   * Outbox kinds this drain must LEAVE ALONE, evaluated once per drain.
   *
   * Rows of a paused kind are neither claimed nor failed: they stay `pending`
   * so the backlog resumes by itself when the pause lifts. The coordinator
   * uses it to stop `submission.apply` while the project is `diverged` - a
   * submission accepted moments before a webhook reconciliation marked the
   * project diverged would otherwise still commit prose to a repository
   * Authorbot knows it mis-models, because the divergence guard sat only at
   * request intake and nothing on the drain path read `projects.status`.
   */
  pausedKinds?(projectId: string): Promise<readonly string[]>;
}

export interface DrainRowOutcome {
  outboxId: string;
  gitOperationId: string | null;
  result: "committed" | "failed" | "deferred";
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
  const maxDeferralMs = options.maxDeferralMs ?? DEFAULT_MAX_DEFERRAL_MS;
  const applier = options.submissionApplier;
  const chapterComposer = options.chapterComposer;
  const repos = createRepositories(db);
  const now = (): string => toTimestamp(clock.now());

  async function drain(projectId: string): Promise<DrainResult> {
    const outcomes: DrainRowOutcome[] = [];
    // Read once per drain, before anything is claimed: a pause that begins
    // mid-drain is honoured by the next drain, and the set cannot change
    // under the loop.
    const paused = new Set(await (options.pausedKinds?.(projectId) ?? Promise.resolve([])));

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
      if (row && !paused.has(row.kind)) {
        outcomes.push(await processRow(row));
      }
    }

    // Claim and process pending rows in insertion order. A paused kind is
    // skipped rather than claimed - and the loop CONTINUES past it, so a
    // paused prose row does not stall the annotation and work-item rows
    // queued behind it.
    const skipped = new Set<string>();
    for (;;) {
      const row = await repos.outbox.nextPending(projectId, {
        ...(paused.size === 0 ? {} : { excludeKinds: [...paused] }),
        ...(skipped.size === 0 ? {} : { excludeIds: [...skipped] }),
      });
      if (!row) break;
      const claimed = await repos.outbox.markProcessing(row.id);
      if (!claimed) {
        // Raced away (or otherwise no longer pending): exclude it explicitly
        // so `nextPending` cannot hand back the same row forever.
        skipped.add(row.id);
        continue;
      }
      const rowOutcome = await processRow({
        ...row,
        status: "processing",
        attempts: row.attempts + 1,
      });
      outcomes.push(rowOutcome);
      if (rowOutcome.result === "deferred") {
        // A deferral hands the row back to a LATER drain, so this one must
        // stop considering it. `deferOperation` returns it to `pending`, and
        // without this the very next `nextPending` call hands back the same
        // row - an unbounded spin at 100% CPU, because deferral deliberately
        // does not spend the attempt budget that bounds every other retry.
        // In production that would peg the coordinator's Durable Object
        // against a GitHub outage instead of yielding until its next alarm.
        skipped.add(row.id);
      }
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
            await completionEventStatement(row, op),
            repos.outbox.markDoneStatement(row.id, now()),
          ]);
          return outcome(row, "committed", op.commitSha === null ? {} : { commitSha: op.commitSha });
        }
        case "failed": {
          // A crash/requeue may hand us an operation whose terminal state was
          // persisted before its owning record was released. Re-run the
          // guarded cleanup so linked proposals (and apply work) cannot stay
          // `applying` forever merely because the operation is already failed.
          return failOperation(row, op, op.error ?? "git operation failed");
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
          const expectedHead = plan.expectedHead ?? op.expectedHead ?? undefined;
          // A SHA left on the row while the operation is still `committing` is
          // an ATTEMPT, not a landing: `committed`/`verified` are the states
          // that mean the ref moved. Handing it back lets the writer settle
          // "did my commit land?" by ancestry - an answer that holds however
          // many commits a third party pushed between the crash and this
          // replay, unlike the bounded trailer scan.
          const attemptedCommitSha = op.commitSha ?? undefined;
          // Captured non-null so the `onCommitCreated` closure below does not
          // defeat the narrowing on `op`.
          const committingOp = op;
          try {
            const result = await writer.commitFiles({
              branch: plan.branch,
              ...(expectedHead === undefined ? {} : { expectedHeadOverride: expectedHead }),
              ...(attemptedCommitSha === undefined ? {} : { attemptedCommitSha }),
              files: plan.files,
              message: plan.message,
              trailers: plan.trailers,
              onCommitCreated: (created: string): Promise<void> =>
                persistCommitAttempt(committingOp, created),
            });
            commitSha = result.commitSha;
          } catch (error) {
            if (isGitWriteError(error) && error.retryable) {
              // CONTENTION vs AVAILABILITY. `non-fast-forward` means the branch
              // moved under us: the right response is to re-resolve against the
              // new head immediately, and the bounded attempt budget exists for
              // exactly that.
              if (error.kind === "non-fast-forward") {
                const t = transitionGitOperation(op, "conflict", maxAttempts);
                if (!t.allowed) return failOperation(row, op, t.message);
                op = await persistTransition(op, "conflict", t.next.attempts, error.message);
                continue; // the `conflict` case decides retry vs exhaustion
              }
              // Anything else retryable is GitHub being unavailable - a 5xx or
              // a rate limit. Retrying inside this drain spends all three
              // attempts within milliseconds against a service that is simply
              // down, so an outage lasting longer than one drain pass used to
              // fail the operation PERMANENTLY, with the content stranded in
              // `pending_git` and nothing to retry it. That defeats the point
              // of the outbox.
              //
              // So an availability failure defers instead: the operation goes
              // back to `queued` WITHOUT consuming the commit budget and the
              // outbox row returns to `pending`, leaving the next drain (the
              // coordinator alarm) to try again. Deferral is deliberately
              // unbounded - the write is durable and should land when GitHub
              // comes back, and a persistent backlog is visible through queue
              // depth and the operation's recorded error.
              return deferOperation(row, op, error.message);
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
            await completionEventStatement(row, op),
            repos.outbox.markDoneStatement(row.id, ts),
          ]);
          return outcome(row, "committed", { commitSha });
        }
      }
    }
    return failOperation(row, op, `git operation ${op.id} exceeded ${MAX_STATE_STEPS} state steps`);
  }

  /**
   * Mark the operation `failed` (if a legal transition remains) and the
   * outbox row failed - releasing whatever the row had left in flight.
   *
   * A `submission.apply` row holds a work item hostage: the submit command
   * moved it to `applying` AND released its lease in one batch, so a
   * terminal failure here previously left the item unclaimable (not
   * `ready`), unreleasable (no active lease), un-resubmittable (not
   * `leased`), and uncancellable (`applying` has no cancel edge) - dead,
   * with no event telling any client. The failure paths are ordinary
   * (a writer without `readFile`, an actor with no external identity,
   * retries exhausted on contention), so the row must hand the item back.
   *
   * `applying → conflict` is the §9.5 edge that fits: the edit could not be
   * applied and a human must repair it. `conflict → ready` keeps the item
   * recoverable, the submission lands in its terminal `conflicted` state,
   * and `work_item_conflict` carries the reason to the feed.
   */
  /**
   * Hand an operation back to a later drain without spending its retry budget.
   * Used when the failure is GitHub's availability rather than anything about
   * this mutation: the attempt count is what bounds *contention* retries, and
   * spending it on an outage is what used to strand writes permanently.
   */
  async function deferOperation(
    row: OutboxRecord,
    op: GitOperationRecord,
    error: string,
  ): Promise<DrainRowOutcome> {
    // Deferral is generous but not infinite. Past the deadline the outage has
    // stopped being transient, and a write parked in `queued` forever tells
    // nobody anything - failing it makes the loss visible and leaves the
    // operator a requeue once GitHub is healthy again.
    const age = Date.parse(now()) - Date.parse(op.createdAt);
    // `>=`, not `>`: with a frozen clock (tests) or a zero deadline, an
    // operation must still be able to reach the deadline it was given.
    if (Number.isFinite(age) && age >= maxDeferralMs) {
      return failOperation(
        row,
        op,
        `${error} (giving up after ${Math.round(age / 60000)} minutes of retrying; ` +
          `requeue the operation once GitHub is reachable)`,
      );
    }
    await repos.gitOperations.updateState(op.id, {
      state: "queued",
      updatedAt: now(),
      error,
    });
    await repos.outbox.markPending(row.id);
    return outcome(row, "deferred", { error });
  }

  async function failOperation(
    row: OutboxRecord,
    op: GitOperationRecord,
    error: string,
  ): Promise<DrainRowOutcome> {
    const ts = now();
    const t = transitionGitOperation(op, "failed", maxAttempts);
    const statements: SqlStatement[] = [];
    if (t.allowed) {
      statements.push(
        repos.gitOperations.updateStateStatement(op.id, {
          state: "failed",
          updatedAt: ts,
          error,
        }),
      );
    }
    statements.push(...(await releaseFailedApplyStatements(row, ts, error)));
    statements.push(...(await releaseFailedChapterWriteStatements(row, ts, error)));
    statements.push(...(await releaseFailedRepositoryDocumentStatements(row, ts, error)));
    statements.push(...(await releaseFailedBookConfigStatements(row, ts)));
    statements.push(repos.outbox.markFailedStatement(row.id, ts));
    await db.batch(statements);
    return outcome(row, "failed", { error });
  }

  /**
   * Statements returning a failed `book_config.update` row's `book_configs`
   * entry to the last config that actually reached Git.
   *
   * Every other pending-state owner has a release path - `submission.apply`
   * via {@link releaseFailedApplyStatements}, pending annotations and replies
   * via the rebuild sweep - and `book_config` was the one that did not. A
   * settings commit fails for ordinary reasons (an actor with no external
   * identity, a revoked token, contention), and the row it left behind was
   * terminal: `projectBookConfig` defers to `pending_git` so Git could never
   * re-assert itself, the settings PATCH route 409s on the same status so the
   * maintainer could not correct it, and `resolveRuleEntries` kept serving -
   * and *enforcing* - governance rules from a document no commit contains.
   *
   * Guarded on `git_operation_id` so a later PATCH that already replaced this
   * row is never reverted by its predecessor's failure.
   */
  async function releaseFailedBookConfigStatements(
    row: OutboxRecord,
    ts: string,
  ): Promise<SqlStatement[]> {
    if (row.kind !== "book_config.update" || row.gitOperationId === null) {
      return [];
    }
    let payload: BookConfigUpdatePayload;
    try {
      payload = parseBookConfigPayload(row);
    } catch {
      return [];
    }
    const existing = await repos.bookConfigs.get(row.projectId);
    if (
      existing === null ||
      existing.status !== "pending_git" ||
      existing.gitOperationId !== row.gitOperationId
    ) {
      return [];
    }
    // No recorded predecessor means this was the book's first settings write,
    // so there is no committed config to fall back to. Dropping the row is the
    // honest state: the projection re-reads `book.yml` from Git on its next
    // pass, settings reads report the book as unprojected rather than serving
    // a document no commit contains, and governance falls back to the
    // deployment's bootstrap rules - the *stricter* direction, so a failed
    // commit can never leave a weakened rule in force.
    if (payload.previousConfig === undefined || payload.previousConfig === null) {
      return [repos.bookConfigs.deletePendingStatement(row.projectId, row.gitOperationId)];
    }
    return [
      repos.bookConfigs.upsertStatement({
        projectId: row.projectId,
        config: payload.previousConfig,
        status: "committed",
        gitOperationId: null,
        sourceCommit: payload.previousSourceCommit ?? null,
        createdAt: existing.createdAt,
        updatedAt: ts,
      }),
    ];
  }

  /**
   * Statements returning a failed `submission.apply` row's work item and
   * submission to honest terminal states. Guarded on the exact expected
   * states so a replay (or a row that never got that far) is a no-op.
   */
  async function releaseFailedApplyStatements(
    row: OutboxRecord,
    ts: string,
    error: string,
  ): Promise<SqlStatement[]> {
    if (row.kind !== "submission.apply") {
      return [];
    }
    let payload: SubmissionApplyPayload;
    try {
      payload = parseSubmissionApplyPayload(row);
    } catch {
      return []; // Malformed payload is what failed us; nothing to release.
    }
    const proposal = await repos.revisionProposals.getBySubmissionId(payload.submissionId);
    const proposalMatches =
      proposal !== null &&
      proposal.projectId === row.projectId &&
      proposal.workItemId === payload.workItemId &&
      proposal.status === "applying" &&
      proposal.gitOperationId === row.gitOperationId;
    const proposalStatements: SqlStatement[] =
      !proposalMatches
        ? []
        : [
            repos.revisionProposals.finalizeStatement(proposal.id, "applying", {
              status: "conflicted",
              updatedAt: ts,
            }),
            repos.events.appendStatement({
              projectId: row.projectId,
              type: "revision_proposal_conflicted",
              payload: {
                revisionProposalId: proposal.id,
                chapterId: proposal.chapterId,
                targetKind: "chapter",
                proposalType: proposal.proposalType,
                submissionId: payload.submissionId,
                workItemId: payload.workItemId,
                reason: error,
              },
              createdAt: ts,
            }),
          ];
    const workItem = await repos.workItems.getById(payload.workItemId);
    if (workItem === null || workItem.status !== "applying") {
      return proposalStatements;
    }
    return [
      db
        .prepare(
          `UPDATE work_items SET status = 'conflict', updated_at = ?
             WHERE id = ? AND status = 'applying'`,
        )
        .bind(ts, workItem.id),
      repos.submissions.transitionStateStatement(payload.submissionId, "applying", "conflicted", ts),
      ...proposalStatements,
      repos.events.appendStatement({
        projectId: row.projectId,
        type: "work_item_conflict",
        payload: {
          workItemId: workItem.id,
          submissionId: payload.submissionId,
          chapterId: workItem.chapterId,
          conflictWorkItemId: null,
          reason: `the submission could not be applied: ${error}`,
          ...(proposalMatches ? { revisionProposalId: proposal.id } : {}),
        },
        createdAt: ts,
      }),
    ];
  }

  /** A failed reviewed chapter write must not leave its proposal applying forever. */
  async function releaseFailedChapterWriteStatements(
    row: OutboxRecord,
    ts: string,
    error: string,
  ): Promise<SqlStatement[]> {
    if (row.kind !== "chapter.write") return [];
    let payload: ChapterWritePayload;
    try {
      payload = parseChapterWritePayload(row);
    } catch {
      return [];
    }
    if (payload.revisionProposalId === undefined) return [];
    const proposal = await repos.revisionProposals.getById(payload.revisionProposalId);
    if (
      proposal === null ||
      proposal.projectId !== row.projectId ||
      proposal.chapterId !== payload.chapterId ||
      proposal.status !== "applying" ||
      proposal.gitOperationId !== row.gitOperationId
    ) {
      return [];
    }
    return [
      repos.revisionProposals.finalizeStatement(proposal.id, "applying", {
        status: "conflicted",
        updatedAt: ts,
      }),
      repos.events.appendStatement({
        projectId: row.projectId,
        type: "revision_proposal_conflicted",
        payload: {
          revisionProposalId: proposal.id,
          chapterId: proposal.chapterId,
          targetKind: "chapter",
          proposalType: proposal.proposalType,
          reason: error,
        },
        createdAt: ts,
      }),
    ];
  }

  /** A failed planning-document write settles its reviewed proposal as conflict. */
  async function releaseFailedRepositoryDocumentStatements(
    row: OutboxRecord,
    ts: string,
    error: string,
  ): Promise<SqlStatement[]> {
    if (row.kind !== "repository_document.write") return [];
    let payload: RepositoryDocumentWritePayload;
    try {
      payload = parseRepositoryDocumentWritePayload(row);
    } catch {
      return [];
    }
    const proposal = await repos.revisionProposals.getById(payload.revisionProposalId);
    if (
      proposal === null ||
      proposal.projectId !== row.projectId ||
      proposal.proposalType !== "repository_document" ||
      proposal.status !== "applying" ||
      proposal.gitOperationId !== row.gitOperationId
    ) {
      return [];
    }
    return [
      repos.revisionProposals.finalizeStatement(proposal.id, "applying", {
        status: "conflicted",
        updatedAt: ts,
      }),
      repos.events.appendStatement({
        projectId: row.projectId,
        type: "revision_proposal_conflicted",
        payload: {
          revisionProposalId: proposal.id,
          targetKind: proposal.targetKind,
          targetId: proposal.targetId,
          targetPath: proposal.targetPath,
          proposalType: proposal.proposalType,
          reason: error,
        },
        createdAt: ts,
      }),
    ];
  }

  /**
   * Record the commit object an in-flight attempt just created, leaving the
   * operation in `committing`.
   *
   * Written before the ref update, so the row survives the one window where
   * the commit can land without us learning that it did: the `PATCH` is
   * applied and the connection drops, the isolate is evicted, the process
   * dies. On the replay this SHA comes back as `attemptedCommitSha` and the
   * writer settles it by ancestry instead of committing a second time.
   */
  async function persistCommitAttempt(
    op: GitOperationRecord,
    commitSha: string,
  ): Promise<void> {
    await repos.gitOperations.updateState(op.id, {
      state: "committing",
      updatedAt: now(),
      attempts: op.attempts,
      commitSha,
    });
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
    /**
     * Head SHA this plan's contents were computed against. When set, the
     * commit is refused with a retryable `non-fast-forward` if the branch has
     * moved - the guard that stops a replayed plan from clobbering newer
     * work. Takes precedence over the operation row's `expected_head`.
     */
    expectedHead?: string;
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
      // A decision.create is also the durable annotation transition. Without
      // this re-render, a projection rebuild would restore the old `open`
      // annotation artifact and resurrect voting and promotion controls even
      // though the decision and work item were already committed.
      if (kind === "decision.create") {
        const annotation = await mustAnnotation(decision.sourceAnnotationId);
        const authorRef = await actorRef(annotation.authorActorId);
        let transitionedStatus: Exclude<AnnotationRecord["status"], "pending_git">;
        if (decision.actionType === "create_work_item") {
          transitionedStatus = "work_item_created";
        } else if (decision.actionType === "reject_suggestion") {
          transitionedStatus = "rejected";
        } else if (decision.actionType === "reopen_suggestion") {
          transitionedStatus = "open";
        } else {
          if (annotation.status === "pending_git") {
            throw new Error(
              `decision ${decision.id}: cannot mirror pending annotation ${annotation.id}`,
            );
          }
          transitionedStatus = annotation.status;
        }
        files.push(
          renderAnnotationArtifact({
            id: annotation.id,
            kind: annotation.kind,
            scope: annotation.scope,
            chapterId: annotation.chapterId,
            chapterRevision: annotation.chapterRevision,
            author: authorRef,
            status: transitionedStatus,
            createdAt: annotation.createdAt,
            ...(annotation.target === null ? {} : { target: annotation.target }),
            body: annotation.body,
          }),
        );
      }
      // One crossing = one commit: the create row also renders the linked
      // work item so all three artifacts land as one logical mutation (task/
      // contract §4). Cancel decisions re-render the item with its new status
      // the same way.
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

    if (kind === "chapter.write") {
      return buildChapterWritePlan(row, op, branch);
    }

    if (kind === "repository_document.write") {
      return buildRepositoryDocumentWritePlan(row, op, branch);
    }

    /**
     * Settings write (Phase 6 contract §3.6). The config is carried IN the
     * payload rather than re-read from `book_configs` at commit time: the row
     * describes one specific revision of `book.yml`, and re-reading would let
     * a later PATCH's config be committed under an earlier operation's
     * message and trailers - two edits collapsing into one commit and losing
     * the audit trail the contract requires each of them to leave.
     */
    if (kind === "book_config.update") {
      const payload = parseBookConfigPayload(row);
      const actingRef = await actorRef(payload.actorId);
      // Only the paths the maintainer edited are written, onto the `book.yml`
      // that is at the branch head right now. The payload's config comes from
      // the `book_configs` projection, which can be arbitrarily stale (frozen
      // while the project is diverged, or kept on an `invalid` projection
      // outcome), so rendering the whole file from it silently reverted direct
      // Git edits - including `content.raw_html`, which §3.6 declares belongs
      // in a reviewed commit. It also preserves the author's comments.
      //
      // The head is resolved and pinned the same way `chapter.write` pins
      // `composed.resolvedHead`: the merge below is computed against these
      // exact bytes, so a commit landing between this read and the ref update
      // must fail the precondition and recompute rather than replay onto a
      // head it never saw. Pinning the *projection's* `source_commit` instead
      // would be wrong - it is arbitrarily old, and every unrelated commit to
      // the branch would dead-letter the settings write.
      const resolvedHead = (await writer.resolveHead?.(branch)) ?? null;
      const head = await mustReadFile(branch, BOOK_CONFIG_PATH);
      return {
        branch,
        ...(resolvedHead === null ? {} : { expectedHead: resolvedHead }),
        files: [mergeBookConfigArtifact(head, payload.config, payload.changed)],
        message: `Update book settings (${payload.changed.join(", ")})`,
        trailers: {
          [ACTOR_TRAILER]: actingRef,
          [OPERATION_TRAILER]: op.id,
        },
      };
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

    // reply.create / reply.withdraw
    const payload = parseReplyPayload(row);
    const reply = await repos.replies.getById(payload.replyId);
    if (!reply) throw new Error(`reply ${payload.replyId} not found`);
    const authorRef2 = await actorRef(reply.authorActorId);
    const isWithdraw = kind === "reply.withdraw";
    const actingRef = isWithdraw
      ? await actorRef((payload as ReplyWithdrawPayload).actorId)
      : authorRef2;
    const file = renderReplyArtifact({
      id: reply.id,
      annotationId: reply.annotationId,
      parentReplyId: reply.parentReplyId,
      author: authorRef2,
      status: isWithdraw ? "withdrawn" : "open",
      createdAt: reply.createdAt,
      body: reply.body,
    });
    return {
      branch,
      files: [file],
      message: isWithdraw ? `Withdraw reply ${reply.id}` : `Create reply ${reply.id}`,
      trailers: {
        [ACTOR_TRAILER]: actingRef,
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
   *   append - ONE commit with the §14.3 trailer set; or
   * - conflict: original work item re-rendered `conflict` + the both-texts
   *   `resolve_conflict` artifact - the chapter is never touched.
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
    await linkedSubmissionRevisionProposal(row, payload, workItem);
    const annotation = await mustAnnotation(workItem.sourceAnnotationId);
    const submitter = await artifactActor(submission.actorId);
    const submitterRef = submitter.ref;

    let resolved = readResolved(row);
    if (resolved === null || resolved.attempt !== op.attempts) {
      // New attempt (or first): resolve against the current head. A reused
      // outcome (same attempt) means a crash between persist and finalize -
      // the commit, if it landed, matched exactly this outcome.
      if (applier === undefined) {
        throw new Error(
          "submission.apply requires a SubmissionApplier (createProcessor({ submissionApplier }))",
        );
      }
      // Pin the head the applier is about to read. The persisted outcome
      // carries the FULL patched chapter computed against THIS head, so it is
      // only ever safe to commit while the branch still sits here.
      const resolvedHead = (await writer.resolveHead?.(branch)) ?? null;
      const outcome = await applier.apply({
        branch,
        submission,
        workItem,
        annotation,
        attempt: op.attempts,
      });
      resolved = {
        attempt: op.attempts,
        ...(resolvedHead === null ? {} : { resolvedHead }),
        outcome: await resolveOutcome(outcome, workItem, submitterRef, submitter.name),
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
        // Commit ONLY at the head this outcome was computed against. Without
        // the pin, a crash-recovery replay (same attempt, so the outcome is
        // reused rather than re-resolved) committed a chapter built from a
        // stale head verbatim over whatever the branch had advanced to -
        // byte-clobbering a newer revision and stamping a revision number
        // behind it, which then poisons every later base-hash comparison.
        // With it, the writer refuses with a retryable `non-fast-forward`,
        // the operation requeues, and the next attempt re-resolves against
        // the real head. A commit that already landed is still returned by
        // the `Authorbot-Operation` trailer dedup, which runs before this
        // check - so the ordinary crash-after-commit replay still finalizes.
        ...(resolved.resolvedHead === undefined ? {} : { expectedHead: resolved.resolvedHead }),
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
      // The conflict record never touches the chapter, but it quotes the
      // current text, so it is pinned the same way.
      ...(resolved.resolvedHead === undefined ? {} : { expectedHead: resolved.resolvedHead }),
      files: [
        await renderWorkItemFile(workItem, payload.createdByActorId, { status: "conflict" }),
        renderConflictArtifact(workItem, submission, outcome),
      ],
      message: `Record conflict on work item ${workItem.id}`,
      trailers,
    };
  }

  /**
   * Build the atomic chapter commit for a `chapter.write` row (Phase 6
   * contract §3.5). The injected composer renders the chapter against the
   * CURRENT branch head; the outcome is persisted onto the payload before the
   * commit and pinned to the head it was computed against, so a crash-recovery
   * replay finalizes exactly what was committed and never lays a stale
   * chapter over a newer one - the same discipline `submission.apply` uses.
   *
   * Two files, one commit: the chapter itself and its attribution append
   * (design §14.2 - "an accepted edit updates all related artifacts in one
   * commit"). Nothing else: a direct authoring write has no annotation, no
   * work item, and no decision behind it.
   */
  async function buildChapterWritePlan(
    row: OutboxRecord,
    op: GitOperationRecord,
    branch: string,
  ): Promise<CommitPlan> {
    const payload = parseChapterWritePayload(row);
    await linkedChapterRevisionProposal(row, payload);
    const writerActor = await artifactActor(payload.actorId);
    const writerRef = writerActor.ref;

    let composed = readComposed(row);
    if (composed === null || composed.attempt !== op.attempts) {
      if (chapterComposer === undefined) {
        throw new Error(
          "chapter.write requires a ChapterComposer (createProcessor({ chapterComposer }))",
        );
      }
      const resolvedHead = (await writer.resolveHead?.(branch)) ?? null;
      const outcome = await chapterComposer.compose({
        branch,
        projectId: row.projectId,
        payload,
        actorRef: writerRef,
        ...(writerActor.name === undefined ? {} : { actorName: writerActor.name }),
        attempt: op.attempts,
      });
      if (outcome.content.length === 0) {
        throw new Error(`chapter composer returned empty content for chapter ${payload.chapterId}`);
      }
      composed = {
        attempt: op.attempts,
        ...(resolvedHead === null ? {} : { resolvedHead }),
        outcome,
      };
      await persistComposed(row, composed);
    }

    const outcome = composed.outcome;
    // Idempotent on replay: `appendAttributionEntry` converges on identical
    // bytes when the entry is already present.
    const prior = await mustReadFile(branch, attributionFilePath(payload.chapterId));
    const attribution = appendAttributionEntry(prior, payload.chapterId, {
      revision: outcome.revision,
      actor: writerRef,
    });

    const baseRevision = payload.intent["baseRevision"];
    return {
      branch,
      ...(composed.resolvedHead === undefined ? {} : { expectedHead: composed.resolvedHead }),
      files: [{ path: outcome.chapterPath, content: outcome.content }, attribution.file],
      message: outcome.message,
      trailers: {
        [ACTOR_TRAILER]: writerRef,
        [CHAPTER_TRAILER]: payload.chapterId,
        ...(typeof baseRevision === "number"
          ? { [BASE_REVISION_TRAILER]: String(baseRevision) }
          : {}),
        [OPERATION_TRAILER]: op.id,
      },
    };
  }

  /**
   * Apply the exact bytes a maintainer reviewed for a repository-backed
   * planning document. Unlike chapters these documents do not carry a
   * numeric revision, so the immutable content hash is the complete stale
   * base guard. The plan is also pinned to the head read for this attempt,
   * preventing an unrelated concurrent commit from turning the write into a
   * blind overwrite.
   */
  async function buildRepositoryDocumentWritePlan(
    row: OutboxRecord,
    op: GitOperationRecord,
    branch: string,
  ): Promise<CommitPlan> {
    const payload = parseRepositoryDocumentWritePayload(row);
    const proposal = await linkedRepositoryDocumentProposal(row, payload);
    if (writer.readFile === undefined) {
      throw new Error("repository_document.write requires a writer with readFile");
    }
    const resolvedHead = (await writer.resolveHead?.(branch)) ?? null;
    const current = await writer.readFile(branch, proposal.targetPath);
    if (current === null) {
      throw new Error(`repository document ${proposal.targetPath} no longer exists`);
    }
    const [currentHash, retainedBaseHash] = await Promise.all([
      sha256Hash(current),
      sha256Hash(proposal.baseContent),
    ]);
    if (retainedBaseHash !== proposal.baseContentHash) {
      throw new Error(`revision proposal ${proposal.id} retained an invalid base snapshot`);
    }
    if (currentHash !== proposal.baseContentHash) {
      throw new Error(
        `${proposal.targetKind} document ${proposal.targetPath} changed after revision proposal ` +
          `${proposal.id} was created`,
      );
    }
    const author = await artifactActor(proposal.authorActorId);
    const label = proposal.targetKind === "character" ? `character ${proposal.targetId}` : proposal.targetKind;
    return {
      branch,
      ...(resolvedHead === null ? {} : { expectedHead: resolvedHead }),
      files: [{ path: proposal.targetPath, content: proposal.proposedContent }],
      message: `Revise ${label}`,
      trailers: {
        [ACTOR_TRAILER]: author.ref,
        [REVISION_PROPOSAL_TRAILER]: proposal.id,
        [OPERATION_TRAILER]: op.id,
      },
    };
  }

  /** Finalize statements for a committed `chapter.write` row. */
  async function chapterWriteSyncStatements(
    row: OutboxRecord,
    commitSha: string | null,
    ts: string,
  ): Promise<SqlStatement[]> {
    const payload = parseChapterWritePayload(row);
    const composed = readComposed(row);
    if (composed === null) {
      throw new Error(`outbox row ${row.id}: committed chapter.write has no composed outcome`);
    }
    const outcome = composed.outcome;
    const existing = await repos.chapters.getById(payload.chapterId);
    const proposal = await linkedChapterRevisionProposal(row, payload);
    return [
      repos.chapters.upsertStatement({
        id: payload.chapterId,
        projectId: row.projectId,
        path: outcome.chapterPath,
        slug: outcome.slug,
        title: outcome.title,
        summary: outcome.summary,
        order: outcome.order,
        status: outcome.status,
        revision: outcome.revision,
        contentHash: outcome.contentHash,
        headCommit: commitSha ?? existing?.headCommit ?? null,
        lastPublishedCommit:
          outcome.status === "published"
            ? (commitSha ?? existing?.lastPublishedCommit ?? null)
            : (existing?.lastPublishedCommit ?? null),
        blockIds: outcome.blockIds,
        updatedAt: ts,
      }),
      ...(proposal === null
        ? []
        : [
            repos.revisionProposals.finalizeStatement(proposal.id, "applying", {
              status: "approved",
              resultingRevision: outcome.revision,
              commitSha,
              updatedAt: ts,
            }),
          ]),
      repos.events.appendStatement({
        projectId: row.projectId,
        type: CHAPTER_EVENT_TYPES[payload.action],
        payload: {
          chapterId: payload.chapterId,
          slug: outcome.slug,
          title: outcome.title,
          status: outcome.status,
          revision: outcome.revision,
          path: outcome.chapterPath,
          ...(proposal === null ? {} : { revisionProposalId: proposal.id }),
        },
        createdAt: ts,
      }),
      ...(proposal === null
        ? []
        : [
            repos.events.appendStatement({
              projectId: row.projectId,
              type: "revision_proposal_applied",
              payload: {
                revisionProposalId: proposal.id,
                chapterId: proposal.chapterId,
                targetKind: "chapter",
                proposalType: proposal.proposalType,
                commitSha,
              },
              createdAt: ts,
            }),
          ]),
    ];
  }

  /** Resolve and integrity-check an explicitly linked direct/summary proposal. */
  async function linkedChapterRevisionProposal(
    row: OutboxRecord,
    payload: ChapterWritePayload,
  ) {
    if (payload.revisionProposalId === undefined) return null;
    const proposal = await repos.revisionProposals.getById(payload.revisionProposalId);
    if (proposal === null) {
      throw new Error(`revision proposal ${payload.revisionProposalId} not found`);
    }
    if (proposal.projectId !== row.projectId || proposal.chapterId !== payload.chapterId) {
      throw new Error(
        `revision proposal ${proposal.id} does not belong to chapter ${payload.chapterId}`,
      );
    }
    if (proposal.status !== "applying") {
      throw new Error(`revision proposal ${proposal.id} is ${proposal.status}, not applying`);
    }
    if (proposal.gitOperationId !== row.gitOperationId) {
      throw new Error(
        `revision proposal ${proposal.id} belongs to git operation ${proposal.gitOperationId}`,
      );
    }
    return proposal;
  }

  /** Resolve and integrity-check a reviewed planning-document proposal. */
  async function linkedRepositoryDocumentProposal(
    row: OutboxRecord,
    payload: RepositoryDocumentWritePayload,
  ) {
    const proposal = await repos.revisionProposals.getById(payload.revisionProposalId);
    if (proposal === null) {
      throw new Error(`revision proposal ${payload.revisionProposalId} not found`);
    }
    if (
      proposal.projectId !== row.projectId ||
      proposal.proposalType !== "repository_document" ||
      proposal.chapterId !== null
    ) {
      throw new Error(`revision proposal ${proposal.id} is not a repository document proposal`);
    }
    if (proposal.status !== "applying") {
      throw new Error(`revision proposal ${proposal.id} is ${proposal.status}, not applying`);
    }
    if (proposal.gitOperationId !== row.gitOperationId) {
      throw new Error(
        `revision proposal ${proposal.id} belongs to git operation ${proposal.gitOperationId}`,
      );
    }
    return proposal;
  }

  /** Resolve and integrity-check an optional work-submission proposal. */
  async function linkedSubmissionRevisionProposal(
    row: OutboxRecord,
    payload: SubmissionApplyPayload,
    workItem: WorkItemRecord,
  ) {
    const proposal = await repos.revisionProposals.getBySubmissionId(payload.submissionId);
    if (proposal === null) return null; // legacy Phase 4 submission
    if (
      proposal.projectId !== row.projectId ||
      proposal.workItemId !== workItem.id ||
      proposal.chapterId !== workItem.chapterId
    ) {
      throw new Error(
        `revision proposal ${proposal.id} does not belong to submission ${payload.submissionId}`,
      );
    }
    if (proposal.status !== "applying") {
      throw new Error(`revision proposal ${proposal.id} is ${proposal.status}, not applying`);
    }
    if (proposal.gitOperationId !== row.gitOperationId) {
      throw new Error(
        `revision proposal ${proposal.id} belongs to git operation ${proposal.gitOperationId}`,
      );
    }
    return proposal;
  }

  function readComposed(row: OutboxRecord): ComposedChapter | null {
    const payload = row.payload as { composed?: ComposedChapter | null } | null;
    const composed = payload?.composed;
    if (composed === undefined || composed === null) return null;
    if (typeof composed.attempt !== "number" || typeof composed.outcome !== "object") {
      throw new Error(`outbox row ${row.id}: malformed composed chapter outcome`);
    }
    return composed;
  }

  /** Persist the composed chapter before committing (see `persistResolved`). */
  async function persistComposed(row: OutboxRecord, composed: ComposedChapter): Promise<void> {
    const payload = { ...(row.payload as Record<string, unknown>), composed };
    await db
      .prepare(`UPDATE outbox SET payload = ? WHERE id = ?`)
      .bind(JSON.stringify(payload), row.id)
      .run();
    row.payload = payload;
  }

  /** Turn an applier outcome into the persisted, commit-ready form. */
  async function resolveOutcome(
    outcome: SubmissionApplyOutcome,
    workItem: WorkItemRecord,
    submitterRef: string,
    submitterName?: string,
  ): Promise<ResolvedApply["outcome"]> {
    if (outcome.result === "applied") {
      const updated = applyChapterFrontmatterUpdate(outcome.patchedSource, {
        revision: outcome.newRevision,
        author: submitterRef,
        ...(submitterName === undefined ? {} : { authorName: submitterName }),
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
    const proposal = await linkedSubmissionRevisionProposal(row, payload, workItem);
    if (resolved.outcome.result === "applied") {
      const outcome = resolved.outcome;
      const statements: SqlStatement[] = [
        repos.workItems.updateStatusStatement(workItem.id, "completed", ts),
        repos.annotations.updateStatusStatement(workItem.sourceAnnotationId, "accepted", ts),
        repos.submissions.transitionStateStatement(payload.submissionId, "applying", "applied", ts),
        ...(proposal === null
          ? []
          : [
              repos.revisionProposals.finalizeStatement(proposal.id, "applying", {
                status: "approved",
                resultingRevision: outcome.newRevision,
                commitSha,
                updatedAt: ts,
              }),
            ]),
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
            ...(proposal === null ? {} : { revisionProposalId: proposal.id }),
          },
          createdAt: ts,
        }),
      );
      if (proposal !== null) {
        statements.push(
          repos.events.appendStatement({
            projectId: row.projectId,
            type: "revision_proposal_applied",
            payload: {
              revisionProposalId: proposal.id,
              chapterId: proposal.chapterId,
              targetKind: "chapter",
              proposalType: proposal.proposalType,
              submissionId: payload.submissionId,
              workItemId: workItem.id,
              commitSha,
            },
            createdAt: ts,
          }),
        );
      }
      return statements;
    }
    const outcome = resolved.outcome;
    const statements: SqlStatement[] = [
      repos.workItems.updateStatusStatement(workItem.id, "conflict", ts),
      repos.submissions.transitionStateStatement(payload.submissionId, "applying", "conflicted", ts),
      ...(proposal === null
        ? []
        : [
            repos.revisionProposals.finalizeStatement(proposal.id, "applying", {
              status: "conflicted",
              updatedAt: ts,
            }),
          ]),
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
          ...(proposal === null ? {} : { revisionProposalId: proposal.id }),
        },
        createdAt: ts,
      }),
    );
    if (proposal !== null) {
      statements.push(
        repos.events.appendStatement({
          projectId: row.projectId,
          type: "revision_proposal_conflicted",
          payload: {
            revisionProposalId: proposal.id,
            chapterId: proposal.chapterId,
            targetKind: "chapter",
            proposalType: proposal.proposalType,
            submissionId: payload.submissionId,
            workItemId: workItem.id,
            reason: outcome.reason,
          },
          createdAt: ts,
        }),
      );
    }
    return statements;
  }

  /** Finalize a committed Outline, Timeline, or Character document write. */
  async function repositoryDocumentSyncStatements(
    row: OutboxRecord,
    commitSha: string | null,
    ts: string,
  ): Promise<SqlStatement[]> {
    const payload = parseRepositoryDocumentWritePayload(row);
    const proposal = await linkedRepositoryDocumentProposal(row, payload);
    return [
      repos.revisionProposals.finalizeStatement(proposal.id, "applying", {
        status: "approved",
        commitSha,
        updatedAt: ts,
      }),
      repos.events.appendStatement({
        projectId: row.projectId,
        type: "revision_proposal_applied",
        payload: {
          revisionProposalId: proposal.id,
          targetKind: proposal.targetKind,
          targetId: proposal.targetId,
          targetPath: proposal.targetPath,
          proposalType: proposal.proposalType,
          commitSha,
        },
        createdAt: ts,
      }),
    ];
  }

  /**
   * The `operation_completed` feed event (contract §5): appended in the same
   * finalize batch that marks the operation committed and the outbox row done,
   * so the stream reflects `pending_git → committed` transitions. Subtype
   * metadata is resolved from the authoritative linked records rather than
   * copied from caller-controlled input; token event projection uses it to
   * keep adjacent editorial capabilities independent.
   */
  async function completionEventStatement(
    row: OutboxRecord,
    op: GitOperationRecord,
  ): Promise<SqlStatement> {
    const kind = parseKind(row);
    let subtype: Record<string, unknown> = {};
    if (kind === "annotation.create" || kind === "annotation.withdraw") {
      const annotation = await mustAnnotation(parseAnnotationPayload(row).annotationId);
      if (annotation.projectId !== row.projectId) {
        throw new Error(`outbox row ${row.id}: linked annotation is outside project`);
      }
      subtype = { annotationKind: annotation.kind };
    } else if (kind === "reply.create" || kind === "reply.withdraw") {
      const reply = await repos.replies.getById(parseReplyPayload(row).replyId);
      if (reply === null || reply.projectId !== row.projectId) {
        throw new Error(`outbox row ${row.id}: linked reply not found in project`);
      }
      const annotation = await mustAnnotation(reply.annotationId);
      if (annotation.projectId !== row.projectId) {
        throw new Error(`outbox row ${row.id}: linked reply annotation is outside project`);
      }
      subtype = { annotationKind: annotation.kind };
    } else if (kind === "decision.create" || kind === "decision.update") {
      const decision = await mustDecision(parseDecisionPayload(row).decisionId);
      const annotation = await mustAnnotation(decision.sourceAnnotationId);
      if (decision.projectId !== row.projectId || annotation.projectId !== row.projectId) {
        throw new Error(`outbox row ${row.id}: linked decision is outside project`);
      }
      subtype = {
        annotationKind: annotation.kind,
        decisionActionType: decision.actionType,
      };
    } else if (kind === "chapter.write") {
      const payload = parseChapterWritePayload(row);
      if (payload.revisionProposalId === undefined) {
        subtype = { directChapterWrite: true };
      } else {
        const proposal = await linkedChapterRevisionProposal(row, payload);
        if (proposal === null) {
          throw new Error(`outbox row ${row.id}: linked chapter proposal is missing`);
        }
        subtype = { revisionProposalId: proposal.id };
      }
    }
    return repos.events.appendStatement({
      projectId: row.projectId,
      type: "operation_completed",
      payload: { operationId: op.id, kind: row.kind, ...subtype },
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
    if (kind === "chapter.write") {
      return chapterWriteSyncStatements(row, commitSha, ts);
    }
    if (kind === "repository_document.write") {
      return repositoryDocumentSyncStatements(row, commitSha, ts);
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
    if (kind === "reply.withdraw") {
      const payload = parseReplyPayload(row);
      return [repos.replies.updateStatusStatement(payload.replyId, "withdrawn", ts)];
    }
    if (kind === "book_config.update") {
      // Guarded on this operation's id, so a settings write that superseded
      // this one while it was in flight keeps its own `pending_git` status
      // instead of being marked committed by its predecessor landing. A row
      // with no git operation cannot have produced this commit, so there is
      // nothing to mark.
      if (row.gitOperationId === null) return [];
      return [
        repos.bookConfigs.markCommittedStatement(row.projectId, row.gitOperationId, commitSha, ts),
      ];
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
      // The annotation body is context, not already-final prose. Suggestions
      // ask the claimant to apply the proposed change; comments are editorial
      // notes and must not be mislabeled as suggestions in the durable task.
      requestedChange:
        annotation.kind === "suggestion"
          ? `Apply the change proposed in suggestion ${workItem.sourceAnnotationId} (see Context).`
          : `Address the note in annotation ${workItem.sourceAnnotationId} (see Context).`,
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
    return (await artifactActor(actorId)).ref;
  }

  /** Resolve durable attribution plus an optional agent-token display name. */
  async function artifactActor(actorId: string): Promise<{ ref: string; name?: string }> {
    const actor = await repos.actors.getById(actorId);
    if (!actor) throw new Error(`actor ${actorId} not found`);
    if (actor.externalIdentity === null) {
      throw new Error(`actor ${actorId} has no external identity for artifact attribution`);
    }
    return {
      ref: actor.externalIdentity,
      ...(actor.type === "agent" ? { name: actor.displayName } : {}),
    };
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

function parseReplyPayload(row: OutboxRecord): ReplyCreatePayload | ReplyWithdrawPayload {
  const payload = row.payload as Partial<ReplyWithdrawPayload> | null;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.replyId !== "string" ||
    (row.kind === "reply.withdraw" && typeof payload.actorId !== "string")
  ) {
    throw new Error(`outbox row ${row.id}: malformed ${row.kind} payload`);
  }
  return payload as ReplyCreatePayload | ReplyWithdrawPayload;
}

function parseBookConfigPayload(row: OutboxRecord): BookConfigUpdatePayload {
  const payload = row.payload as Partial<BookConfigUpdatePayload> | null;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.actorId !== "string" ||
    typeof payload.config !== "object" ||
    payload.config === null ||
    !Array.isArray(payload.changed) ||
    !payload.changed.every((field) => typeof field === "string")
  ) {
    throw new Error(`outbox row ${row.id}: malformed ${row.kind} payload`);
  }
  return payload as BookConfigUpdatePayload;
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
 * outcome to one git-operation attempt - a retry (new attempt) re-resolves,
 * a crash-recovery replay (same attempt) reuses.
 */
interface ResolvedApply {
  attempt: number;
  /**
   * Branch head the applier read when producing this outcome. Replayed as
   * `expectedHeadOverride` so a reused outcome can only land on the head it
   * was computed from. Absent when the writer cannot report a head (the
   * commit then proceeds unpinned, as before).
   */
  resolvedHead?: string;
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

/** Persisted composer outcome on a `chapter.write` row (crash recovery). */
interface ComposedChapter {
  attempt: number;
  /** Branch head the outcome was composed against; pins the commit. */
  resolvedHead?: string;
  outcome: ChapterComposeOutcome;
}

/** Feed event emitted when a `chapter.write` row commits (Phase 6 §3.5). */
const CHAPTER_EVENT_TYPES: Record<ChapterWriteAction, string> = {
  create: "chapter_created",
  revise: "chapter_revised",
  publish: "chapter_published",
  unpublish: "chapter_unpublished",
};

const CHAPTER_WRITE_ACTIONS = new Set<string>(["create", "revise", "publish", "unpublish"]);

function parseChapterWritePayload(row: OutboxRecord): ChapterWritePayload {
  const payload = row.payload as Partial<ChapterWritePayload> | null;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.chapterId !== "string" ||
    typeof payload.actorId !== "string" ||
    (payload.revisionProposalId !== undefined &&
      typeof payload.revisionProposalId !== "string") ||
    typeof payload.action !== "string" ||
    !CHAPTER_WRITE_ACTIONS.has(payload.action) ||
    payload.intent === null ||
    typeof payload.intent !== "object"
  ) {
    throw new Error(`outbox row ${row.id}: malformed ${row.kind} payload`);
  }
  return payload as ChapterWritePayload;
}

function parseRepositoryDocumentWritePayload(
  row: OutboxRecord,
): RepositoryDocumentWritePayload {
  const payload = row.payload as Partial<RepositoryDocumentWritePayload> | null;
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof payload.revisionProposalId !== "string" ||
    payload.revisionProposalId === ""
  ) {
    throw new Error(`outbox row ${row.id}: malformed ${row.kind} payload`);
  }
  return payload as RepositoryDocumentWritePayload;
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
