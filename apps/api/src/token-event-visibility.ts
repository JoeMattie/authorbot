/**
 * Capability-scoped projection of the shared project event log for agent
 * tokens.
 *
 * Human project members retain the lossless operational feed. Agent tokens do
 * not: the event table is shared by editorial, repository, and control-plane
 * workflows, so membership alone cannot be allowed to bypass the exact Phase
 * 11 capability model. Every event type and payload field below is explicitly
 * reviewed. Unknown types and additive fields fail closed.
 */
import type { EventRecord } from "@authorbot/database";
import type { EditorialCapability } from "@authorbot/domain";

type EventProjector = (event: EventRecord) => EventRecord | null;
type FeedbackKind = "comment" | "suggestion";
type FeedbackDiscriminator =
  | { state: "valid"; kind: FeedbackKind }
  | { state: "legacy" }
  | { state: "invalid" };

const COMMENT_READ: EditorialCapability = "comments:read";
const SUGGESTION_READ: EditorialCapability = "suggestions:read";

function payloadObject(event: EventRecord): Record<string, unknown> | null {
  return typeof event.payload === "object" &&
    event.payload !== null &&
    !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : null;
}

function hasString(payload: Record<string, unknown>, key: string): boolean {
  return typeof payload[key] === "string" && payload[key].length > 0;
}

function hasStringValue(
  payload: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): boolean {
  return hasString(payload, key) && allowed.includes(payload[key] as string);
}

const FEEDBACK_SCOPES = ["chapter", "block", "range"] as const;
const WORK_ITEM_TYPES = [
  "revise_range",
  "revise_block",
  "revise_chapter",
  "write_chapter",
  "resolve_conflict",
  "planning",
] as const;
const SUBMISSION_TYPES = [
  "range_replacement",
  "block_replacement",
  "chapter_replacement",
] as const;
const REVISION_TARGET_KINDS = ["chapter", "outline", "timeline", "character"] as const;
const REVISION_PROPOSAL_TYPES = [
  "chapter_replacement",
  "chapter_summary",
  "repository_document",
] as const;
const SUPPORT_CHANGE_TRANSITIONS = ["marked", "cleared"] as const;

function validRevisionDiscriminator(payload: Record<string, unknown>): boolean {
  if (
    !hasStringValue(payload, "targetKind", REVISION_TARGET_KINDS) ||
    !hasStringValue(payload, "proposalType", REVISION_PROPOSAL_TYPES)
  ) {
    return false;
  }
  const chapterTarget = payload["targetKind"] === "chapter";
  const compatibleType = chapterTarget
    ? payload["proposalType"] === "chapter_replacement" ||
      payload["proposalType"] === "chapter_summary"
    : payload["proposalType"] === "repository_document";
  if (!compatibleType) return false;
  return chapterTarget
    ? hasString(payload, "chapterId")
    : hasString(payload, "targetId") && hasString(payload, "targetPath");
}

function feedbackDiscriminator(payload: Record<string, unknown>): FeedbackDiscriminator {
  const hasAnnotationKind = Object.prototype.hasOwnProperty.call(payload, "annotationKind");
  const hasKind = Object.prototype.hasOwnProperty.call(payload, "kind");
  if (!hasAnnotationKind && !hasKind) return { state: "legacy" };

  const annotationKind = payload["annotationKind"];
  const kind = payload["kind"];
  const valid = (value: unknown): value is FeedbackKind =>
    value === "comment" || value === "suggestion";
  if (hasAnnotationKind && !valid(annotationKind)) return { state: "invalid" };
  if (hasKind && !valid(kind)) return { state: "invalid" };
  if (hasAnnotationKind && hasKind && annotationKind !== kind) {
    return { state: "invalid" };
  }
  return {
    state: "valid",
    kind: (hasAnnotationKind ? annotationKind : kind) as FeedbackKind,
  };
}

/** `operation_completed.kind` is the outbox kind, never an annotation kind. */
function operationFeedbackDiscriminator(
  payload: Record<string, unknown>,
): FeedbackDiscriminator {
  if (!Object.prototype.hasOwnProperty.call(payload, "annotationKind")) {
    return { state: "legacy" };
  }
  const kind = payload["annotationKind"];
  return kind === "comment" || kind === "suggestion"
    ? { state: "valid", kind }
    : { state: "invalid" };
}

function feedbackKind(payload: Record<string, unknown>): FeedbackKind | null {
  const discriminator = feedbackDiscriminator(payload);
  return discriminator.state === "valid" ? discriminator.kind : null;
}

