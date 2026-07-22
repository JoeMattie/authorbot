/**
 * Minimal fetch client for the Phase 2 API (contract §2.4-§2.5): credentialed
 * requests, `Idempotency-Key` on every mutation, `application/problem+json`
 * error surfacing. No runtime dependencies.
 */
import type { ComposerKind, ComposerScope } from "./composer-state.js";
import type { RangeSelector } from "./selection.js";

export interface MeActor {
  id: string;
  displayName: string;
  externalIdentity: string | null;
}

/**
 * One project membership as `/v1/me` returns it. Only `role` is load-bearing
 * for the islands: Phase 6 gates the authoring and settings surfaces on the
 * editor/maintainer roles, and the API checks the same role again on every
 * write - this is which affordances to *offer*, never the authorization.
 */
export interface MeMembership {
  role: string;
}

export interface Me {
  actor: MeActor;
  scopes: string[];
  /** Present since Phase 3; absent for an actor with no membership. */
  memberships?: MeMembership[];
  /** Phase 11's authoritative capability representation for this credential. */
  capabilityMode?: "human" | "legacy" | "canonical";
  grantedCapabilities?: string[];
  roleCapabilityCeiling?: string[];
  effectiveCapabilities?: string[];
  /** Preserved high-impact behavior for an unconverted legacy token only. */
  legacyEffectiveActions?: Array<{ action: string; sourceScopes?: string[] }>;
}

/** Exact response of the dev-only login route (singular project membership). */
export interface DevLogin {
  actor: MeActor;
  membership: MeMembership;
  scopes: string[];
}

/** Roles that may author chapters (contract §3.5) and read settings (§3.6). */
export type Role = "reader" | "contributor" | "editor" | "maintainer";

/**
 * The viewer's role on this project, or null when signed out / not a member.
 * `/v1/me` returns at most one membership (the authenticated project's).
 */
export function roleOf(me: Me | null): Role | null {
  const role = me?.memberships?.[0]?.role;
  return role === "reader" || role === "contributor" || role === "editor" || role === "maintainer"
    ? role
    : null;
}

/** Contract §3.5: authoring is editor-or-maintainer, never scope alone. */
export function canAuthorChapters(me: Me | null): boolean {
  const role = roleOf(me);
  return (role === "editor" || role === "maintainer") && me !== null && me.scopes.includes("submissions:write");
}

/** Contract §3.6: settings and the overrides are maintainer-only. */
export function isMaintainer(me: Me | null): boolean {
  return roleOf(me) === "maintainer";
}

/**
 * Browser affordances consume the same exact capability projection as the
 * API. `legacyScope` is only a rolling-deploy fallback for a Worker that
 * predates Phase 11 and therefore omitted the canonical fields entirely.
 */
export function hasEffectiveCapability(
  me: Me | null,
  capability: string,
  legacyScope?: string,
): boolean {
  if (me === null) return false;
  if (Array.isArray(me.effectiveCapabilities)) {
    return me.effectiveCapabilities.includes(capability);
  }
  return legacyScope !== undefined && me.scopes.includes(legacyScope);
}

/** High-impact compatibility actions are source-tagged, never inferred. */
export function hasLegacyEffectiveAction(
  me: Me | null,
  action: string,
  oldWorkerScope?: string,
): boolean {
  if (me === null) return false;
  if (Array.isArray(me.legacyEffectiveActions)) {
    return me.legacyEffectiveActions.some((entry) => entry.action === action);
  }
  // A canonical-capability response with no matching source-tagged action is
  // an authoritative denial. Only a genuinely old response gets the fallback.
  if (me.capabilityMode !== undefined || me.effectiveCapabilities !== undefined) {
    return false;
  }
  return oldWorkerScope !== undefined && me.scopes.includes(oldWorkerScope);
}

export interface AnnotationTarget {
  blockId: string;
  textPosition?: { start: number; end: number };
  textQuote?: { exact: string; prefix?: string; suffix?: string };
}

/** Vote value (Phase 3 contract §2). */
export type VoteValue = "approve" | "reject" | "abstain";

/**
 * Aggregate vote tally (Phase 3 contract §2/§26.1: counts only - never
 * per-voter data). Mirrors the API's `tallyJson`.
 */
export interface VoteTally {
  approvals: number;
  rejections: number;
  abstentions: number;
  netScore: number;
  distinctVoters: number;
  humanApprovals: number;
  agentApprovals: number;
  /**
   * Role-aware approval counts (Phase 6 contract §3.6). Optional because a
   * deployment predating the amendment omits them; the override panel shows
   * "-" rather than a confident zero when they are absent.
   */
  maintainerApprovals?: number;
  humanMaintainerApprovals?: number;
}

/**
 * The `create_work_item` decision embedded beside a suggestion (Phase 3
 * contract §6): drives the "Queued as work item" badge and the honest
 * `supportChanged` state. Mirrors the API's `decisionSummaryJson`.
 */
export interface DecisionSummary {
  id: string;
  actionType: string;
  result: string;
  supportChanged: boolean;
  workItemId: string | null;
}

export interface Annotation {
  id: string;
  chapterId: string;
  kind: ComposerKind;
  scope: "range" | "block" | "chapter";
  chapterRevision: number;
  target: AnnotationTarget | null;
  authorActorId: string;
  body: string;
  status: string;
  gitOperationId: string | null;
  createdAt: string;
  /** Aggregate vote tally (present on suggestion reads; §2/§6). */
  votes?: VoteTally;
  /** The create_work_item decision, or null (§6 badge). */
  decision?: DecisionSummary | null;
  /** The viewer's own current vote - member-only (§2). */
  myVote?: VoteValue | null;
}

/** A ready work item for the read-only `/work/` queue (Phase 3 contract §6). */
export interface WorkItem {
  id: string;
  projectId: string;
  type: string;
  status: string;
  sourceAnnotationId: string;
  chapterId: string;
  baseRevision: number | null;
  target: AnnotationTarget | null;
  priority: string;
  createdAt: string;
  updatedAt: string;
  /** Support summary (aggregate tally) for the source suggestion. */
  support?: VoteTally;
}

