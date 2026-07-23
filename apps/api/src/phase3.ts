/**
 * Phase 3 routes: votes, the serialized vote command with rule evaluation and
 * idempotent work generation, maintainer overrides, work-queue reads, and the
 * event feed (Phase 3 contract §2-§5).
 *
 * Concurrency model: every vote/override command runs inside a per-project
 * serial queue (contract §3 "the same serialized command"), and the decision
 * batch carries the `(source_annotation_id, action_type, rule_version)`
 * unique key (contract §4) - so even racing writers outside the queue
 * collapse to exactly one decision: a loser's batch aborts atomically on the
 * key, is rebuilt against the now-existing decision, and proceeds
 * idempotently.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  isConstraintError,
  type AnnotationRecord,
  type CompletedWorkItemSummary,
  type DecisionRecord,
  type EventRecord,
  type ProjectRecord,
  type Repositories,
  type SqlStatement,
  type VoteTally,
  type WorkItemRecord,
} from "@authorbot/database";
import {
  DECISION_SUPPORT_CHANGED_EVENT,
  FORCE_CREATE_RULE_VERSION,
  authorizeCancelWorkItem,
  authorizeForceCreateWorkItem,
  authorizeRejectSuggestion,
  authorizeReopenSuggestion,
  cancelWorkItemCommandSchema,
  castVoteCommandSchema,
  clearVoteCommandSchema,
  forceCreateWorkItemCommandSchema,
  rejectSuggestionCommandSchema,
  reopenSuggestionCommandSchema,
  resolveSupportChange,
  type AnnotationStatus,
  type EditorialCapability,
  type VoteValue,
} from "@authorbot/domain";
import { evaluate, workTypeForScope } from "@authorbot/rule-engine";
import { z } from "zod";
import {
  authOf,
  hasEditorialAuthority,
  requireProjectScope,
  type AuthServices,
} from "./auth.js";
import type { AppDeps, AppEnv, Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";
import { annotationJson } from "./json.js";
import { problem } from "./problems.js";
import type { RuleEntry } from "./rules.js";
import type { ProjectSerializer } from "./serializer.js";
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_SSE_POLL_MS,
  createStreamLimiter,
  eventJson,
  sseResponse,
  streamClientKey,
} from "./sse.js";
import { adjustTally, tallyJson, tallyToMetrics, type Voter, type VoterActorType } from "./tally.js";
import { createTokenEventProjector } from "./token-event-visibility.js";

/**
 * Outbox kinds Phase 3 emits, matching the @authorbot/repo-coordinator
 * processor's vocabulary: a single `decision.create` row renders the decision
 * YAML and (when the decision references a work item) the work-item Markdown
 * in one commit; `decision.update` re-renders the decision alone for the
 * `support_changed` mark/clear path.
 */
export const PHASE3_OUTBOX_KINDS = ["decision.create", "decision.update"] as const;

/** Rule/override name recorded on override decisions. */
export const OVERRIDE_RULE_NAME = "maintainer_override";

