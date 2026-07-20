#!/usr/bin/env node
/**
 * Copy the repository LICENSE into the package being packed.
 *
 * npm only includes a LICENSE that sits inside the package directory, and a
 * published package with no license text is a package nobody can safely adopt.
 * The copies are generated (gitignored) rather than committed so there is one
 * authoritative licence file in the repository and no chance of ten of them
 * drifting apart.
 *
 * Run from a package directory (as a `prepack` script).
 */
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../LICENSE", import.meta.url));
await copyFile(source, "LICENSE");
