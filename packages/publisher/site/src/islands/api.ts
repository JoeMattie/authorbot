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

export interface Me {
  actor: MeActor;
  scopes: string[];
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

export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

interface PageBody {
  items: unknown[];
  nextCursor: string | null;
}

async function problemMessage(response: Response): Promise<string> {
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

  private projectUrl(path: string): string {
    return `${this.base}/v1/projects/${encodeURIComponent(this.project)}${path}`;
  }

  /** OAuth start URL with `return_to` back to the current page (§2.4). */
  signInUrl(returnTo: string): string {
    return `${this.base}/v1/auth/github?return_to=${encodeURIComponent(returnTo)}`;
  }

  private async get(url: string): Promise<Response> {
    return fetch(url, { credentials: "include", headers: { accept: "application/json" } });
  }

  private async post(url: string, body: unknown): Promise<Response> {
    return this.mutate("POST", url, body);
  }

  /**
   * A credentialed idempotent mutation (POST/PUT/DELETE). The `Origin` header
   * is set by the browser and satisfies the API's CSRF check (contract §3);
   * the `Idempotency-Key` makes retries safe (contract §2.4).
   */
  private async mutate(method: "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<Response> {
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
    // Bounded pagination: 10 pages x 200 is far beyond a chapter's plausible
    // annotation count and keeps a hostile cursor loop finite.
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
