/**
 * Adapter parity smoke test (contract §2): the same SQL statements executed
 * through the D1 wrapper (over a stub D1-shaped database backed by
 * better-sqlite3) and through the native better-sqlite3 adapter produce the
 * same results, including batch atomicity.
 */
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  wrapD1Database,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1ResultLike,
} from "../src/adapters/d1.js";
import { openSqliteDatabase, SqliteAdapter } from "../src/adapters/better-sqlite3.js";
import { applyMigrations } from "../src/migrate.js";
import type { SqlDatabase } from "../src/sql.js";
import { MIGRATIONS_DIR, NOW, uuidv7 } from "./helpers.js";

/** Minimal D1-shaped stub over better-sqlite3, used only for parity testing. */
function stubD1(sqlite: BetterSqlite3.Database): D1DatabaseLike {
  sqlite.pragma("foreign_keys = ON");

  function statement(sql: string, values: unknown[]): D1PreparedStatementLike & {
    execute(): D1ResultLike;
  } {
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      first: async <T>() => ((sqlite.prepare(sql).get(...(values as never[])) as T) ?? null),
      all: async <T>() => ({
        results: sqlite.prepare(sql).all(...(values as never[])) as T[],
        success: true,
        meta: {},
      }),
      run: async <T>(): Promise<D1ResultLike<T>> => statement(sql, values).execute() as D1ResultLike<T>,
      execute(): D1ResultLike {
        const prepared = sqlite.prepare(sql);
        if (prepared.reader) {
          return { results: prepared.all(...(values as never[])), success: true, meta: {} };
        }
        const info = prepared.run(...(values as never[]));
        return {
          results: [],
          success: true,
          meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
        };
      },
    };
  }

  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async <T>(statements: D1PreparedStatementLike[]) => {
      // D1 batches are implicit transactions.
      const tx = sqlite.transaction(() =>
        statements.map((s) => (s as unknown as { execute(): D1ResultLike }).execute()),
      );
      return tx() as D1ResultLike<T>[];
    },
  };
}

async function exercise(db: SqlDatabase): Promise<{
  firstRow: unknown;
  allRows: unknown[];
  runChanges: number;
  batchChanges: number[];
  countAfterFailedBatch: number;
}> {
  const projectId = uuidv7();
  const insert = db
    .prepare(
      `INSERT INTO projects (id, slug, repo_provider, repo, default_branch, status,
                             created_at, updated_at)
       VALUES (?, ?, 'github', 'o/r', 'main', 'active', ?, ?)`,
    )
    .bind(projectId, "parity", NOW, NOW);
  const runChanges = (await insert.run()).changes;

  const firstRow = await db
    .prepare(`SELECT slug, repo FROM projects WHERE id = ?`)
    .bind(projectId)
    .first();
  const allRows = await db.prepare(`SELECT slug FROM projects ORDER BY slug`).all();

  const actorA = uuidv7();
  const actorB = uuidv7();
  const insertActor = (id: string, identity: string) =>
    db
      .prepare(
        `INSERT INTO actors (id, type, display_name, external_identity, status, created_at)
         VALUES (?, 'agent', 'Bot', ?, 'active', ?)`,
      )
      .bind(id, identity, NOW);
  const batchChanges = (
    await db.batch([insertActor(actorA, `agent:${actorA}`), insertActor(actorB, `agent:${actorB}`)])
  ).map((r) => r.changes);

  // Mid-batch failure must roll back the whole batch on both adapters.
  const actorC = uuidv7();
  let failed = false;
  try {
    await db.batch([
      insertActor(actorC, `agent:${actorC}`),
      insertActor(uuidv7(), `agent:${actorA}`), // duplicate external identity
    ]);
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM actors`)
    .first<{ n: number }>();

  return {
    firstRow,
    allRows,
    runChanges,
    batchChanges,
    countAfterFailedBatch: Number(countRow?.n),
  };
}

describe("adapter parity", () => {
  it("D1-shaped adapter and better-sqlite3 adapter agree on the same statements", async () => {
    const native = openSqliteDatabase(":memory:");
    await applyMigrations(native, MIGRATIONS_DIR);

    // Migrate a raw handle via a SqliteAdapter, then expose the SAME handle
    // through a D1-shaped facade wrapped by the D1 adapter under test.
    const d1Handle = new BetterSqlite3(":memory:");
    await applyMigrations(new SqliteAdapter(d1Handle), MIGRATIONS_DIR);
    const d1Wrapped = wrapD1Database(stubD1(d1Handle));

    const nativeResult = await exercise(native);
    const d1Result = await exercise(d1Wrapped);

    expect(d1Result.firstRow).toEqual(nativeResult.firstRow);
    expect(d1Result.allRows).toEqual(nativeResult.allRows);
    expect(d1Result.runChanges).toBe(nativeResult.runChanges);
    expect(d1Result.batchChanges).toEqual(nativeResult.batchChanges);
    expect(d1Result.countAfterFailedBatch).toBe(nativeResult.countAfterFailedBatch);
    // Both adapters kept exactly the two successfully batched actors.
    expect(nativeResult.countAfterFailedBatch).toBe(2);

    native.close();
    d1Handle.close();
  });
});
