import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteDatabase, type SqliteAdapter } from "../src/adapters/better-sqlite3.js";
import { applyMigrations, listMigrationFiles } from "../src/migrate.js";
import type { SqlRow } from "../src/sql.js";
import { MIGRATIONS_DIR } from "./helpers.js";

const BACKFILL_MIGRATION = "0013_phase11_capabilities_backfill.sql";
const LEGACY_EDITORIAL_SCOPES = [
  "chapters:read",
  "annotations:read",
  "annotations:write",
  "work:read",
  "work:claim",
  "submissions:write",
  "votes:write",
] as const;
const LEGACY_AGENT_SCOPES = [
  "chapters:read",
  "annotations:read",
  "annotations:write",
  "work:read",
  "work:claim",
  "submissions:write",
  "tokens:manage",
  "members:manage",
  "votes:write",
] as const;
const LEGACY_SAFE = new Set<string>(LEGACY_EDITORIAL_SCOPES);
const NEVER_SYNTHESIZED = [
  "comments:vote",
  "feedback:moderate",
  "work:promote",
  "work:cancel",
  "summaries:write",
  "revisions:read",
  "revisions:write",
  "revisions:review",
  "history:read",
] as const;

const PROJECT_ID = "01900000-0000-7000-8000-000000000001";
const ACTOR_ID = "01900000-0000-7000-8000-000000000002";
const CREATED_AT = "2026-07-22T00:00:00Z";
const ACTIVE_EXPIRY = "2026-08-22T00:00:00Z";
const EXPIRED_AT = "2026-07-01T00:00:00Z";
const REVOKED_AT = "2026-07-20T00:00:00Z";

interface StoredToken extends SqlRow {
  id: string;
  scopes: string;
  capabilities_v2: string | null;
  capability_mode: string;
  expires_at: string;
  revoked_at: string | null;
}

interface StoredAudit extends SqlRow {
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  correlation_id: string;
  metadata: string;
}

interface TimestampedAudit extends StoredAudit {
  id: string;
  created_at: string;
}

const tokenId = (ordinal: number): string =>
  `01900000-0000-7000-8000-${ordinal.toString(16).padStart(12, "0")}`;

function uuidV7TimestampMillis(id: string): number {
  return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

function uuidV7At(millis: number, suffix: string): string {
  const timestamp = Math.trunc(millis).toString(16).padStart(12, "0");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.padStart(12, "0")}`;
}

function expectedCapabilities(scopes: readonly string[]): string[] {
  const has = new Set(scopes);
  const capabilities: string[] = [];
  if (has.has("chapters:read")) capabilities.push("chapters:read");
  if (has.has("annotations:read")) {
    capabilities.push("comments:read", "suggestions:read");
  }
  if (has.has("annotations:write")) {
    capabilities.push("comments:write", "suggestions:write", "replies:write");
  }
  if (has.has("votes:write")) capabilities.push("suggestions:vote");
  if (has.has("annotations:write")) capabilities.push("feedback:withdraw-own");
  if (has.has("work:read")) capabilities.push("work:read");
  if (has.has("work:claim")) capabilities.push("work:claim");
  if (has.has("submissions:write")) {
    capabilities.push("work:submit", "chapters:write", "chapters:publish");
  }
  return capabilities;
}

function uniqueRemovedScopes(scopes: readonly string[]): string[] {
  return scopes.filter(
    (scope, index) => !LEGACY_SAFE.has(scope) && scopes.indexOf(scope) === index,
  );
}

async function copyMigrationsBefore(dir: string, boundary: string): Promise<void> {
  const files = await listMigrationFiles(MIGRATIONS_DIR);
  for (const name of files.filter((candidate) => candidate < boundary)) {
    await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
  }
}

async function preBackfillDatabase(): Promise<{
  db: SqliteAdapter;
  migrationsDir: string;
}> {
  const migrationsDir = await mkdtemp(join(tmpdir(), "authorbot-phase11-3b-"));
  await copyMigrationsBefore(migrationsDir, "0013_");
  const db = openSqliteDatabase(":memory:");
  await applyMigrations(db, migrationsDir);
  return { db, migrationsDir };
}

async function seedIdentity(db: SqliteAdapter): Promise<void> {
  await db
    .prepare(
      `INSERT INTO projects
         (id, slug, repo, default_branch, status, created_at, updated_at)
       VALUES (?, 'book', 'owner/book', 'main', 'active', ?, ?)`,
    )
    .bind(PROJECT_ID, CREATED_AT, CREATED_AT)
    .run();
  await db
    .prepare(
      `INSERT INTO actors
         (id, type, display_name, external_identity, owner_actor_id, status, created_at)
       VALUES (?, 'agent', 'legacy-agent', 'agent:legacy-agent', NULL, 'active', ?)`,
    )
    .bind(ACTOR_ID, CREATED_AT)
    .run();
}

function oldWorkerInsert(
  db: SqliteAdapter,
  id: string,
  scopes: string | readonly string[],
  options: {
    expiresAt?: string;
    revokedAt?: string | null;
    actorId?: string;
    createdBy?: string;
  } = {},
) {
  const encoded = typeof scopes === "string" ? scopes : JSON.stringify(scopes);
  const actorId = options.actorId ?? ACTOR_ID;
  return db
    .prepare(
      `INSERT INTO agent_tokens
         (id, project_id, actor_id, name, token_hash, scopes, created_by,
          created_at, expires_at, revoked_at, last_used_at)
       VALUES (?, ?, ?, 'legacy-agent', ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      id,
      PROJECT_ID,
      actorId,
      `hash-${id}`,
      encoded,
      options.createdBy ?? actorId,
      CREATED_AT,
      options.expiresAt ?? ACTIVE_EXPIRY,
      options.revokedAt ?? null,
    );
}

