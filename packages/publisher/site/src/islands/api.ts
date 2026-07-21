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
 * write — this is which affordances to *offer*, never the authorization.
 */
export interface MeMembership {
  role: string;
}

export interface Me {
  actor: MeActor;
  scopes: string[];
  /** Present since Phase 3; absent for an actor with no membership. */
  memberships?: MeMembership[];
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

export interface AnnotationTarget {
  blockId: string;
  textPosition?: { start: number; end: number };
  textQuote?: { exact: string; prefix?: string; suffix?: string };
}

/** Vote value (Phase 3 contract §2). */
export type VoteValue = "approve" | "reject" | "abstain";

/**
 * Aggregate vote tally (Phase 3 contract §2/§26.1: counts only — never
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
   * "—" rather than a confident zero when they are absent.
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
  /** The viewer's own current vote — member-only (§2). */
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
  baseRevision: number;
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
  annotationId: string;
  parentReplyId: string | null;
  authorActorId: string;
  body: string;
  status: string;
  createdAt: string;
}

export interface Operation {
  id: string;
  state: string;
  error: string | null;
  /** Present once the operation has committed (Phase 2 contract §5). */
  commitSha?: string | null;
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

export interface Accepted {
  operationId: string;
  annotationId?: string;
  replyId?: string;
}

/** The 200 body of a vote cast/clear (Phase 3 contract §2). */
export interface VoteResult {
  value: VoteValue | null;
  votes: VoteTally;
  decision: DecisionSummary | null;
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
 * The claim response — design §15.3 / Phase 4 contract §3, verbatim.
 *
 * SECURITY: every string under `context`, `document.source` and
 * `workItem.acceptanceCriteria` is **untrusted project prose** (design
 * §19.6). It is rendered exclusively through `textContent` and is never
 * interpreted as markup or as an instruction by this client.
 */
export interface TaskBundle {
  workItem: { id: string; type: string; acceptanceCriteria: string[]; priority: string };
  /** `token` is returned exactly once by the API and is never logged. */
  lease: {
    id: string;
    token: string;
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
 * `GET .../chapters/{id}/source` — a chapter's prose as an author wrote it.
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
}

/** 202 body of a chapter create/revise/publish/unpublish (contract §3.5). */
export interface ChapterAccepted {
  chapterId: string;
  operationId: string;
  correlationId: string;
  status: string;
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

/** `GET .../settings` — mirrors the API's field taxonomy exactly. */
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
   * boundary can be EXPLAINED — never bound to a form control (contract §3.6:
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
 * The 200/201 body of a suggestion override. `workItemId` is present only for
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

export type ApiResult<T> =
  | { ok: true; value: T }
  /**
   * `problem` carries the parsed `application/problem+json` body when the API
   * returned one, so callers can use its typed extensions (e.g. the claim
   * 409's holder display name) instead of re-parsing `detail`.
   */
  | { ok: false; status: number; message: string; problem?: Record<string, unknown> };

interface PageBody {
  items: unknown[];
  nextCursor: string | null;
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
   * the API refused it — the caller keeps the button and says so, rather than
   * reloading into a page where the reader is still signed in.
   */
  async signOut(): Promise<boolean> {
    try {
      const response = await this.post(`${this.base}/v1/auth/logout`, {});
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

  protected async post(url: string, body: unknown): Promise<Response> {
    return this.mutate("POST", url, body);
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
  ): Promise<Response> {
    return fetch(url, {
      method,
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /**
   * Auth state with reachability (contract §1): `ok: false, status: 0` ONLY
   * when the API cannot be reached at all — the caller must then render zero
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

  private async accept(url: string, body: unknown): Promise<ApiResult<Accepted>> {
    let response: Response;
    try {
      response = await this.post(url, body);
    } catch {
      return { ok: false, status: 0, message: "network error — is the API reachable?" };
    }
    if (response.status !== 202 && !response.ok) {
      return { ok: false, status: response.status, message: await problemMessage(response) };
    }
    return { ok: true, value: (await response.json()) as Accepted };
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
  ): Promise<ApiResult<Accepted>> {
    return this.accept(
      this.projectUrl(`/chapters/${encodeURIComponent(chapterId)}/annotations`),
      command,
    );
  }

  async createReply(
    annotationId: string,
    body: string,
    parentReplyId?: string,
  ): Promise<ApiResult<Accepted>> {
    return this.accept(this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/replies`), {
      body,
      ...(parentReplyId !== undefined ? { parentReplyId } : {}),
    });
  }

  async withdraw(annotationId: string): Promise<ApiResult<Accepted>> {
    return this.accept(this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/withdraw`), {});
  }

  async operation(operationId: string): Promise<Operation | null> {
    try {
      const response = await this.get(this.projectUrl(`/operations/${encodeURIComponent(operationId)}`));
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as Operation;
    } catch {
      return null;
    }
  }

  // ---- votes (Phase 3 contract §2) -----------------------------------------

  /**
   * Cast (or change) the viewer's vote on a suggestion. The 200 response
   * carries the fresh aggregate tally and the current `create_work_item`
   * decision (if any), so the caller updates the control in place without a
   * refetch.
   */
  async castVote(annotationId: string, value: VoteValue): Promise<ApiResult<VoteResult>> {
    return this.voteResult(
      this.mutate("PUT", this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/vote`), {
        value,
      }),
    );
  }

  /** Clear the viewer's vote (§2: `DELETE` clears). */
  async clearVote(annotationId: string): Promise<ApiResult<VoteResult>> {
    return this.voteResult(
      this.mutate("DELETE", this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/vote`)),
    );
  }

  private async voteResult(pending: Promise<Response>): Promise<ApiResult<VoteResult>> {
    let response: Response;
    try {
      response = await pending;
    } catch {
      return { ok: false, status: 0, message: "network error — is the API reachable?" };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, message: await problemMessage(response) };
    }
    const body = (await response.json()) as {
      value: VoteValue | null;
      votes: VoteTally;
      decision: DecisionSummary | null;
    };
    return {
      ok: true,
      value: { value: body.value, votes: body.votes, decision: body.decision ?? null },
    };
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
  ): Promise<ApiResult<T>> {
    let response: Response;
    try {
      response = await pending;
    } catch {
      return { ok: false, status: 0, message: "network error — is the API reachable?" };
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
    return { ok: true, value: (await response.json()) as T };
  }

  /**
   * Claim a work item (contract §2): 201 with the §15.3 task bundle whose
   * `lease.token` is returned exactly once. The loser of a simultaneous claim
   * gets 409 `lease-held` with the holder's display name only.
   */
  async claim(workItemId: string): Promise<ApiResult<TaskBundle>> {
    return this.jsonResult<TaskBundle>(this.post(this.workItemUrl(workItemId, "/claim"), {}), [201]);
  }

  /** Renew the lease (holder + current token, contract §2). */
  async renewLease(
    workItemId: string,
    leaseId: string,
    leaseToken: string,
  ): Promise<ApiResult<LeaseRenewal>> {
    return this.jsonResult<LeaseRenewal>(
      this.post(this.workItemUrl(workItemId, "/lease/renew"), { leaseId, leaseToken }),
      [200],
    );
  }

  /** Release the lease — holder or maintainer; no token required (contract §2). */
  async releaseLease(workItemId: string, leaseId?: string): Promise<ApiResult<{ status: string }>> {
    return this.jsonResult<{ status: string }>(
      this.post(this.workItemUrl(workItemId, "/lease/release"), leaseId === undefined ? {} : { leaseId }),
      [200],
    );
  }

  /** Submit the edit (contract §4): 202 + the operation to poll. */
  async submitWork(workItemId: string, body: SubmitBody): Promise<ApiResult<SubmissionAccepted>> {
    return this.jsonResult<SubmissionAccepted>(
      this.post(this.workItemUrl(workItemId, "/submissions"), body),
      [202],
    );
  }

  // ---- event feed (Phase 3 contract §5) ------------------------------------

  /** Base URL of the SSE / poll event feed for this project. */
  eventsUrl(): string {
    return this.projectUrl("/events");
  }

  /**
   * One JSON page of the pollable event feed (`?poll=1`) — the SSE fallback
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
   * would silently REPLACE the chapter with whatever is typed into it — a
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
  async createChapter(command: {
    title: string;
    body: string;
    summary?: string;
  }): Promise<ApiResult<ChapterAccepted>> {
    return this.jsonResult<ChapterAccepted>(
      this.post(this.projectUrl("/chapter-submissions"), command),
      [202],
    );
  }

  /**
   * Revise an existing chapter. `baseRevision` is the `revision` that came
   * back from `chapterSource`, so a chapter edited elsewhere in the meantime
   * fails with a clean 409 instead of silently clobbering the other edit.
   */
  async reviseChapter(command: {
    chapterId: string;
    baseRevision: number;
    title?: string;
    body?: string;
    summary?: string;
  }): Promise<ApiResult<ChapterAccepted>> {
    return this.jsonResult<ChapterAccepted>(
      this.post(this.projectUrl("/chapter-submissions"), command),
      [202],
    );
  }

  /** Publish a draft chapter — a separate explicit action (§3.5). */
  async publishChapter(chapterId: string): Promise<ApiResult<ChapterAccepted>> {
    return this.chapterStatus(chapterId, "publish");
  }

  /** Return a published chapter to draft. */
  async unpublishChapter(chapterId: string): Promise<ApiResult<ChapterAccepted>> {
    return this.chapterStatus(chapterId, "unpublish");
  }

  private async chapterStatus(
    chapterId: string,
    action: "publish" | "unpublish",
  ): Promise<ApiResult<ChapterAccepted>> {
    return this.jsonResult<ChapterAccepted>(
      this.post(this.projectUrl(`/chapters/${encodeURIComponent(chapterId)}/${action}`), {}),
      [202],
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
  async patchSettings(patch: SettingsPatch): Promise<ApiResult<SettingsSaved>> {
    return this.jsonResult<SettingsSaved>(
      this.mutate("PATCH", this.projectUrl("/settings"), patch),
      [200, 202],
    );
  }

  // ---- Phase 3 maintainer overrides, surfaced by Phase 6 §3.6 --------------

  /**
   * Force-create a work item from a suggestion regardless of the tally. The
   * reason is required by the API and is recorded on the decision, which is
   * what makes an override auditable rather than silent.
   */
  async promoteToWork(annotationId: string, reason: string): Promise<ApiResult<OverrideResult>> {
    return this.jsonResult<OverrideResult>(
      this.post(
        this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/force-create-work-item`),
        { reason },
      ),
      // 201: force-create makes a work item, so it answers "created" — unlike
      // reject, which only transitions the suggestion and answers 200.
      [201],
    );
  }

  /** Reject an open suggestion (the inverse override, same reason discipline). */
  async rejectSuggestion(annotationId: string, reason: string): Promise<ApiResult<OverrideResult>> {
    return this.jsonResult<OverrideResult>(
      this.post(this.projectUrl(`/annotations/${encodeURIComponent(annotationId)}/reject`), {
        reason,
      }),
      [200],
    );
  }

  /** Dev-mode login (only rendered behind the `data-dev-login` build flag). */
  async devLogin(login: string, role: string): Promise<ApiResult<Me>> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/v1/dev/login`, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ login, role }),
      });
    } catch {
      return { ok: false, status: 0, message: "network error — is the dev API running?" };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, message: await problemMessage(response) };
    }
    return { ok: true, value: (await response.json()) as Me };
  }
}
