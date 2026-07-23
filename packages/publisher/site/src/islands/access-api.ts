/**
 * The Phase 7 half of the API client - the author-facing access control routes
 * (collaborators, agent tokens, audit, access state, freeze, pause, roles,
 * removal, revocation, moderation).
 *
 * It lives in its own module, as a SUBCLASS of `CollabApi` rather than as more
 * methods on it. `CollabApi` ships in `authorbot-collab.js`, while these
 * maintainer-only routes belong to `/settings/` and nowhere else. The shared
 * request plumbing (`projectUrl`, `get`, `post`, `mutate`, `jsonResult`) is
 * inherited rather than reimplemented, so there is one
 * CSRF/idempotency/problem-parsing path in the codebase, not two.
 *
 * Nothing here can return an agent token's value after the fact.
 * `agentTokens()` reads metadata, and no route re-displays a token once minted
 * - `mintAgentToken()` is the single moment its value exists to be shown.
 */
import {
  CollabApi,
  problemMessage,
  type AnnotationPolicy,
  type AnnotationTarget,
  type ApiResult,
  type Role,
} from "./api.js";

/** An actor as `actorJson` serialises it. */
export interface AccessActor {
  id: string;
  type: string;
  displayName: string;
  externalIdentity: string | null;
  status?: string;
}

/**
 * One collaborator row (contract "Seeing": "who has access, their role, when
 * they joined, who added them, and when they last acted").
 *
 * `addedByActorId` and `lastActedAt` are genuinely nullable - a membership
 * predating Phase 7 has no recorded granter, and someone who has never acted
 * has no last action. The view says so rather than inventing a value.
 */
export interface Collaborator {
  membershipId: string;
  actorId: string;
  actor: AccessActor | null;
  role: Role;
  /** The server's plain-language account of what this role may do. */
  roleMeans: string;
  scopes: string[];
  joinedAt: string;
  removedAt: string | null;
  addedByActorId: string | null;
  lastActedAt: string | null;
  /** An agent actor is a token's identity, not a person's. */
  isAgent: boolean;
  ownerActorId: string | null;
}

/**
 * Agent token METADATA. There is no field here for a token value and no route
 * that returns one: a token is displayed exactly once, by the mint response
 * that created it, and never again.
 */
export interface AgentTokenMeta {
  id: string;
  actorId: string;
  name: string;
  scopes: string[];
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /** The human who minted it. */
  owner: AccessActor | null;
  /** Membership role - half of the token's effective authority. */
  role: string | null;
  /**
   * Whether this token still uses a legacy umbrella-scope compatibility row
   * or the exact, deny-by-default editorial capability model.
   */
  capabilityMode?: "legacy" | "canonical";
  /** Exact capabilities selected by the maintainer. */
  grantedCapabilities?: string[];
  /** Capabilities the token's current project role is allowed to exercise. */
  roleCapabilityCeiling?: string[];
  /** The intersection that is enforced on the token's next request. */
  effectiveCapabilities?: string[];
  /** Old maintainer actions preserved only while a legacy row stays legacy. */
  legacyEffectiveActions?: Array<{
    action: string;
    source: "legacy-scope";
    sourceScope: string;
  }>;
  expired: boolean;
}

/** One audit-log row, with the actor already resolved by the API. */
export interface AuditEvent {
  id: string;
  at: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  actorIdentity: string | null;
  actorType: string | null;
  targetType: string;
  targetId: string;
  correlationId: string;
  metadata: unknown;
}

/** `GET .../access` - the state the enforcement gate actually reads. */
export interface AccessStateDoc {
  annotationPolicy: AnnotationPolicy;
  requiresApproval: boolean;
  freeze: { state: string; since?: string | null; reason?: string | null };
  agents: { state: string; since?: string | null; reason?: string | null };
  /** Only meaningful under `approval-gated`; 0 otherwise. */
  pendingModerationCount?: number;
}

/** How many of this author's submissions to this book landed in each state. */
export interface AuthorHistory {
  pending: number;
  approved: number;
  rejected: number;
}

/** One row of the approval queue (contract "Moderating"). */
export interface PendingAnnotation {
  id: string;
  chapterId: string;
  kind: string;
  scope: string;
  chapterRevision: number;
  target: AnnotationTarget | null;
  authorActorId: string;
  /** UNTRUSTED user prose - rendered through `textContent` only. */
  body: string;
  moderation: {
    state: string;
    reviewedByActorId: string | null;
    reviewedAt: string | null;
    rejectionReason: string | null;
  };
  createdAt: string;
  author: AccessActor | null;
  chapter: { id: string; title: string; slug: string; revision: number } | null;
  authorHistory: AuthorHistory;
}