/** One event-feed row (Phase 3 contract §5). */
export interface FeedEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface Reply {
  id: string;
  /** Returned by authoritative reads; absent on older optimistic adapters. */
  projectId?: string;
  annotationId: string;
  parentReplyId: string | null;
  authorActorId: string;
  body: string;
  status: string;
  /** Lets a refetched pending reply resume its Git-operation reconciliation. */
  gitOperationId?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface Operation {
  id: string;
  projectId: string;
  correlationId: string;
  state: string;
  attempts: number;
  error: string | null;
  /** Present once the operation has committed (Phase 2 contract §5). */
  commitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Read the Phase 4 `submission-conflict` problem out of a git operation's
 * `error` column (JSON-encoded by the apply pipeline). Returns null for a
 * clean operation or any other failure, so callers keep their normal
 * "committed" / "failed" branches.
 */
export function parseSubmissionConflict(error: string | null | undefined): SubmissionConflict | null {
  if (typeof error !== "string" || error.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(error) as Record<string, unknown>;
    if (parsed["code"] !== "submission-conflict") {
      return null;
    }
    const conflictWorkItemId = parsed["conflictWorkItemId"];
    const reason = parsed["reason"];
    return {
      code: "submission-conflict",
      ...(typeof parsed["submissionId"] === "string" ? { submissionId: parsed["submissionId"] } : {}),
      ...(typeof parsed["workItemId"] === "string" ? { workItemId: parsed["workItemId"] } : {}),
      conflictWorkItemId: typeof conflictWorkItemId === "string" ? conflictWorkItemId : null,
      reason: typeof reason === "string" && reason !== "" ? reason : null,
    };
  } catch {
    return null;
  }
}

/** Common 202 body for a Git-backed collaboration mutation. */
export interface Accepted {
  operationId: string;
  correlationId: string;
  status: string;
  annotationId?: string;
  replyId?: string;
}

/** A comment/suggestion accepted into the Git-backed collaboration stream. */
export interface QueuedAnnotationAccepted {
  outcome: "queued_git";
  operationId: string;
  annotationId: string;
  correlationId: string;
  status: "queued";
}

/**
 * A contribution retained for maintainer moderation. There is deliberately no
 * operation id: approval-gated submissions do not create a Git operation,
 * outbox row, or public annotation until a maintainer approves them.
 */
export interface PendingReviewAnnotationAccepted {
  outcome: "pending_review";
  pendingId: string;
  annotationId: null;
  correlationId: string;
  status: "pending_review";
  moderation: {
    state: "pending";
    message: string;
  };
}

export type CreateAnnotationAccepted =
  | QueuedAnnotationAccepted
  | PendingReviewAnnotationAccepted;

/** A reply accepted into the Git-backed collaboration stream. */
export interface ReplyAccepted extends Accepted {
  replyId: string;
}

/** An annotation withdrawal accepted into the Git-backed stream. */
export interface WithdrawAccepted extends Accepted {
  annotationId: string;
}

/** The 200 body of a vote cast/clear (Phase 3 contract §2). */
export interface VoteResult {
  annotationId: string;
  value: VoteValue | null;
  votes: VoteTally;
  ruleSatisfied: boolean;
  decision: DecisionSummary | null;
  correlationId: string;
}

// ---- Phase 4: leases, task bundle, submissions ------------------------------

/** `target` of the §15.3 task bundle (absent for chapter-scope items). */
export interface BundleTarget {
  blockId: string;
  exact?: string;
  start?: number;
  end?: number;
}

/**
 * The claim response - design §15.3 / Phase 4 contract §3, verbatim.
 *
 * SECURITY: every string under `context`, `document.source` and
 * `workItem.acceptanceCriteria` is **untrusted project prose** (design
 * §19.6). It is rendered exclusively through `textContent` and is never
 * interpreted as markup or as an instruction by this client.
 */
export interface TaskBundle {
  workItem: { id: string; type: string; acceptanceCriteria: string[]; priority: string };
  /**
   * `token` is returned on the first claim response. An idempotent replay
   * carries `tokenRedacted: true` instead, so the client must recover it
   * through the credential-bound rotation endpoint.
   */
  lease: {
    id: string;
    token?: string;
    tokenRedacted?: true;
    expiresAt: string;
    maxExpiresAt: string;
    /** Contract §3 (amended): lets a fresh claim honor the deployment's
     * configured renewal lead time instead of assuming the default. */
    renewalPromptAt?: string;
  };
  document: { chapterId: string; revision: number; contentHash: string; source: string };
  target?: BundleTarget;
  context: { annotationBody: string; chapterSummary: string; storyRefs: string[] };
  submissionSchema: string | null;
}

/** 200 body of `POST .../lease/renew` (contract §2). */
export interface LeaseRenewal {
  leaseId: string;
  workItemId: string;
  expiresAt: string;
  maxExpiresAt: string;
  renewalCount: number;
  renewalPromptAt: string;
}

/** 200 body of a credential-bound lease-token rotation. */
export interface LeaseRecovery {
  workItemId: string;
  lease: {
    id: string;
    token?: string;
    tokenRedacted?: true;
    expiresAt: string;
    maxExpiresAt: string;
    renewalCount: number;
    renewalPromptAt: string;
  };
  correlationId: string;
}

/** 200 body of `POST .../lease/release` (contract §2). */
export interface LeaseRelease {
  workItemId: string;
  leaseId: string;
  status: string;
  expired: boolean;
  correlationId: string;
}

/** 202 body of `POST .../submissions` (contract §4). */
export interface SubmissionAccepted {
  submissionId: string;
  operationId: string;
  correlationId: string;
  status: string;
}

/** Phase 4 submission types (contract §4). */
export type SubmissionType = "range_replacement" | "block_replacement" | "chapter_replacement";

export interface SubmitBody {
  leaseId: string;
  leaseToken: string;
  type: SubmissionType;
  baseRevision: number;
  baseContentHash: string;
  content: string;
  summary?: string;
  notes?: string;
}

/**
 * The `submission-conflict` problem the pipeline records on the git operation
 * (Phase 4 contract §5): the operation still **commits** (its commit is the
 * conflict record), so a committed operation carrying this error means the
 * submission conflicted and a `resolve_conflict` work item exists.
 */
export interface SubmissionConflict {
  code: "submission-conflict";
  submissionId?: string;
  workItemId?: string;
  conflictWorkItemId: string | null;
  /** The applier's deterministic reason, when the API recorded one. */
  reason: string | null;
}

// ---- Phase 6 §3.5: chapter authoring ---------------------------------------

/**
 * `GET .../chapters/{id}/source` - a chapter's prose as an author wrote it.
 *
 * `body` is marker-free and frontmatter-free by construction (the API strips
 * block markers before returning it), which is what lets the composer be a
 * plain title-and-prose box. `revision` goes straight back as `baseRevision`
 * on the revise, so an edit that raced another edit fails cleanly.
 */
export interface ChapterSource {
  chapterId: string;
  title: string;
  summary: string | null;
  revision: number;
  status: string;
  body: string;
}

/**
 * Authorized open activity returned beside one chapter projection.
 *
 * Every field is independently optional: the server omits categories the
 * caller cannot read. Consumers must distinguish an omitted field from a
 * visible zero, even though both stay visually quiet in the chapter rail.
 */
export interface ChapterActivity {
  openSuggestions?: number;
  openBlockComments?: number;
  openChapterComments?: number;
  openReplies?: number;
  openWorkItems?: number;
}

/**
 * One chapter projection from `GET .../chapters`.
 *
 * This is metadata only: unpublished prose stays behind the separately
 * authorized `chapterSource` route and is never embedded in the static site.
 */
export interface ChapterProjection {
  id: string;
  projectId: string;
  path: string;
  slug: string;
  title: string;
  status: "draft" | "proposed" | "published" | "archived";
  revision: number;
  updatedAt: string;
  /** Absent on older deployments; fields are omitted when unauthorized. */
  activity?: ChapterActivity;
}

/** 202 body of a chapter create/revise/publish/unpublish (contract §3.5). */
export interface ChapterAccepted {
  chapterId: string;
  operationId: string;
  correlationId: string;
  status: string;
}

// ---- Phase 11 §6: chapter history ----------------------------------------

export type ChapterHistoryComparison = "previous" | "current";

/** One immutable revision row. History lists never carry manuscript text. */
export interface ChapterHistoryRevision {
  revision: number;
  /** Historical list rows may omit this to avoid one Git blob read per row. */
  contentHash: string | null;
  commitSha: string | null;
  createdAt: string;
  author: RevisionProposalActor | null;
  changeSummary: string | null;
  origin: string | null;
  isCurrent: boolean;
}

export interface ChapterHistoryCurrent extends ChapterHistoryRevision {
  status: string;
}

/** One bounded, newest-first metadata page. */
export interface ChapterHistoryPage {
  items: ChapterHistoryRevision[];
  current: ChapterHistoryCurrent;
  nextCursor: string | null;
}

export interface ChapterHistorySnapshot extends ChapterHistoryRevision {
  /** Detail reads fetch this exact blob, so its digest is authoritative. */
  contentHash: string;
  content: string;
}

export interface ChapterHistoryDiff {
  fromRevision: number;
  toRevision: number;
  unifiedDiff: string | null;
  computationLimited: boolean;
}

/** One selected snapshot and exactly one requested comparison. */
export interface ChapterHistoryDetail {
  chapterId: string;
  compare: ChapterHistoryComparison;
  selected: ChapterHistorySnapshot;
  comparison: ChapterHistorySnapshot | null;
  current: ChapterHistoryCurrent;
  diff: ChapterHistoryDiff | null;
}

/** Restoring history always creates a reviewable proposal; it never applies. */
export interface ChapterHistoryRestoreAccepted {
  proposalId: string;
  status: "pending_review";
  correlationId: string;
}

// ---- Phase 11 §5: revision proposal review --------------------------------

/**
 * Repository document named by a proposal. Chapter proposals use `chapter`;
 * the deliberately open kind also supports Outline, Timeline, and Character
 * documents without teaching the review surface a second workflow later.
 */
export interface RevisionProposalTarget {
  kind: string;
  id: string;
  path: string;
  label: string;
}

export interface RevisionProposalActor {
  id: string;
  displayName: string;
  type: string | null;
}

export interface RevisionProposalWork {
  id: string;
  type: string;
  status: string;
}

/** Compatibility metadata returned while chapter proposals are the only kind. */
export interface RevisionProposalChapter {
  id: string;
  title: string;
  slug?: string;
  path?: string;
  revision: number;
}

/** Bounded list row: immutable prose snapshots are detail-only. */
export interface RevisionProposalSummary {
  id: string;
  projectId: string;
  chapterId: string | null;
  proposalType: string;
  origin: string;
  workItemId: string | null;
  submissionId: string | null;
  authorActorId: string;
  baseRevision: number | null;
  changeSummary: string | null;
  notes: string | null;
  status: string;
  reviewedByActorId: string | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  /** New generic name; older proposal routes expose the same value as operationId. */
  gitOperationId?: string | null;
  operationId?: string | null;
  resultingRevision: number | null;
  commitSha: string | null;
  createdAt: string;
  updatedAt: string;
  /** Null for non-versioned/future document types or an unavailable projection. */
  currentRevision?: number | null;
  currentContentHash?: string | null;
  /** API-computed base revision/hash mismatch, including same-revision external edits. */
  conflictWarning?: boolean;
  target?: RevisionProposalTarget | null;
  author?: RevisionProposalActor | null;
  workItem?: RevisionProposalWork | null;
  chapter?: RevisionProposalChapter | null;
}

/** Authorized review payload; snapshots remain complete when diffing is capped. */
export interface RevisionProposalDetail extends RevisionProposalSummary {
  baseContentHash: string;
  baseContent: string;
  proposedContent: string;
  diff: {
    unifiedDiff: string | null;
    computationLimited: boolean;
  };
}

/** Approve queues Git; reject settles synchronously without an operation. */
export interface RevisionReviewResult {
  proposalId: string;
  status: string;
  correlationId: string;
  operationId?: string;
}

export type RepositoryDocumentKind = "outline" | "timeline" | "character";

/** Canonical source and immutable base identity for one planning document. */
export interface RepositoryDocumentSource {
  target: {
    kind: RepositoryDocumentKind;
    id: string;
    path: string;
    label: string;
  };
  content: string;
  contentHash: string;
}

export interface RepositoryDocumentProposalCommand {
  proposalType: "repository_document";
  targetKind: RepositoryDocumentKind;
  targetPath: string;
  baseContentHash: string;
  proposedContent: string;
  changeSummary?: string;
  notes?: string;
  applyImmediately?: boolean;
}

/** A normal proposal is pending review; an atomic maintainer apply is queued. */
export interface RevisionProposalAccepted {
  proposalId: string;
  operationId: string | null;
  correlationId: string;
  status: "pending_review" | "applying" | string;
}

// ---- Phase 6 §3.6: settings ------------------------------------------------

/** One governance rule as the settings document carries it (no `version`). */
export interface SettingsRule {
  trigger?: string;
  when: unknown;
  action: unknown;
}

/** A guarded field: its value plus what changing it breaks (server-supplied). */
export interface GuardedField {
  value: string | null;
  consequence: string;
}

/**
 * Who may comment and suggest, and whether it appears immediately (Phase 7
 * contract "Restricting"). A progression from public to private workspace that
 * an author moves up and down freely.
 */
export type AnnotationPolicy = "open" | "approval-gated" | "collaborators-only" | "locked";

/** `GET .../settings` - mirrors the API's field taxonomy exactly. */
export interface SettingsDocument {
  settings: {
    title: string;
    language: string;
    license: string | null;
    publication: {
      show_revision: boolean | null;
      show_attribution: boolean | null;
      show_public_annotations: boolean | null;
    };
    /**
     * Phase 7 "Restricting". `options` is the API's own plain-language account
     * of each mode, so the picker never keeps a second copy of what `locked`
     * actually does. Optional because a deployment predating Phase 7 omits the
     * whole section; the view then falls back to its shipped wording.
     */
    collaboration?: {
      annotation_policy: AnnotationPolicy;
      /** `default` when the book has declared nothing, `book` once it has. */
      source?: string;
      options?: Record<string, string>;
    };
  };
  guarded: Record<string, GuardedField>;
  governance: {
    /** `book` once the book declares its own rules, else `bootstrap`. */
    source: "book" | "bootstrap";
    rules: Record<string, SettingsRule>;
    vocabulary: { metrics: string[]; operators: string[] };
  };
  /**
   * Values the API will never change, each with the reason. Present so the
   * boundary can be EXPLAINED - never bound to a form control (contract §3.6:
   * never-editable fields are absent from the interface, not disabled).
   */
  readOnly: Record<string, string | boolean | null | Record<string, string>>;
  /** `pending_git` while a previous settings commit is still in flight. */
  status: string;
  updatedAt: string;
}

/** PATCH body. `null` clears an optional field; absent leaves it alone. */
export interface SettingsPatch {
  /** `null` returns the book to the default `collaborators-only`. */
  collaboration?: { annotation_policy?: AnnotationPolicy | null };
  title?: string;
  language?: string;
  license?: string | null;
  slug?: string;
  publication?: {
    chapter_url?: string | null;
    show_revision?: boolean | null;
    show_attribution?: boolean | null;
    show_public_annotations?: boolean | null;
  };
  /** REPLACES the rule map wholesale, so a rule can be deleted. */
  governance?: { rules: Record<string, SettingsRule> };
  /** Dotted paths of guarded fields the maintainer has explicitly confirmed. */
  confirm?: string[];
}

export interface SettingsSaved {
  operationId?: string;
  changed?: string[];
  status?: string;
  correlationId?: string;
}

// ---- Phase 3 maintainer overrides ------------------------------------------

/**
 * The 200/201 body of an annotation override. `workItemId` is present only for
 * force-create; reject answers with the transitioned status alone.
 */
export interface OverrideResult {
  annotationId: string;
  status: string;
  decisionId: string;
  workItemId?: string;
  operationIds: string[];
  correlationId: string;
}

/**
 * A caller may retain one key across retries of the same logical command.
 * When omitted, the legacy behavior remains: each method call gets a fresh
 * UUID. The store owns the retained key; this transport never persists it.
 */
export interface MutationOptions {
  idempotencyKey?: string;
  /**
   * A caller-owned request correlation lets the event feed identify its own
   * mutation even when the event wins the HTTP response race.
   */
  correlationId?: string;
}

export type ApiResult<T> =
  | { ok: true; value: T }
  /**
   * `problem` carries the parsed `application/problem+json` body when the API
   * returned one, so callers can use its typed extensions (e.g. the claim
   * 409's holder display name) instead of re-parsing `detail`.
   */
  | {
      ok: false;
      status: number;
      message: string;
      problem?: Record<string, unknown>;
      /**
       * The command may have landed, but the client could not read a usable
       * success response. Callers must reconcile with an authoritative read
       * instead of rolling forward or retrying under a new idempotency key.
       */
      ambiguous?: true;
    };

interface PageBody {
  items: unknown[];
  nextCursor: string | null;
}

interface JsonResultOptions {
  /** A lost response may hide a committed write. */
  mutation?: boolean;
  /** Plain-language subject used in an ambiguous success message. */
  subject?: string;
}

/**
 * The `detail`/`title` of an `application/problem+json` body. Exported so the
 * Phase 7 client (`access-api.ts`) surfaces API errors through exactly this
 * path rather than growing a second, subtly different one.
 */
export async function problemMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; title?: string };
    return body.detail ?? body.title ?? `request failed (${response.status})`;
  } catch {
    return `request failed (${response.status})`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unreadableSuccess(status: number, subject = "request"): ApiResult<never> {
  return {
    ok: false,
    status,
    message: `${subject} may have succeeded, but its response could not be read`,
    ambiguous: true,
  };
}

async function readSuccessJson<T>(response: Response, subject?: string): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: (await response.json()) as T };
  } catch {
    return unreadableSuccess(response.status, subject);
  }
}

