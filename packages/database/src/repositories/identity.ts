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

export class ProjectsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: ProjectRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO projects
           (id, slug, repo_provider, repo, default_branch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.slug,
        record.repoProvider,
        record.repo,
        record.defaultBranch,
        record.status,
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
}

function mapProject(row: SqlRow): ProjectRecord {
  return {
    id: String(row["id"]),
    slug: String(row["slug"]),
    repoProvider: String(row["repo_provider"]),
    repo: String(row["repo"]),
    defaultBranch: String(row["default_branch"]),
    status: String(row["status"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
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
           (id, project_id, actor_id, name, token_hash, scopes, created_by,
            created_at, expires_at, revoked_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.actorId,
        record.name,
        record.tokenHash,
        JSON.stringify(record.scopes),
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

  revokeStatement(id: string, revokedAt: string): SqlStatement {
    return this.db
      .prepare(`UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .bind(revokedAt, id);
  }

  /** Returns true when the token existed and was not already revoked. */
  async revoke(id: string, revokedAt: string): Promise<boolean> {
    const result = await this.revokeStatement(id, revokedAt).run();
    return result.changes > 0;
  }

  /** Contract §3: last_used_at is updated at most once per minute — callers throttle. */
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
    createdBy: String(row["created_by"]),
    createdAt: String(row["created_at"]),
    expiresAt: String(row["expires_at"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
    lastUsedAt: row["last_used_at"] === null ? null : String(row["last_used_at"]),
  };
}
