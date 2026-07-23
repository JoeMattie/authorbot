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
    // recorded file. A direct rerun neither mutates rows nor duplicates audit.
    const beforeRerun = { stored, audits };
    await db.exec(await readFile(join(MIGRATIONS_DIR, BACKFILL_MIGRATION), "utf8"));
    const afterRerun = {
      stored: await db
        .prepare(
          `SELECT id, scopes, capabilities_v2, capability_mode, expires_at, revoked_at
             FROM agent_tokens ORDER BY id`,
        )
        .all<StoredToken>(),
      audits: await db
        .prepare(
          `SELECT actor_id, action, target_type, target_id, correlation_id, metadata
             FROM audit_events
            WHERE action = 'agent_token.legacy_scopes.sanitized'
            ORDER BY target_id`,
        )
        .all<StoredAudit>(),
    };
    expect(afterRerun).toEqual(beforeRerun);
    db.close();
  });

  it("requires the deployed 3A dual-reader before its one-shot application", async () => {
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
    await oldWorkerInsert(db, duringExpandId, ["annotations:read", "work:claim"]).run();
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
      // An old reader still sees the exact ordinary scopes. The deployed 3A
      // dual-reader still treats mode=legacy as authoritative and derives the
      // same canonical projection before and after the backfill.
      expect(JSON.parse(row.scopes)).toEqual(["annotations:read", "work:claim"]);
      expect(JSON.parse(row.capabilities_v2 ?? "null")).toEqual(
        expectedCapabilities(JSON.parse(row.scopes) as string[]),
      );
      expect(row.capability_mode).toBe("legacy");
    }

    // This old-worker-shaped write deliberately names no new columns. SQLite
    // therefore applies the expand defaults and leaves a NULL projection. It
    // proves why 0013 cannot run while the pre-3A writer is still deployed: a
    // one-shot migration cannot backfill a row written after it completes.
    const afterBackfillOldWriterId = tokenId(3002);
    await oldWorkerInsert(db, afterBackfillOldWriterId, ["chapters:read"]).run();
    expect(
      await db
        .prepare(
          `SELECT capabilities_v2, capability_mode FROM agent_tokens WHERE id = ?`,
        )
        .bind(afterBackfillOldWriterId)
        .first<{ capabilities_v2: string | null; capability_mode: string }>(),
    ).toEqual({ capabilities_v2: null, capability_mode: "legacy" });
    db.close();
  });
});