/** The 200 body of a freeze / unfreeze / pause / resume. */
export interface AccessChange extends AccessStateDoc {
  changed: boolean;
  affectedTokens?: number;
}

/** The 200 body of a collaborator removal - what actually happened. */
export interface RemovalResult {
  actorId: string;
  removed: boolean;
  sessionsInvalidated: boolean;
  leasesReleased: { leaseId: string; workItemId: string }[];
  submissionsRejected: string[];
  agentTokensRevoked: string[];
  /** Always true, and said plainly: removing someone is not erasing them. */
  contributionsRetained: boolean;
}

/** The 200 body of revoke-all. */
export interface RevokeAllResult {
  revoked: { id: string; name: string }[];
  leasesReleased: { leaseId: string; workItemId: string }[];
  submissionsRejected: string[];
  contributionsRetained: boolean;
}

/** Per-item outcomes of a bulk moderation action. */
export interface BulkModerationResult {
  action: "approve" | "reject";
  approved: number;
  rejected: number;
  results: { pendingId: string; outcome: string; annotationId?: string }[];
}

export class AccessApi extends CollabApi {
  /**
   * Who can touch this book. Maintainer-only server-side; a non-maintainer
   * gets a 403 the view renders as an explanation rather than an empty table.
   */
  async collaborators(): Promise<
    ApiResult<{ items: Collaborator[]; roleConsequences: Record<string, string> }>
  > {
    return this.jsonResult<{ items: Collaborator[]; roleConsequences: Record<string, string> }>(
      (async () => this.get(this.projectUrl("/collaborators")))(),
      [200],
    );
  }

  /** Agent token metadata - never a token value; no route returns one. */
  async agentTokens(): Promise<ApiResult<{ items: AgentTokenMeta[] }>> {
    return this.jsonResult<{ items: AgentTokenMeta[] }>(
      (async () => this.get(this.projectUrl("/agent-tokens")))(),
      [200],
    );
  }

