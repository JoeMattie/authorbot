#!/usr/bin/env node
/**
 * Copy the repository LICENSE and CHANGELOG into the package being packed.
 *
 * npm only includes a LICENSE that sits inside the package directory, and a
 * published package with no license text is a package nobody can safely adopt.
 * The copies are generated (gitignored) rather than committed so there is one
 * authoritative licence file in the repository and no chance of ten of them
 * drifting apart.
 *
 * The changelog rides along for the same reason: npm renders it on the package
 * page, and "what changed and should I upgrade" is a question asked by people
 * who are looking at npm, not at the repository. Both are generated
 * (gitignored) rather than committed so there is one authoritative copy of each
 * in the repository and no chance of twelve of them drifting apart.
 *
 * Run from a package directory (as a `prepack` script).
 */
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

await copyFile(fileURLToPath(new URL("../LICENSE", import.meta.url)), "LICENSE");
await copyFile(fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)), "CHANGELOG.md");
