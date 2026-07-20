/**
 * Node migration runner (Phase 2 contract §2): applies pending numbered .sql
 * files from a migrations directory and tracks them in a `d1_migrations`
 * table using the same shape wrangler uses, so a database migrated locally
 * and one migrated with `wrangler d1 migrations apply` agree on state.
 *
 * Used by tests and local dev; production D1 applies the same files via
 * wrangler.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlScriptDatabase } from "./sql.js";

export const MIGRATIONS_TABLE = "d1_migrations";

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export interface MigrationResult {
  /** File names applied by this invocation, in order. */
  applied: string[];
  /** File names that were already recorded and skipped. */
  skipped: string[];
}

/** Numbered migration file names (`NNNN_name.sql`), sorted ascending. */
export async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

/**
 * Apply every pending migration in `migrationsDir`, in file-name order.
 * Idempotent: already-recorded migrations are skipped. Each migration script
 * runs inside a transaction so a failing script leaves no partial schema.
 */
export async function applyMigrations(
  db: SqlScriptDatabase,
  migrationsDir: string,
): Promise<MigrationResult> {
  await db.exec(CREATE_MIGRATIONS_TABLE);

  const files = await listMigrationFiles(migrationsDir);
  const appliedRows = await db
    .prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`)
    .all<{ name: string }>();
  const alreadyApplied = new Set(appliedRows.map((row) => row.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of files) {
    if (alreadyApplied.has(name)) {
      skipped.push(name);
      continue;
    }
    const sql = await readFile(join(migrationsDir, name), "utf8");
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      await db
        .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`)
        .bind(name)
        .run();
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    applied.push(name);
  }

  return { applied, skipped };
}
