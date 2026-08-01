#!/usr/bin/env node
/**
 * Extract one release's notes from the root changelog.
 *
 * The release workflow runs this before publishing to require a matching,
 * nonempty changelog section. The GitHub metadata job runs it again to
 * produce the release body.
 *
 * Usage: node scripts/extract-release-notes.mjs v1.5.0 [output-file]
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const [tag, outputFile] = process.argv.slice(2);

const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag ?? "");
if (!match) {
  console.error("usage: extract-release-notes.mjs <vMAJOR.MINOR.PATCH[-prerelease]> [output-file]");
  process.exit(2);
}

const version = match[1];
const changelog = await readFile(join(ROOT, "CHANGELOG.md"), "utf8");
const headings = [...changelog.matchAll(/^## ([^\s]+)\s*$/gm)];
const headingIndex = headings.findIndex((heading) => heading[1] === version);

if (headingIndex === -1) {
  console.error(`✗ CHANGELOG.md has no \`## ${version}\` release notes for ${tag}`);
  process.exit(1);
}

const heading = headings[headingIndex];
const start = heading.index + heading[0].length;
const end = headings[headingIndex + 1]?.index ?? changelog.length;
const body = changelog.slice(start, end).trim();

if (!body) {
  console.error(`✗ CHANGELOG.md's \`## ${version}\` section is empty`);
  process.exit(1);
}

const notes = `## What's Changed\n\n${body}\n`;
if (outputFile) {
  await writeFile(outputFile, notes);
  console.log(`✓ wrote ${tag} release notes to ${outputFile}`);
} else {
  process.stdout.write(notes);
}
