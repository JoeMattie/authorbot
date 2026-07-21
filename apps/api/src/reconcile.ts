/**
 * Reconciliation: webhook-driven projection refresh, external-edit detection,
 * and divergence (Phase 5 contract §6; design §14.5, §20.3).
 *
 * Three responsibilities, deliberately in one module because they share one
 * decision:
 *
 * 1. **Staleness.** A verified `push` on the default branch marks the
 *    projection stale and *asks* for a refresh through {@link ProjectionRefresher}.
 *    The flag is set before the request, so a refresh that never happens (DO
 *    unreachable, isolate evicted, request cancelled mid-flight) is still owed
 *    work the coordinator's periodic alarm will find. Reversing that order
 *    would silently drop pushes.
 *
 * 2. **Classification.** Before any projection write, the freshly read
 *    snapshot is compared against the current projection. Chapters fall into
 *    exactly one of: unchanged, externally edited, or divergent.
 *
 * 3. **Divergence.** When the repository broke an invariant Authorbot cannot
 *    reconcile deterministically, the project is marked `diverged`, the
 *    projection is left ALONE, and prose writes are refused. Reads keep
 *    serving the last coherent projection - design §14.5's "block prose
 *    writes until invalid state is repaired, but continue safe reads".
 *
 * ## Why "without an Authorbot operation" is decided structurally
 *
 * The contract asks for external edits - a projected chapter whose content
 * changed *without* an Authorbot operation. Attributing a file change to a
 * commit author would need per-file commit history (an extra API call per
 * chapter per push) and would still be wrong for a squashed or amended
 * commit. Instead the classification is derived from state Authorbot already
 * owns, and the "without an Authorbot operation" clause is satisfied by
 * *idempotence* rather than by attribution:
 *
 * - The re-projection is an upsert at the file's own frontmatter revision,
 *   which for an Authorbot-authored commit is exactly what the projection
 *   already holds - a no-op.
 * - The re-anchor pass skips annotations already decided at that revision
 *   (reanchor.ts), which for an Authorbot-authored commit the post-drain hook
 *   already did - also a no-op.
 *
 * So a push produced by Authorbot's own writer flows through this path and
 * changes nothing, while a push produced by a human editing on GitHub does the
 * full §10.3 work. Nothing depends on guessing who wrote the commit, which is
 * the only version of this that cannot be fooled.
 *
 * ## Why an external edit at an UNCHANGED revision still re-anchors
 *
 * An outside editor is under no obligation to bump frontmatter `revision`.
 * Their prose change can move or delete the text an annotation quotes while
 * the revision number stays put, which leaves annotations that *look*
 * correctly anchored and are not - the §10.2 step 6 hazard. So when the
 * content hash changed, the re-anchor pass runs with `force`, re-deciding
 * every live annotation against the new source regardless of revision.
 */
