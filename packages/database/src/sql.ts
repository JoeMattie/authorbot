/**
 * Minimal SQL portability interface (Phase 2 contract §2).
 *
 * Repositories are written exclusively against `SqlDatabase`; the two
 * adapters (Cloudflare D1 for production, built-in SQLite for local Node, and
 * better-sqlite3 in the test suite) implement it over the same SQL dialect.
 * No adapter-specific SQL may appear in repositories.
 */

/** Values that can be bound to a statement or returned in a row. */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** A result row: column name to value. */
export type SqlRow = Record<string, SqlValue>;

/** Result metadata for a write statement. */
export interface SqlRunResult {
  /** Rows changed by the statement (INSERT/UPDATE/DELETE). */
  changes: number;
  /** Last inserted rowid where the adapter reports one, else null. */
  lastRowId: number | null;
}

/**
 * A prepared statement. `bind` returns a NEW statement carrying the values
 * (D1 semantics); the original statement is not mutated and can be re-bound.
 */
export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  /** First row, or null when the query returns no rows. */
  first<T extends SqlRow = SqlRow>(): Promise<T | null>;
  /** All rows. */
  all<T extends SqlRow = SqlRow>(): Promise<T[]>;
  /** Execute for side effects. */
  run(): Promise<SqlRunResult>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  /**
   * Execute the statements in order as one atomic unit: if any statement
   * fails, none of the batch's effects persist. (D1 `batch` is an implicit
   * transaction; both Node adapters wrap a transaction.)
   */
  batch(statements: SqlStatement[]): Promise<SqlRunResult[]>;
}

/**
 * A database that can additionally execute a multi-statement SQL script
 * (including triggers). Required by the migration runner; both Node adapters
 * implement it natively. Production D1 migrations are applied with `wrangler
 * d1 migrations apply`, not this interface.
 */
export interface SqlScriptDatabase extends SqlDatabase {
  exec(sql: string): Promise<void>;
}

/**
 * True when `error` is a UNIQUE/PRIMARY KEY constraint violation from either
 * adapter (better-sqlite3 `SQLITE_CONSTRAINT_*` codes, D1 message text).
 */
export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (
    typeof code === "string" &&
    (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY")
  ) {
    return true;
  }
  return /UNIQUE constraint failed/i.test(error.message);
}

/** True when `error` is any SQLite constraint violation (CHECK, FK, UNIQUE…). */
export function isConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) return true;
  return /constraint failed|FOREIGN KEY constraint/i.test(error.message);
}