function feedbackReadable(
  payload: Record<string, unknown>,
  grants: ReadonlySet<EditorialCapability>,
): boolean {
  const discriminator = feedbackDiscriminator(payload);
  if (discriminator.state === "valid") {
    return discriminator.kind === "comment"
      ? grants.has(COMMENT_READ)
      : grants.has(SUGGESTION_READ);
  }
  // A present discriminator with a value outside the reviewed vocabulary is
  // a future/private kind, not a legacy row. Never let holding both current
  // reads turn into authority over a later kind.
  if (discriminator.state === "invalid") return false;
  // Rows written before annotationKind was added cannot safely be attributed
  // to one side of the split feedback model. Requiring both is conservative
  // and still preserves the old annotations:read compatibility projection.
  return grants.has(COMMENT_READ) && grants.has(SUGGESTION_READ);
}

function projectedPayload() {
  const output: Record<string, unknown> = {};
  return {
    output,
    string(input: Record<string, unknown>, key: string): void {
      if (typeof input[key] === "string") output[key] = input[key];
    },
    number(input: Record<string, unknown>, key: string): void {
      if (typeof input[key] === "number" && Number.isFinite(input[key])) {
        output[key] = input[key];
      }
    },
    boolean(input: Record<string, unknown>, key: string): void {
      if (typeof input[key] === "boolean") output[key] = input[key];
    },
  };
}

function projectFeedbackEvent(
  event: EventRecord,
  payload: Record<string, unknown>,
  grants: ReadonlySet<EditorialCapability>,
): EventRecord | null {
  if (event.type === "decision_support_changed") {
    const discriminator = feedbackDiscriminator(payload);
    if (
      discriminator.state !== "valid" ||
      discriminator.kind !== "suggestion" ||
      !grants.has(SUGGESTION_READ)
    ) {
      return null;
    }
  }
  if (!feedbackReadable(payload, grants)) return null;
  const projected = projectedPayload();
  const kind = feedbackKind(payload);
  if (kind !== null) projected.output["kind"] = kind;

  switch (event.type) {
    case "annotation_created":
      if (
        !hasString(payload, "annotationId") ||
        !hasStringValue(payload, "scope", FEEDBACK_SCOPES)
      ) return null;
      for (const key of ["annotationId", "scope"]) {
        projected.string(payload, key);
      }
      if (grants.has("chapters:read")) projected.string(payload, "chapterId");
      projected.boolean(payload, "moderated");
      break;
    case "annotation_needs_reanchor":
      if (!hasString(payload, "annotationId")) return null;
      for (const key of ["annotationId", "algorithmVersion"]) {
        projected.string(payload, key);
      }
      if (grants.has("chapters:read")) {
        projected.string(payload, "chapterId");
        projected.number(payload, "revision");
      }
      break;
    case "vote_aggregate": {
      if (!hasString(payload, "annotationId")) return null;
      projected.string(payload, "annotationId");
      if (grants.has("chapters:read")) projected.string(payload, "chapterId");
      const rawVotes = payload["votes"];
      const voteKeys = [
        "approvals",
        "rejections",
        "abstentions",
        "netScore",
        "distinctVoters",
        "humanApprovals",
        "agentApprovals",
        "maintainerApprovals",
        "humanMaintainerApprovals",
      ] as const;
      if (
        typeof rawVotes !== "object" ||
        rawVotes === null ||
        Array.isArray(rawVotes) ||
        voteKeys.some((key) => {
          const value = (rawVotes as Record<string, unknown>)[key];
          return typeof value !== "number" || !Number.isFinite(value);
        })
      ) {
        return null;
      }
      {
        const votes: Record<string, number> = {};
        for (const key of voteKeys) {
          const value = (rawVotes as Record<string, unknown>)[key];
          votes[key] = value as number;
        }
        projected.output["votes"] = votes;
      }
      break;
    }
    case "decision_support_changed":
      if (
        !hasString(payload, "decisionId") ||
        !hasString(payload, "annotationId") ||
        typeof payload["supportChanged"] !== "boolean" ||
        !hasStringValue(payload, "transition", SUPPORT_CHANGE_TRANSITIONS) ||
        (payload["transition"] === "marked" && payload["supportChanged"] !== true) ||
        (payload["transition"] === "cleared" && payload["supportChanged"] !== false)
      ) {
        return null;
      }
      for (const key of ["decisionId", "annotationId", "transition"]) {
        projected.string(payload, key);
      }
      projected.boolean(payload, "supportChanged");
      break;
    default:
      return null;
  }
  return { ...event, payload: projected.output };
}