export class CollabApi {
  constructor(
    readonly base: string,
    readonly project: string,
  ) {}

  protected projectUrl(path: string): string {
    return `${this.base}/v1/projects/${encodeURIComponent(this.project)}${path}`;
  }

  /** OAuth start URL with `return_to` back to the current page (§2.4). */
  /**
   * Ends the session. Returns false only when the request could not be made or
   * the API refused it - the caller keeps the button and says so, rather than
   * reloading into a page where the reader is still signed in.
   */
  async signOut(options?: MutationOptions): Promise<boolean> {
    try {
      const response = await this.post(`${this.base}/v1/auth/logout`, {}, options);
      return response.ok;
    } catch {
      return false;
    }
  }

  signInUrl(returnTo: string): string {
    return `${this.base}/v1/auth/github?return_to=${encodeURIComponent(returnTo)}`;
  }

  protected async get(url: string): Promise<Response> {
    return fetch(url, { credentials: "include", headers: { accept: "application/json" } });
  }

  protected async post(url: string, body: unknown, options?: MutationOptions): Promise<Response> {
    return this.mutate("POST", url, body, options);
  }

  /**
   * A credentialed idempotent mutation (POST/PUT/DELETE). The `Origin` header
   * is set by the browser and satisfies the API's CSRF check (contract §3);
   * the `Idempotency-Key` makes retries safe (contract §2.4).
   */
  protected async mutate(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    options?: MutationOptions,
  ): Promise<Response> {
    return fetch(url, {
      method,
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": options?.idempotencyKey ?? crypto.randomUUID(),
        ...(options?.correlationId === undefined
          ? {}
          : { "x-correlation-id": options.correlationId }),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /**
   * Auth state with reachability (contract §1): `ok: false, status: 0` ONLY
   * when the API cannot be reached at all - the caller must then render zero
   * collaboration chrome. Any HTTP response (401 included) is `ok: true`,
   * with `value: null` meaning "reachable but signed out".
   */
  async meResult(): Promise<ApiResult<Me | null>> {
    let response: Response;
    try {
      response = await this.get(`${this.base}/v1/me`);
    } catch {
      return { ok: false, status: 0, message: "network error" };
    }
    if (!response.ok) {
      return { ok: true, value: null };
    }
    return { ok: true, value: (await response.json()) as Me };
  }

  /** Auth state; null when signed out (401) or the API is unreachable. */
  async me(): Promise<Me | null> {
    const result = await this.meResult();
    return result.ok ? result.value : null;
  }

  private async list<T>(firstUrl: string, join: string): Promise<ApiResult<T[]>> {
    const items: T[] = [];
    let url: string | null = firstUrl;
    // Bounded pagination: 10 pages x 200 covers any plausible UI collection
    // and keeps a hostile cursor loop finite.
    for (let pageIndex = 0; url !== null && pageIndex < 10; pageIndex += 1) {
      let response: Response;
      try {
        response = await this.get(url);
      } catch {
        return { ok: false, status: 0, message: "network error" };
      }
      if (!response.ok) {
        return { ok: false, status: response.status, message: await problemMessage(response) };
      }
      const body = (await response.json()) as PageBody;
      items.push(...(body.items as T[]));
      url = body.nextCursor === null ? null : `${firstUrl}${join}cursor=${encodeURIComponent(body.nextCursor)}`;
    }
    return { ok: true, value: items };
  }

  async annotations(chapterId: string): Promise<ApiResult<Annotation[]>> {
    const url = this.projectUrl(`/chapters/${encodeURIComponent(chapterId)}/annotations?limit=200`);
    return this.list<Annotation>(url, "&");
  }

  /**
   * Threaded replies for one annotation. The list endpoint is the natural
   * REST complement of the existing `POST .../replies`; a 404/405 from an API
   * that has not shipped it yet degrades to "no fetched replies".
   */
  async replies(annotationId: string): Promise<ApiResult<Reply[]>> {
    const url = this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/replies?limit=200`);
    return this.list<Reply>(url, "&");
  }

  /** Actor display names for card attribution; empty on failure. */
  async memberNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const result = await this.list<{ actorId: string; actor: { displayName?: string } | null }>(
      this.projectUrl("/members?limit=200"),
      "&",
    );
    if (result.ok) {
      for (const membership of result.value) {
        const name = membership.actor?.displayName;
        if (typeof name === "string" && name !== "") {
          names.set(membership.actorId, name);
        }
      }
    }
    return names;
  }

  private async accept<T>(
    url: string,
    body: unknown,
    options?: MutationOptions,
  ): Promise<ApiResult<T>> {
    return this.jsonResult<T>(this.post(url, body, options), [202], {
      mutation: true,
      subject: "mutation",
    });
  }

  async createAnnotation(
    chapterId: string,
    command: {
      kind: ComposerKind;
      scope: ComposerScope | "chapter";
      chapterRevision: number;
      target?: RangeSelector | { blockId: string };
      body: string;
    },
    options?: MutationOptions,
  ): Promise<ApiResult<CreateAnnotationAccepted>> {
    const accepted = await this.accept<Record<string, unknown>>(
      this.projectUrl(`/chapters/${encodeURIComponent(chapterId)}/annotations`),
      command,
      options,
    );
    if (!accepted.ok) {
      return accepted;
    }
    const body = accepted.value;
    if (!isRecord(body)) {
      return unreadableSuccess(202, "annotation submission");
    }
    const correlationId = body["correlationId"];
    if (
      body["status"] === "pending_review" &&
      typeof body["pendingId"] === "string" &&
      body["annotationId"] === null &&
      typeof correlationId === "string" &&
      isRecord(body["moderation"]) &&
      body["moderation"]["state"] === "pending" &&
      typeof body["moderation"]["message"] === "string"
    ) {
      return {
        ok: true,
        value: {
          outcome: "pending_review",
          pendingId: body["pendingId"],
          annotationId: null,
          correlationId,
          status: "pending_review",
          moderation: {
            state: "pending",
            message: body["moderation"]["message"],
          },
        },
      };
    }
    if (
      body["status"] === "queued" &&
      typeof body["operationId"] === "string" &&
      typeof body["annotationId"] === "string" &&
      typeof correlationId === "string"
    ) {
      return {
        ok: true,
        value: {
          outcome: "queued_git",
          operationId: body["operationId"],
          annotationId: body["annotationId"],
          correlationId,
          status: "queued",
        },
      };
    }
    return unreadableSuccess(202, "annotation submission");
  }

  async createReply(
    annotationId: string,
    body: string,
    parentReplyId?: string,
    options?: MutationOptions,
  ): Promise<ApiResult<ReplyAccepted>> {
    return this.accept<ReplyAccepted>(
      this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/replies`),
      {
        body,
        ...(parentReplyId !== undefined ? { parentReplyId } : {}),
      },
      options,
    );
  }

  async withdraw(
    annotationId: string,
    options?: MutationOptions,
  ): Promise<ApiResult<WithdrawAccepted>> {
    return this.accept<WithdrawAccepted>(
      this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/withdraw`),
      {},
      options,
    );
  }

  async operation(operationId: string): Promise<Operation | null> {
    const result = await this.operationResult(operationId);
    return result.ok ? result.value : null;
  }

  /**
   * Operation polling with transport detail retained for the shared store.
   * `operation()` remains as the nullable compatibility adapter for islands
   * that have not moved into the store yet.
   */
  async operationResult(operationId: string): Promise<ApiResult<Operation>> {
    try {
      const response = await this.get(
        this.projectUrl(`/operations/${encodeURIComponent(operationId)}`),
      );
      if (!response.ok) {
        return { ok: false, status: response.status, message: await problemMessage(response) };
      }
      return readSuccessJson<Operation>(response, "operation read");
    } catch {
      return { ok: false, status: 0, message: "network error" };
    }
  }

  // ---- votes (Phase 3 contract §2) -----------------------------------------

  /**
   * Cast (or change) the viewer's vote on a suggestion. The 200 response
   * carries the fresh aggregate tally and the current `create_work_item`
   * decision (if any), so the caller updates the control in place without a
   * refetch.
   */
  async castVote(
    annotationId: string,
    value: VoteValue,
    options?: MutationOptions,
  ): Promise<ApiResult<VoteResult>> {
    return this.voteResult(
      this.mutate(
        "PUT",
        this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/vote`),
        { value },
        options,
      ),
    );
  }

  /** Clear the viewer's vote (§2: `DELETE` clears). */
  async clearVote(annotationId: string, options?: MutationOptions): Promise<ApiResult<VoteResult>> {
    return this.voteResult(
      this.mutate(
        "DELETE",
        this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/vote`),
        undefined,
        options,
      ),
    );
  }

  private async voteResult(pending: Promise<Response>): Promise<ApiResult<VoteResult>> {
    let response: Response;
    try {
      response = await pending;
    } catch {
      return {
        ok: false,
        status: 0,
        message: "network error - is the API reachable?",
        ambiguous: true,
      };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, message: await problemMessage(response) };
    }
    return readSuccessJson<VoteResult>(response, "vote");
  }

  // ---- work queue (Phase 3 contract §6) ------------------------------------

  /** A page of ready work items (read-only queue). */
  async workItems(cursor?: string): Promise<ApiResult<{ items: WorkItem[]; nextCursor: string | null }>> {
    const query = `?status=ready&limit=50${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    let response: Response;
    try {
      response = await this.get(this.projectUrl(`/work-items${query}`));
    } catch {
      return { ok: false, status: 0, message: "network error" };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, message: await problemMessage(response) };
    }
    const body = (await response.json()) as { items: WorkItem[]; nextCursor: string | null };
    return { ok: true, value: { items: body.items, nextCursor: body.nextCursor ?? null } };
  }

  /** One work item by id (status refresh after a claim/release). */
  async workItem(workItemId: string): Promise<ApiResult<WorkItem>> {
    return this.jsonResult<WorkItem>(
      (async () => this.get(this.projectUrl(`/work-items/${encodeURIComponent(workItemId)}`)))(),
      [200],
    );
  }

  // ---- Phase 4: leases + submissions (contract §2-§4) ----------------------

  private workItemUrl(workItemId: string, suffix: string): string {
    return this.projectUrl(`/work-items/${encodeURIComponent(workItemId)}${suffix}`);
  }

  /**
   * Shared response funnel: `status: 0` means "unreachable" (the islands' cue
   * to stay quiet), any HTTP error carries the parsed problem body.
   */
  protected async jsonResult<T>(
    pending: Promise<Response>,
    okStatuses: readonly number[],
    options: JsonResultOptions = {},
  ): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await pending;
    } catch {
      return {
        ok: false,
        status: 0,
        message: "network error - is the API reachable?",
        ...(options.mutation === true ? { ambiguous: true as const } : {}),
      };
    }
    if (!okStatuses.includes(response.status)) {
      let body: Record<string, unknown> | undefined;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
      const message =
        (typeof body?.["detail"] === "string" ? body["detail"] : undefined) ??
        (typeof body?.["title"] === "string" ? body["title"] : undefined) ??
        `request failed (${response.status})`;
      return {
        ok: false,
        status: response.status,
        message,
        ...(body === undefined ? {} : { problem: body }),
      };
    }
    return readSuccessJson<T>(response, options.subject);
  }

  /**
   * Claim a work item (contract §2): 201 with the §15.3 task bundle whose
   * `lease.token` is returned exactly once. The loser of a simultaneous claim
   * gets 409 `lease-held` with the holder's display name only.
   */
  async claim(workItemId: string, options?: MutationOptions): Promise<ApiResult<TaskBundle>> {
    return this.jsonResult<TaskBundle>(
      this.post(this.workItemUrl(workItemId, "/claim"), {}, options),
      [201],
      { mutation: true, subject: "claim" },
    );
  }

  /** Renew the lease (holder + current token, contract §2). */
  async renewLease(
    workItemId: string,
    leaseId: string,
    leaseToken: string,
    options?: MutationOptions,
  ): Promise<ApiResult<LeaseRenewal>> {
    return this.jsonResult<LeaseRenewal>(
      this.post(this.workItemUrl(workItemId, "/lease/renew"), { leaseId, leaseToken }, options),
      [200],
      { mutation: true, subject: "lease renewal" },
    );
  }

  /** Rotate and recover the in-memory token for this credential's live lease. */
  async recoverLease(
    workItemId: string,
    leaseId: string,
    options?: MutationOptions,
  ): Promise<ApiResult<LeaseRecovery>> {
    return this.jsonResult<LeaseRecovery>(
      this.post(this.workItemUrl(workItemId, "/lease/recover"), { leaseId }, options),
      [200],
      { mutation: true, subject: "lease recovery" },
    );
  }

  /** Release the lease - holder or maintainer; no token required (contract §2). */
  async releaseLease(
    workItemId: string,
    leaseId?: string,
    options?: MutationOptions,
  ): Promise<ApiResult<LeaseRelease>> {
    return this.jsonResult<LeaseRelease>(
      this.post(
        this.workItemUrl(workItemId, "/lease/release"),
        leaseId === undefined ? {} : { leaseId },
        options,
      ),
      [200],
      { mutation: true, subject: "lease release" },
    );
  }

  /** Submit the edit (contract §4): 202 + the operation to poll. */
  async submitWork(
    workItemId: string,
    body: SubmitBody,
    options?: MutationOptions,
  ): Promise<ApiResult<SubmissionAccepted>> {
    return this.jsonResult<SubmissionAccepted>(
      this.post(this.workItemUrl(workItemId, "/submissions"), body, options),
      [202],
      { mutation: true, subject: "submission" },
    );
  }

  // ---- event feed (Phase 3 contract §5) ------------------------------------

  /** Base URL of the SSE / poll event feed for this project. */
  eventsUrl(): string {
    return this.projectUrl("/events");
  }

  /**
   * One JSON page of the pollable event feed (`?poll=1`) - the SSE fallback
   * for environments without a streaming transport (contract §5).
   */
  async pollEvents(after: number): Promise<ApiResult<{ items: FeedEvent[]; latestId: number }>> {
    let response: Response;
    try {
      response = await this.get(`${this.eventsUrl()}?poll=1&after=${after}&limit=100`);
    } catch {
      return { ok: false, status: 0, message: "network error" };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, message: await problemMessage(response) };
    }
    const body = (await response.json()) as { items?: FeedEvent[]; latestId?: number };
    if (!Array.isArray(body.items) || typeof body.latestId !== "number") {
      // A response that is not the poll shape (e.g. an API predating the feed):
      // treat the endpoint as unsupported so the client stops cleanly.
      return { ok: false, status: 404, message: "event feed unavailable" };
    }
    return { ok: true, value: { items: body.items, latestId: body.latestId } };
  }

  // ---- Phase 6 §3.5: authoring chapters ------------------------------------

  /** Authenticated chapter metadata, including unpublished drafts. */
  async chapters(): Promise<ApiResult<ChapterProjection[]>> {
    return this.list<ChapterProjection>(this.projectUrl("/chapters?limit=200"), "&");
  }

  /**
   * The prose behind an existing chapter, for the edit half of the composer.
   *
   * `state-conflict` here means the deployment has no repository reader
   * configured, so the current text cannot be read. The composer reports that
   * verbatim and refuses to open rather than presenting an empty box that
   * would silently REPLACE the chapter with whatever is typed into it - a
   * revise sends a complete replacement body.
   */
  async chapterSource(chapterId: string): Promise<ApiResult<ChapterSource>> {
    return this.jsonResult<ChapterSource>(
      (async () => this.get(this.projectUrl(`/chapters/${encodeURIComponent(chapterId)}/source`)))(),
      [200],
    );
  }

  /**
   * Create a chapter from a title and Markdown prose (contract §3.5). The
   * server generates the id, the slug, the order and every block marker, so
   * nothing here carries a UUID the author had to know.
   */
  async createChapter(
    command: {
      title: string;
      body: string;
      summary?: string;
    },
    options?: MutationOptions,
  ): Promise<ApiResult<ChapterAccepted>> {
    return this.jsonResult<ChapterAccepted>(
      this.post(this.projectUrl("/chapter-submissions"), command, options),
      [202],
      { mutation: true, subject: "chapter creation" },
    );
  }

  /**
   * Revise an existing chapter. `baseRevision` is the `revision` that came
   * back from `chapterSource`, so a chapter edited elsewhere in the meantime
   * fails with a clean 409 instead of silently clobbering the other edit.
   */
  async reviseChapter(
    command: {
      chapterId: string;
      baseRevision: number;
      title?: string;
      body?: string;
      summary?: string;
    },
    options?: MutationOptions,
  ): Promise<ApiResult<ChapterAccepted>> {
    return this.jsonResult<ChapterAccepted>(
      this.post(this.projectUrl("/chapter-submissions"), command, options),
      [202],
      { mutation: true, subject: "chapter revision" },
    );
  }

  /** Publish a draft chapter - a separate explicit action (§3.5). */
  async publishChapter(
    chapterId: string,
    options?: MutationOptions,
  ): Promise<ApiResult<ChapterAccepted>> {
    return this.chapterStatus(chapterId, "publish", options);
  }

  /** Return a published chapter to draft. */
  async unpublishChapter(
    chapterId: string,
    options?: MutationOptions,
  ): Promise<ApiResult<ChapterAccepted>> {
    return this.chapterStatus(chapterId, "unpublish", options);
  }

  private async chapterStatus(
    chapterId: string,
    action: "publish" | "unpublish",
    options?: MutationOptions,
  ): Promise<ApiResult<ChapterAccepted>> {
    return this.jsonResult<ChapterAccepted>(
      this.post(
        this.projectUrl(`/chapters/${encodeURIComponent(chapterId)}/${action}`),
        {},
        options,
      ),
      [202],
      { mutation: true, subject: `chapter ${action}` },
    );
  }

  // ---- Phase 11 §6: chapter history --------------------------------------

  /** Latest 50 immutable revision records, newest first and without prose. */
  async chapterHistory(chapterId: string): Promise<ApiResult<ChapterHistoryPage>> {
    const query = new URLSearchParams({ limit: "50" });
    return this.jsonResult<ChapterHistoryPage>(
      (async () =>
        this.get(
          this.projectUrl(
            `/chapters/${encodeURIComponent(chapterId)}/history?${query.toString()}`,
          ),
        ))(),
      [200],
    );
  }

  /** Selected manuscript snapshot plus either its predecessor or current text. */
  async chapterHistoryRevision(
    chapterId: string,
    revision: number,
    compare: ChapterHistoryComparison,
  ): Promise<ApiResult<ChapterHistoryDetail>> {
    const query = new URLSearchParams({ compare });
    return this.jsonResult<ChapterHistoryDetail>(
      (async () =>
        this.get(
          this.projectUrl(
            `/chapters/${encodeURIComponent(chapterId)}/history/${revision}?${query.toString()}`,
          ),
        ))(),
      [200],
    );
  }

  /** Create a pending proposal from an immutable historic snapshot. */
  async restoreChapterRevision(
    chapterId: string,
    revision: number,
    options?: MutationOptions,
  ): Promise<ApiResult<ChapterHistoryRestoreAccepted>> {
    return this.jsonResult<ChapterHistoryRestoreAccepted>(
      this.post(
        this.projectUrl(
          `/chapters/${encodeURIComponent(chapterId)}/history/${revision}/restore`,
        ),
        {},
        options,
      ),
      [201],
      { mutation: true, subject: "chapter history restore" },
    );
  }

  // ---- Phase 11 §5: revision proposal review ------------------------------

  /** One bounded page of proposal summaries; immutable snapshots stay detail-only. */
  async revisionProposals(
    cursor?: string,
  ): Promise<ApiResult<{ items: RevisionProposalSummary[]; nextCursor: string | null }>> {
    const query = new URLSearchParams({ status: "pending_review", limit: "50" });
    if (cursor !== undefined) query.set("cursor", cursor);
    return this.jsonResult<{ items: RevisionProposalSummary[]; nextCursor: string | null }>(
      (async () => this.get(this.projectUrl(`/revision-proposals?${query.toString()}`)))(),
      [200],
    );
  }

  /** Full before/after snapshots plus the API's CPU-bounded unified diff. */
  async revisionProposal(proposalId: string): Promise<ApiResult<RevisionProposalDetail>> {
    const detail = await this.jsonResult<
      Omit<RevisionProposalDetail, "diff"> & { diff?: RevisionProposalDetail["diff"] }
    >(
      (async () =>
        this.get(this.projectUrl(`/revision-proposals/${encodeURIComponent(proposalId)}`)))(),
      [200],
    );
    if (!detail.ok) return detail;
    if (detail.value.diff !== undefined) {
      return { ok: true, value: detail.value as RevisionProposalDetail };
    }
    // The first deploy kept CPU-bounded diff generation on a sibling route.
    // Normalize it here so the shared store and view retain one stable detail
    // interface while newer APIs may embed `diff` directly.
    const rendered = await this.jsonResult<{
      proposal: RevisionProposalSummary;
      author?: RevisionProposalActor | null;
      baseContent: string;
      proposedContent: string;
      unifiedDiff: string | null;
      computationLimited: boolean;
    }>(
      (async () =>
        this.get(
          this.projectUrl(`/revision-proposals/${encodeURIComponent(proposalId)}/diff`),
        ))(),
      [200],
    );
    if (!rendered.ok) return rendered;
    return {
      ok: true,
      value: {
        ...detail.value,
        ...rendered.value.proposal,
        author: rendered.value.author ?? detail.value.author ?? null,
        target: rendered.value.proposal.target ?? detail.value.target ?? null,
        workItem: rendered.value.proposal.workItem ?? detail.value.workItem ?? null,
        chapter: rendered.value.proposal.chapter ?? detail.value.chapter ?? null,
        currentRevision:
          rendered.value.proposal.currentRevision ?? detail.value.currentRevision ?? null,
        gitOperationId:
          rendered.value.proposal.gitOperationId ??
          rendered.value.proposal.operationId ??
          detail.value.gitOperationId ??
          detail.value.operationId ??
          null,
        baseContent: rendered.value.baseContent,
        proposedContent: rendered.value.proposedContent,
        diff: {
          unifiedDiff: rendered.value.unifiedDiff,
          computationLimited: rendered.value.computationLimited,
        },
      },
    };
  }

  /**
   * Approve is the one-click validated apply command. Rejection may carry a
   * note, but an empty note is deliberately `{}` and never blocks the action.
   */
  async reviewRevisionProposal(
    proposalId: string,
    decision: "approve" | "reject",
    reason?: string,
    options?: MutationOptions,
  ): Promise<ApiResult<RevisionReviewResult>> {
    return this.jsonResult<RevisionReviewResult>(
      this.post(
        this.projectUrl(
          `/revision-proposals/${encodeURIComponent(proposalId)}/${decision}`,
        ),
        reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() },
        options,
      ),
      decision === "approve" ? [202] : [200],
      { mutation: true, subject: `revision ${decision}` },
    );
  }

  // ---- Phase 6 §3.6: book settings -----------------------------------------

  /** The maintainer-only settings document (editable + guarded + governance). */
  async settings(): Promise<ApiResult<SettingsDocument>> {
    return this.jsonResult<SettingsDocument>(
      (async () => this.get(this.projectUrl("/settings")))(),
      [200],
    );
  }

  /**
   * Save a settings change. A guarded field (slug, chapter_url) comes back as
   * a `settings-confirmation-required` problem the FIRST time, carrying what
   * each change breaks; the view shows that text and resends with `confirm`.
   */
  async patchSettings(
    patch: SettingsPatch,
    options?: MutationOptions,
  ): Promise<ApiResult<SettingsSaved>> {
    return this.jsonResult<SettingsSaved>(
      this.mutate("PATCH", this.projectUrl("/settings"), patch, options),
      [200, 202],
      { mutation: true, subject: "settings update" },
    );
  }

  // ---- Phase 3 maintainer overrides, surfaced by Phase 6 §3.6 --------------

  /**
   * Promote a comment or suggestion to Work regardless of the tally. Phase 11
   * sends `{}` for the one-click UI; `reason` remains optional for older
   * callers whose rationale should continue to be retained.
   */
  async promoteToWork(
    annotationId: string,
    reason?: string,
    options?: MutationOptions,
  ): Promise<ApiResult<OverrideResult>> {
    return this.jsonResult<OverrideResult>(
      this.post(
        this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/force-create-work-item`),
        reason === undefined ? {} : { reason },
        options,
      ),
      // 201: force-create makes a work item, so it answers "created" - unlike
      // reject, which only transitions the suggestion and answers 200.
      [201],
      { mutation: true, subject: "work promotion" },
    );
  }

  /** Reject an open suggestion (the inverse override, same reason discipline). */
  async rejectSuggestion(
    annotationId: string,
    reason: string,
    options?: MutationOptions,
  ): Promise<ApiResult<OverrideResult>> {
    return this.jsonResult<OverrideResult>(
      this.post(
        this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/reject`),
        { reason },
        options,
      ),
      [200],
      { mutation: true, subject: "suggestion rejection" },
    );
  }

  /** Dev-mode login (only rendered behind the `data-dev-login` build flag). */
  async devLogin(login: string, role: string): Promise<ApiResult<DevLogin>> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/v1/dev/login`, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ login, role }),
      });
    } catch {
      return { ok: false, status: 0, message: "network error - is the dev API running?" };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, message: await problemMessage(response) };
    }
    return readSuccessJson<DevLogin>(response, "dev login");
  }
}
