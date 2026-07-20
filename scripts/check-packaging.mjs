#!/usr/bin/env node
/**
 * Packaging gate (ADR-0022). Runs `npm pack --dry-run` over every publishable
 * workspace package and asserts the tarball is what an author should receive.
 *
 * This exists because packaging mistakes are invisible until someone installs
 * the package: a missing `dist/` or a leaked `test/` directory both build,
 * typecheck, and test green in this repository. Publishing is the one action
 * that cannot be undone (npm unpublish is restricted after 72 hours), so the
 * check runs in the release workflow before anything is pushed to the
 * registry.
 *
 * Asserted per package:
 *   - it is not marked private, and publishes with public access
 *   - name, version, description, license, and repository.directory are set
 *   - the tarball contains dist/ and LICENSE
 *   - the tarball contains no test/, src/ (except the publisher's Astro site,
 *     which is a real runtime asset), tsconfig, or source map
 *   - every declared `bin` target is inside the tarball and has a shebang
 *   - `exports` targets all exist on disk
 *   - no workspace dependency is private (an unpublishable transitive dep
 *     makes the whole package uninstallable)
 *
 * Usage: node scripts/check-packaging.mjs [--json]
 */
import { execFileSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISHABLE } from "./publishable.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN = [
  { re: /^test\//, why: "test directory" },
  { re: /^src\//, why: "TypeScript source" },
  { re: /(^|\/)node_modules\//, why: "a nested node_modules directory" },
  { re: /^tsconfig.*\.json$/, why: "tsconfig" },
  { re: /\.map$/, why: "source map with no shipped sources" },
  { re: /^vitest\.config\./, why: "test config" },
  { re: /^wrangler\.jsonc$/, why: "our own Worker config, not the author's" },
  { re: /^\.dev\.vars/, why: "local secrets file" },
  { re: /^node_modules\//, why: "vendored node_modules" },
];

function packFiles(dir) {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(ROOT, dir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 32 * 1024 * 1024,
  });
  // `prepack` output (licence copy, migration staging) lands on the same
  // stream, so take the JSON document rather than the whole stream.
  const start = raw.indexOf("[");
  if (start < 0) throw new Error(`npm pack produced no JSON for ${dir}:\n${raw}`);
  return JSON.parse(raw.slice(start))[0];
}

const failures = [];
const report = [];

for (const dir of PUBLISHABLE) {
  const pkg = JSON.parse(await readFile(join(ROOT, dir, "package.json"), "utf8"));
  const fail = (msg) => failures.push(`${pkg.name}: ${msg}`);

  if (pkg.private) fail("marked private — it would never publish");
  if (pkg.publishConfig?.access !== "public") {
    fail("publishConfig.access must be \"public\" (scoped packages default to restricted)");
  }
  for (const field of ["name", "version", "description", "license"]) {
    if (!pkg[field]) fail(`missing "${field}"`);
  }
  if (pkg.repository?.directory !== dir) {
    fail(`repository.directory is ${JSON.stringify(pkg.repository?.directory)}, expected ${JSON.stringify(dir)}`);
  }

  // A published package may not depend on an unpublished one.
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
    if (!range.startsWith("workspace:")) continue;
    const found = await Promise.all(
      PUBLISHABLE.map(async (d) =>
        JSON.parse(await readFile(join(ROOT, d, "package.json"), "utf8")).name === dep ? d : null,
      ),
    );
    if (!found.some(Boolean)) fail(`depends on ${dep}, which is not in the publishable set`);
  }

  const packed = packFiles(dir);
  const names = packed.files.map((f) => f.path);

  if (!names.some((n) => n.startsWith("dist/"))) fail("tarball contains no dist/ — did `build` run?");
  if (!names.includes("LICENSE")) fail("tarball contains no LICENSE");
  if (!names.includes("package.json")) fail("tarball contains no package.json");

  for (const { re, why, allow } of FORBIDDEN) {
    if (allow?.includes(dir)) continue;
    const hit = names.filter((n) => re.test(n));
    if (hit.length) fail(`tarball leaks ${why}: ${hit.slice(0, 3).join(", ")}${hit.length > 3 ? ` (+${hit.length - 3})` : ""}`);
  }

  for (const target of Object.values(pkg.bin ?? {})) {
    const rel = target.replace(/^\.\//, "");
    if (!names.includes(rel)) {
      fail(`bin target ${target} is not in the tarball`);
      continue;
    }
    const head = await readFile(join(ROOT, dir, rel), "utf8");
    if (!head.startsWith("#!")) fail(`bin target ${target} has no shebang`);
  }

  for (const [entry, cond] of Object.entries(pkg.exports ?? {})) {
    const targets = typeof cond === "string" ? [cond] : Object.values(cond);
    for (const t of targets) {
      if (t.includes("*")) continue; // wildcard subpath: nothing single to stat
      try {
        await access(join(ROOT, dir, t));
      } catch {
        fail(`exports["${entry}"] → ${t} does not exist`);
      }
    }
  }

  report.push({
    name: pkg.name,
    version: pkg.version,
    dir,
    files: packed.entryCount,
    unpackedSize: packed.unpackedSize,
    size: packed.size,
  });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ packages: report, failures }, null, 2));
} else {
  for (const r of report) {
    console.log(
      `  ${r.name.padEnd(30)} ${r.version.padEnd(8)} ${String(r.files).padStart(4)} files  ` +
        `${(r.size / 1024).toFixed(1)} kB packed / ${(r.unpackedSize / 1024).toFixed(1)} kB unpacked`,
    );
  }
}

if (failures.length) {
  console.error(`\n${failures.length} packaging problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\n${report.length} package(s) ready to publish. Nothing was published.`);
