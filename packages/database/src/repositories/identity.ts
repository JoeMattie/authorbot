/**
 * Repositories for identity tables: projects, actors, project_memberships,
 * human_sessions, agent_tokens.
 *
 * Every mutating method has a `...Statement` variant returning a bound
 * `SqlStatement` so callers can compose atomic multi-table writes with
 * `db.batch([...])` (Phase 2 contract §5 command flow).
 */
import type { SqlDatabase, SqlRow, SqlStatement } from "../sql.js";
import type {
  ActorRecord,
  AgentTokenCapabilityMode,
  AgentTokenRecord,
  HumanSessionRecord,
  MembershipRole,
  ProjectMembershipRecord,
  ProjectRecord,
} from "../records.js";

function parseScopes(json: unknown): string[] {
  const parsed: unknown = JSON.parse(String(json));
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === "string")) {
    throw new Error("scopes column does not contain a JSON string array");
  }
  return parsed;
}

function parseCapabilities(json: unknown): string[] | null {
  if (json === null || json === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(String(json));
  if (!Array.isArray(parsed) || !parsed.every((capability) => typeof capability === "string")) {
    throw new Error("capabilities_v2 column does not contain a JSON string array");
  }
  return parsed;
}

function parseCapabilityMode(value: unknown): AgentTokenCapabilityMode {
  // A row returned by the pre-expand schema has no such key. Treating absence
  // as legacy mirrors the migration default and keeps read fixtures and a
  // rolling migration conservative.
  if (value === undefined || value === null || value === "legacy") {
    return "legacy";
  }
  if (value === "canonical") {
    return "canonical";
  }
  throw new Error(`unknown agent-token capability mode "${String(value)}"`);
}

export class ProjectsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: ProjectRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO projects
           (id, slug, repo_provider, repo, default_branch, status,
            projection_stale, projected_commit, divergence_reason, diverged_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.slug,
        record.repoProvider,
        record.repo,
        record.defaultBranch,
        record.status,
        record.projectionStale ? 1 : 0,
        record.projectedCommit,
        record.divergenceReason === null || record.divergenceReason === undefined
          ? null
          : JSON.stringify(record.divergenceReason),
        record.divergedAt,
        record.createdAt,
        record.updatedAt,
      );
  }

  async insert(record: ProjectRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<ProjectRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM projects WHERE id = ?`).bind(id).first();
    return row ? mapProject(row) : null;
  }

  async getBySlug(slug: string): Promise<ProjectRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM projects WHERE slug = ?`).bind(slug).first();
    return row ? mapProject(row) : null;
  }

  // ---- Phase 5 §6: projection staleness and divergence ---------------------

  /**
   * Mark the projection stale (a verified default-branch push arrived).
   * Deliberately unconditional and idempotent: two pushes racing must both
   * leave the flag set, and setting it is always safe - the worst outcome is
   * one redundant refresh.
   */
  markProjectionStaleStatement(projectId: string, at: string): SqlStatement {
    return this.db
      .prepare(`UPDATE projects SET projection_stale = 1, updated_at = ? WHERE id = ?`)
      .bind(at, projectId);
  }

  /**
   * Record a completed refresh: store the commit it was built from and clear
   * the stale flag - but ONLY if no newer push arrived meanwhile.
   *
   * `observedStaleAt` is the `updated_at` the row carried when the refresh
   * began. If a push bumped it since, the flag stays set and the next refresh
   * picks the newer head up. Clearing unconditionally would drop that push
   * (the refresh read a snapshot taken before it).
   */
  completeProjectionRefreshStatement(input: {
    projectId: string;
    projectedCommit: string | null;
    observedUpdatedAt: string;
    at: string;
  }): SqlStatement {
    return this.db
      .prepare(
        `UPDATE projects
            SET projected_commit = ?,
                projection_stale = CASE WHEN updated_at = ? THEN 0 ELSE projection_stale END,
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(input.projectedCommit, input.observedUpdatedAt, input.at, input.projectId);
  }

  /**
   * Mark the project diverged (design §14.5). Idempotent on `diverged_at`: the
   * FIRST detection's timestamp is kept, because that is when the repository
   * actually broke, while `divergence_reason` always reflects the most recent
   * detection so a maintainer sees the current explanation.
   */
  markDivergedStatement(input: {
    projectId: string;
    reason: unknown;
    at: string;
  }): SqlStatement {
    return this.db
      .prepare(
        `UPDATE projects
            SET status = 'diverged',
                divergence_reason = ?,
                diverged_at = COALESCE(diverged_at, ?),
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(JSON.stringify(input.reason ?? null), input.at, input.at, input.projectId);
  }

  /**
   * Clear divergence (maintainer recovery, contract §6). The clearing reason
   * replaces the detection record so the row explains its own current state;
   * the audit event carries the full history.
   */
  clearDivergenceStatement(input: {
    projectId: string;
    reason: unknown;
    at: string;
  }): SqlStatement {
    return this.db
      .prepare(
        `UPDATE projects
            SET status = 'active',
                divergence_reason = ?,
                diverged_at = NULL,
                updated_at = ?
          WHERE id = ? AND status = 'diverged'`,
      )
      .bind(JSON.stringify(input.reason ?? null), input.at, input.projectId);
  }
}

