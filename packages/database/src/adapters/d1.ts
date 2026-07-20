/**
 * Cloudflare D1 adapter (production). A thin wrapper: D1's prepared-statement
 * API already matches `SqlDatabase`, so this only normalizes result shapes
 * and brands statements so `batch` can recover the native ones.
 *
 * Typed structurally against the `@cloudflare/workers-types` D1 surface so
 * the package builds for Node without pulling Workers globals into scope; the
 * real `D1Database` binding satisfies `D1DatabaseLike` exactly.
 */
import type { D1Database } from "@cloudflare/workers-types";
import type { SqlDatabase, SqlRow, SqlRunResult, SqlStatement, SqlValue } from "../sql.js";

/** Structural subset of `@cloudflare/workers-types` `D1PreparedStatement`. */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1ResultLike<T>>;
  run<T = unknown>(): Promise<D1ResultLike<T>>;
}

/** Structural subset of `@cloudflare/workers-types` `D1Result`. */
export interface D1ResultLike<T = unknown> {
  results: T[];
  success: boolean;
  meta: {
    changes?: number;
    last_row_id?: number;
  };
}

/** Structural subset of `@cloudflare/workers-types` `D1Database`. */
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
}

// Compile-time check that a real Workers `D1Database` binding satisfies the
// structural surface this adapter wraps (Phase 2 contract §2: typed against
// @cloudflare/workers-types).
type AssertTrue<T extends true> = T;
type _D1BindingIsCompatible = AssertTrue<D1Database extends D1DatabaseLike ? true : false>;

class D1Statement implements SqlStatement {
  constructor(readonly native: D1PreparedStatementLike) {}

  bind(...values: SqlValue[]): SqlStatement {
    return new D1Statement(this.native.bind(...values));
  }

  async first<T extends SqlRow = SqlRow>(): Promise<T | null> {
    return await this.native.first<T>();
  }

  async all<T extends SqlRow = SqlRow>(): Promise<T[]> {
    const result = await this.native.all<T>();
    return result.results;
  }

  async run(): Promise<SqlRunResult> {
    const result = await this.native.run();
    return toRunResult(result);
  }
}

function toRunResult(result: D1ResultLike): SqlRunResult {
  return {
    changes: result.meta.changes ?? 0,
    lastRowId: result.meta.last_row_id ?? null,
  };
}

export class D1Adapter implements SqlDatabase {
  constructor(private readonly db: D1DatabaseLike) {}

  prepare(sql: string): SqlStatement {
    return new D1Statement(this.db.prepare(sql));
  }

  async batch(statements: SqlStatement[]): Promise<SqlRunResult[]> {
    const native = statements.map((s) => {
      if (!(s instanceof D1Statement)) {
        throw new TypeError(
          "D1Adapter.batch received a statement prepared by a different adapter",
        );
      }
      return s.native;
    });
    const results = await this.db.batch(native);
    return results.map(toRunResult);
  }
}

/** Wrap a Cloudflare D1 binding as a `SqlDatabase`. */
export function wrapD1Database(db: D1DatabaseLike): D1Adapter {
  return new D1Adapter(db);
}
