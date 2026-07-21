#!/usr/bin/env node
/**
 * Assert every publishable package's version equals the release tag.
 *
 * The tag is what a book repository pins and what provenance attests to, so a
 * tag that does not match the package versions publishes a version number
 * that exists nowhere in git history - unrevertable, and impossible to
 * explain to whoever hits it six months later.
 *
 * Usage: node scripts/check-release-versions.mjs v1.5.0
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHABLE } from "./publishable.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const tag = process.argv[2];
if (!tag) {
  console.error("usage: check-release-versions.mjs <tag>   (e.g. v1.5.0)");
  process.exit(2);
}

const SEMVER = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const match = SEMVER.exec(tag);
if (!match) {
  console.error(`✗ ${tag} is not a semver release tag (expected vMAJOR.MINOR.PATCH[-prerelease])`);
  process.exit(1);
}
const expected = match[1];

const problems = [];
for (const dir of PUBLISHABLE) {
  const pkg = JSON.parse(await readFile(join(ROOT, dir, "package.json"), "utf8"));
  if (pkg.version !== expected) {
    problems.push(`${pkg.name} is ${pkg.version}, tag says ${expected}`);
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} version mismatch(es) for ${tag}:`);
  for (const p of problems) console.error(`    ${p}`);
  console.error("\nRun `pnpm -r exec npm version <version> --no-git-tag-version`, commit, then re-tag.");
  process.exit(1);
}

console.log(`✓ all ${PUBLISHABLE.length} publishable packages are at ${expected}`);
