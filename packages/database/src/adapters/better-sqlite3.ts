/**
 * better-sqlite3 adapter (Node: tests and local dev). `batch` executes inside
 * a better-sqlite3 transaction so a mid-batch failure rolls everything back.
 */
import BetterSqlite3 from "better-sqlite3";
import type {
  SqlDatabase,
  SqlRow,
  SqlRunResult,
  SqlScriptDatabase,
  SqlStatement,
  SqlValue,
} from "../sql.js";

const STATEMENT_BRAND = Symbol("authorbot.sqlite-statement");

class SqliteStatement implements SqlStatement {
  readonly [STATEMENT_BRAND] = true;

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly sql: string,
    private readonly values: readonly SqlValue[],
  ) {}

  bind(...values: SqlValue[]): SqlStatement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  private prepared(): BetterSqlite3.Statement {
    return this.db.prepare(this.sql);
  }

  async first<T extends SqlRow = SqlRow>(): Promise<T | null> {
    const row = this.prepared().get(...this.values) as T | undefined;
    return row ?? null;
  }

  async all<T extends SqlRow = SqlRow>(): Promise<T[]> {
    return this.prepared().all(...this.values) as T[];
  }

  async run(): Promise<SqlRunResult> {
    return this.runSync();
  }

  /** Synchronous execution used by `batch` inside a transaction. */
  runSync(): SqlRunResult {
    const stmt = this.prepared();
    if (stmt.reader) {
      // Statements that return rows (e.g. SELECT) cannot go through .run()
      // in better-sqlite3; execute and report zero changes, matching D1's
      // behavior of allowing reads in a batch.
      stmt.all(...this.values);
      return { changes: 0, lastRowId: null };
    }
    const info = stmt.run(...this.values);
    return {
      changes: info.changes,
      lastRowId: typeof info.lastInsertRowid === "bigint"
        ? Number(info.lastInsertRowid)
        : info.lastInsertRowid,
    };
  }
}

export class SqliteAdapter implements SqlScriptDatabase {
  constructor(private readonly db: BetterSqlite3.Database) {
    this.db.pragma("foreign_keys = ON");
  }

  prepare(sql: string): SqlStatement {
    return new SqliteStatement(this.db, sql, []);
  }

  async batch(statements: SqlStatement[]): Promise<SqlRunResult[]> {
    const own = statements.map((s) => {
      if (!(s instanceof SqliteStatement)) {
        throw new TypeError(
          "SqliteAdapter.batch received a statement prepared by a different adapter",
        );
      }
      return s;
    });
    const tx = this.db.transaction(() => own.map((s) => s.runSync()));
    return tx();
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

/** Open a better-sqlite3 database at `path` (`:memory:` for in-memory). */
export function openSqliteDatabase(path: string): SqliteAdapter {
  return new SqliteAdapter(new BetterSqlite3(path));
}
