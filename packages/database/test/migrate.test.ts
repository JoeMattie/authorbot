import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteDatabase } from "../src/adapters/better-sqlite3.js";
import { applyMigrations, listMigrationFiles, MIGRATIONS_TABLE } from "../src/migrate.js";
import { MIGRATIONS_DIR } from "./helpers.js";

const EXPECTED_TABLES = [
  "projects",
  "actors",
  "project_memberships",
  "human_sessions",
  "agent_tokens",
  "chapters",
  "annotations",
  "replies",
  "git_operations",
  "outbox",
  "idempotency_keys",
  "webhook_deliveries",
  "audit_events",
  "leases",
  "submissions",
  "revision_proposals",
];

describe("migration runner", () => {
  it("finds the numbered migration files at the repo root", async () => {
    const files = await listMigrationFiles(MIGRATIONS_DIR);
    expect(files).toContain("0001_phase2.sql");
    expect(files).toContain("0011_phase11_revision_proposals.sql");
    expect(files).toEqual([...files].sort());
  });

  it("applies pending migrations and creates every contract §2 table", async () => {
    const db = openSqliteDatabase(":memory:");
    const result = await applyMigrations(db, MIGRATIONS_DIR);
    expect(result.applied).toContain("0001_phase2.sql");
    expect(result.skipped).toEqual([]);

    const rows = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all<{ name: string }>();
    const tables = rows.map((r) => r.name);
    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
    db.close();
  });

  it("is idempotent: a second run applies nothing", async () => {
    const db = openSqliteDatabase(":memory:");
    const first = await applyMigrations(db, MIGRATIONS_DIR);
    const second = await applyMigrations(db, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(first.applied);
    db.close();
  });

  it("tracks applied migrations in a wrangler-compatible d1_migrations table", async () => {
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, MIGRATIONS_DIR);
    const rows = await db
      .prepare(`SELECT name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY id`)
      .all<{ name: string; applied_at: string }>();
    expect(rows.map((r) => r.name)).toContain("0001_phase2.sql");
    expect(rows.every((r) => typeof r.applied_at === "string")).toBe(true);
    db.close();
  });

  it("indexes every chapter-activity aggregate access path", async () => {
    const db = openSqliteDatabase(":memory:");
    const result = await applyMigrations(db, MIGRATIONS_DIR);
    expect(result.applied).toContain("0009_chapter_activity.sql");

    const indexColumns = async (name: string): Promise<string[]> => {
      const rows = await db
        .prepare(`PRAGMA index_info('${name}')`)
        .all<{ name: string }>();
      return rows.map((row) => row.name);
    };
    expect(await indexColumns("idx_chapters_project_id")).toEqual([
      "project_id",
      "id",
    ]);
    expect(await indexColumns("idx_annotations_project_chapter_activity")).toEqual([
      "project_id",
      "chapter_id",
      "status",
      "kind",
      "scope",
    ]);
    expect(await indexColumns("idx_replies_annotation_status")).toEqual([
      "annotation_id",
      "status",
      "project_id",
    ]);
    expect(await indexColumns("idx_work_items_project_chapter_status")).toEqual([
      "project_id",
      "chapter_id",
      "status",
    ]);
    db.close();
  });

  it("expands agent-token capabilities without changing legacy rows or old-worker inserts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "authorbot-capabilities-expand-"));
    const files = await listMigrationFiles(MIGRATIONS_DIR);
    for (const name of files.filter((name) => name < "0010_")) {
      await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    }

    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, dir);
    const projectId = "01900000-0000-7000-8000-000000000001";
    const actorId = "01900000-0000-7000-8000-000000000002";
    await db
      .prepare(
        `INSERT INTO projects
           (id, slug, repo, default_branch, status, created_at, updated_at)
         VALUES (?, 'book', 'owner/book', 'main', 'active', ?, ?)`,
      )
      .bind(projectId, "2026-07-22T00:00:00Z", "2026-07-22T00:00:00Z")
      .run();
    await db
      .prepare(
        `INSERT INTO actors
           (id, type, display_name, external_identity, owner_actor_id, status, created_at)
         VALUES (?, 'agent', 'legacy-agent', 'agent:legacy-agent', NULL, 'active', ?)`,
      )
      .bind(actorId, "2026-07-22T00:00:00Z")
      .run();

    const insertLikePriorWorker = (id: string, hash: string) =>
      db
        .prepare(
          `INSERT INTO agent_tokens
             (id, project_id, actor_id, name, token_hash, scopes, created_by,
              created_at, expires_at, revoked_at, last_used_at)
           VALUES (?, ?, ?, 'legacy-agent', ?, '["chapters:read"]', ?, ?, ?, NULL, NULL)`,
        )
        .bind(
          id,
          projectId,
          actorId,
          hash,
          actorId,
          "2026-07-22T00:00:00Z",
          "2026-08-22T00:00:00Z",
        )
        .run();

    const beforeId = "01900000-0000-7000-8000-000000000003";
    await insertLikePriorWorker(beforeId, "before-expand");
    await copyFile(
      join(MIGRATIONS_DIR, "0010_phase11_capabilities_expand.sql"),
      join(dir, "0010_phase11_capabilities_expand.sql"),
    );
    const expanded = await applyMigrations(db, dir);
    expect(expanded.applied).toEqual(["0010_phase11_capabilities_expand.sql"]);

    const afterId = "01900000-0000-7000-8000-000000000004";
    await insertLikePriorWorker(afterId, "after-expand");
    const rows = await db
      .prepare(
        `SELECT id, capabilities_v2, capability_mode
           FROM agent_tokens ORDER BY id`,
      )
      .all<{ id: string; capabilities_v2: string | null; capability_mode: string }>();
    expect(rows).toEqual([
      { id: beforeId, capabilities_v2: null, capability_mode: "legacy" },
      { id: afterId, capabilities_v2: null, capability_mode: "legacy" },
    ]);

    await expect(
      db
        .prepare(`UPDATE agent_tokens SET capability_mode = 'unknown' WHERE id = ?`)
        .bind(beforeId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(`UPDATE agent_tokens SET capability_mode = 'canonical' WHERE id = ?`)
        .bind(beforeId)
        .run(),
    ).rejects.toThrow();
    db.close();
  });

  it("installs the revision-proposal queue indexes and immutability trigger", async () => {
    const db = openSqliteDatabase(":memory:");
    const result = await applyMigrations(db, MIGRATIONS_DIR);
    expect(result.applied).toContain("0011_phase11_revision_proposals.sql");

    const indexes = await db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'revision_proposals'
          ORDER BY name`,
      )
      .all<{ name: string }>();
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "idx_revision_proposals_chapter",
        "idx_revision_proposals_project_status",
        "idx_revision_proposals_submission",
        "idx_revision_proposals_work_item",
      ]),
    );

    const trigger = await db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'trigger' AND name = 'revision_proposals_immutable_payload'`,
      )
      .first<{ name: string }>();
    expect(trigger?.name).toBe("revision_proposals_immutable_payload");
    db.close();
  });

  it("backfills chapter order at ten-point spacing for an existing book", async () => {
    const dir = await mkdtemp(join(tmpdir(), "authorbot-order-migration-"));
    const files = await listMigrationFiles(MIGRATIONS_DIR);
    for (const name of files.filter((name) => name < "0008_")) {
      await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
    }
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, dir);
    await db
      .prepare(
        `INSERT INTO projects
           (id, slug, repo, default_branch, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "project",
        "book",
        "owner/book",
        "main",
        "active",
        "2026-07-21T00:00:00Z",
        "2026-07-21T00:00:00Z",
      )
      .run();
    const insert = (id: string, path: string, slug: string) =>
      db
        .prepare(
          `INSERT INTO chapters
             (id, project_id, path, slug, title, status, revision, content_hash,
              head_commit, last_published_commit, block_ids, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', ?)`,
        )
        .bind(
          id,
          "project",
          path,
          slug,
          slug,
          "published",
          1,
          `sha256:${id}`,
          "2026-07-21T00:00:00Z",
        )
        .run();
    await insert("b", "chapters/002-second.md", "second");
    await insert("a", "chapters/001-first.md", "first");

    await copyFile(
      join(MIGRATIONS_DIR, "0008_chapter_order.sql"),
      join(dir, "0008_chapter_order.sql"),
    );
    await applyMigrations(db, dir);
    const rows = await db
      .prepare(`SELECT path, chapter_order FROM chapters ORDER BY path`)
      .all<{ path: string; chapter_order: number }>();
    expect(rows).toEqual([
      { path: "chapters/001-first.md", chapter_order: 10 },
      { path: "chapters/002-second.md", chapter_order: 20 },
    ]);
    db.close();
  });

  it("rolls back a failing migration and does not record it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "authorbot-migrations-"));
    await writeFile(
      join(dir, "0001_bad.sql"),
      "CREATE TABLE half_done (id TEXT PRIMARY KEY);\nTHIS IS NOT SQL;\n",
    );
    const db = openSqliteDatabase(":memory:");
    await expect(applyMigrations(db, dir)).rejects.toThrow(/0001_bad\.sql/);

    const tables = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_done'`)
      .all();
    expect(tables).toEqual([]);
    const recorded = await db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all();
    expect(recorded).toEqual([]);
    db.close();
  });
});