function projectDecisionEvent(
  event: EventRecord,
  payload: Record<string, unknown>,
  grants: ReadonlySet<EditorialCapability>,
): EventRecord | null {
  if (!hasString(payload, "decisionId")) return null;
  const decisionActionType = payload["decisionActionType"];
  if (
    decisionActionType !== undefined &&
    decisionActionType !== "create_work_item" &&
    decisionActionType !== "reject_suggestion" &&
    decisionActionType !== "reopen_suggestion" &&
    decisionActionType !== "cancel_work_item"
  ) {
    return null;
  }
  const discriminator = feedbackDiscriminator(payload);
  const genuinelyLegacy =
    decisionActionType === undefined && discriminator.state === "legacy";
  if (decisionActionType === undefined && !genuinelyLegacy) return null;
  const workCancellation = decisionActionType === "cancel_work_item" ||
    (genuinelyLegacy && payload["override"] === "cancel");
  const feedbackAllowed =
    hasString(payload, "annotationId") && feedbackReadable(payload, grants);
  const workLinked = genuinelyLegacy || decisionActionType === "create_work_item";
  const workAllowed =
    workLinked && grants.has("work:read") && hasString(payload, "workItemId");
  if (decisionActionType !== undefined) {
    const validActionShape =
      (decisionActionType === "create_work_item" &&
        payload["result"] === "create_work_item" &&
        payload["override"] === undefined &&
        hasString(payload, "workItemId")) ||
      (decisionActionType === "reject_suggestion" &&
        payload["result"] === "rejected" &&
        payload["override"] === "reject" &&
        discriminator.state === "valid" &&
        discriminator.kind === "suggestion" &&
        !hasString(payload, "workItemId")) ||
      (decisionActionType === "reopen_suggestion" &&
        payload["result"] === "overridden" &&
        payload["override"] === "reopen" &&
        discriminator.state === "valid" &&
        discriminator.kind === "suggestion" &&
        !hasString(payload, "workItemId")) ||
      (decisionActionType === "cancel_work_item" &&
        payload["result"] === "overridden" &&
        payload["override"] === "cancel" &&
        hasString(payload, "workItemId"));
    if (!validActionShape) return null;
  }
  if (workCancellation) {
    if (!grants.has("work:read") || !hasString(payload, "workItemId")) return null;
    const projected = projectedPayload();
    for (const key of ["decisionId", "result", "override", "workItemId"]) {
      projected.string(payload, key);
    }
    if (feedbackAllowed) {
      projected.string(payload, "annotationId");
      const kind = feedbackKind(payload);
      if (kind !== null) projected.output["kind"] = kind;
    }
    return { ...event, payload: projected.output };
  }
  if (!feedbackAllowed && !workAllowed) return null;

  const projected = projectedPayload();
  if (feedbackAllowed) {
    for (const key of ["decisionId", "result", "rule", "override"]) {
      projected.string(payload, key);
    }
    projected.number(payload, "ruleVersion");
    projected.string(payload, "annotationId");
    const kind = feedbackKind(payload);
    if (kind !== null) projected.output["kind"] = kind;
  }
  if (workAllowed) projected.string(payload, "workItemId");
  return { ...event, payload: projected.output };
}

