/** Node-only, install-script-free database entry point for local authoring. */
export { openNodeSqliteDatabase, NodeSqliteAdapter } from "./adapters/node-sqlite.js";
export {
  applyMigrations,
  listMigrationFiles,
  MIGRATIONS_TABLE,
  type MigrationResult,
} from "./migrate.js";
export type {
  SqlDatabase,
  SqlRow,
  SqlRunResult,
  SqlScriptDatabase,
  SqlStatement,
  SqlValue,
} from "./sql.js";