import {
  createRepositories,
  type ProjectRecord,
  type Repositories,
  type SqlDatabase,
  type SqlStatement,
} from "@authorbot/database";
import { toTimestamp } from "@authorbot/domain";
import type { Context } from "hono";
import { projectBookConfig } from "./book-config.js";
import type { AppEnv, Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";
import { problem } from "./problems.js";
import { reanchorChapterFromSource } from "./reanchor.js";
import type { BookRepoReader, BookRepoSnapshot } from "./projection/reader.js";
import { rebuildProjection, type RebuildResult } from "./projection/rebuild.js";

/**
 * The seam between the webhook and the `ProjectCoordinator` Durable Object
 * (contract §5). The API never imports the coordinator: it asks, through this
 * interface, for a refresh to happen *somewhere serialized*.
 *
 * Implementations may return as soon as the request is durably accepted; the
 * caller treats this as fire-and-forget and never blocks the webhook response
 * on a repository read. A rejection is logged-and-swallowed by the caller
 * because the stale flag - already committed - is the durable record of the
 * owed work.
 */
export interface ProjectionRefresher {
  requestProjectionRefresh(request: ProjectionRefreshRequest): Promise<void>;
}

export interface ProjectionRefreshRequest {
  projectId: string;
  /** Why the refresh was asked for; carried into coordinator logs. */
  reason: ProjectionRefreshReason;
  /** Correlation id of the triggering request, for end-to-end tracing. */
  correlationId: string;
  /** GitHub delivery id, when a webhook triggered this. */
  deliveryId?: string;
  /** Head commit the push reported, when known. */
  headCommit?: string;
}

export type ProjectionRefreshReason =
  | "webhook-push"
  | "divergence-recovery"
  | "manual"
  | "alarm";

export interface ReconcileContext {
  db: SqlDatabase;
  repos: Repositories;
  clock: Clock;
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * Mark the projection stale and ask for a refresh. Returns whether the
 * refresher accepted the request; a refusal is not an error - the stale flag
 * carries the work forward.
 */
export interface StalenessOutcome {
  marked: true;
  /**
   * A refresher is configured, so the refresh belongs to it. True even when
   * the request FAILED: a configured coordinator is the serialization point
   * for this project, and falling back to an in-process refresh because the
   * coordinator was briefly unreachable would run exactly the concurrent
   * projection write the coordinator exists to prevent. The stale flag is
   * durable, so a failed request is retried by the periodic alarm.
   */
  delegated: boolean;
  /** The refresher accepted the request. */
  refreshRequested: boolean;
}

export async function markStaleAndRequestRefresh(
  ctx: ReconcileContext,
  project: ProjectRecord,
  refresher: ProjectionRefresher | undefined,
  request: Omit<ProjectionRefreshRequest, "projectId">,
): Promise<StalenessOutcome> {
  const at = toTimestamp(ctx.clock.now());
  // Durable first: the flag must survive a refresher that never runs.
  await ctx.repos.projects.markProjectionStaleStatement(project.id, at).run();
  if (refresher === undefined) {
    return { marked: true, delegated: false, refreshRequested: false };
  }
  try {
    await refresher.requestProjectionRefresh({ ...request, projectId: project.id });
    return { marked: true, delegated: true, refreshRequested: true };
  } catch {
    // Swallowed deliberately: the webhook has already done the only
    // irreversible thing that matters. Surfacing a 500 here would make GitHub
    // redeliver a delivery whose durable effect already landed.
    return { marked: true, delegated: true, refreshRequested: false };
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** A repository invariant Authorbot cannot reconcile deterministically. */
export type DivergenceKind = "revision-regressed" | "anchor-blocks-vanished";

export interface DivergenceFinding {
  kind: DivergenceKind;
  chapterId: string;
  chapterPath: string;
  /** Revision the projection holds. */
  projectedRevision: number;
  /** Revision the repository file declares. */
  snapshotRevision: number;
  /** For `anchor-blocks-vanished`: block ids that left the file. */
  missingBlockIds?: string[];
  /** For `anchor-blocks-vanished`: live annotations that referenced them. */
  strandedAnnotationIds?: string[];
}

export interface ExternalEdit {
  chapterId: string;
  path: string;
  fromRevision: number;
  toRevision: number;
  previousContentHash: string;
  contentHash: string;
}

export interface SnapshotAnalysis {
  divergence: DivergenceFinding[];
  externalEdits: ExternalEdit[];
  /** Chapters in the snapshot with no projection row yet (first projection). */
  newChapters: number;
}

/** Cap on annotations inspected per changed chapter when hunting anchors. */
const ANCHOR_SCAN_PAGE = 200;

/**
 * Compare a freshly read snapshot against the current projection.
 *
 * Pure with respect to the database: it only reads. The caller decides what to
 * do with the findings, which is what makes both "refuse and diverge" and
 * "accept the repository as truth" (maintainer recovery) expressible without
 * two copies of the detection logic.
 */
export async function analyzeSnapshot(
  ctx: ReconcileContext,
  project: ProjectRecord,
  snapshot: BookRepoSnapshot,
): Promise<SnapshotAnalysis> {
  const { repos } = ctx;
  const projected = await repos.chapters.listByProject(project.id);
  const byId = new Map(projected.map((row) => [row.id, row]));

  const divergence: DivergenceFinding[] = [];
  const externalEdits: ExternalEdit[] = [];
  let newChapters = 0;

  for (const chapter of snapshot.chapters) {
    const current = byId.get(chapter.frontmatter.id);
    if (current === undefined) {
      newChapters += 1;
      continue;
    }
    const snapshotRevision = chapter.frontmatter.revision;

    // (1) Backwards revision. A revision number that moved down means the
    // repository no longer agrees with a history Authorbot already published
    // (annotations, submissions, and task bundles are all keyed to revisions),
    // and no deterministic rule can decide which version is "right".
    if (snapshotRevision < current.revision) {
      divergence.push({
        kind: "revision-regressed",
        chapterId: current.id,
        chapterPath: chapter.path,
        projectedRevision: current.revision,
        snapshotRevision,
      });
      continue;
    }

    if (chapter.contentHash === current.contentHash) {
      continue; // nothing changed in this file
    }

    // (2) Vanished anchors. Block ids are a repository invariant (design
    // §26.1 "mandatory source block IDs"): they are stable identity, not
    // incidental markup. When Authorbot's own patch engine replaces a block it
    // mints the replacement id deliberately and the §10.3 pass flags the
    // affected annotations. An id disappearing from the file with nobody
    // having minted a successor is a broken invariant, so it diverges rather
    // than quietly flagging every annotation that pointed at it.
    const survivingBlocks = new Set(chapter.blockIds);
    const stranded = await strandedAnnotations(ctx, current.id, survivingBlocks);
    if (stranded.annotationIds.length > 0) {
      divergence.push({
        kind: "anchor-blocks-vanished",
        chapterId: current.id,
        chapterPath: chapter.path,
        projectedRevision: current.revision,
        snapshotRevision,
        missingBlockIds: stranded.missingBlockIds,
        strandedAnnotationIds: stranded.annotationIds,
      });
      continue;
    }

    // (3) Ordinary content change - re-project at the file's own revision and
    // re-anchor. See the module docs on why this is safe for Authorbot's own
    // commits too.
    externalEdits.push({
      chapterId: current.id,
      path: chapter.path,
      fromRevision: current.revision,
      toRevision: snapshotRevision,
      previousContentHash: current.contentHash,
      contentHash: chapter.contentHash,
    });
  }

  return { divergence, externalEdits, newChapters };
}

/**
 * Live annotations on `chapterId` whose anchor block id is absent from
 * `survivingBlocks`. Only `open` / `work_item_created` annotations count:
 * a resolved, rejected, withdrawn, or already-`needs_reanchor` annotation has
 * no live claim on a block, so its block disappearing is not a broken
 * invariant - it is history.
 */
async function strandedAnnotations(
  ctx: ReconcileContext,
  chapterId: string,
  survivingBlocks: ReadonlySet<string>,
): Promise<{ annotationIds: string[]; missingBlockIds: string[] }> {
  const annotationIds: string[] = [];
  const missing = new Set<string>();
  let afterId = "";
  for (;;) {
    const page = await ctx.repos.annotations.listByChapter(chapterId, {
      limit: ANCHOR_SCAN_PAGE,
      afterId,
    });
    if (page.length === 0) break;
    for (const a of page) {
      if (a.status !== "open" && a.status !== "work_item_created") continue;
      // Chapter-scope annotations anchor to the chapter, not a block.
      if (a.scope === "chapter") continue;
      const blockId = (a.target as { blockId?: unknown } | null)?.blockId;
      if (typeof blockId !== "string" || blockId.length === 0) continue;
      if (survivingBlocks.has(blockId)) continue;
      annotationIds.push(a.id);
      missing.add(blockId);
    }
    afterId = page[page.length - 1]?.id ?? "";
    if (page.length < ANCHOR_SCAN_PAGE) break;
  }
  return { annotationIds, missingBlockIds: [...missing].sort() };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  /**
   * `diverged` ⇒ the projection was deliberately left untouched.
   * `snapshot-stale` ⇒ divergence findings were discarded because the branch
   * head moved during the pass; the projection is untouched and still owed a
   * refresh.
   */
  outcome: "projected" | "diverged" | "no-reader" | "snapshot-stale";
  rebuild: RebuildResult | null;
  divergence: DivergenceFinding[];
  externalEdits: ExternalEdit[];
  /** §10.3 tallies over externally edited chapters. */
  reanchored: { kept: number; needsReanchor: number };
  /** Commit the projection is now built from, when the reader reported one. */
  projectedCommit: string | null;
}

export interface ReconcileOptions {
  correlationId: string;
  /**
   * Accept the repository as truth even when it diverges (maintainer
   * recovery, contract §6): the snapshot is projected and re-anchored, and
   * divergence is NOT re-flagged from these findings. Never set by the
   * automatic paths.
   */
  acceptRepository?: boolean;
  /** Snapshot already read by the caller; avoids a second repository read. */
  snapshot?: BookRepoSnapshot;
}

/**
 * One reconciliation pass: read the snapshot, classify it, then either mark
 * the project diverged or project + re-anchor.
 *
 * Idempotent by construction. Running it twice over an unchanged repository
 * produces one no-op rebuild and zero re-anchor decisions, so the coordinator
 * alarm can call it freely and a duplicate webhook costs nothing.
 */
export async function reconcileProjection(
  ctx: ReconcileContext,
  project: ProjectRecord,
  reader: BookRepoReader | undefined,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  if (reader === undefined) {
    return {
      outcome: "no-reader",
      rebuild: null,
      divergence: [],
      externalEdits: [],
      reanchored: { kept: 0, needsReanchor: 0 },
      projectedCommit: null,
    };
  }

  // Capture `updated_at` BEFORE the snapshot read: the stale flag is only
  // cleared if nothing bumped the row while this pass was in flight, so a push
  // arriving mid-refresh is not lost (identity.ts
  // `completeProjectionRefreshStatement`).
  const observed = await ctx.repos.projects.getById(project.id);
  const observedUpdatedAt = observed?.updatedAt ?? project.updatedAt;

  const snapshot = options.snapshot ?? (await reader.readSnapshot());
  const analysis = await analyzeSnapshot(ctx, project, snapshot);
  const at = toTimestamp(ctx.clock.now());

  if (analysis.divergence.length > 0 && options.acceptRepository !== true) {
    // Divergence is a project-wide prose-write block that only a maintainer
    // can clear, so it must never be declared on evidence the snapshot itself
    // undermines. If the branch head moved while this pass was reading, the
    // classification compared a snapshot from one commit against a projection
    // some later commit may already have advanced - exactly the shape a
    // `revision-regressed` false positive takes. Leave the flag stale and let
    // the next pass decide from a consistent read.
    if (await snapshotWentStale(reader, snapshot)) {
      await ctx.repos.projects.markProjectionStaleStatement(project.id, at).run();
      return {
        outcome: "snapshot-stale",
        rebuild: null,
        divergence: analysis.divergence,
        externalEdits: analysis.externalEdits,
        reanchored: { kept: 0, needsReanchor: 0 },
        projectedCommit: null,
      };
    }
    await markDiverged(ctx, project, analysis.divergence, options.correlationId, at);
    return {
      outcome: "diverged",
      rebuild: null,
      divergence: analysis.divergence,
      externalEdits: analysis.externalEdits,
      reanchored: { kept: 0, needsReanchor: 0 },
      projectedCommit: null,
    };
  }

  const rebuild = await rebuildProjection(ctx, project, reader, options.correlationId, {
    snapshot,
  });

  // Re-anchor every chapter whose bytes changed. In recovery mode the
  // divergent chapters are re-anchored too - that is the point of accepting
  // the repository: annotations whose anchors are gone become
  // `needs_reanchor` rather than staying quietly wrong.
  const toReanchor = options.acceptRepository === true
    ? [...analysis.externalEdits.map((e) => e.chapterId), ...analysis.divergence.map((d) => d.chapterId)]
    : analysis.externalEdits.map((e) => e.chapterId);
  const reanchored = { kept: 0, needsReanchor: 0 };
  const seen = new Set<string>();
  for (const chapterId of toReanchor) {
    if (seen.has(chapterId)) continue;
    seen.add(chapterId);
    const chapterSnapshot = snapshot.chapters.find((c) => c.frontmatter.id === chapterId);
    if (chapterSnapshot === undefined) continue;
    // Source from the SNAPSHOT, not a fresh read: `revision` and `blockIds`
    // below come from this snapshot, and mixing them with bytes re-read at a
    // newly resolved head anchors annotations against text the projection
    // does not hold. The fallback is only for readers that do not retain
    // file text.
    const source =
      snapshot.files?.get(chapterSnapshot.path) ??
      (await readSource(reader, chapterSnapshot.path));
    if (source === null || source === undefined) {
      // A reader without `readTextFile`, or a file that vanished between the
      // tree read and the blob read. Skipping is correct: re-anchoring against
      // absent source could only guess, and the next push re-runs this pass.
      continue;
    }
    const pass = await reanchorChapterFromSource(
      { db: ctx.db, clock: ctx.clock },
      {
        projectId: project.id,
        chapterId,
        source,
        revision: chapterSnapshot.frontmatter.revision,
        blockIds: chapterSnapshot.blockIds,
        correlationId: options.correlationId,
        force: true,
        trigger: options.acceptRepository === true ? "divergence_recovery" : "external_edit",
      },
      at,
    );
    reanchored.kept += pass.kept;
    reanchored.needsReanchor += pass.needsReanchor;
  }

  const projectedCommit = snapshot.headCommit ?? null;

  // Phase 6 §3.6: `book.yml` is projected alongside everything else in this
  // snapshot, from the same tree. A malformed config is recorded and skipped
  // rather than allowed to abort a pass that has already rebuilt the prose -
  // a typo in the book's title must not take the book's chapters offline.
  const bookConfig = await projectBookConfig(ctx, project.id, reader, {
    sourceCommit: projectedCommit,
    ...(snapshot.files === undefined ? {} : { files: snapshot.files }),
  });
  if (bookConfig.outcome === "invalid") {
    await ctx.repos.auditEvents
      .insertStatement({
        id: uuidv7(ctx.clock.now()),
        projectId: project.id,
        actorId: null,
        action: "projection.book_config_invalid",
        targetType: "project",
        targetId: project.id,
        correlationId: options.correlationId,
        metadata: { reason: bookConfig.reason, headCommit: projectedCommit },
        createdAt: at,
      })
      .run();
  }

  await ctx.repos.projects
    .completeProjectionRefreshStatement({
      projectId: project.id,
      projectedCommit,
      observedUpdatedAt,
      at: toTimestamp(ctx.clock.now()),
    })
    .run();

  if (analysis.externalEdits.length > 0) {
    await ctx.db.batch(
      analysis.externalEdits.map((edit) =>
        ctx.repos.auditEvents.insertStatement({
          id: uuidv7(ctx.clock.now()),
          projectId: project.id,
          actorId: null,
          action: "projection.external_edit",
          targetType: "chapter",
          targetId: edit.chapterId,
          correlationId: options.correlationId,
          metadata: {
            path: edit.path,
            fromRevision: edit.fromRevision,
            toRevision: edit.toRevision,
            headCommit: projectedCommit,
          },
          createdAt: at,
        }),
      ),
    );
  }

  return {
    outcome: "projected",
    rebuild,
    divergence: analysis.divergence,
    externalEdits: analysis.externalEdits,
    reanchored,
    projectedCommit,
  };
}

async function readSource(reader: BookRepoReader, path: string): Promise<string | null> {
  if (reader.readTextFile === undefined) return null;
  return reader.readTextFile(path);
}

/**
 * Did the branch move under this pass? `false` when the reader cannot answer
 * or the snapshot carries no commit - an unknown is never treated as
 * evidence, in either direction: the caller still refuses to diverge only on
 * a POSITIVE answer.
 */
async function snapshotWentStale(
  reader: BookRepoReader,
  snapshot: BookRepoSnapshot,
): Promise<boolean> {
  if (reader.readHeadCommit === undefined || snapshot.headCommit === undefined) {
    return false;
  }
  try {
    return (await reader.readHeadCommit()) !== snapshot.headCommit;
  } catch {
    // A failed head read is not evidence of anything. Fall through to the
    // ordinary decision rather than suppressing a real divergence.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Divergence state
// ---------------------------------------------------------------------------

/** Machine-readable record stored on `projects.divergence_reason`. */
export interface DivergenceRecord {
  state: "diverged";
  detectedAt: string;
  correlationId: string;
  findings: DivergenceFinding[];
}

export async function markDiverged(
  ctx: ReconcileContext,
  project: ProjectRecord,
  findings: DivergenceFinding[],
  correlationId: string,
  at: string,
): Promise<void> {
  const record: DivergenceRecord = {
    state: "diverged",
    detectedAt: at,
    correlationId,
    findings,
  };
  const statements: SqlStatement[] = [
    ctx.repos.projects.markDivergedStatement({ projectId: project.id, reason: record, at }),
    ctx.repos.auditEvents.insertStatement({
      id: uuidv7(ctx.clock.now()),
      projectId: project.id,
      actorId: null,
      action: "project.diverged",
      targetType: "project",
      targetId: project.id,
      correlationId,
      metadata: { findings },
      createdAt: at,
    }),
    ctx.repos.events.appendStatement({
      projectId: project.id,
      type: "project_diverged",
      payload: {
        kinds: [...new Set(findings.map((f) => f.kind))].sort(),
        chapterIds: [...new Set(findings.map((f) => f.chapterId))].sort(),
      },
      createdAt: at,
    }),
  ];
  await ctx.db.batch(statements);
}

/** Reason record stored when a maintainer clears divergence. */
export interface DivergenceClearedRecord {
  state: "cleared";
  clearedAt: string;
  reason: string;
  clearedByActorId: string;
  /** The findings that were in force when it was cleared, for the record. */
  clearedFindings: DivergenceFinding[];
}

export async function clearDivergence(
  ctx: ReconcileContext,
  project: ProjectRecord,
  input: { reason: string; actorId: string; correlationId: string },
): Promise<{ cleared: boolean; priorFindings: DivergenceFinding[] }> {
  const at = toTimestamp(ctx.clock.now());
  const priorFindings = divergenceFindingsOf(project);
  const record: DivergenceClearedRecord = {
    state: "cleared",
    clearedAt: at,
    reason: input.reason,
    clearedByActorId: input.actorId,
    clearedFindings: priorFindings,
  };
  // The UPDATE is guarded on `status = 'diverged'`, so two maintainers racing
  // produce one clearing; the loser's audit row still records the attempt,
  // which is the honest history.
  const result = await ctx.repos.projects
    .clearDivergenceStatement({ projectId: project.id, reason: record, at })
    .run();
  const cleared = result.changes > 0;
  await ctx.db.batch([
    ctx.repos.auditEvents.insertStatement({
      id: uuidv7(ctx.clock.now()),
      projectId: project.id,
      actorId: input.actorId,
      action: "project.divergence_cleared",
      targetType: "project",
      targetId: project.id,
      correlationId: input.correlationId,
      metadata: { reason: input.reason, cleared, priorFindings },
      createdAt: at,
    }),
    ctx.repos.events.appendStatement({
      projectId: project.id,
      type: "project_divergence_cleared",
      payload: { reason: input.reason, cleared },
      createdAt: at,
    }),
  ]);
  return { cleared, priorFindings };
}

/** Findings currently recorded on the project row, or `[]`. */
export function divergenceFindingsOf(project: ProjectRecord): DivergenceFinding[] {
  const reason = project.divergenceReason;
  if (typeof reason !== "object" || reason === null) return [];
  const findings = (reason as { findings?: unknown }).findings;
  return Array.isArray(findings) ? (findings as DivergenceFinding[]) : [];
}

export function isDiverged(project: ProjectRecord): boolean {
  return project.status === "diverged";
}

/**
 * Prose-write guard (design §14.5). Returns a problem response when the
 * project is diverged, else null.
 *
 * Applied to the submission endpoint only - the one route that changes
 * chapter prose. Annotations, replies, votes, and lease lifecycle keep working
 * while diverged: they record intent about prose rather than rewriting it, and
 * refusing them would turn a repository problem into a total outage for
 * collaborators who cannot fix it.
 */
export function proseWriteBlocked(
  c: Context<AppEnv>,
  project: ProjectRecord,
): Response | null {
  if (!isDiverged(project)) {
    return null;
  }
  const findings = divergenceFindingsOf(project);
  return problem(c, "project-diverged", {
    detail:
      "the book repository diverged from the projection; prose writes are blocked until a maintainer clears it",
    divergence: {
      divergedAt: project.divergedAt,
      kinds: [...new Set(findings.map((f) => f.kind))].sort(),
      chapters: findings.map((f) => ({
        chapterId: f.chapterId,
        path: f.chapterPath,
        kind: f.kind,
        projectedRevision: f.projectedRevision,
        snapshotRevision: f.snapshotRevision,
      })),
    },
    recovery: "POST /v1/projects/{projectId}/divergence/clear (maintainer)",
  });
}

/** Convenience for callers holding only a `SqlDatabase`. */
export function reconcileContext(db: SqlDatabase, clock: Clock): ReconcileContext {
  return { db, repos: createRepositories(db), clock };
}