function expandedWorkerInsert(
  db: SqliteAdapter,
  id: string,
  scopes: string | readonly string[],
  capabilitiesV2: string | readonly string[] | null,
  capabilityMode: "legacy" | "canonical" = "legacy",
  actorId = ACTOR_ID,
) {
  const encodedScopes = typeof scopes === "string" ? scopes : JSON.stringify(scopes);
  const encodedCapabilities =
    capabilitiesV2 === null
      ? null
      : typeof capabilitiesV2 === "string"
        ? capabilitiesV2
        : JSON.stringify(capabilitiesV2);
  return db
    .prepare(
      `INSERT INTO agent_tokens
         (id, project_id, actor_id, name, token_hash, scopes,
          capabilities_v2, capability_mode, created_by, created_at,
          expires_at, revoked_at, last_used_at)
       VALUES (?, ?, ?, 'legacy-agent', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      id,
      PROJECT_ID,
      actorId,
      `hash-${id}`,
      encodedScopes,
      encodedCapabilities,
      capabilityMode,
      actorId,
      CREATED_AT,
      ACTIVE_EXPIRY,
    );
}

function v0134WorkerInsert(
  db: SqliteAdapter,
  id: string,
  scopes: string | readonly string[],
  actorId = ACTOR_ID,
) {
  // v0.1.34 already used the expanded repository shape: it named both new
  // columns explicitly, writing NULL plus legacy rather than relying on their
  // database defaults.
  return expandedWorkerInsert(db, id, scopes, null, "legacy", actorId);
}

function v0135WorkerInsert(
  db: SqliteAdapter,
  id: string,
  scopes: readonly string[],
  actorId = ACTOR_ID,
) {
  return expandedWorkerInsert(
    db,
    id,
    scopes,
    expectedCapabilities(scopes),
    "legacy",
    actorId,
  );
}

async function totalChanges(db: SqliteAdapter): Promise<number> {
  const row = await db
    .prepare("SELECT total_changes() AS total_changes")
    .first<{ total_changes: number }>();
  return Number(row?.total_changes ?? 0);
}

async function applyBackfill(db: SqliteAdapter, migrationsDir: string): Promise<void> {
  await copyFile(
    join(MIGRATIONS_DIR, BACKFILL_MIGRATION),
    join(migrationsDir, BACKFILL_MIGRATION),
  );
  const result = await applyMigrations(db, migrationsDir);
  expect(result.applied).toEqual([BACKFILL_MIGRATION]);
}

describe("Phase 11 slice 3B capability backfill", () => {
  it("translates every legacy scope combination without expanding authority", async () => {
    const { db, migrationsDir } = await preBackfillDatabase();
    await seedIdentity(db);

    const combinations = 1 << LEGACY_AGENT_SCOPES.length;
    const insertions = [];
    for (let mask = 0; mask < combinations; mask += 1) {
      const scopes = LEGACY_AGENT_SCOPES.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      insertions.push(oldWorkerInsert(db, tokenId(1000 + mask), scopes));
    }

    const unknownId = tokenId(2000);
    const invalidObjectId = tokenId(2001);
    const invalidJsonId = tokenId(2002);
    const revokedId = tokenId(2003);
    const expiredId = tokenId(2004);
    const staleProjectionId = tokenId(2006);
    insertions.push(
      oldWorkerInsert(db, unknownId, [
        "chapters:read",
        "future:admin",
        "tokens:manage",
        "annotations:read",
        "future:admin",
      ]),
      oldWorkerInsert(db, invalidObjectId, '{"tokens:manage":true}'),
      oldWorkerInsert(db, invalidJsonId, "{not-json"),
      oldWorkerInsert(db, revokedId, ["submissions:write"], {
        revokedAt: REVOKED_AT,
      }),
      oldWorkerInsert(db, expiredId, ["annotations:read", "work:claim"], {
        expiresAt: EXPIRED_AT,
      }),
      expandedWorkerInsert(
        db,
        staleProjectionId,
        ["annotations:write"],
        ["chapters:read"],
      ),
    );
    await db.batch(insertions);

    // A canonical row belongs to 3A/3C, not this backfill. Even a deliberately
    // corrupt shadow proves 3B is scoped to legacy-mode rows only.
    const canonicalId = tokenId(2005);
    await db
      .prepare(
        `INSERT INTO agent_tokens
           (id, project_id, actor_id, name, token_hash, scopes,
            capabilities_v2, capability_mode, created_by, created_at,
            expires_at, revoked_at, last_used_at)
         VALUES (?, ?, ?, 'canonical-agent', ?, ?, ?, 'canonical', ?, ?, ?, NULL, NULL)`,
      )
      .bind(
        canonicalId,
        PROJECT_ID,
        ACTOR_ID,
        `hash-${canonicalId}`,
        '["chapters:read","tokens:manage"]',
        '["chapters:read"]',
        ACTOR_ID,
        CREATED_AT,
        ACTIVE_EXPIRY,
      )
      .run();

    await applyBackfill(db, migrationsDir);

    const stored = await db
      .prepare(
        `SELECT id, scopes, capabilities_v2, capability_mode, expires_at, revoked_at
           FROM agent_tokens ORDER BY id`,
      )
      .all<StoredToken>();
    const byId = new Map(stored.map((row) => [row.id, row]));

    for (let mask = 0; mask < combinations; mask += 1) {
      const original = LEGACY_AGENT_SCOPES.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const row = byId.get(tokenId(1000 + mask));
      expect(row, `missing legacy combination mask ${mask}`).toBeDefined();
      const sanitized = original.filter((scope) => LEGACY_SAFE.has(scope));
      expect(JSON.parse(row?.scopes ?? "null"), `scopes mask ${mask}`).toEqual(
        sanitized,
      );
      const capabilities = JSON.parse(row?.capabilities_v2 ?? "null") as string[];
      expect(capabilities, `capabilities mask ${mask}`).toEqual(
        expectedCapabilities(original),
      );
      expect(row?.capability_mode).toBe("legacy");
      for (const forbidden of NEVER_SYNTHESIZED) {
        expect(capabilities, `${forbidden} mask ${mask}`).not.toContain(forbidden);
      }
    }

    expect(byId.get(unknownId)).toMatchObject({
      capability_mode: "legacy",
      scopes: '["chapters:read","annotations:read"]',
      capabilities_v2: '["chapters:read","comments:read","suggestions:read"]',
    });
    expect(byId.get(invalidObjectId)).toMatchObject({
      capability_mode: "legacy",
      scopes: "[]",
      capabilities_v2: "[]",
    });
    expect(byId.get(invalidJsonId)).toMatchObject({
      capability_mode: "legacy",
      scopes: "[]",
      capabilities_v2: "[]",
    });
    expect(byId.get(revokedId)).toMatchObject({
      capability_mode: "legacy",
      capabilities_v2: '["work:submit","chapters:write","chapters:publish"]',
      revoked_at: REVOKED_AT,
      expires_at: ACTIVE_EXPIRY,
    });
    expect(byId.get(expiredId)).toMatchObject({
      capability_mode: "legacy",
      capabilities_v2:
        '["comments:read","suggestions:read","work:claim"]',
      revoked_at: null,
      expires_at: EXPIRED_AT,
    });
    expect(byId.get(staleProjectionId)).toMatchObject({
      capability_mode: "legacy",
      scopes: '["annotations:write"]',
      capabilities_v2:
        '["comments:write","suggestions:write","replies:write","feedback:withdraw-own"]',
    });
    expect(
      await db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM audit_events
            WHERE target_id = ?
              AND action = 'agent_token.legacy_capabilities.projected'
              AND correlation_id LIKE 'phase11-3b-capability-guard:%'`,
        )
        .bind(staleProjectionId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(byId.get(canonicalId)).toMatchObject({
      capability_mode: "canonical",
      scopes: '["chapters:read","tokens:manage"]',
      capabilities_v2: '["chapters:read"]',
    });

    const audits = await db
      .prepare(
        `SELECT id, actor_id, action, target_type, target_id, correlation_id,
                metadata, created_at
           FROM audit_events
          WHERE action = 'agent_token.legacy_scopes.sanitized'
          ORDER BY target_id`,
      )
      .all<TimestampedAudit>();
    const auditsByTarget = new Map(audits.map((row) => [row.target_id, row]));
    for (const audit of audits) {
      expect(uuidV7TimestampMillis(audit.id)).toBe(Date.parse(audit.created_at));
    }

    for (let mask = 0; mask < combinations; mask += 1) {
      const original = LEGACY_AGENT_SCOPES.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const removed = uniqueRemovedScopes(original);
      const audit = auditsByTarget.get(tokenId(1000 + mask));
      if (removed.length === 0) {
        expect(audit, `unexpected audit mask ${mask}`).toBeUndefined();
        continue;
      }
      expect(audit).toMatchObject({
        actor_id: null,
        action: "agent_token.legacy_scopes.sanitized",
        target_type: "agent_token",
        target_id: tokenId(1000 + mask),
        correlation_id: `phase11-3b-capability-backfill:${tokenId(1000 + mask)}`,
      });
      expect(JSON.parse(audit?.metadata ?? "null")).toEqual({
        migration: BACKFILL_MIGRATION,
        capabilityMode: "legacy",
        reason: "control-plane-or-unknown-scope",
        removedScopes: removed,
        retainedScopes: original.filter((scope) => LEGACY_SAFE.has(scope)),
      });
    }

    expect(JSON.parse(auditsByTarget.get(unknownId)?.metadata ?? "null")).toEqual({
      migration: BACKFILL_MIGRATION,
      capabilityMode: "legacy",
      reason: "control-plane-or-unknown-scope",
      removedScopes: ["future:admin", "tokens:manage"],
      retainedScopes: ["chapters:read", "annotations:read"],
    });
    for (const id of [invalidObjectId, invalidJsonId]) {
      expect(JSON.parse(auditsByTarget.get(id)?.metadata ?? "null")).toEqual({
        migration: BACKFILL_MIGRATION,
        capabilityMode: "legacy",
        reason: "invalid-legacy-scope-set",
        removedScopes: [],
        retainedScopes: [],
      });
    }
    expect(auditsByTarget.has(canonicalId)).toBe(false);

    // SQL-level idempotency matters independently of d1_migrations skipping a
    // recorded file. A direct rerun neither mutates rows nor duplicates any
    // backfill or trigger audit.
    const migrationAudits = await db
      .prepare(
        `SELECT actor_id, action, target_type, target_id, correlation_id, metadata
           FROM audit_events
          WHERE correlation_id LIKE 'phase11-3b-capability-%'
          ORDER BY target_id, action`,
      )
      .all<StoredAudit>();
    const beforeRerun = { stored, migrationAudits };
    await db.exec(await readFile(join(MIGRATIONS_DIR, BACKFILL_MIGRATION), "utf8"));
    const afterRerun = {
      stored: await db
        .prepare(
          `SELECT id, scopes, capabilities_v2, capability_mode, expires_at, revoked_at
             FROM agent_tokens ORDER BY id`,
        )
        .all<StoredToken>(),
      migrationAudits: await db
        .prepare(
          `SELECT actor_id, action, target_type, target_id, correlation_id, metadata
             FROM audit_events
            WHERE correlation_id LIKE 'phase11-3b-capability-%'
            ORDER BY target_id, action`,
        )
        .all<StoredAudit>(),
    };
    expect(afterRerun).toEqual(beforeRerun);
    db.close();
  });

  it("shields a direct upgrade and later rollback writes from an old Worker", async () => {
    const migrationsDir = await mkdtemp(join(tmpdir(), "authorbot-phase11-gate-"));
    await copyMigrationsBefore(migrationsDir, "0010_");
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, migrationsDir);
    await seedIdentity(db);

    const beforeExpandId = tokenId(3000);
    await oldWorkerInsert(db, beforeExpandId, ["annotations:read", "work:claim"]).run();

    for (const name of [
      "0010_phase11_capabilities_expand.sql",
      "0011_phase11_revision_proposals.sql",
    ]) {
      await copyFile(join(MIGRATIONS_DIR, name), join(migrationsDir, name));
    }
    await applyMigrations(db, migrationsDir);

    const duringExpandId = tokenId(3001);
    await v0134WorkerInsert(
      db,
      duringExpandId,
      ["annotations:read", "work:claim"],
    ).run();
    const before = await db
      .prepare(
        `SELECT id, scopes, capabilities_v2, capability_mode, expires_at, revoked_at
           FROM agent_tokens ORDER BY id`,
      )
      .all<StoredToken>();
    expect(before).toEqual([
      expect.objectContaining({
        id: beforeExpandId,
        scopes: '["annotations:read","work:claim"]',
        capabilities_v2: null,
        capability_mode: "legacy",
      }),
      expect.objectContaining({
        id: duringExpandId,
        scopes: '["annotations:read","work:claim"]',
        capabilities_v2: null,
        capability_mode: "legacy",
      }),
    ]);

    await applyBackfill(db, migrationsDir);
    const after = await db
      .prepare(
        `SELECT id, scopes, capabilities_v2, capability_mode, expires_at, revoked_at
           FROM agent_tokens ORDER BY id`,
      )
      .all<StoredToken>();
    for (const row of after) {
      // An old reader still sees the exact ordinary scopes. The deployed
      // v0.1.35 Worker treats mode=legacy as authoritative and derives the same
      // canonical projection before and after the backfill.
      expect(JSON.parse(row.scopes)).toEqual(["annotations:read", "work:claim"]);
      expect(JSON.parse(row.capabilities_v2 ?? "null")).toEqual(
        expectedCapabilities(JSON.parse(row.scopes) as string[]),
      );
      expect(row.capability_mode).toBe("legacy");
    }

    // Prove the shield converges even under D1's supported recursive-trigger
    // mode. This is the exact v0.1.34 repository shape: it names the expanded
    // columns but writes NULL plus legacy.
    await db.exec("PRAGMA recursive_triggers = ON");
    const afterBackfillOldWriterId = tokenId(3002);
    await v0134WorkerInsert(db, afterBackfillOldWriterId, ["chapters:read"]).run();
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(afterBackfillOldWriterId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toEqual({
      scopes: '["chapters:read"]',
      capabilities_v2: '["chapters:read"]',
      capability_mode: "legacy",
    });

    const unsafeId = tokenId(3003);
    await expect(
      oldWorkerInsert(db, unsafeId, [
        "tokens:manage",
        "annotations:read",
        "future:admin",
      ]).run(),
    ).rejects.toThrow(/scopes require sanitation/);
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(unsafeId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toBeNull();

    // A rollback writer can still make a safe authority change. The trigger
    // preserves the exact scopes that Worker will return and refreshes the
    // projection instead of leaving it stale.
    await db
      .prepare(`UPDATE agent_tokens SET scopes = ? WHERE id = ?`)
      .bind('["submissions:write"]', duringExpandId)
      .run();
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(duringExpandId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toEqual({
      scopes: '["submissions:write"]',
      capabilities_v2: '["work:submit","chapters:write","chapters:publish"]',
      capability_mode: "legacy",
    });

    // Rewriting an old response behind its back would make the HTTP body and
    // mint audit lie. Unsafe legacy writes therefore fail atomically and leave
    // no guard audit behind.
    const guardedAudits = await db
      .prepare(
        `SELECT actor_id, action, target_type, target_id, correlation_id, metadata
           FROM audit_events
          WHERE action = 'agent_token.legacy_scopes.sanitized'
            AND correlation_id LIKE 'phase11-3b-capability-guard:%'
          ORDER BY target_id`,
      )
      .all<StoredAudit>();
    expect(guardedAudits).toEqual([]);

    const projectionAudits = await db
      .prepare(
        `SELECT actor_id, action, target_type, target_id, correlation_id, metadata
           FROM audit_events
          WHERE action = 'agent_token.legacy_capabilities.projected'
            AND correlation_id LIKE 'phase11-3b-capability-guard:%'
          ORDER BY target_id`,
      )
      .all<StoredAudit>();
    expect(projectionAudits.map((audit) => audit.target_id)).toEqual([
      duringExpandId,
      afterBackfillOldWriterId,
    ]);
    expect(JSON.parse(projectionAudits[0]?.metadata ?? "null")).toMatchObject({
      migration: BACKFILL_MIGRATION,
      reason: "stale-projection",
      capabilities: ["work:submit", "chapters:write", "chapters:publish"],
    });
    expect(JSON.parse(projectionAudits[1]?.metadata ?? "null")).toMatchObject({
      migration: BACKFILL_MIGRATION,
      reason: "missing-projection",
    });

    const schemaObjects = await db
      .prepare(
        `SELECT type, name FROM sqlite_schema
          WHERE name IN (
            '_phase11_legacy_token_projection',
            'agent_tokens_phase11_legacy_insert',
            'agent_tokens_phase11_legacy_update'
          )
          ORDER BY type, name`,
      )
      .all<{ type: string; name: string }>();
    expect(schemaObjects).toEqual([
      { type: "trigger", name: "agent_tokens_phase11_legacy_insert" },
      { type: "trigger", name: "agent_tokens_phase11_legacy_update" },
      { type: "view", name: "_phase11_legacy_token_projection" },
    ]);
    db.close();
  });

  it("rolls back complete old-Worker batches when a legacy write needs sanitation", async () => {
    const { db, migrationsDir } = await preBackfillDatabase();
    await seedIdentity(db);
    await applyBackfill(db, migrationsDir);
    await db.exec("PRAGMA recursive_triggers = ON");

    const actorId = tokenId(6000);
    const membershipId = tokenId(6001);
    const unsafeTokenId = tokenId(6002);
    const auditId = tokenId(6003);
    const idempotencyId = tokenId(6004);
    const actorInsert = db
      .prepare(
        `INSERT INTO actors
           (id, type, display_name, external_identity, owner_actor_id, status, created_at)
         VALUES (?, 'agent', 'old-worker-agent', ?, NULL, 'active', ?)`,
      )
      .bind(actorId, `agent:${actorId}`, CREATED_AT);
    const membershipInsert = db
      .prepare(
        `INSERT INTO project_memberships
           (id, project_id, actor_id, role, scopes, created_at, revoked_at)
         VALUES (?, ?, ?, 'editor', ?, ?, NULL)`,
      )
      .bind(
        membershipId,
        PROJECT_ID,
        actorId,
        JSON.stringify(LEGACY_EDITORIAL_SCOPES),
        CREATED_AT,
      );
    const auditInsert = db
      .prepare(
        `INSERT INTO audit_events
           (id, project_id, actor_id, action, target_type, target_id,
            correlation_id, metadata, created_at)
         VALUES (?, ?, ?, 'agent_token.mint.started', 'agent_token', ?,
                 'old-worker-batch', '{}', ?)`,
      )
      .bind(auditId, PROJECT_ID, actorId, unsafeTokenId, CREATED_AT);
    const idempotencyInsert = db
      .prepare(
        `INSERT INTO idempotency_keys
           (id, project_id, actor_id, key, request_hash, response_status,
            response_body, created_at)
         VALUES (?, ?, ?, 'old-worker-batch', 'hash', 201, '{}', ?)`,
      )
      .bind(idempotencyId, PROJECT_ID, ACTOR_ID, CREATED_AT);

    await expect(
      db.batch([
        actorInsert,
        membershipInsert,
        auditInsert,
        idempotencyInsert,
        v0135WorkerInsert(
          db,
          unsafeTokenId,
          ["annotations:read", "tokens:manage"],
          actorId,
        ),
      ]),
    ).rejects.toThrow(/scopes require sanitation/);

    for (const [table, id] of [
      ["actors", actorId],
      ["project_memberships", membershipId],
      ["agent_tokens", unsafeTokenId],
      ["audit_events", auditId],
      ["idempotency_keys", idempotencyId],
    ] as const) {
      expect(
        await db
          .prepare(`SELECT id FROM ${table} WHERE id = ?`)
          .bind(id)
          .first<{ id: string }>(),
        `${table} survived the rejected old-Worker batch`,
      ).toBeNull();
    }

    const safeTokenId = tokenId(6005);
    await v0135WorkerInsert(
      db,
      safeTokenId,
      ["annotations:read", "work:claim"],
    ).run();
    const updateAuditId = tokenId(6006);
    const updateMarker = db
      .prepare(
        `INSERT INTO audit_events
           (id, project_id, actor_id, action, target_type, target_id,
            correlation_id, metadata, created_at)
         VALUES (?, ?, ?, 'agent_token.update.started', 'agent_token', ?,
                 'old-worker-update-batch', '{}', ?)`,
      )
      .bind(updateAuditId, PROJECT_ID, ACTOR_ID, safeTokenId, CREATED_AT);
    const unsafeUpdate = db
      .prepare(`UPDATE agent_tokens SET scopes = ? WHERE id = ?`)
      .bind('["annotations:read","members:manage"]', safeTokenId);

    await expect(db.batch([updateMarker, unsafeUpdate])).rejects.toThrow(
      /scopes require sanitation/,
    );
    expect(
      await db
        .prepare(`SELECT id FROM audit_events WHERE id = ?`)
        .bind(updateAuditId)
        .first<{ id: string }>(),
    ).toBeNull();
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(safeTokenId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toEqual({
      scopes: '["annotations:read","work:claim"]',
      capabilities_v2: '["comments:read","suggestions:read","work:claim"]',
      capability_mode: "legacy",
    });
    expect(
      await db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM audit_events
            WHERE target_id = ?
              AND correlation_id LIKE 'phase11-3b-capability-guard:%'`,
        )
        .bind(safeTokenId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    db.close();
  });

  it("normalizes historical redacted mint replays without touching unrelated bodies", async () => {
    const { db, migrationsDir } = await preBackfillDatabase();
    await seedIdentity(db);

    const unsafeTokenId = tokenId(6100);
    const originalScopes = [
      "chapters:read",
      "tokens:manage",
      "annotations:read",
      "members:manage",
    ];
    await oldWorkerInsert(db, unsafeTokenId, originalScopes).run();

    const normalizedId = tokenId(6101);
    const unrelatedId = tokenId(6102);
    const invalidId = tokenId(6103);
    const plaintextId = tokenId(6104);
    const historicalBody = {
      id: unsafeTokenId,
      projectId: PROJECT_ID,
      actorId: ACTOR_ID,
      createdBy: ACTOR_ID,
      name: "historical-agent",
      scopes: originalScopes,
      capabilityMode: "legacy",
      grantedCapabilities: expectedCapabilities(originalScopes),
      sentinel: { preserved: true },
      tokenRedacted: true,
    };
    const unrelatedBody = {
      ...historicalBody,
      projectId: "01900000-0000-7000-8000-00000000ffff",
    };
    const plaintextBody = {
      ...historicalBody,
      token: "must-never-be-rewritten-or-logged",
    };
    await db.batch([
      db
        .prepare(
          `INSERT INTO idempotency_keys
             (id, project_id, actor_id, key, request_hash, response_status,
              response_body, created_at)
           VALUES (?, ?, ?, ?, 'hash', 201, ?, ?)`,
        )
        .bind(
          normalizedId,
          PROJECT_ID,
          ACTOR_ID,
          "historical-mint",
          JSON.stringify(historicalBody),
          CREATED_AT,
        ),
      db
        .prepare(
          `INSERT INTO idempotency_keys
             (id, project_id, actor_id, key, request_hash, response_status,
              response_body, created_at)
           VALUES (?, ?, ?, ?, 'hash', 201, ?, ?)`,
        )
        .bind(
          unrelatedId,
          PROJECT_ID,
          ACTOR_ID,
          "unrelated-response",
          JSON.stringify(unrelatedBody),
          CREATED_AT,
        ),
      db
        .prepare(
          `INSERT INTO idempotency_keys
             (id, project_id, actor_id, key, request_hash, response_status,
              response_body, created_at)
           VALUES (?, ?, ?, ?, 'hash', 201, ?, ?)`,
        )
        .bind(invalidId, PROJECT_ID, ACTOR_ID, "invalid-response", "{not-json", CREATED_AT),
      db
        .prepare(
          `INSERT INTO idempotency_keys
             (id, project_id, actor_id, key, request_hash, response_status,
              response_body, created_at)
           VALUES (?, ?, ?, ?, 'hash', 201, ?, ?)`,
        )
        .bind(
          plaintextId,
          PROJECT_ID,
          ACTOR_ID,
          "plaintext-response",
          JSON.stringify(plaintextBody),
          CREATED_AT,
        ),
    ]);

    await applyBackfill(db, migrationsDir);

    const replayRows = await db
      .prepare(
        `SELECT id, response_body FROM idempotency_keys
          WHERE id IN (?, ?, ?, ?) ORDER BY id`,
      )
      .bind(normalizedId, unrelatedId, invalidId, plaintextId)
      .all<{ id: string; response_body: string }>();
    const replayById = new Map(replayRows.map((row) => [row.id, row.response_body]));
    expect(JSON.parse(replayById.get(normalizedId) ?? "null")).toEqual({
      ...historicalBody,
      scopes: ["chapters:read", "annotations:read"],
    });
    expect(replayById.get(unrelatedId)).toBe(JSON.stringify(unrelatedBody));
    expect(replayById.get(invalidId)).toBe("{not-json");
    expect(replayById.get(plaintextId)).toBe(JSON.stringify(plaintextBody));

    const afterFirstRun = new Map(replayById);
    await db.exec(await readFile(join(MIGRATIONS_DIR, BACKFILL_MIGRATION), "utf8"));
    const afterRerun = await db
      .prepare(
        `SELECT id, response_body FROM idempotency_keys
          WHERE id IN (?, ?, ?, ?) ORDER BY id`,
      )
      .bind(normalizedId, unrelatedId, invalidId, plaintextId)
      .all<{ id: string; response_body: string }>();
    expect(new Map(afterRerun.map((row) => [row.id, row.response_body]))).toEqual(
      afterFirstRun,
    );

    db.close();
  });

  it("aligns SQL audit UUID timestamps with created_at and preserves time order", async () => {
    const { db, migrationsDir } = await preBackfillDatabase();
    await seedIdentity(db);
    await applyBackfill(db, migrationsDir);
    await db.exec("PRAGMA recursive_triggers = ON");

    let generated: TimestampedAudit | null = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const id = tokenId(6200 + attempt);
      await v0134WorkerInsert(db, id, ["chapters:read"]).run();
      const audit = await db
        .prepare(
          `SELECT id, actor_id, action, target_type, target_id, correlation_id,
                  metadata, created_at
             FROM audit_events
            WHERE target_id = ?
              AND action = 'agent_token.legacy_capabilities.projected'`,
        )
        .bind(id)
        .first<TimestampedAudit>();
      if (audit !== null && Date.parse(audit.created_at) % 1000 > 1) {
        generated = audit;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(generated).not.toBeNull();
    if (generated === null) {
      throw new Error("could not observe a non-boundary SQL audit timestamp");
    }
    const generatedMillis = Date.parse(generated.created_at);
    expect(uuidV7TimestampMillis(generated.id)).toBe(generatedMillis);
    expect(generated.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const earlierMillis = generatedMillis - 1;
    const earlierId = uuidV7At(earlierMillis, "00000000f001");
    await db
      .prepare(
        `INSERT INTO audit_events
           (id, project_id, actor_id, action, target_type, target_id,
            correlation_id, metadata, created_at)
         VALUES (?, ?, NULL, 'test.earlier', 'agent_token', ?,
                 'uuid-order-regression', '{}', ?)`,
      )
      .bind(
        earlierId,
        PROJECT_ID,
        generated.target_id,
        new Date(earlierMillis).toISOString(),
      )
      .run();
    const orderedIds = await db
      .prepare(`SELECT id FROM audit_events WHERE id IN (?, ?) ORDER BY id`)
      .bind(earlierId, generated.id)
      .all<{ id: string }>();
    expect(orderedIds.map((row) => row.id)).toEqual([earlierId, generated.id]);

    db.close();
  });

  it("projects every safe old-writer combination and rejects every unsafe one", async () => {
    const { db, migrationsDir } = await preBackfillDatabase();
    await seedIdentity(db);
    await applyBackfill(db, migrationsDir);
    await db.exec("PRAGMA recursive_triggers = ON");

    const combinations = 1 << LEGACY_AGENT_SCOPES.length;
    const safeInsertions = [];
    for (let mask = 0; mask < combinations; mask += 1) {
      const scopes = LEGACY_AGENT_SCOPES.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const insertion = oldWorkerInsert(db, tokenId(4000 + mask), scopes);
      if (scopes.some((scope) => !LEGACY_SAFE.has(scope))) {
        await expect(insertion.run(), `unsafe mask ${mask}`).rejects.toThrow(
          /scopes require sanitation/,
        );
      } else {
        safeInsertions.push(insertion);
      }
    }
    await db.batch(safeInsertions);

    const stored = await db
      .prepare(
        `SELECT id, scopes, capabilities_v2, capability_mode, expires_at, revoked_at
           FROM agent_tokens ORDER BY id`,
      )
      .all<StoredToken>();
    const byId = new Map(stored.map((row) => [row.id, row]));
    for (let mask = 0; mask < combinations; mask += 1) {
      const original = LEGACY_AGENT_SCOPES.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      const row = byId.get(tokenId(4000 + mask));
      if (original.some((scope) => !LEGACY_SAFE.has(scope))) {
        expect(row, `unsafe combination survived mask ${mask}`).toBeUndefined();
        continue;
      }
      expect(row, `missing guarded combination mask ${mask}`).toBeDefined();
      expect(JSON.parse(row?.scopes ?? "null"), `scopes mask ${mask}`).toEqual(original);
      expect(
        JSON.parse(row?.capabilities_v2 ?? "null"),
        `capabilities mask ${mask}`,
      ).toEqual(expectedCapabilities(original));
      expect(row?.capability_mode).toBe("legacy");
    }
    db.close();
  });

  it("guards expanded writes without mutating exact dual-write rows", async () => {
    const { db, migrationsDir } = await preBackfillDatabase();
    await seedIdentity(db);
    await applyBackfill(db, migrationsDir);
    await db.exec("PRAGMA recursive_triggers = ON");

    // An exact v0.1.35 legacy dual write must be a true trigger no-op. The
    // connection change counter observes the outer INSERT plus any trigger
    // UPDATE/audit side effects, so a delta of one proves the INSERT mismatch
    // guard did not rewrite the row.
    const exactDualWriteId = tokenId(5000);
    const beforeExactInsert = await totalChanges(db);
    await v0135WorkerInsert(
      db,
      exactDualWriteId,
      ["annotations:read", "work:claim"],
    ).run();
    expect((await totalChanges(db)) - beforeExactInsert).toBe(1);
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(exactDualWriteId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toEqual({
      scopes: '["annotations:read","work:claim"]',
      capabilities_v2: '["comments:read","suggestions:read","work:claim"]',
      capability_mode: "legacy",
    });

    // A capabilities-only rollback/manual write is stale while legacy scopes
    // remain authoritative. Correct it exactly once, then leave an already
    // exact UPDATE alone even with recursive triggers enabled.
    await db
      .prepare(`UPDATE agent_tokens SET capabilities_v2 = ? WHERE id = ?`)
      .bind('["chapters:publish"]', exactDualWriteId)
      .run();
    expect(
      await db
        .prepare(`SELECT capabilities_v2 FROM agent_tokens WHERE id = ?`)
        .bind(exactDualWriteId)
        .first<{ capabilities_v2: string }>(),
    ).toEqual({
      capabilities_v2: '["comments:read","suggestions:read","work:claim"]',
    });
    const projectionAuditsAfterCorrection = await db
      .prepare(
        `SELECT action, metadata
           FROM audit_events
          WHERE target_id = ?
            AND action = 'agent_token.legacy_capabilities.projected'
            AND correlation_id LIKE 'phase11-3b-capability-guard:%'`,
      )
      .bind(exactDualWriteId)
      .all<Pick<StoredAudit, "action" | "metadata">>();
    expect(projectionAuditsAfterCorrection).toHaveLength(1);
    expect(JSON.parse(projectionAuditsAfterCorrection[0]?.metadata ?? "null")).toMatchObject({
      reason: "stale-projection",
      capabilities: ["comments:read", "suggestions:read", "work:claim"],
    });

    await db
      .prepare(`UPDATE agent_tokens SET capabilities_v2 = capabilities_v2 WHERE id = ?`)
      .bind(exactDualWriteId)
      .run();
    expect(
      await db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM audit_events
            WHERE target_id = ?
              AND action = 'agent_token.legacy_capabilities.projected'
              AND correlation_id LIKE 'phase11-3b-capability-guard:%'`,
        )
        .bind(exactDualWriteId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });

    // v0.1.35 can still carry deprecated control-plane scope names while
    // supplying the exact translated capability projection. The database
    // cannot rewrite the response that old Worker already constructed, so the
    // entire statement fails instead of persisting a contradictory row.
    const unsafeDualWriteId = tokenId(5001);
    await expect(
      v0135WorkerInsert(
        db,
        unsafeDualWriteId,
        ["tokens:manage", "annotations:read"],
      ).run(),
    ).rejects.toThrow(/scopes require sanitation/);
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(unsafeDualWriteId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toBeNull();
    const unsafeAudits = await db
      .prepare(
        `SELECT action, metadata
           FROM audit_events
          WHERE target_id = ?
            AND correlation_id LIKE 'phase11-3b-capability-guard:%'
          ORDER BY action`,
      )
      .bind(unsafeDualWriteId)
      .all<Pick<StoredAudit, "action" | "metadata">>();
    expect(unsafeAudits).toEqual([]);

    // Authority-equivalent ordering and duplicates remain byte-for-byte
    // truthful to the old response. Only the derived projection is repaired.
    const canonicalizedLegacyId = tokenId(5004);
    await oldWorkerInsert(db, canonicalizedLegacyId, [
      "work:claim",
      "annotations:read",
      "work:claim",
    ]).run();
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(canonicalizedLegacyId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toEqual({
      scopes: '["work:claim","annotations:read","work:claim"]',
      capabilities_v2: '["comments:read","suggestions:read","work:claim"]',
      capability_mode: "legacy",
    });

    // A malformed post-migration v0.1.34-shaped insert fails closed before any
    // row or audit survives.
    const malformedId = tokenId(5002);
    await expect(
      v0134WorkerInsert(db, malformedId, "{not-json").run(),
    ).rejects.toThrow(/scopes require sanitation/);
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(malformedId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toBeNull();
    const malformedAudits = await db
      .prepare(
        `SELECT action, metadata
           FROM audit_events
          WHERE target_id = ?
            AND correlation_id LIKE 'phase11-3b-capability-guard:%'
          ORDER BY action`,
      )
      .bind(malformedId)
      .all<Pick<StoredAudit, "action" | "metadata">>();
    expect(malformedAudits).toEqual([]);

    // The guard owns legacy compatibility only. A maintainer's canonical
    // conversion, and later canonical capability edits, must pass through
    // without being projected back from the legacy shadow.
    const convertedId = tokenId(5003);
    await v0135WorkerInsert(db, convertedId, ["chapters:read"]).run();
    await db
      .prepare(
        `UPDATE agent_tokens
            SET scopes = ?,
                capabilities_v2 = ?,
                capability_mode = 'canonical'
          WHERE id = ?`,
      )
      .bind('["chapters:read"]', '["history:read"]', convertedId)
      .run();
    await db
      .prepare(`UPDATE agent_tokens SET capabilities_v2 = ? WHERE id = ?`)
      .bind('["revisions:read","revisions:write"]', convertedId)
      .run();
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(convertedId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toEqual({
      scopes: '["chapters:read"]',
      capabilities_v2: '["revisions:read","revisions:write"]',
      capability_mode: "canonical",
    });
    expect(
      await db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM audit_events
            WHERE target_id = ?
              AND correlation_id LIKE 'phase11-3b-capability-guard:%'`,
        )
        .bind(convertedId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    db.close();
  });
});
