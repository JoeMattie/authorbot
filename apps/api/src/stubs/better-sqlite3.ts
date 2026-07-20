/**
 * Bundling stub (see wrangler.jsonc `alias`): `@authorbot/database` exports
 * both adapters from its index, so bundling the Worker would otherwise drag
 * the native better-sqlite3 module into the bundle. The Worker only ever
 * constructs the D1 adapter; this stub satisfies the import and throws if
 * anything actually tries to open a SQLite file inside workerd.
 */
export default class BetterSqlite3Unavailable {
  constructor() {
    throw new Error("better-sqlite3 is not available in the Workers runtime (use the D1 binding)");
  }
}