function operationEventReadable(
  payload: Record<string, unknown>,
  grants: ReadonlySet<EditorialCapability>,
): boolean {
  const kind = payload["kind"];
  if (typeof kind !== "string") return false;
  switch (kind) {
    case "annotation.create":
    case "annotation.withdraw":
    case "reply.create":
    case "reply.withdraw": {
      const discriminator = operationFeedbackDiscriminator(payload);
      if (discriminator.state === "valid") {
        return discriminator.kind === "comment"
          ? grants.has(COMMENT_READ)
          : grants.has(SUGGESTION_READ);
      }
      // Completion rows do not retain the parent annotation kind. Do not let
      // one feedback-read capability reveal activity from the adjacent kind.
      return discriminator.state === "legacy" &&
        grants.has(COMMENT_READ) && grants.has(SUGGESTION_READ);
    }
    case "decision.create":
    case "decision.update": {
      const action = payload["decisionActionType"];
      const discriminator = operationFeedbackDiscriminator(payload);
      if (discriminator.state !== "valid") return false;
      if (kind === "decision.update" && action !== "create_work_item") return false;
      const feedbackGranted = discriminator.kind === "comment"
        ? grants.has(COMMENT_READ)
        : grants.has(SUGGESTION_READ);
      if (action === "create_work_item") {
        return feedbackGranted || grants.has("work:read");
      }
      if (action === "reject_suggestion" || action === "reopen_suggestion") {
        return discriminator.kind === "suggestion" && grants.has(SUGGESTION_READ);
      }
      if (action === "cancel_work_item") return grants.has("work:read");
      // Old completion rows retained neither action nor annotation kind and
      // cannot be assigned safely to one of the adjacent domains.
      return false;
    }
    case "work_item.update":
    case "submission.apply":
      return grants.has("work:read");
    case "chapter.write": {
      const hasProposal = Object.prototype.hasOwnProperty.call(payload, "revisionProposalId");
      if (hasProposal) {
        if (payload["directChapterWrite"] !== undefined) return false;
        return hasString(payload, "revisionProposalId") && grants.has("revisions:read");
      }
      // Legacy rows omitted the proposal discriminator, so only the
      // conservative intersection can distinguish neither direct nor reviewed
      // chapter writes. New producer rows carry `directChapterWrite: true`.
      if (payload["directChapterWrite"] === true) return grants.has("chapters:read");
      if (payload["directChapterWrite"] !== undefined) return false;
      return grants.has("chapters:read") && grants.has("revisions:read");
    }
    case "repository_document.write":
      return grants.has("revisions:read");
    case "book_config.update":
    default:
      return false;
  }
}

/**
 * Build one projector for a request. Constructing the grant set once keeps the
 * SSE hot path allocation-free apart from the deliberately rebuilt payload.
 */