  /**
   * The readable activity view, newest first. `actor` accepts an actor id or an
   * external identity (`github:avery`) - the API resolves either, because the
   * id is what the database stores and the handle is what a person knows.
   */
  async audit(options: { actor?: string; limit?: number } = {}): Promise<
    ApiResult<{ items: AuditEvent[]; nextCursor: string | null }>
  > {
    const params = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.actor !== undefined && options.actor !== "") {
      params.set("actor", options.actor);
    }
    return this.jsonResult<{ items: AuditEvent[]; nextCursor: string | null }>(
      (async () => this.get(this.projectUrl(`/audit?${params.toString()}`)))(),
      [200],
    );
  }

  /** The access state in force right now (member-readable, not maintainer-only). */
  async accessState(): Promise<ApiResult<AccessStateDoc>> {
    return this.jsonResult<AccessStateDoc>(
      (async () => this.get(this.projectUrl("/access")))(),
      [200],
    );
  }

  /**
   * Freeze / unfreeze. A reason is REQUIRED to freeze and optional to unfreeze:
   * freezing is the act everyone else will need explained; unfreezing is
   * self-explanatory.
   */
  async setFreeze(frozen: boolean, reason?: string): Promise<ApiResult<AccessChange>> {
    return this.jsonResult<AccessChange>(
      this.post(
        this.projectUrl(`/access/${frozen ? "freeze" : "unfreeze"}`),
        reason === undefined || reason === "" ? {} : { reason },
      ),
      [200],
    );
  }

  /**
   * Mints an agent token.
   *
   * The response is the only time the token's value exists anywhere outside
   * the agent that will use it: the server keeps a hash, and no route
   * re-displays it. So the caller must show it immediately, and say that it
   * cannot be shown again.
   *
   * This is the route that had no way to reach it. Minting requires a
   * maintainer *session*, which is a cookie a browser holds - and the only
   * thing that ever asked for it was the setup wizard, which wanted a bearer
   * token no author has ever been issued. Everything needed was here; nothing
   * called it.
   */
  async mintAgentToken(
    name: string,
    capabilities: readonly string[],
    expiresInDays: number,
  ): Promise<ApiResult<AgentTokenMeta & { token: string }>> {
    return this.jsonResult<AgentTokenMeta & { token: string }>(
      this.post(this.projectUrl("/agent-tokens"), {
        name,
        capabilities: [...capabilities],
        expiresInDays,
      }),
      [201, 200],
    );
  }

  /** Replace one active token's complete canonical capability set in place. */
  async updateTokenCapabilities(
    tokenId: string,
    capabilities: readonly string[],
  ): Promise<ApiResult<AgentTokenMeta>> {
    return this.jsonResult<AgentTokenMeta>(
      this.mutate(
        "PUT",
        this.projectUrl(`/agent-tokens/${encodeURIComponent(tokenId)}/capabilities`),
        { capabilities: [...capabilities] },
      ),
      [200],
    );
  }

  /** Pause / resume every agent token at once. Nothing is revoked. */
  async setAgentsPaused(paused: boolean, reason?: string): Promise<ApiResult<AccessChange>> {
    return this.jsonResult<AccessChange>(
      this.post(
        this.projectUrl(`/access/${paused ? "pause-agents" : "resume-agents"}`),
        reason === undefined || reason === "" ? {} : { reason },
      ),
      [200],
    );
  }

  /** Change a collaborator's role. */
  async changeRole(
    actorId: string,
    role: Role,
    reason?: string,
  ): Promise<ApiResult<{ actorId: string; role: Role; roleMeans: string; changed: boolean }>> {
    return this.jsonResult<{ actorId: string; role: Role; roleMeans: string; changed: boolean }>(
      this.mutate("PATCH", this.projectUrl(`/collaborators/${encodeURIComponent(actorId)}`), {
        role,
        ...(reason === undefined || reason === "" ? {} : { reason }),
      }),
      [200],
    );
  }

  /**
   * Remove a collaborator. Their sessions die, their leases return to the
   * queue, their in-flight submissions are rejected - and every annotation,
   * vote and commit trailer they ever produced stays exactly where it is.
   */
  async removeCollaborator(actorId: string, reason?: string): Promise<ApiResult<RemovalResult>> {
    return this.jsonResult<RemovalResult>(
      this.mutate(
        "DELETE",
        this.projectUrl(`/collaborators/${encodeURIComponent(actorId)}`),
        reason === undefined || reason === "" ? {} : { reason },
      ),
      [200],
    );
  }

  /**
   * Revoke one agent token. The API answers 204 with no body, so this cannot
   * go through `jsonResult` (which parses one) and is spelled out instead.
   */
  async revokeToken(tokenId: string): Promise<ApiResult<null>> {
    let response: Response;
    try {
      response = await this.mutate(
        "DELETE",
        this.projectUrl(`/agent-tokens/${encodeURIComponent(tokenId)}`),
      );
    } catch {
      return { ok: false, status: 0, message: "network error - is the API reachable?" };
    }
    if (response.status === 204 || response.ok) {
      return { ok: true, value: null };
    }
    return { ok: false, status: response.status, message: await problemMessage(response) };
  }

  /** Revoke every agent token at once, for a suspected leak. Reason required. */
  async revokeAllTokens(reason: string): Promise<ApiResult<RevokeAllResult>> {
    return this.jsonResult<RevokeAllResult>(
      this.post(this.projectUrl("/agent-tokens/revoke-all"), { reason }),
      [200],
    );
  }

  /** The approval queue: pending rows with their chapter and author history. */
  async moderationQueue(): Promise<
    ApiResult<{ items: PendingAnnotation[]; nextCursor: string | null; pendingCount: number }>
  > {
    return this.jsonResult<{
      items: PendingAnnotation[];
      nextCursor: string | null;
      pendingCount: number;
    }>(
      (async () => this.get(this.projectUrl("/moderation/queue?status=pending&limit=50")))(),
      [200],
    );
  }

  /** Approve one queued annotation - the moment it becomes durable (202). */
  async approvePending(pendingId: string): Promise<ApiResult<{ pendingId: string; operationId: string }>> {
    return this.jsonResult<{ pendingId: string; operationId: string }>(
      this.post(this.projectUrl(`/moderation/${encodeURIComponent(pendingId)}/approve`), {}),
      [202],
    );
  }

  /** Reject one queued annotation. Nothing reaches Git; the record is retained. */
  async rejectPending(
    pendingId: string,
    reason?: string,
  ): Promise<ApiResult<{ pendingId: string; retained: boolean }>> {
    return this.jsonResult<{ pendingId: string; retained: boolean }>(
      this.post(
        this.projectUrl(`/moderation/${encodeURIComponent(pendingId)}/reject`),
        reason === undefined || reason === "" ? {} : { reason },
      ),
      [200],
    );
  }

  /** Bulk approve / bulk reject, with per-item outcomes rather than all-or-nothing. */
  async bulkModeration(
    action: "approve" | "reject",
    ids: string[],
    reason?: string,
  ): Promise<ApiResult<BulkModerationResult>> {
    return this.jsonResult<BulkModerationResult>(
      this.post(this.projectUrl("/moderation/bulk"), {
        action,
        ids,
        ...(reason === undefined || reason === "" ? {} : { reason }),
      }),
      [200],
    );
  }
}
