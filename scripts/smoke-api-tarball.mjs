#!/usr/bin/env node
/**
 * Exercise the published API artifact rather than workspace symlinks.
 *
 * The book scaffold points Wrangler at:
 *
 *   node_modules/@authorbot/api/dist/worker.js
 *
 * and at the migrations directory beside it. A generic pack-file check cannot
 * prove that entry module imports from a real npm install, exports the Durable
 * Object Wrangler names, or carries the exact migration boundary intended for
 * this release. This smoke test packs the complete release set, installs only
 * those local tarballs into a scratch project, and checks that deployed shape.
 *
 * Usage:
 *   node scripts/smoke-api-tarball.mjs
 *   node scripts/smoke-api-tarball.mjs --keep
 *   node scripts/smoke-api-tarball.mjs --release-dir <existing tarball directory>
 */
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PUBLISHABLE } from "./publishable.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/smoke-api-tarball.mjs [--keep] [--release-dir DIR]

Pack every release package, install the local tarball set with lifecycle
scripts disabled, then verify the API Worker entry and D1 migrations.

  --keep             retain the scratch directory for inspection
  --release-dir DIR  smoke an existing packed release instead of repacking`);
  process.exit(0);
}

let keep = false;
let suppliedReleaseDir;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--") {
    continue;
  } else if (arg === "--keep") {
    keep = true;
  } else if (arg === "--release-dir") {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      console.error("--release-dir requires a directory");
      process.exit(2);
    }
    suppliedReleaseDir = resolve(value);
    index += 1;
  } else {
    console.error(`unknown option: ${arg}`);
    process.exit(2);
  }
}

const work = await mkdtemp(join(tmpdir(), "authorbot-api-tarball-"));
const vendor = suppliedReleaseDir ?? join(work, "release");
const scratch = join(work, "consumer");

try {
  try {
    await access(join(ROOT, "apps/api/dist/worker.js"));
  } catch {
    throw new Error("apps/api/dist/worker.js is missing; run `pnpm build` before this smoke");
  }

  if (suppliedReleaseDir === undefined) {
    step("Packing the complete release set");
    run(process.execPath, [join(ROOT, "scripts/pack-release.mjs"), "--out", vendor], {
      cwd: ROOT,
    });
  } else {
    step(`Using the packed release at ${vendor}`);
  }

  await mkdir(scratch, { recursive: true });
  const tarballs = new Map();
  for (const dir of PUBLISHABLE) {
    const pkg = JSON.parse(await readFile(join(ROOT, dir, "package.json"), "utf8"));
    const tarball = join(
      vendor,
      `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`,
    );
    await access(tarball);
    tarballs.set(pkg.name, pathToFileURL(tarball).href);
  }

  const apiTarball = tarballs.get("@authorbot/api");
  if (apiTarball === undefined) {
    throw new Error("the packed release has no @authorbot/api tarball");
  }

  await writeFile(
    join(scratch, "package.json"),
    `${JSON.stringify(
      {
        name: "authorbot-api-tarball-smoke",
        version: "0.0.0",
        private: true,
        type: "module",
        // Only the API is direct. Local overrides supply its declared
        // @authorbot/* closure without hoisting every release package into the
        // project and accidentally masking a missing API dependency.
        dependencies: {
          "@authorbot/api": apiTarball,
        },
        overrides: Object.fromEntries(
          [...tarballs].filter(
            ([name]) => name.startsWith("@authorbot/") && name !== "@authorbot/api",
          ),
        ),
      },
      null,
      2,
    )}\n`,
  );

  step("Installing local tarballs with lifecycle scripts disabled");
  run(
    packageManagerCommand("npm"),
    [
      "install",
      "--ignore-scripts",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: scratch,
      env: npmChildEnvironment(process.env),
    },
  );

  const installedApiPackage = JSON.parse(
    await readFile(join(scratch, "node_modules/@authorbot/api/package.json"), "utf8"),
  );
  for (const [name, spec] of Object.entries(installedApiPackage.dependencies ?? {})) {
    if (!name.startsWith("@authorbot/")) {
      continue;
    }
    if (!tarballs.has(name)) {
      throw new Error(`installed @authorbot/api depends on unpublished package ${name}`);
    }
    if (spec !== installedApiPackage.version) {
      throw new Error(
        `installed @authorbot/api depends on ${name}@${String(spec)}, ` +
          `not the release version ${installedApiPackage.version}`,
      );
    }
  }

  step("Importing the installed Worker entry");
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'const worker = await import("./node_modules/@authorbot/api/dist/worker.js");',
        'if (worker.default === null || typeof worker.default !== "object") {',
        '  throw new Error("default Worker export is not an object");',
        "}",
        'if (typeof worker.default.fetch !== "function") {',
        '  throw new Error("default Worker export has no fetch handler");',
        "}",
        'if (typeof worker.default.scheduled !== "function") {',
        '  throw new Error("default Worker export has no scheduled handler");',
        "}",
        'if (typeof worker.ProjectCoordinator !== "function") {',
        '  throw new Error("missing ProjectCoordinator class export");',
        "}",
        'console.log("Worker exports: default, ProjectCoordinator");',
      ].join("\n"),
    ],
    { cwd: scratch },
  );

  step("Checking the packaged D1 migration boundary");
  const migrationDir = join(scratch, "node_modules/@authorbot/api/migrations");
  const migrations = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
  const sourceMigrationDir = join(ROOT, "migrations");
  const sourceMigrations = (await readdir(sourceMigrationDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (JSON.stringify(migrations) !== JSON.stringify(sourceMigrations)) {
    throw new Error(
      "installed @authorbot/api migrations do not exactly match the root migration set\n" +
        `source: ${sourceMigrations.join(", ")}\n` +
        `packed: ${migrations.join(", ")}`,
    );
  }
  for (const name of sourceMigrations) {
    const [source, packed] = await Promise.all([
      readFile(join(sourceMigrationDir, name), "utf8"),
      readFile(join(migrationDir, name), "utf8"),
    ]);
    if (packed !== source) {
      throw new Error(`installed migration ${name} differs from the root source`);
    }
  }

  const required = [
    "0010_phase11_capabilities_expand.sql",
    "0011_phase11_revision_proposals.sql",
    "0012_chapter_summaries.sql",
    "0013_phase11_capabilities_backfill.sql",
  ];
  for (const name of required) {
    if (!migrations.includes(name)) {
      throw new Error(`installed @authorbot/api is missing migration ${name}`);
    }
  }
  const beyondBoundary = migrations.find((name) => Number.parseInt(name.slice(0, 4), 10) > 13);
  if (beyondBoundary !== undefined) {
    throw new Error(
      `installed @authorbot/api unexpectedly contains ${beyondBoundary}; ` +
        "v0.1.36 ends at migration 0013",
    );
  }

  console.log(`Migrations present: ${required.join(", ")}`);
  console.log("Migration boundary: 0013.");
  console.log("\nAPI tarball smoke passed. Nothing was published.");
} finally {
  if (keep) {
    console.log(`\nScratch directory retained at ${work}`);
  } else {
    await rm(work, { recursive: true, force: true });
  }
}

function step(message) {
  console.log(`\n-- ${message}`);
}

function run(file, commandArgs, options) {
  execFileSync(file, commandArgs, {
    encoding: "utf8",
    stdio: "inherit",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

/** npm and pnpm are command shims rather than native executables on Windows. */
function packageManagerCommand(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

/**
 * `pnpm check:api-tarball` runs beneath pnpm, which exports its own
 * `npm_config_*` values. Those belong to the outer command and can make the
 * scratch install resolve against the workspace or reject the nested install.
 */
function npmChildEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !/^npm_config_/i.test(name)),
  );
}