export function createTokenEventProjector(
  capabilities: readonly EditorialCapability[],
): EventProjector {
  const grants: ReadonlySet<EditorialCapability> = new Set(capabilities);

  return (event) => {
    const payload = payloadObject(event);
    if (payload === null) return null;

    if (
      event.type === "annotation_created" ||
      event.type === "annotation_needs_reanchor" ||
      event.type === "vote_aggregate" ||
      event.type === "decision_support_changed"
    ) {
      return projectFeedbackEvent(event, payload, grants);
    }
    if (event.type === "decision_created") {
      return projectDecisionEvent(event, payload, grants);
    }

    const projected = projectedPayload();
    switch (event.type) {
      case "work_item_created":
        if (
          !grants.has("work:read") ||
          !hasString(payload, "workItemId") ||
          !hasStringValue(payload, "type", WORK_ITEM_TYPES)
        ) return null;
        for (const key of ["workItemId", "type"]) {
          projected.string(payload, key);
        }
        if (feedbackReadable(payload, grants)) projected.string(payload, "annotationId");
        if (grants.has("chapters:read")) projected.string(payload, "chapterId");
        if (grants.has("chapters:read")) projected.number(payload, "baseRevision");
        break;
      case "work_item_leased":
        if (
          !grants.has("work:read") ||
          !hasString(payload, "workItemId") ||
          !hasString(payload, "leaseId")
        ) return null;
        for (const key of ["workItemId", "leaseId", "expiresAt"]) {
          projected.string(payload, key);
        }
        break;
      case "lease_recovered":
        if (
          !grants.has("work:read") ||
          !hasString(payload, "workItemId") ||
          !hasString(payload, "leaseId")
        ) return null;
        for (const key of ["workItemId", "leaseId", "correlationId"]) {
          projected.string(payload, key);
        }
        break;
      case "lease_released":
      case "lease_expired":
      case "lease_revoked":
        if (
          !grants.has("work:read") ||
          !hasString(payload, "workItemId") ||
          !hasString(payload, "leaseId")
        ) return null;
        for (const key of ["workItemId", "leaseId"]) {
          projected.string(payload, key);
        }
        break;
      case "lease_renewed":
        if (
          !grants.has("work:read") ||
          !hasString(payload, "workItemId") ||
          !hasString(payload, "leaseId")
        ) return null;
        for (const key of [
          "workItemId",
          "leaseId",
          "expiresAt",
          "maxExpiresAt",
          "renewalPromptAt",
        ]) {
          projected.string(payload, key);
        }
        projected.number(payload, "renewalCount");
        break;
      case "work_item_completed":
        if (
          !grants.has("work:read") ||
          !hasString(payload, "workItemId") ||
          !hasString(payload, "submissionId")
        ) return null;
        for (const key of ["workItemId", "submissionId"]) {
          projected.string(payload, key);
        }
        if (grants.has("chapters:read")) {
          projected.string(payload, "chapterId");
          projected.number(payload, "revision");
        }
        if (grants.has("revisions:read")) projected.string(payload, "revisionProposalId");
        break;
      case "work_item_conflict":
        if (
          !grants.has("work:read") ||
          !hasString(payload, "workItemId") ||
          !hasString(payload, "submissionId")
        ) return null;
        for (const key of [
          "workItemId",
          "submissionId",
          "conflictWorkItemId",
        ]) {
          projected.string(payload, key);
        }
        if (grants.has("chapters:read")) projected.string(payload, "chapterId");
        if (grants.has("revisions:read")) projected.string(payload, "revisionProposalId");
        break;
      case "submission_received":
        if (
          !grants.has("work:read") ||
          !hasString(payload, "workItemId") ||
          !hasString(payload, "submissionId") ||
          !hasStringValue(payload, "type", SUBMISSION_TYPES)
        ) return null;
        for (const key of [
          "submissionId",
          "operationId",
          "workItemId",
          "type",
          "correlationId",
        ]) {
          projected.string(payload, key);
        }
        if (grants.has("revisions:read")) projected.string(payload, "proposalId");
        break;
      case "revision_proposal_created":
      case "revision_proposal_approved":
      case "revision_proposal_rejected":
        if (
          !grants.has("revisions:read") ||
          !hasString(payload, "proposalId") ||
          !validRevisionDiscriminator(payload)
        ) return null;
        for (const key of [
          "proposalId",
          "revisionProposalId",
          "targetKind",
          "proposalType",
          "authorActorId",
          "operationId",
          "reviewerActorId",
          "correlationId",
          "commitSha",
        ]) {
          projected.string(payload, key);
        }
        if (grants.has("work:read")) {
          projected.string(payload, "submissionId");
          projected.string(payload, "workItemId");
        }
        if (grants.has("chapters:read")) projected.string(payload, "chapterId");
        if (payload["targetKind"] === "chapter") {
          if (grants.has("chapters:read")) {
            projected.string(payload, "targetId");
            projected.string(payload, "targetPath");
          }
        } else if (
          payload["targetKind"] === "outline" ||
          payload["targetKind"] === "timeline" ||
          payload["targetKind"] === "character"
        ) {
          projected.string(payload, "targetId");
          projected.string(payload, "targetPath");
        }
        projected.boolean(payload, "applyImmediately");
        break;
      case "revision_proposal_applied":
      case "revision_proposal_conflicted":
        if (
          !grants.has("revisions:read") ||
          !hasString(payload, "revisionProposalId") ||
          !validRevisionDiscriminator(payload)
        ) return null;
        for (const key of [
          "proposalId",
          "revisionProposalId",
          "targetKind",
          "proposalType",
          "authorActorId",
          "operationId",
          "reviewerActorId",
          "correlationId",
          "commitSha",
        ]) {
          projected.string(payload, key);
        }
        if (grants.has("work:read")) {
          projected.string(payload, "submissionId");
          projected.string(payload, "workItemId");
        }
        if (grants.has("chapters:read")) projected.string(payload, "chapterId");
        if (payload["targetKind"] === "chapter") {
          if (grants.has("chapters:read")) {
            projected.string(payload, "targetId");
            projected.string(payload, "targetPath");
          }
        } else if (
          payload["targetKind"] === "outline" ||
          payload["targetKind"] === "timeline" ||
          payload["targetKind"] === "character"
        ) {
          projected.string(payload, "targetId");
          projected.string(payload, "targetPath");
        }
        projected.boolean(payload, "applyImmediately");
        break;
      case "chapter_created":
      case "chapter_revised":
      case "chapter_published":
      case "chapter_unpublished":
        if (!grants.has("chapters:read") || !hasString(payload, "chapterId")) return null;
        for (const key of ["chapterId", "slug", "title", "status", "path"]) {
          projected.string(payload, key);
        }
        projected.number(payload, "revision");
        if (grants.has("revisions:read")) projected.string(payload, "revisionProposalId");
        break;
      case "operation_completed":
        if (
          !hasString(payload, "operationId") ||
          !hasString(payload, "kind") ||
          !operationEventReadable(payload, grants)
        ) return null;
        projected.string(payload, "operationId");
        projected.string(payload, "kind");
        break;
      default:
        // Project control, divergence, and every future event type stay hidden
        // until deliberately assigned an exact read capability and field list.
        return null;
    }
    return { ...event, payload: projected.output };
  };
}
