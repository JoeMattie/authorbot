#!/usr/bin/env node
/**
 * Regenerates `src/scaffold/static-files.ts` from `templates/book-repo`.
 *
 * The wizard cannot read the templates directory at runtime: `@authorbot/create`
 * publishes only `dist/` (ADR-0022), so the files it scaffolds must be compiled
 * into it. This script is the one-way copy, and `test/template-drift.test.ts`
 * is the guard that the copy is current — the test fails if the template
 * changes without this script being re-run.
 *
 * Usage: node apps/create/scripts/sync-templates.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const templateDir = path.join(repoRoot, "templates/book-repo");
const target = path.join(here, "../src/scaffold/static-files.ts");

/**
 * Only files the scaffold emits verbatim. `book.yml`, `package.json`,
 * `wrangler.jsonc`, and `README.md` are rendered per book and live in
 * `src/scaffold/render.ts` instead.
 */
export const STATIC_FILES = [
  ".gitignore",
  "story/outline.yml",
  "story/timeline.yml",
  ".github/workflows/validate.yml",
  ".github/workflows/publish.yml",
];

export const KEEP_DIRECTORIES = [
  "chapters",
  "story/characters",
  ".authorbot/annotations",
  ".authorbot/attribution",
  ".authorbot/decisions",
  ".authorbot/exports",
  ".authorbot/releases",
  ".authorbot/work-items",
];

async function main() {
  const entries = [];
  for (const rel of STATIC_FILES) {
    const text = await readFile(path.join(templateDir, rel), "utf8");
    entries.push(`  ${JSON.stringify(rel)}: ${JSON.stringify(text)},`);
  }

  const source = `/**
 * Files the scaffold copies out of \`templates/book-repo\` unchanged.
 *
 * They are embedded rather than read from disk because \`@authorbot/create\`
 * ships as an npm package containing only \`dist/\` (ADR-0022) — the templates
 * directory is not published, so a runtime read would work in this repository
 * and fail for every real user.
 *
 * GENERATED. Do not hand-edit: \`test/template-drift.test.ts\` asserts every
 * entry is byte-identical to its counterpart under \`templates/book-repo\`, so
 * an edit here without the matching edit there fails the suite, and the
 * template stays the single source of truth.
 *
 * Regenerate with: node apps/create/scripts/sync-templates.mjs
 */
export const STATIC_TEMPLATE_FILES: Readonly<Record<string, string>> = {
${entries.join("\n")}
};

/** Directories the template keeps with a \`.gitkeep\` (contract §3.2 scaffold). */
export const KEEP_DIRECTORIES: readonly string[] = [
${KEEP_DIRECTORIES.map((dir) => `  ${JSON.stringify(dir)},`).join("\n")}
];
`;

  await writeFile(target, source, "utf8");
  process.stdout.write(`wrote ${path.relative(repoRoot, target)} (${STATIC_FILES.length} files)\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
