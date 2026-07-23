#!/usr/bin/env node
/**
 * Rehearse an author's CI against packed tarballs, end to end (ADR-0022).
 *
 * Everything else in this repository tests the toolchain as a pnpm workspace,
 * where every `@authorbot/*` import resolves through a symlink to source that
 * was just compiled. An author has none of that. They have a tarball from the
 * registry, `npm ci`, and `npx authorbot`. The gap between those two worlds is
 * exactly where packaging bugs live - a missing `dist/`, an unpublished
 * transitive dependency, a `bin` without a shebang - and none of them can fail
 * a normal test run.
 *
 * So this builds the workspace's tarballs, copies templates/book-repo into a
 * temp directory, installs the CLI from those tarballs with plain npm, and
 * runs `npx authorbot validate` and `npx authorbot build` the way author CI
 * does. It is the only check that exercises the artifact rather than the
 * source.
 *
 * Requires the network (npm fetches astro, remark, zod and friends) and takes
 * a couple of minutes. Publishes nothing.
 *
 * Usage: node scripts/simulate-author-ci.mjs [--keep]
 */
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHABLE } from "./publishable.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const keep = process.argv.includes("--keep");

// Derive the CLI's complete local workspace closure instead of maintaining a
// second dependency list by hand. Local authoring makes @authorbot/api a lazy
// CLI dependency, so every unreleased @authorbot package in that closure must
// come from the rehearsal's tarballs rather than the public registry.
const publishablePackages = await Promise.all(
  PUBLISHABLE.map(async (dir) => ({
    dir,
    pkg: JSON.parse(await readFile(join(ROOT, dir, "package.json"), "utf8")),
  })),
);
const packageByName = new Map(publishablePackages.map((entry) => [entry.pkg.name, entry]));
const requiredNames = new Set(["@authorbot/cli"]);
const pendingNames = ["@authorbot/cli"];
while (pendingNames.length > 0) {
  const name = pendingNames.pop();
  const entry = packageByName.get(name);
  if (entry === undefined) continue;
  for (const dependency of Object.keys(entry.pkg.dependencies ?? {})) {
    if (!packageByName.has(dependency) || requiredNames.has(dependency)) continue;
    requiredNames.add(dependency);
    pendingNames.push(dependency);
  }
}
const CLI_CLOSURE = publishablePackages.filter((entry) => requiredNames.has(entry.pkg.name));

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

const step = (msg) => console.log(`\n── ${msg}`);

const work = await mkdtemp(join(tmpdir(), "authorbot-author-ci-"));
const vendor = join(work, "vendor");
const book = join(work, "book");

try {
  step("Packing the CLI and its runtime dependencies");
  const tarballs = {};
  for (const { dir, pkg } of CLI_CLOSURE) {
    run("pnpm", ["--filter", pkg.name, "pack", "--pack-destination", vendor], { cwd: ROOT });
    tarballs[pkg.name] = `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
    console.log(`   ${pkg.name} → ${tarballs[pkg.name]}`);
  }

  step("Creating a book repository from templates/book-repo");
  await cp(join(ROOT, "templates/book-repo"), book, { recursive: true });
  await cp(vendor, join(book, "vendor"), { recursive: true });

  // The template pins `@authorbot/cli` by version, which only resolves once
  // the package is on the registry. Point it at the local tarball instead -
  // and override the transitive @authorbot/* deps too, since the tarball
  // declares them by version as well. This is the one place the rehearsal
  // differs from the real thing, and it differs only in *where* the packages
  // come from, not in what they contain.
  const pkg = JSON.parse(await readFile(join(book, "package.json"), "utf8"));
  pkg.devDependencies["@authorbot/cli"] = `file:vendor/${tarballs["@authorbot/cli"]}`;
  delete pkg.devDependencies.wrangler; // nothing here deploys
  pkg.overrides = Object.fromEntries(
    Object.entries(tarballs)
      .filter(([name]) => name !== "@authorbot/cli")
      .map(([name, file]) => [name, `file:vendor/${file}`]),
  );
  await writeFile(join(book, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  step("npm install (generating the lockfile an author would commit)");
  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: book });
  await access(join(book, "package-lock.json"));

  // The real workflow runs `npm ci`, which is stricter: it deletes
  // node_modules and installs strictly from the lockfile. Rehearse that, not
  // the install that produced it.
  step("npm ci (what the workflow actually runs)");
  await rm(join(book, "node_modules"), { recursive: true, force: true });
  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: book });

  step("npx authorbot validate .");
  const validate = run("npx", ["authorbot", "validate", "."], { cwd: book });
  process.stdout.write(validate);
  if (!/valid \(0 errors/.test(validate)) {
    throw new Error(`validate did not report a clean book:\n${validate}`);
  }

  step("npx authorbot build . --out _site");
  const build = run("npx", ["authorbot", "build", ".", "--out", "_site"], { cwd: book });
  process.stdout.write(build);

  const index = await readFile(join(book, "_site/index.html"), "utf8");
  if (!index.includes("No chapters published yet")) {
    throw new Error("the built site is missing the chapterless empty state");
  }
  await access(join(book, "_site/authorbot-build.json"));

  console.log("\n✓ author CI works against packed tarballs: npm ci → validate → build.");
  console.log("  No clone of this repository, no TypeScript compile. Nothing was published.");
} finally {
  if (keep) console.log(`\n(kept ${work})`);
  else await rm(work, { recursive: true, force: true });
}
