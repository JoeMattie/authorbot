#!/usr/bin/env node
/**
 * Set the release version everywhere it is written down.
 *
 * The version lives in more places than the package manifests: the wizard
 * pins the toolchain a generated book installs, and the book template pins it
 * too. Both are deliberately constants rather than lookups so a change shows
 * up in a diff (see `scaffold/render.ts`) - but that only works if bumping
 * them is one action. Doing it by hand meant a release reached CI with the
 * wizard pinning a version that no longer existed, which a test caught after
 * a full build.
 *
 *   node scripts/bump-version.mjs 0.2.0
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PUBLISHABLE } from "./publishable.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/bump-version.mjs <semver>");
  process.exit(2);
}

const touched = [];

for (const dir of [...PUBLISHABLE, "packages/test-fixtures"]) {
  const file = join(ROOT, dir, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf8"));
  if (pkg.version === version) continue;
  pkg.version = version;
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
  touched.push(`${dir}/package.json`);
}

// The wizard's pin for generated books.
const renderPath = join(ROOT, "apps/create/src/scaffold/render.ts");
const render = await readFile(renderPath, "utf8");
const updated = render.replace(
  /export const TOOLCHAIN_VERSION = "[^"]+";/,
  `export const TOOLCHAIN_VERSION = "${version}";`,
);
if (updated !== render) {
  await writeFile(renderPath, updated);
  touched.push("apps/create/src/scaffold/render.ts");
}

// The book template's own pin.
const templatePath = join(ROOT, "templates/book-repo/package.json");
const template = JSON.parse(await readFile(templatePath, "utf8"));
let templateChanged = false;
for (const section of ["dependencies", "devDependencies"]) {
  if (template[section]?.["@authorbot/cli"] && template[section]["@authorbot/cli"] !== version) {
    template[section]["@authorbot/cli"] = version;
    templateChanged = true;
  }
}
if (templateChanged) {
  await writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`);
  touched.push("templates/book-repo/package.json");
}

console.log(touched.length ? `set ${version} in:\n  ${touched.join("\n  ")}` : `already at ${version}`);
