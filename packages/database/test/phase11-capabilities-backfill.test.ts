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

const tokenId = (ordinal: number): string =>
  `01900000-0000-7000-8000-${ordinal.toString(16).padStart(12, "0")}`;

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
  options: { expiresAt?: string; revokedAt?: string | null } = {},
) {
  const encoded = typeof scopes === "string" ? scopes : JSON.stringify(scopes);
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
      ACTOR_ID,
      `hash-${id}`,
      encoded,
      ACTOR_ID,
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
      ACTOR_ID,
      `hash-${id}`,
      encodedScopes,
      encodedCapabilities,
      capabilityMode,
      ACTOR_ID,
      CREATED_AT,
      ACTIVE_EXPIRY,
    );
}

function v0134WorkerInsert(
  db: SqliteAdapter,
  id: string,
  scopes: string | readonly string[],
) {
  // v0.1.34 already used the expanded repository shape: it named both new
  // columns explicitly, writing NULL plus legacy rather than relying on their
  // database defaults.
  return expandedWorkerInsert(db, id, scopes, null, "legacy");
}

function v0135WorkerInsert(
  db: SqliteAdapter,
  id: string,
  scopes: readonly string[],
) {
  return expandedWorkerInsert(db, id, scopes, expectedCapabilities(scopes), "legacy");
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
        `SELECT actor_id, action, target_type, target_id, correlation_id, metadata
           FROM audit_events
          WHERE action = 'agent_token.legacy_scopes.sanitized'
          ORDER BY target_id`,
      )
      .all<StoredAudit>();
    const auditsByTarget = new Map(audits.map((row) => [row.target_id, row]));

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
    await oldWorkerInsert(db, unsafeId, [
      "tokens:manage",
      "annotations:read",
      "future:admin",
    ]).run();
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(unsafeId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toEqual({
      scopes: '["annotations:read"]',
      capabilities_v2: '["comments:read","suggestions:read"]',
      capability_mode: "legacy",
    });

    // An old writer changing scopes after migration is normalized too. The
    // trigger overwrites the prior projection instead of leaving it stale.
    await db
      .prepare(`UPDATE agent_tokens SET scopes = ? WHERE id = ?`)
      .bind('["submissions:write","members:manage"]', duringExpandId)
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

    const guardedAudits = await db
      .prepare(
        `SELECT actor_id, action, target_type, target_id, correlation_id, metadata
           FROM audit_events
          WHERE action = 'agent_token.legacy_scopes.sanitized'
            AND correlation_id LIKE 'phase11-3b-capability-guard:%'
          ORDER BY target_id`,
      )
      .all<StoredAudit>();
    expect(guardedAudits.map((audit) => audit.target_id)).toEqual([
      duringExpandId,
      unsafeId,
    ]);
    expect(JSON.parse(guardedAudits[0]?.metadata ?? "null")).toMatchObject({
      migration: BACKFILL_MIGRATION,
      reason: "control-plane-or-unknown-scope",
      removedScopes: ["members:manage"],
      retainedScopes: ["submissions:write"],
    });
    expect(JSON.parse(guardedAudits[1]?.metadata ?? "null")).toMatchObject({
      migration: BACKFILL_MIGRATION,
      reason: "control-plane-or-unknown-scope",
      removedScopes: ["tokens:manage", "future:admin"],
      retainedScopes: ["annotations:read"],
    });

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
      unsafeId,
    ]);
    expect(JSON.parse(projectionAudits[0]?.metadata ?? "null")).toMatchObject({
      migration: BACKFILL_MIGRATION,
      reason: "stale-projection",
      capabilities: ["work:submit", "chapters:write", "chapters:publish"],
    });
    for (const audit of projectionAudits.slice(1)) {
      expect(JSON.parse(audit.metadata)).toMatchObject({
        migration: BACKFILL_MIGRATION,
        reason: "missing-projection",
      });
    }

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

  it("normalizes every old-writer scope combination after backfill", async () => {
    const { db, migrationsDir } = await preBackfillDatabase();
    await seedIdentity(db);
    await applyBackfill(db, migrationsDir);
    await db.exec("PRAGMA recursive_triggers = ON");

    const combinations = 1 << LEGACY_AGENT_SCOPES.length;
    const insertions = [];
    for (let mask = 0; mask < combinations; mask += 1) {
      const scopes = LEGACY_AGENT_SCOPES.filter(
        (_, index) => (mask & (1 << index)) !== 0,
      );
      insertions.push(oldWorkerInsert(db, tokenId(4000 + mask), scopes));
    }
    await db.batch(insertions);

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
      expect(row, `missing guarded combination mask ${mask}`).toBeDefined();
      expect(JSON.parse(row?.scopes ?? "null"), `scopes mask ${mask}`).toEqual(
        original.filter((scope) => LEGACY_SAFE.has(scope)),
      );
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
    // supplying the exact translated capability projection. Scopes alone must
    // trip the mismatch guard, and sanitation must not invent a projection
    // audit when the supplied projection was already correct.
    const unsafeDualWriteId = tokenId(5001);
    await v0135WorkerInsert(
      db,
      unsafeDualWriteId,
      ["tokens:manage", "annotations:read"],
    ).run();
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(unsafeDualWriteId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toEqual({
      scopes: '["annotations:read"]',
      capabilities_v2: '["comments:read","suggestions:read"]',
      capability_mode: "legacy",
    });
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
    expect(unsafeAudits.map((audit) => audit.action)).toEqual([
      "agent_token.legacy_scopes.sanitized",
    ]);
    expect(JSON.parse(unsafeAudits[0]?.metadata ?? "null")).toMatchObject({
      reason: "control-plane-or-unknown-scope",
      removedScopes: ["tokens:manage"],
      retainedScopes: ["annotations:read"],
    });

    // SQL sanitation must match parseLegacyScopes exactly, including stable
    // canonical ordering and de-duplication of safe legacy names.
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
      scopes: '["annotations:read","work:claim"]',
      capabilities_v2: '["comments:read","suggestions:read","work:claim"]',
      capability_mode: "legacy",
    });

    // A malformed post-migration v0.1.34-shaped insert fails closed, receives
    // one sanitation audit, and receives one missing-projection audit.
    const malformedId = tokenId(5002);
    await v0134WorkerInsert(db, malformedId, "{not-json").run();
    expect(
      await db
        .prepare(
          `SELECT scopes, capabilities_v2, capability_mode
             FROM agent_tokens WHERE id = ?`,
        )
        .bind(malformedId)
        .first<Pick<StoredToken, "scopes" | "capabilities_v2" | "capability_mode">>(),
    ).toEqual({
      scopes: "[]",
      capabilities_v2: "[]",
      capability_mode: "legacy",
    });
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
    expect(malformedAudits.map((audit) => audit.action)).toEqual([
      "agent_token.legacy_capabilities.projected",
      "agent_token.legacy_scopes.sanitized",
    ]);
    expect(JSON.parse(malformedAudits[0]?.metadata ?? "null")).toMatchObject({
      reason: "missing-projection",
      capabilities: [],
    });
    expect(JSON.parse(malformedAudits[1]?.metadata ?? "null")).toMatchObject({
      reason: "invalid-legacy-scope-set",
      removedScopes: [],
      retainedScopes: [],
    });

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
