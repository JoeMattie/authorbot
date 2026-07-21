#!/usr/bin/env node
/**
 * Pack every publishable package into a directory of tarballs, in dependency
 * order, and print their paths.
 *
 * `pnpm pack` rather than `npm pack`, for one reason: internal dependencies
 * are declared `workspace:*`, which no consumer can resolve. pnpm rewrites
 * each to the exact version being released as it writes the tarball. npm
 * would publish the literal string and every install would fail.
 *
 * The exact-version rewrite is deliberate rather than incidental. Internal
 * packages carry no compatibility promise (ADR-0022), so `@authorbot/cli` at
 * 1.5.0 should pull `@authorbot/schemas` at exactly 1.5.0 - the set that was
 * built and tested together - not whatever a caret range happens to resolve.
 *
 *   node scripts/pack-release.mjs --out DIR    pack, print paths
 *   node scripts/pack-release.mjs --list --out DIR
 *                                              print paths of an existing
 *                                              set without repacking
 *
 * Packs. Does not publish.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHABLE } from "./publishable.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const outIndex = args.indexOf("--out");
if (outIndex === -1 || !args[outIndex + 1]) {
  console.error("usage: pack-release.mjs [--list] --out <dir>");
  process.exit(2);
}
const outDir = resolve(args[outIndex + 1]);
await mkdir(outDir, { recursive: true });

const paths = [];
for (const dir of PUBLISHABLE) {
  const pkg = JSON.parse(await readFile(join(ROOT, dir, "package.json"), "utf8"));
  // pnpm names tarballs `<scope>-<name>-<version>.tgz` with the scope's `@`
  // and `/` flattened, matching `npm pack`.
  const tarball = join(outDir, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);

  if (listOnly) {
    await access(tarball); // fail loudly rather than print a path that is not there
  } else {
    execFileSync("pnpm", ["--filter", pkg.name, "pack", "--pack-destination", outDir], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
    });
    await access(tarball);
  }
  paths.push(tarball);
}

console.log(paths.join("\n"));
