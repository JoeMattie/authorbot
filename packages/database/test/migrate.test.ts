import { mkdtemp, writeFile } from "node:fs/promises";
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
];

describe("migration runner", () => {
  it("finds the numbered migration files at the repo root", async () => {
    const files = await listMigrationFiles(MIGRATIONS_DIR);
    expect(files).toContain("0001_phase2.sql");
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
