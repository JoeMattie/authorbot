#!/usr/bin/env node
/**
 * Stage the operational D1 migrations inside @authorbot/api for publication.
 *
 * ADR-0021 §4 requires author CI to run `wrangler d1 migrations apply` before
 * deploying the Worker. Those SQL files therefore have to be on disk in the
 * author's checkout — and the only version of them that can possibly match the
 * Worker being deployed is the one shipped by the same package. So a book's
 * `wrangler.jsonc` sets:
 *
 *     "migrations_dir": "node_modules/@authorbot/api/migrations"
 *
 * and the toolchain pin in the book's package.json governs the schema exactly
 * as it governs the code. Copying an out-of-band directory into the book repo
 * would let the two drift, which is the failure ADR-0021 exists to prevent.
 *
 * The copy is generated (gitignored) rather than committed: `migrations/` at
 * the repository root stays the single source of truth.
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../migrations", import.meta.url));
const target = fileURLToPath(new URL("../migrations", import.meta.url));

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });

const copied = (await readdir(target)).filter((f) => f.endsWith(".sql"));
if (copied.length === 0) {
  throw new Error(`no .sql migrations found in ${source}`);
}
console.log(`staged ${copied.length} migration(s) into apps/api/migrations`);