function parseJsonColumn(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    // A hand-edited or pre-JSON value is still worth surfacing as text rather
    // than failing every project read.
    return String(value);
  }
}

function mapProject(row: SqlRow): ProjectRecord {
  return {
    id: String(row["id"]),
    slug: String(row["slug"]),
    repoProvider: String(row["repo_provider"]),
    repo: String(row["repo"]),
    defaultBranch: String(row["default_branch"]),
    status: String(row["status"]),
    projectionStale: Number(row["projection_stale"] ?? 0) !== 0,
    projectedCommit: nullableText(row["projected_commit"]),
    divergenceReason: parseJsonColumn(row["divergence_reason"]),
    divergedAt: nullableText(row["diverged_at"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class ActorsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: ActorRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO actors
           (id, type, display_name, external_identity, owner_actor_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.type,
        record.displayName,
        record.externalIdentity,
        record.ownerActorId,
        record.status,
        record.createdAt,
      );
  }

  async insert(record: ActorRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<ActorRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM actors WHERE id = ?`).bind(id).first();
    return row ? mapActor(row) : null;
  }

  async getByExternalIdentity(externalIdentity: string): Promise<ActorRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM actors WHERE external_identity = ?`)
      .bind(externalIdentity)
      .first();
    return row ? mapActor(row) : null;
  }
}

function mapActor(row: SqlRow): ActorRecord {
  return {
    id: String(row["id"]),
    type: String(row["type"]) as ActorRecord["type"],
    displayName: String(row["display_name"]),
    externalIdentity: row["external_identity"] === null ? null : String(row["external_identity"]),
    ownerActorId: row["owner_actor_id"] === null ? null : String(row["owner_actor_id"]),
    status: String(row["status"]),
    createdAt: String(row["created_at"]),
  };
}

export class ProjectMembershipsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: ProjectMembershipRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO project_memberships
           (id, project_id, actor_id, role, scopes, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.actorId,
        record.role,
        JSON.stringify(record.scopes),
        record.createdAt,
        record.revokedAt,
      );
  }

  async insert(record: ProjectMembershipRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getByProjectAndActor(
    projectId: string,
    actorId: string,
  ): Promise<ProjectMembershipRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM project_memberships WHERE project_id = ? AND actor_id = ?`)
      .bind(projectId, actorId)
      .first();
    return row ? mapMembership(row) : null;
  }

  async listByProject(projectId: string): Promise<ProjectMembershipRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM project_memberships WHERE project_id = ? ORDER BY id`)
      .bind(projectId)
      .all();
    return rows.map(mapMembership);
  }

  revokeStatement(id: string, revokedAt: string): SqlStatement {
    return this.db
      .prepare(
        `UPDATE project_memberships SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      )
      .bind(revokedAt, id);
  }

  /** Returns true when the membership existed and was not already revoked. */
  async revoke(id: string, revokedAt: string): Promise<boolean> {
    const result = await this.revokeStatement(id, revokedAt).run();
    return result.changes > 0;
  }
}

function mapMembership(row: SqlRow): ProjectMembershipRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    actorId: String(row["actor_id"]),
    role: String(row["role"]) as MembershipRole,
    scopes: parseScopes(row["scopes"]),
    createdAt: String(row["created_at"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
  };
}

export class HumanSessionsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: HumanSessionRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO human_sessions
           (id, session_hash, actor_id, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.sessionHash,
        record.actorId,
        record.createdAt,
        record.expiresAt,
        record.revokedAt,
      );
  }

  async insert(record: HumanSessionRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getBySessionHash(sessionHash: string): Promise<HumanSessionRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM human_sessions WHERE session_hash = ?`)
      .bind(sessionHash)
      .first();
    return row ? mapSession(row) : null;
  }

  async revoke(id: string, revokedAt: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE human_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(revokedAt, id)
      .run();
    return result.changes > 0;
  }

  /**
   * Revoke EVERY live session an actor holds (Phase 7 contract "Revoking":
   * revocation must "invalidate that actor's sessions, not merely their
   * membership", and take effect "on the next request - not on session
   * expiry").
   *
   * Exposed as a statement as well as an awaited helper because a revocation
   * lands the membership change, the session kill, the released lease, the
   * rejected submissions, and the audit event in one batch: a partial
   * revocation is worse than none, since it would report success while leaving
   * the removed collaborator holding a working cookie.
   */
  revokeAllForActorStatement(actorId: string, revokedAt: string): SqlStatement {
    return this.db
      .prepare(
        `UPDATE human_sessions SET revoked_at = ? WHERE actor_id = ? AND revoked_at IS NULL`,
      )
      .bind(revokedAt, actorId);
  }

  async revokeAllForActor(actorId: string, revokedAt: string): Promise<number> {
    const result = await this.revokeAllForActorStatement(actorId, revokedAt).run();
    return result.changes;
  }

  /** Delete sessions whose expiry is at or before `now`. Returns count. */
  async deleteExpired(now: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM human_sessions WHERE expires_at <= ?`)
      .bind(now)
      .run();
    return result.changes;
  }
}

function mapSession(row: SqlRow): HumanSessionRecord {
  return {
    id: String(row["id"]),
    sessionHash: String(row["session_hash"]),
    actorId: String(row["actor_id"]),
    createdAt: String(row["created_at"]),
    expiresAt: String(row["expires_at"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
  };
}

export class AgentTokensRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: AgentTokenRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO agent_tokens
           (id, project_id, actor_id, name, token_hash, scopes,
            capabilities_v2, capability_mode, created_by, created_at,
            expires_at, revoked_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.actorId,
        record.name,
        record.tokenHash,
        JSON.stringify(record.scopes),
        record.capabilitiesV2 === undefined || record.capabilitiesV2 === null
          ? null
          : JSON.stringify(record.capabilitiesV2),
        record.capabilityMode ?? "legacy",
        record.createdBy,
        record.createdAt,
        record.expiresAt,
        record.revokedAt,
        record.lastUsedAt,
      );
  }

  async insert(record: AgentTokenRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<AgentTokenRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM agent_tokens WHERE id = ?`).bind(id).first();
    return row ? mapToken(row) : null;
  }

  async getByTokenHash(tokenHash: string): Promise<AgentTokenRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM agent_tokens WHERE token_hash = ?`)
      .bind(tokenHash)
      .first();
    return row ? mapToken(row) : null;
  }

  async listByProject(projectId: string): Promise<AgentTokenRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM agent_tokens WHERE project_id = ? ORDER BY id`)
      .bind(projectId)
      .all();
    return rows.map(mapToken);
  }

  /** Live (unrevoked) tokens for a project, whether or not they have expired. */
  async listActiveByProject(projectId: string): Promise<AgentTokenRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM agent_tokens WHERE project_id = ? AND revoked_at IS NULL ORDER BY id`,
      )
      .bind(projectId)
      .all();
    return rows.map(mapToken);
  }

  /**
   * Atomically replace both representations of one token's authority.
   *
   * Slice 3A's canonical writer will provide a conservative `scopes` shadow;
   * the later backfill can populate `capabilitiesV2` while deliberately
   * leaving `capabilityMode` as `legacy`. Keeping the three columns in one
   * statement prevents a request from observing a mode paired with the wrong
   * grant set.
   */
  setCapabilityStateStatement(
    id: string,
    state: {
      scopes: readonly string[];
      capabilitiesV2: readonly string[] | null;
      capabilityMode: AgentTokenCapabilityMode;
    },
  ): SqlStatement {
    return this.db
      .prepare(
        `UPDATE agent_tokens
            SET scopes = ?, capabilities_v2 = ?, capability_mode = ?
          WHERE id = ?`,
      )
      .bind(
        JSON.stringify(state.scopes),
        state.capabilitiesV2 === null ? null : JSON.stringify(state.capabilitiesV2),
        state.capabilityMode,
        id,
      );
  }

  /**
   * Replace a live token's authority only when its complete stored state still
   * matches the caller's read. A lost CAS assigns NULL to the NOT NULL
   * `scopes` column so an enclosing batch aborts with its audit/idempotency
   * writes instead of recording a change that did not happen.
   */
  setCapabilityStateCasStatement(
    id: string,
    expected: {
      scopes: readonly string[];
      capabilitiesV2: readonly string[] | null;
      capabilityMode: AgentTokenCapabilityMode;
    },
    state: {
      scopes: readonly string[];
      capabilitiesV2: readonly string[] | null;
      capabilityMode: AgentTokenCapabilityMode;
    },
    activeAfter: string,
  ): SqlStatement {
    const expectedCapabilities =
      expected.capabilitiesV2 === null ? null : JSON.stringify(expected.capabilitiesV2);
    return this.db
      .prepare(
        `UPDATE agent_tokens
            SET scopes = CASE
                  WHEN scopes = ?
                   AND ((capabilities_v2 IS NULL AND ? IS NULL) OR capabilities_v2 = ?)
                   AND capability_mode = ?
                   AND revoked_at IS NULL
                   AND expires_at > ?
                  THEN ?
                  ELSE NULL
                END,
                capabilities_v2 = ?,
                capability_mode = ?
          WHERE id = ?`,
      )
      .bind(
        JSON.stringify(expected.scopes),
        expectedCapabilities,
        expectedCapabilities,
        expected.capabilityMode,
        activeAfter,
        JSON.stringify(state.scopes),
        state.capabilitiesV2 === null ? null : JSON.stringify(state.capabilitiesV2),
        state.capabilityMode,
        id,
      );
  }

  /** Returns true when the token existed. */
  async setCapabilityState(
    id: string,
    state: {
      scopes: readonly string[];
      capabilitiesV2: readonly string[] | null;
      capabilityMode: AgentTokenCapabilityMode;
    },
  ): Promise<boolean> {
    const result = await this.setCapabilityStateStatement(id, state).run();
    return result.changes > 0;
  }

  revokeStatement(id: string, revokedAt: string): SqlStatement {
    return this.db
      .prepare(`UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(revokedAt, id);
  }

  /**
   * Revoke every live token for a project in one statement (Phase 7 contract
   * "Revoking": "Revoke all agent tokens in one action, for a suspected
   * leak"). One statement rather than a loop because a leak response that
   * revokes tokens one at a time leaves a window in which the attacker's token
   * is the one not yet reached.
   */
  revokeAllForProjectStatement(projectId: string, revokedAt: string): SqlStatement {
    return this.db
      .prepare(
        `UPDATE agent_tokens SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL`,
      )
      .bind(revokedAt, projectId);
  }

  /** Returns true when the token existed and was not already revoked. */
  async revoke(id: string, revokedAt: string): Promise<boolean> {
    const result = await this.revokeStatement(id, revokedAt).run();
    return result.changes > 0;
  }

  /** Contract §3: last_used_at is updated at most once per minute - callers throttle. */
  async touchLastUsed(id: string, lastUsedAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE agent_tokens SET last_used_at = ? WHERE id = ?`)
      .bind(lastUsedAt, id)
      .run();
  }
}

function mapToken(row: SqlRow): AgentTokenRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    actorId: String(row["actor_id"]),
    name: String(row["name"]),
    tokenHash: String(row["token_hash"]),
    scopes: parseScopes(row["scopes"]),
    capabilitiesV2: parseCapabilities(row["capabilities_v2"]),
    capabilityMode: parseCapabilityMode(row["capability_mode"]),
    createdBy: String(row["created_by"]),
    createdAt: String(row["created_at"]),
    expiresAt: String(row["expires_at"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
    lastUsedAt: row["last_used_at"] === null ? null : String(row["last_used_at"]),
  };
}