/** The wiring `createApi` hands this module (closures over its own state). */
export interface Phase3Context {
  app: Hono<AppEnv>;
  deps: AppDeps;
  repos: Repositories;
  clock: Clock;
  services: AuthServices;
  /**
   * The rules in force for a project, resolved per call (Phase 6 contract
   * §3.6): a maintainer editing the governance rule in Settings must see it
   * apply to the next vote, so this is a lookup rather than a boot constant.
   */
  rules(projectId: string): Promise<RuleEntry[]>;
  auth: MiddlewareHandler<AppEnv>;
  maybeAuth: MiddlewareHandler<AppEnv>;
  idem: MiddlewareHandler<AppEnv>;
  /** Shared per-project serial queue (also serializes Phase 4 commands). */
  serialize: ProjectSerializer;
  requireReadOrPublic(
    c: Context<AppEnv>,
  ): Promise<{ project: ProjectRecord } | { response: Response }>;
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

/**
 * Decision summary for the "Queued as work item" badge and the member
 * decision views. `overrideReason` is maintainer-authored free text and is
 * member-only (contract §2 threat model: member data on public books); it is
 * omitted when `includeOverrideReason` is false. The public-only path passes
 * false so anonymous readers and authenticated nonmembers never see the
 * maintainer's private rationale, only the public result/support fields.
 */
export function decisionSummaryJson(
  d: DecisionRecord,
  includeOverrideReason = true,
): Record<string, unknown> {
  return {
    id: d.id,
    sourceAnnotationId: d.sourceAnnotationId,
    actionType: d.actionType,
    rule: d.rule,
    ruleVersion: d.ruleVersion,
    metrics: d.metrics,
    result: d.result,
    supportChanged: d.supportChanged,
    ...(includeOverrideReason ? { overrideReason: d.overrideReason } : {}),
    workItemId: d.workItemId,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export function workItemJson(w: WorkItemRecord): Record<string, unknown> {
  return {
    id: w.id,
    projectId: w.projectId,
    type: w.type,
    status: w.status,
    sourceAnnotationId: w.sourceAnnotationId,
    chapterId: w.chapterId,
    baseRevision: w.baseRevision,
    target: w.target,
    priority: w.priority,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

function completedWorkSourceCapability(kind: string): EditorialCapability | null {
  if (kind === "comment") return "comments:read";
  if (kind === "suggestion") return "suggestions:read";
  return null;
}

/**
 * Compact Work-history response. Retained submission prose is never exposed,
 * and source feedback is projected only when the caller may read that exact
 * feedback kind. The Work row itself remains useful to a `work:read` caller.
 */
export function completedWorkItemJson(
  row: CompletedWorkItemSummary,
  effectiveCapabilities: readonly EditorialCapability[],
): Record<string, unknown> {
  const sourceCapability =
    row.source === null ? null : completedWorkSourceCapability(row.source.kind);
  const source =
    row.source !== null &&
    sourceCapability !== null &&
    effectiveCapabilities.includes(sourceCapability)
      ? row.source
      : null;
  return {
    ...workItemJson(row.workItem),
    source,
    chapter:
      row.chapter === null
        ? null
        : { id: row.workItem.chapterId, title: row.chapter.title, slug: row.chapter.slug },
    completedBy: row.completedBy,
    completedAt: row.completedAt,
    resultingRevision: row.resultingRevision,
    commitSha: row.commitSha,
    revisionProposalId: row.revisionProposalId,
    approvedBy: row.approvedBy,
  };
}

/**
 * Annotation JSON + collaboration data (Phase 3 contract §2/§6): aggregate
 * tally for everyone the annotation is readable by; `myVote` only for
 * authenticated members (per-voter identity is member-only); the
 * `create_work_item` decision summary for the "Queued as work item" badge.
 */
export async function annotationCollabJson(
  repos: Repositories,
  annotation: AnnotationRecord,
  memberActorId: string | null,
): Promise<Record<string, unknown>> {
  const tally = await repos.votes.tally(annotation.id);
  const decisions = await repos.decisions.listByAnnotation(annotation.id);
  const decision = decisions.find((d) => d.actionType === "create_work_item") ?? null;
  // Anonymous readers and authenticated non-members never see member-only
  // decision prose or a per-voter projection.
  const isMember = memberActorId !== null;
  const base: Record<string, unknown> = {
    ...annotationJson(annotation),
    votes: tallyJson(tally),
    decision: decision === null ? null : decisionSummaryJson(decision, isMember),
  };
  if (isMember) {
    const mine = await repos.votes.getCurrent(annotation.id, memberActorId);
    base["myVote"] = mine?.value ?? null;
  }
  return base;
}

/** Statuses a suggestion may be voted on (sticky semantics keep votes legal after crossing). */
const VOTABLE_STATUSES = new Set(["open", "work_item_created"]);

/**
 * Phase 3's public collaboration vocabulary. The event endpoint may be read
 * in public-only mode by anonymous readers and authenticated nonmembers when
 * public annotations are enabled, but later phases append operational and
 * control-plane rows to the same table. Those rows can carry lease metadata,
 * draft chapter metadata, or maintainer-authored reasons and must remain
 * member-only.
 */
const PUBLIC_READER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "annotation_created",
  "vote_aggregate",
  "decision_created",
  "decision_support_changed",
  "work_item_created",
  "operation_completed",
]);

/** Work-item kinds created by public annotation governance, never Phase 4 conflicts. */
const PUBLIC_READER_WORK_ITEM_TYPES: ReadonlySet<string> = new Set([
  "revise_range",
  "revise_block",
  "revise_chapter",
]);

/**
 * `operation_completed` is emitted by the shared Git outbox, including later
 * chapter and settings writes. Public readers need completion notifications
 * for committed annotations/replies, but must not learn that a private prose
 * or control-plane operation exists.
 */
const PUBLIC_READER_OPERATION_KINDS: ReadonlySet<string> = new Set([
  "annotation.create",
  "reply.create",
  "reply.withdraw",
  "annotation.withdraw",
]);

function publicReaderEventPayload(event: {
  type: string;
  payload: unknown;
}): Record<string, unknown> | null {
  if (!PUBLIC_READER_EVENT_TYPES.has(event.type)) {
    return null;
  }
  if (typeof event.payload !== "object" || event.payload === null) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "work_item_created") {
    // `resolve_conflict` reuses this Phase 3 event name from the private
    // submission pipeline. Only the three annotation-governance work types
    // are public.
    const type = payload["type"];
    if (typeof type !== "string" || !PUBLIC_READER_WORK_ITEM_TYPES.has(type)) {
      return null;
    }
  }
  if (event.type === "decision_created") {
    // Reject/reopen and create-work-item decisions affect the public
    // annotation projection. Cancelling a private Work item does not.
    const result = payload["result"];
    const override = payload["override"];
    if (!(
      result === "create_work_item" ||
      (result === "rejected" && override === "reject") ||
      (result === "overridden" && override === "reopen")
    )) {
      return null;
    }
  }
  if (event.type === "operation_completed") {
    // Decision and Work outbox kinds contain both public and private
    // subtypes, but completion rows do not carry enough origin metadata to
    // distinguish them. Fail closed until they do.
    const kind = payload["kind"];
    if (typeof kind !== "string" || !PUBLIC_READER_OPERATION_KINDS.has(kind)) {
      return null;
    }
  }

  // Never forward the stored payload object itself. Event rows are shared by
  // public collaboration and later private workflows; projecting the reviewed
  // fields here means an additive internal field cannot silently cross the
  // public boundary merely because its event type/subtype was already allowed.
  const projected: Record<string, unknown> = {};
  const copyString = (key: string): void => {
    if (typeof payload[key] === "string") projected[key] = payload[key];
  };
  const copyNumber = (key: string): void => {
    if (typeof payload[key] === "number" && Number.isFinite(payload[key])) {
      projected[key] = payload[key];
    }
  };
  const copyBoolean = (key: string): void => {
    if (typeof payload[key] === "boolean") projected[key] = payload[key];
  };

  switch (event.type) {
    case "annotation_created":
      for (const key of ["annotationId", "chapterId", "kind", "scope"]) copyString(key);
      copyBoolean("moderated");
      break;
    case "vote_aggregate": {
      copyString("annotationId");
      copyString("chapterId");
      const rawVotes = payload["votes"];
      if (typeof rawVotes === "object" && rawVotes !== null) {
        const votePayload = rawVotes as Record<string, unknown>;
        const votes: Record<string, number> = {};
        for (const key of [
          "approvals",
          "rejections",
          "abstentions",
          "netScore",
          "distinctVoters",
          "humanApprovals",
          "agentApprovals",
          "maintainerApprovals",
          "humanMaintainerApprovals",
        ]) {
          const value = votePayload[key];
          if (typeof value === "number" && Number.isFinite(value)) votes[key] = value;
        }
        projected["votes"] = votes;
      }
      break;
    }
    case "decision_created":
      for (const key of [
        "decisionId",
        "annotationId",
        "result",
        "rule",
        "workItemId",
        "override",
      ]) {
        copyString(key);
      }
      copyNumber("ruleVersion");
      break;
    case "decision_support_changed":
      for (const key of ["decisionId", "annotationId", "transition"]) copyString(key);
      copyBoolean("supportChanged");
      break;
    case "work_item_created":
      for (const key of ["workItemId", "annotationId", "chapterId", "type"]) copyString(key);
      copyNumber("baseRevision");
      break;
    case "operation_completed":
      copyString("operationId");
      copyString("kind");
      break;
  }
  return projected;
}

function projectPublicReaderEvent(event: EventRecord): EventRecord | null {
  const payload = publicReaderEventPayload(event);
  return payload === null ? null : { ...event, payload };
}

export function registerPhase3Routes(ctx: Phase3Context): void {
  const { app, deps, repos, clock, services, auth, maybeAuth, idem, serialize, now } = ctx;

  /**
   * One limiter per app instance, so the cap is shared by every stream this
   * isolate serves rather than reset per request.
   */
  const streamLimiter = createStreamLimiter(
    deps.config.sseMaxStreamsPerClient ?? undefined,
  );

  const appendEventStatement = (
    projectId: string,
    type: string,
    payload: unknown,
  ): SqlStatement =>
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

  /** Load an annotation scoped to the project, or a 404 response. */
  const findAnnotation = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
  ): Promise<AnnotationRecord | Response> => {
    const annotation = await repos.annotations.getById(c.req.param("annotationId") ?? "");
    if (annotation === null || annotation.projectId !== project.id) {
      return problem(c, "not-found", { detail: "unknown annotation" });
    }
    return annotation;
  };

  /**
   * Statements + ids for creating the decision/work-item pair: the contract
   * §4 one-DB-batch (decision row, work-item row, annotation transition,
   * audit events, one `decision.create` outbox row rendering BOTH Git
   * artifacts in a single commit, feed events).
   *
   * `actingActorId`/`createdByActorId` are omitted for rule crossings (the
   * repo-coordinator credits `system:rule-engine`) and set to the maintainer
   * for force-creates.
   */
  const buildCreationStatements = async (input: {
    c: Context<AppEnv>;
    project: ProjectRecord;
    annotation: AnnotationRecord;
    actorId: string;
    ruleName: string;
    ruleVersion: number;
    actionType: string;
    metrics: Record<string, number>;
    overrideReason: string | null;
    actingActorId?: string;
    createdByActorId?: string;
  }): Promise<{ decisionId: string; workItemId: string; operationIds: string[]; statements: SqlStatement[] }> => {
    const { c, project, annotation } = input;
    const correlationId = c.get("correlationId");
    const timestamp = now();
    const decisionId = uuidv7(clock.now());
    const workItemId = uuidv7(clock.now());

    // Base = CURRENT chapter revision (contract §4), falling back to the
    // annotation's revision if the chapter projection row is missing.
    const chapter = await repos.chapters.getById(annotation.chapterId);
    const baseRevision = chapter?.revision ?? annotation.chapterRevision;

    // One outbox row → one commit rendering the decision YAML AND the linked
    // work-item Markdown (repo-coordinator decision.create semantics).
    const decisionCommand = ctx.commandStatements({
      project,
      correlationId,
      actorId: input.actorId,
      action: "decision.create",
      targetType: "decision",
      targetId: decisionId,
      outboxKind: "decision.create",
      outboxPayload: {
        decisionId,
        ...(input.actingActorId !== undefined ? { actorId: input.actingActorId } : {}),
        ...(input.createdByActorId !== undefined
          ? { createdByActorId: input.createdByActorId }
          : {}),
      },
      metadata: { rule: input.ruleName, ruleVersion: input.ruleVersion, result: "create_work_item", workItemId },
    });

    const workItemType = workTypeForScope(annotation.scope);
    const statements: SqlStatement[] = [
      repos.decisions.insertStatement({
        id: decisionId,
        projectId: project.id,
        sourceAnnotationId: annotation.id,
        actionType: input.actionType,
        rule: input.ruleName,
        ruleVersion: input.ruleVersion,
        metrics: input.metrics,
        result: "create_work_item",
        supportChanged: false,
        overrideReason: input.overrideReason,
        workItemId,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      repos.workItems.insertStatement({
        id: workItemId,
        projectId: project.id,
        type: workItemType,
        status: "ready",
        sourceAnnotationId: annotation.id,
        chapterId: annotation.chapterId,
        baseRevision,
        // Target snapshot of the annotation selector incl. quote (contract §4).
        target: annotation.target,
        priority: "normal",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      // Annotation transition open -> work_item_created (contract §4), as an
      // optimistic compare-and-swap: if a concurrent writer already moved the
      // annotation off `open` (e.g. a maintainer reject), this aborts the batch
      // so the loser never clobbers that transition (Findings 1/2).
      repos.annotations.casStatusStatement(annotation.id, "open", "work_item_created", timestamp),
      ...decisionCommand.statements,
      appendEventStatement(project.id, "decision_created", {
        decisionId,
        annotationId: annotation.id,
        annotationKind: annotation.kind,
        decisionActionType: input.actionType,
        result: "create_work_item",
        rule: input.ruleName,
        ruleVersion: input.ruleVersion,
        workItemId,
      }),
      appendEventStatement(project.id, "work_item_created", {
        workItemId,
        annotationId: annotation.id,
        annotationKind: annotation.kind,
        chapterId: annotation.chapterId,
        type: workItemType,
        baseRevision,
      }),
    ];
    return {
      decisionId,
      workItemId,
      operationIds: [decisionCommand.operationId],
      statements,
    };
  };

  // ---- votes (contract §2, §3, §4) ------------------------------------------

  const voteHandler = (mode: "cast" | "clear") => async (c: Context<AppEnv>) => {
    // Kind-specific authority is checked after the annotation is loaded. This
    // first guard still applies membership, freeze/pause/policy, and rate
    // limits without allowing the old umbrella to decide comment authority.
    const guard = await requireProjectScope(c, services, null, { capability: "vote" });
    if ("response" in guard) {
      return guard.response;
    }

    let value: VoteValue | null = null;
    if (mode === "cast") {
      const body = await ctx.readJson(c);
      if (body instanceof Response) {
        return body;
      }
      const parsed = castVoteCommandSchema.safeParse(
        typeof body === "object" && body !== null
          ? { ...body, annotationId: c.req.param("annotationId") }
          : body,
      );
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }
      value = parsed.data.value;
    } else {
      const parsed = clearVoteCommandSchema.safeParse({
        annotationId: c.req.param("annotationId"),
      });
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }
    }

    return serialize(guard.project.id, async () => {
      const a = authOf(c);
      // Phase 6 §3.6: the maintainer metrics need the voter's ROLE as well as
      // their actor type. Taken from the auth context - the membership the
      // request already resolved - so it is the same current, unrevoked role
      // the SQL tally's join will read on the next request.
      const voter: Voter = { actorType: a.actor.type as VoterActorType, role: a.role };

      /**
       * One full attempt at the command as a single atomic batch. Fresh reads
       * of the annotation and the actor's current vote are taken HERE (not once
       * per request) so a retry after a governance-race constraint abort runs
       * against current truth, not the status read at command start (contract
       * §4). A crossing decision only forms when no `create_work_item` decision
       * yet exists for the annotation (across any rule_version) and the
       * annotation is still `open`; the decision uniqueness index and the
       * status compare-and-swap in `buildCreationStatements` are the
       * cross-isolate backstops.
       */
      const attempt = async (): Promise<Response> => {
        const annotation = await findAnnotation(c, guard.project);
        if (annotation instanceof Response) {
          return annotation;
        }
        const requiredCapability =
          annotation.kind === "suggestion" ? "suggestions:vote" : "comments:vote";
        // Legacy votes:write remains suggestion-only. Passing no legacy scope
        // for a comment makes the compatibility credential fail closed while
        // canonical tokens and sessions use the exact kind capability.
        if (
          !hasEditorialAuthority(
            a,
            annotation.kind === "suggestion" ? "votes:write" : null,
            { capabilities: [requiredCapability] },
          )
        ) {
          return problem(c, "forbidden", {
            detail: `actor lacks required editorial capability "${requiredCapability}"`,
          });
        }
        if (!VOTABLE_STATUSES.has(annotation.status)) {
          return problem(c, "state-conflict", {
            detail: `cannot vote on an annotation with status "${annotation.status}"`,
          });
        }

        const previous = await repos.votes.getCurrent(annotation.id, a.actor.id);
        const previousValue = previous?.value ?? null;

        const respond = async (
          tally: VoteTally,
          ruleSatisfied: boolean,
          decision: DecisionRecord | null,
          extraStatements: SqlStatement[],
        ): Promise<Response> => {
          const responseBody = {
            annotationId: annotation.id,
            value: mode === "cast" ? value : null,
            votes: tallyJson(tally),
            ruleSatisfied,
            decision: decision === null ? null : decisionSummaryJson(decision),
            correlationId: c.get("correlationId"),
          };
          const statements = [...extraStatements, ...ctx.claimStatements(c, 200, responseBody)];
          if (statements.length > 0) {
            await deps.db.batch(statements);
          }
          return c.json(responseBody, 200);
        };

        const currentDecision = (): Promise<DecisionRecord | null> =>
          repos.decisions.getWorkItemCreation(annotation.id);

        // No-op: same value re-vote, or clearing an absent vote. Nothing is
        // recorded (no vote_event, no aggregate event) - the aggregate did not
        // change - but the idempotency claim still commits.
        if (previousValue === (mode === "cast" ? value : null)) {
          return respond(
            await repos.votes.tally(annotation.id),
            false,
            await currentDecision(),
            [],
          );
        }

        const timestamp = now();
        const base = await repos.votes.tally(annotation.id);
        const nextValue = mode === "cast" ? value : null;
        const tally = adjustTally(base, voter, previousValue, nextValue);
        const metrics = tallyToMetrics(tally);
        const correlationId = c.get("correlationId");

        const statements: SqlStatement[] = [];
        if (mode === "cast" && value !== null) {
          statements.push(
            repos.votes.upsertStatement({
              id: uuidv7(clock.now()),
              projectId: guard.project.id,
              annotationId: annotation.id,
              actorId: a.actor.id,
              value,
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          );
        } else {
          statements.push(repos.votes.deleteStatement(annotation.id, a.actor.id));
        }
        statements.push(
          repos.voteEvents.insertStatement({
            id: uuidv7(clock.now()),
            projectId: guard.project.id,
            annotationId: annotation.id,
            actorId: a.actor.id,
            value: nextValue,
            previousValue,
            createdAt: timestamp,
          }),
          auditStatement({
            projectId: guard.project.id,
            actorId: a.actor.id,
            action: mode === "cast" ? "vote.cast" : "vote.clear",
            targetType: "annotation",
            targetId: annotation.id,
            correlationId,
            metadata: { value: nextValue, previousValue },
          }),
          appendEventStatement(guard.project.id, "vote_aggregate", {
            annotationId: annotation.id,
            chapterId: annotation.chapterId,
            annotationKind: annotation.kind,
            votes: tallyJson(tally),
          }),
        );

        let ruleSatisfied = false;
        let decision: DecisionRecord | null = null;
        let createdWorkItem = false;
        let stickyMirror = false;

        // Comment votes use the same tally/history machinery but can never
        // cross the suggestion-to-Work rule. Promotion remains the explicit
        // maintainer action for a comment.
        const applicableRules =
          annotation.kind === "suggestion" ? await ctx.rules(guard.project.id) : [];
        for (const entry of applicableRules) {
          const evaluation = evaluate(entry.rule, metrics);
          if (evaluation.satisfied) {
            ruleSatisfied = true;
          }
          const existing = await repos.decisions.getByKey(
            annotation.id,
            entry.rule.action.type,
            entry.rule.version,
          );
          if (existing === null) {
            // First threshold crossing (only from `open`; a force-created
            // work item already moved the annotation on). Guard on ANY existing
            // create_work_item decision (any rule_version), so a rule crossing
            // never races a force-create into a second work item (Finding 1) -
            // the uniqueness index backstops the cross-isolate window.
            if (
              evaluation.satisfied &&
              annotation.status === "open" &&
              decision === null &&
              (await currentDecision()) === null
            ) {
              const creation = await buildCreationStatements({
                c,
                project: guard.project,
                annotation,
                actorId: a.actor.id,
                ruleName: entry.name,
                ruleVersion: entry.rule.version,
                actionType: entry.rule.action.type,
                metrics,
                overrideReason: null,
              });
              statements.push(...creation.statements);
              createdWorkItem = true;
              decision = {
                id: creation.decisionId,
                projectId: guard.project.id,
                sourceAnnotationId: annotation.id,
                actionType: entry.rule.action.type,
                rule: entry.name,
                ruleVersion: entry.rule.version,
                metrics,
                result: "create_work_item",
                supportChanged: false,
                overrideReason: null,
                workItemId: creation.workItemId,
                createdAt: timestamp,
                updatedAt: timestamp,
              };
            }
          } else {
            // Sticky decision (contract §4): never deleted; only the
            // support_changed mark flips, with an event on each flip.
            // Force-created decisions (rule_version 0) are keyed separately
            // and are not support-tracked (no rule defined them).
            const outcome = resolveSupportChange({
              supportChanged: existing.supportChanged,
              ruleSatisfied: evaluation.satisfied,
            });
            if (outcome.emitEvent) {
              // Re-render the decision artifact (support_changed line) via a
              // `decision.update` outbox row (repo-coordinator).
              const updateCommand = ctx.commandStatements({
                project: guard.project,
                correlationId,
                actorId: a.actor.id,
                action: "decision.support_changed",
                targetType: "decision",
                targetId: existing.id,
                outboxKind: "decision.update",
                outboxPayload: { decisionId: existing.id },
                metadata: { supportChanged: outcome.supportChanged },
              });
              statements.push(
                repos.decisions.setSupportChangedStatement(
                  existing.id,
                  outcome.supportChanged,
                  timestamp,
                ),
                ...updateCommand.statements,
                appendEventStatement(guard.project.id, DECISION_SUPPORT_CHANGED_EVENT, {
                  decisionId: existing.id,
                  annotationId: annotation.id,
                  annotationKind: annotation.kind,
                  supportChanged: outcome.supportChanged,
                  transition: outcome.transition,
                }),
              );
              stickyMirror = true;
            }
            decision = { ...existing, supportChanged: outcome.supportChanged };
          }
        }

        // Force-created decision visible in the response even when no rule
        // decision exists.
        if (decision === null) {
          decision = await currentDecision();
        }

        const response = await respond(tally, ruleSatisfied, decision, statements);
        if (createdWorkItem || stickyMirror) {
          await ctx.notifyMutation(guard.project.id);
        }
        return response;
      };

      // Contract §4: a concurrent governance write (a rival crossing/force-
      // create on the decision uniqueness index, or a status transition losing
      // the annotation compare-and-swap) rolls the whole batch back atomically.
      // Re-run against fresh state: the next pass finds the existing decision
      // and proceeds as already-decided, or sees the new status and responds
      // with the correct state-conflict - losers treat the violation as
      // already-done, not error. Bounded so a genuine persistent constraint
      // error still surfaces.
      const MAX_ATTEMPTS = 5;
      for (let i = 1; ; i += 1) {
        try {
          return await attempt();
        } catch (error) {
          if (isConstraintError(error) && i < MAX_ATTEMPTS) {
            continue;
          }
          throw error;
        }
      }
    });
  };

  app.put("/v1/projects/:projectId/annotations/:annotationId/vote", auth, idem, voteHandler("cast"));
  app.delete(
    "/v1/projects/:projectId/annotations/:annotationId/vote",
    auth,
    idem,
    voteHandler("clear"),
  );

  // ---- maintainer overrides (contract §4) -----------------------------------

  const overrideDenied = (
    c: Context<AppEnv>,
    decision: { allowed: false; reason: string; message: string },
  ): Response => {
    if (decision.reason === "not-maintainer") {
      return problem(c, "forbidden", { detail: decision.message });
    }
    if (decision.reason === "not-a-suggestion") {
      return problem(c, "domain-rule-failed", { detail: decision.message });
    }
    return problem(c, "state-conflict", { detail: decision.message });
  };

  /**
   * Record (or refresh, on repeated reject/reopen cycles) an override
   * decision row keyed `(annotation, actionType, rule_version 0)`.
   */
  const overrideDecisionStatement = async (input: {
    project: ProjectRecord;
    sourceAnnotationId: string;
    actionType: string;
    result: DecisionRecord["result"];
    metrics: Record<string, number>;
    reason: string;
    workItemId: string | null;
  }): Promise<{ decisionId: string; statement: SqlStatement }> => {
    const timestamp = now();
    const existing = await repos.decisions.getByKey(
      input.sourceAnnotationId,
      input.actionType,
      FORCE_CREATE_RULE_VERSION,
    );
    const record: DecisionRecord = {
      id: existing?.id ?? uuidv7(clock.now()),
      projectId: input.project.id,
      sourceAnnotationId: input.sourceAnnotationId,
      actionType: input.actionType,
      rule: OVERRIDE_RULE_NAME,
      ruleVersion: FORCE_CREATE_RULE_VERSION,
      metrics: input.metrics,
      result: input.result,
      supportChanged: existing?.supportChanged ?? false,
      overrideReason: input.reason,
      workItemId: input.workItemId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    return { decisionId: record.id, statement: repos.decisions.upsertStatement(record) };
  };

  const suggestionOverride = (
    action: "reject" | "reopen",
  ): ((c: Context<AppEnv>) => Promise<Response>) => {
    const schema = action === "reject" ? rejectSuggestionCommandSchema : reopenSuggestionCommandSchema;
    const authorize = action === "reject" ? authorizeRejectSuggestion : authorizeReopenSuggestion;
    const nextStatus = action === "reject" ? "rejected" : "open";
    const fromStatus = action === "reject" ? "open" : "rejected";
    return async (c: Context<AppEnv>) => {
      /**
       * A real scope, not `null`.
       *
       * `scope: null` told `requireProjectScope` to skip the scope check
       * entirely AND - through `capabilityForScope(null)` - the annotation
       * policy gate with it, so these routes were authorized by the membership
       * role alone. For a human session that is the same answer; for an agent
       * token it is not, because effective scopes are `token ∩ role bundle` and
       * an intersection nobody consults binds nothing. Rejecting or reopening a
       * suggestion changes an annotation, so it asks for `annotations:write`
       * and picks up the policy gate that goes with it.
       */
      const guard = await requireProjectScope(c, services, "annotations:write", {
        editorial: {
          capabilities: ["suggestions:read", "feedback:moderate"],
          legacyAction: "feedback:moderate",
        },
      });
      if ("response" in guard) {
        return guard.response;
      }
      const body = await ctx.readJson(c);
      if (body instanceof Response) {
        return body;
      }
      const parsed = schema.safeParse(
        typeof body === "object" && body !== null
          ? { ...body, annotationId: c.req.param("annotationId") }
          : body,
      );
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }
      const reason = parsed.data.reason;

      return serialize(guard.project.id, async () => {
        const a = authOf(c);
        // One attempt; re-reads the annotation so a retry after a status
        // compare-and-swap abort re-authorizes against current truth (a reject
        // that lost the `open` state to a concurrent crossing then denies with
        // an illegal-transition state conflict instead of clobbering it).
        const attempt = async (): Promise<Response> => {
          const annotation = await findAnnotation(c, guard.project);
          if (annotation instanceof Response) {
            return annotation;
          }
          if (annotation.status === "pending_git") {
            return problem(c, "state-conflict", {
              detail: "annotation is still being committed; retry once its operation completes",
            });
          }
          const decision = authorize({
            actorRole: a.role ?? "reader",
            annotationKind: annotation.kind,
            annotationStatus: annotation.status as AnnotationStatus,
          });
          if (!decision.allowed) {
            return overrideDenied(c, decision);
          }

          const correlationId = c.get("correlationId");
          const timestamp = now();
          const metrics = tallyToMetrics(await repos.votes.tally(annotation.id));
          const override = await overrideDecisionStatement({
            project: guard.project,
            sourceAnnotationId: annotation.id,
            actionType: action === "reject" ? "reject_suggestion" : "reopen_suggestion",
            result: action === "reject" ? "rejected" : "overridden",
            metrics,
            reason,
            workItemId: null,
          });
          // The override decision is the durable Git record (contract §4:
          // "recorded as decisions with override_reason"). Its `decision.create`
          // row renders both the decision YAML and the annotation's transitioned
          // status so a rebuild restores the same settled state.
          const decisionCommand = ctx.commandStatements({
            project: guard.project,
            correlationId,
            actorId: a.actor.id,
            action: `annotation.${action}`,
            targetType: "decision",
            targetId: override.decisionId,
            outboxKind: "decision.create",
            outboxPayload: { decisionId: override.decisionId, actorId: a.actor.id },
            metadata: { override: action, reason },
          });

          const responseBody = {
            annotationId: annotation.id,
            status: nextStatus,
            decisionId: override.decisionId,
            operationIds: [decisionCommand.operationId],
            correlationId,
          };
          await deps.db.batch([
            override.statement,
            // Optimistic transition: aborts the batch if a concurrent writer
            // already moved the annotation off `fromStatus` (Finding 2).
            repos.annotations.casStatusStatement(annotation.id, fromStatus, nextStatus, timestamp),
            ...decisionCommand.statements,
            appendEventStatement(guard.project.id, "decision_created", {
              decisionId: override.decisionId,
              annotationId: annotation.id,
              annotationKind: annotation.kind,
              decisionActionType:
                action === "reject" ? "reject_suggestion" : "reopen_suggestion",
              result: action === "reject" ? "rejected" : "overridden",
              override: action,
            }),
            ...ctx.claimStatements(c, 200, responseBody),
          ]);
          await ctx.notifyMutation(guard.project.id);
          return c.json(responseBody, 200);
        };

        const MAX_ATTEMPTS = 5;
        for (let i = 1; ; i += 1) {
          try {
            return await attempt();
          } catch (error) {
            if (isConstraintError(error) && i < MAX_ATTEMPTS) {
              continue;
            }
            throw error;
          }
        }
      });
    };
  };

  app.post(
    "/v1/projects/:projectId/annotations/:annotationId/reject",
    auth,
    idem,
    suggestionOverride("reject"),
  );
  app.post(
    "/v1/projects/:projectId/annotations/:annotationId/reopen",
    auth,
    idem,
    suggestionOverride("reopen"),
  );

  app.post(
    "/v1/projects/:projectId/annotations/:annotationId/force-create-work-item",
    auth,
    idem,
    async (c) => {
      /**
       * `work:claim`, not `null`: forcing a work item into existence is a write
       * to the work queue, and it must require a work-related scope. Without
       * one, a credential holding nothing but `chapters:read` could create a
       * suggestion and then manufacture work on it - no vote, no rule, and no
       * scope that says anything about work.
       */
      const guard = await requireProjectScope(c, services, "work:claim", {
        editorial: {
          capabilities: ["work:promote"],
          legacyAction: "work:promote",
        },
      });
      if ("response" in guard) {
        return guard.response;
      }
      const body = await ctx.readJson(c);
      if (body instanceof Response) {
        return body;
      }
      const parsed = forceCreateWorkItemCommandSchema.safeParse(
        typeof body === "object" && body !== null
          ? { ...body, annotationId: c.req.param("annotationId") }
          : body,
      );
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }
      const reason = parsed.data.reason ?? null;

      return serialize(guard.project.id, async () => {
        const annotation = await findAnnotation(c, guard.project);
        if (annotation instanceof Response) {
          return annotation;
        }
        if (annotation.status === "pending_git") {
          return problem(c, "state-conflict", {
            detail: "annotation is still being committed; retry once its operation completes",
          });
        }
        const a = authOf(c);
        const decision = authorizeForceCreateWorkItem({
          actorRole: a.role ?? "reader",
          annotationKind: annotation.kind,
          annotationStatus: annotation.status as AnnotationStatus,
        });
        if (!decision.allowed) {
          return overrideDenied(c, decision);
        }
        // Force-create shares ONE work-item-creation uniqueness domain with
        // rule crossings (contract §4). Reject fast if ANY create_work_item
        // decision already exists for this annotation (rule crossing OR a prior
        // force-create), not only the rule_version-0 one; the partial unique
        // index backstops the cross-isolate race window (Finding 1).
        const existingCreate = await repos.decisions.getWorkItemCreation(annotation.id);
        if (existingCreate !== null) {
          return problem(c, "state-conflict", {
            detail: "a work item already exists for this annotation",
          });
        }

        const metrics = tallyToMetrics(await repos.votes.tally(annotation.id));
        const creation = await buildCreationStatements({
          c,
          project: guard.project,
          annotation,
          actorId: a.actor.id,
          ruleName: OVERRIDE_RULE_NAME,
          ruleVersion: FORCE_CREATE_RULE_VERSION,
          actionType: "create_work_item",
          metrics,
          overrideReason: reason,
          // Force-create is a maintainer act: credit them in the commit and
          // as the work item's created_by (repo-coordinator).
          actingActorId: a.actor.id,
          createdByActorId: a.actor.id,
        });
        const correlationId = c.get("correlationId");
        const responseBody = {
          annotationId: annotation.id,
          status: "work_item_created",
          decisionId: creation.decisionId,
          workItemId: creation.workItemId,
          operationIds: creation.operationIds,
          correlationId,
        };
        try {
          await deps.db.batch([
            ...creation.statements,
            auditStatement({
              projectId: guard.project.id,
              actorId: a.actor.id,
              action: "work_item.force_create",
              targetType: "annotation",
              targetId: annotation.id,
              correlationId,
              metadata: {
                ...(reason === null ? {} : { reason }),
                decisionId: creation.decisionId,
                workItemId: creation.workItemId,
              },
            }),
            ...ctx.claimStatements(c, 201, responseBody),
          ]);
        } catch (error) {
          // A concurrent governance write won the race: either a rival
          // create_work_item decision took the uniqueness index, or the
          // annotation left `open` and the status compare-and-swap aborted.
          if (isConstraintError(error)) {
            const raced = await repos.decisions.getWorkItemCreation(annotation.id);
            if (raced !== null) {
              return problem(c, "state-conflict", {
                detail: "a work item already exists for this annotation",
              });
            }
            const fresh = await repos.annotations.getById(annotation.id);
            if (fresh !== null && fresh.status !== "open") {
              return problem(c, "state-conflict", {
                detail: `the annotation is no longer open (status "${fresh.status}")`,
              });
            }
          }
          throw error;
        }
        await ctx.notifyMutation(guard.project.id);
        return c.json(responseBody, 201);
      });
    },
  );

  app.post("/v1/projects/:projectId/work-items/:workItemId/cancel", auth, idem, async (c) => {
    /** `work:claim`, not `null` - see force-create-work-item above. */
    const guard = await requireProjectScope(c, services, "work:claim", {
      editorial: {
        capabilities: ["work:cancel"],
        legacyAction: "work:cancel",
      },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const body = await ctx.readJson(c);
    if (body instanceof Response) {
      return body;
    }
    const parsed = cancelWorkItemCommandSchema.safeParse(
      typeof body === "object" && body !== null
        ? { ...body, workItemId: c.req.param("workItemId") }
        : body,
    );
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const reason = parsed.data.reason;

    return serialize(guard.project.id, async () => {
      const workItem = await repos.workItems.getById(parsed.data.workItemId);
      if (workItem === null || workItem.projectId !== guard.project.id) {
        return problem(c, "not-found", { detail: "unknown work item" });
      }
      const sourceAnnotation = await repos.annotations.getById(workItem.sourceAnnotationId);
      if (sourceAnnotation === null || sourceAnnotation.projectId !== guard.project.id) {
        throw new Error(
          `work item ${workItem.id} has no project-owned source annotation ${workItem.sourceAnnotationId}`,
        );
      }
      const a = authOf(c);
      const decision = authorizeCancelWorkItem({
        actorRole: a.role ?? "reader",
        workItemStatus: workItem.status,
      });
      if (!decision.allowed) {
        return overrideDenied(c, decision);
      }

      const correlationId = c.get("correlationId");
      const timestamp = now();
      const metrics = tallyToMetrics(await repos.votes.tally(workItem.sourceAnnotationId));
      const override = await overrideDecisionStatement({
        project: guard.project,
        sourceAnnotationId: workItem.sourceAnnotationId,
        actionType: "cancel_work_item",
        result: "overridden",
        metrics,
        reason,
        workItemId: workItem.id,
      });
      // The cancel override decision references the work item, so its single
      // `decision.create` row re-renders the work-item Markdown with its new
      // `cancelled` status (status frontmatter, Phase 0 §4 stable paths) in
      // the same commit - a rebuild restores `cancelled`.
      const decisionCommand = ctx.commandStatements({
        project: guard.project,
        correlationId,
        actorId: a.actor.id,
        action: "work_item.cancel",
        targetType: "decision",
        targetId: override.decisionId,
        outboxKind: "decision.create",
        outboxPayload: { decisionId: override.decisionId, actorId: a.actor.id },
        metadata: { override: "cancel", reason, workItemId: workItem.id },
      });

      const responseBody = {
        workItemId: workItem.id,
        status: "cancelled",
        decisionId: override.decisionId,
        operationIds: [decisionCommand.operationId],
        correlationId,
      };
      await deps.db.batch([
        override.statement,
        repos.workItems.updateStatusStatement(workItem.id, "cancelled", timestamp),
        ...decisionCommand.statements,
        appendEventStatement(guard.project.id, "decision_created", {
          decisionId: override.decisionId,
          annotationId: workItem.sourceAnnotationId,
          annotationKind: sourceAnnotation.kind,
          decisionActionType: "cancel_work_item",
          result: "overridden",
          override: "cancel",
          workItemId: workItem.id,
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      ]);
      await ctx.notifyMutation(guard.project.id);
      return c.json(responseBody, 200);
    });
  });

  // ---- work-queue reads (contract §1: work items stop at `ready`) -----------

  const workItemStatusSchema = z.enum([
    "ready",
    "leased",
    "submitted",
    "applying",
    "completed",
    "conflict",
    "failed",
    "cancelled",
  ]);

  app.get("/v1/projects/:projectId/work-items", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "work:read", {
      editorial: { capabilities: ["work:read"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const limit = ctx.parseLimit(c);
    if (limit instanceof Response) {
      return limit;
    }
    const statusRaw = c.req.query("status");
    let status: z.infer<typeof workItemStatusSchema> | undefined;
    if (statusRaw !== undefined) {
      const parsed = workItemStatusSchema.safeParse(statusRaw);
      if (!parsed.success) {
        return problem(c, "validation-failed", { detail: "unknown work item status" });
      }
      status = parsed.data;
    }
    const cursor = c.req.query("cursor");
    const items = await repos.workItems.listByProject(guard.project.id, {
      limit,
      ...(cursor !== undefined ? { afterId: cursor } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    const serialized = await Promise.all(
      items.map(async (item) => ({
        ...workItemJson(item),
        support: tallyJson(await repos.votes.tally(item.sourceAnnotationId)),
      })),
    );
    return c.json({
      items: serialized,
      nextCursor: items.length === limit ? (items[items.length - 1]?.id ?? null) : null,
    });
  });

  app.get("/v1/projects/:projectId/work-items/completed", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "work:read", {
      editorial: { capabilities: ["work:read"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const limit = ctx.parseLimit(c);
    if (limit instanceof Response) {
      return limit;
    }
    const cursor = c.req.query("cursor");
    const items = await repos.workItems.listCompletedSummaries(guard.project.id, {
      limit,
      ...(cursor === undefined ? {} : { beforeId: cursor }),
    });
    const effectiveCapabilities = authOf(c).effectiveCapabilities;
    return c.json({
      items: items.map((item) => completedWorkItemJson(item, effectiveCapabilities)),
      nextCursor: items.length === limit ? (items[items.length - 1]?.workItem.id ?? null) : null,
    });
  });

  app.get("/v1/projects/:projectId/work-items/:workItemId", auth, async (c) => {
    const guard = await requireProjectScope(c, services, "work:read", {
      editorial: { capabilities: ["work:read"] },
    });
    if ("response" in guard) {
      return guard.response;
    }
    const workItem = await repos.workItems.getById(c.req.param("workItemId"));
    if (workItem === null || workItem.projectId !== guard.project.id) {
      return problem(c, "not-found", { detail: "unknown work item" });
    }
    const decisions = await repos.decisions.listByAnnotation(workItem.sourceAnnotationId);
    const decision = decisions.find((d) => d.workItemId === workItem.id) ?? null;
    return c.json({
      ...workItemJson(workItem),
      support: tallyJson(await repos.votes.tally(workItem.sourceAnnotationId)),
      decision: decision === null ? null : decisionSummaryJson(decision),
    });
  });

  // ---- events (contract §5) -------------------------------------------------

  app.get("/v1/projects/:projectId/events", maybeAuth, async (c) => {
    // Auth identical to annotation reads, incl. anonymous on public books.
    const guard = await ctx.requireReadOrPublic(c);
    if ("response" in guard) {
      return guard.response;
    }
    const project = guard.project;

    const parseCursor = (raw: string | undefined): number | null | Response => {
      if (raw === undefined || raw.length === 0) {
        return null;
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        return problem(c, "validation-failed", {
          detail: "event cursor must be a non-negative integer",
        });
      }
      return value;
    };
    const lastEventId = parseCursor(c.req.header("last-event-id"));
    if (lastEventId instanceof Response) {
      return lastEventId;
    }
    // A native EventSource reconnect reuses its original URL while adding a
    // newer Last-Event-ID header. The header must win over that stale `after`
    // query. When it is present, do not even reject an obsolete query cursor:
    // the reconnect cursor is the only one that participates in the request.
    const afterParam =
      lastEventId === null ? parseCursor(c.req.query("after")) : null;
    if (afterParam instanceof Response) {
      return afterParam;
    }
    const requestAuth = c.get("auth");
    // Open and approval-gated books admit signed-in non-members to annotation
    // reads. A credential alone therefore does not authorize the operational
    // feed. Human members retain its lossless representation; agent-token
    // members receive only capability-authorized, field-projected events.
    const publicOnly = requestAuth === undefined || requestAuth.membership === null;
    const tokenProjector = requestAuth?.kind === "token"
      ? createTokenEventProjector(requestAuth.effectiveCapabilities)
      : null;

    if (c.req.query("poll") === "1") {
      // JSON fallback for simple agents (§26.1). Public-only readers
      // (anonymous readers and authenticated nonmembers) see only the reviewed
      // Phase 3 collaboration vocabulary. `latestId` still follows the
      // unfiltered page so member-only rows cannot wedge their cursor.
      const after = lastEventId ?? afterParam ?? 0;
      const limit = ctx.parseLimit(c);
      if (limit instanceof Response) {
        return limit;
      }
      const items = await repos.events.listAfter(project.id, after, limit);
      const latest = items.length > 0 ? (items[items.length - 1]?.id ?? after) : after;
      const visible = publicOnly
        ? items.flatMap((event) => {
            const projected = projectPublicReaderEvent(event);
            return projected === null ? [] : [projected];
          })
        : tokenProjector === null
          ? items
          : items.flatMap((event) => {
              const projected = tokenProjector(event);
              return projected === null ? [] : [projected];
            });
      return c.json({ items: visible.map(eventJson), latestId: latest });
    }

    if (publicOnly) {
      // EventSource receives every SSE frame over the wire even when the page
      // has not registered a listener for that event name. Refuse public-only
      // streaming rather than risk sending a newly added private payload; the
      // browser client treats the failed initial stream as a signal to use the
      // filtered JSON poll path above.
      return problem(c, "forbidden", {
        detail: "public event streaming is unavailable; use the filtered poll endpoint",
      });
    }

    // SSE. Without a cursor the stream starts at the current head (clients
    // fetch authoritative state first, then stream deltas).
    //
    // A slot is taken BEFORE the stream is built, so a client already at its
    // concurrency cap is refused with a cheap 429 instead of being handed
    // another second-by-second poll. The slot is handed to `onClose`, which
    // every termination path runs - disconnect, lifetime cap, write failure.
    const slot = streamLimiter.acquire(streamClientKey(c.req.raw.headers));
    if (slot === null) {
      const refusal = problem(c, "rate-limited", {
        detail: `this client already holds the maximum of ${streamLimiter.max} concurrent event streams. Close one, or poll with ?poll=1 instead.`,
        limitClass: "event-stream",
        limit: streamLimiter.max,
        scope: "client",
      });
      refusal.headers.set("Retry-After", "5");
      return refusal;
    }
    const initialCursor = lastEventId ?? afterParam ?? (await repos.events.latestId(project.id));
    const headers = new Headers();
    const correlationId = c.get("correlationId");
    if (correlationId !== undefined) {
      headers.set("X-Correlation-Id", correlationId);
    }
    return sseResponse(
      {
        listAfter: (afterId, limit) => repos.events.listAfter(project.id, afterId, limit),
        ...(tokenProjector === null ? {} : { projectEvent: tokenProjector }),
        initialCursor,
        pollMs: deps.config.ssePollMs ?? DEFAULT_SSE_POLL_MS,
        heartbeatMs: deps.config.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS,
        ...(deps.config.sseMaxLifetimeMs !== undefined
          ? { maxLifetimeMs: deps.config.sseMaxLifetimeMs }
          : {}),
        onClose: () => slot.release(),
      },
      headers,
    );
  });
}

/** Zod error → safe, stable issue list (same shape as app.ts). */
function issueList(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
