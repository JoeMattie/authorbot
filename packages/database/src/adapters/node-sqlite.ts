/**
 * Node's built-in SQLite adapter for local Authorbot runtimes.
 *
 * Kept behind the `@authorbot/database/node` export so the Cloudflare worker
 * graph never sees `node:sqlite`. Unlike the historical better-sqlite3
 * adapter, this requires no install script or native addon.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  SqlRow,
  SqlRunResult,
  SqlScriptDatabase,
  SqlStatement,
  SqlValue,
} from "../sql.js";

const STATEMENT_BRAND = Symbol("authorbot.node-sqlite-statement");

class NodeSqliteStatement implements SqlStatement {
  readonly [STATEMENT_BRAND] = true;

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly values: readonly SqlValue[],
  ) {}

  bind(...values: SqlValue[]): SqlStatement {
    return new NodeSqliteStatement(this.db, this.sql, values);
  }

  private prepared(): StatementSync {
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
    if (/^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/iu.test(this.sql)) {
      this.prepared().all(...this.values);
      return { changes: 0, lastRowId: null };
    }
    const result = this.prepared().run(...this.values);
    return {
      changes: Number(result.changes),
      lastRowId:
        result.lastInsertRowid === undefined || result.lastInsertRowid === null
          ? null
          : Number(result.lastInsertRowid),
    };
  }

  runSync(): SqlRunResult {
    if (/^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/iu.test(this.sql)) {
      this.prepared().all(...this.values);
      return { changes: 0, lastRowId: null };
    }
    const result = this.prepared().run(...this.values);
    return {
      changes: Number(result.changes),
      lastRowId:
        result.lastInsertRowid === undefined || result.lastInsertRowid === null
          ? null
          : Number(result.lastInsertRowid),
    };
  }
}

export class NodeSqliteAdapter implements SqlScriptDatabase {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql: string): SqlStatement {
    return new NodeSqliteStatement(this.db, sql, []);
  }

  async batch(statements: SqlStatement[]): Promise<SqlRunResult[]> {
    const own = statements.map((statement) => {
      if (!(statement instanceof NodeSqliteStatement)) {
        throw new TypeError(
          "NodeSqliteAdapter.batch received a statement prepared by a different adapter",
        );
      }
      return statement;
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = own.map((statement) => statement.runSync());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

export function openNodeSqliteDatabase(path: string): NodeSqliteAdapter {
  return new NodeSqliteAdapter(new DatabaseSync(path));
}
