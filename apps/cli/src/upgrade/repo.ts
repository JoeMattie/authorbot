/**
 * Reading the three facts about a book repository that `upgrade` needs: what
 * it is pinned to, what branch its pull requests target, and whether it has a
 * D1 database whose migrations need applying.
 */

import { parse as parseYaml } from "yaml";
import { type MigrationRepo } from "./migrations.js";
import { parsePin, type Pin } from "./semver.js";
import type { UpgradeFs } from "./ports.js";

export const CLI_PACKAGE = "@authorbot/cli";
export const API_PACKAGE = "@authorbot/api";

/** A problem with the repository itself - always CLI exit code 2. */
export class UpgradeRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpgradeRepoError";
  }
}

export interface PinLocation {
  readonly pin: Pin;
  /** Which dependency block holds it. */
  readonly field: "devDependencies" | "dependencies";
  /** package.json exactly as it is on disk, so a rewrite can preserve it. */
  readonly packageJsonText: string;
}

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

/** Read the book repository's `@authorbot/cli` pin. */
export async function readPin(fs: UpgradeFs, repoPath: string): Promise<PinLocation> {
  const packageJsonPath = join(repoPath, "package.json");
  if (!(await fs.exists(packageJsonPath))) {
    throw new UpgradeRepoError(
      `no package.json in ${repoPath}; ` +
        "`authorbot upgrade` runs inside a book repository (the one with your chapters/ directory)",
    );
  }
  const packageJsonText = await fs.readFile(packageJsonPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch (error) {
    throw new UpgradeRepoError(
      `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new UpgradeRepoError("package.json is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  for (const field of ["devDependencies", "dependencies"] as const) {
    const block = record[field];
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const spec = (block as Record<string, unknown>)[CLI_PACKAGE];
    if (typeof spec !== "string") {
      continue;
    }
    const pin = parsePin(spec);
    if (pin === undefined) {
      throw new UpgradeRepoError(
        `package.json pins ${CLI_PACKAGE} to "${spec}", which is not a version or a ^/~ range. ` +
          "`upgrade` will not guess what you meant; set it to an exact release (ADR-0021 §1) and re-run.",
      );
    }
    return { pin, field, packageJsonText };
  }
  throw new UpgradeRepoError(
    `package.json does not depend on ${CLI_PACKAGE}; this does not look like a book repository`,
  );
}

interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** Return the index after a JSON string's closing quote. */
function jsonStringEnd(input: string, start: number): number {
  for (let index = start + 1; index < input.length; index += 1) {
    if (input[index] === "\\") {
      index += 1;
    } else if (input[index] === '"') {
      return index + 1;
    }
  }
  throw new UpgradeRepoError("package.json contains an unterminated string");
}

function skipWhitespace(input: string, start: number): number {
  let index = start;
  while (/\s/.test(input[index] ?? "")) {
    index += 1;
  }
  return index;
}

function decodeJsonString(input: string, start: number, end: number): string {
  try {
    const decoded: unknown = JSON.parse(input.slice(start, end));
    return typeof decoded === "string" ? decoded : "";
  } catch {
    throw new UpgradeRepoError("package.json contains an invalid string");
  }
}

/**
 * Find string-value properties immediately inside a named top-level object.
 *
 * This small scanner is intentionally narrower than a JSON reserializer. It
 * gives us exact byte ranges for dependency specs while leaving indentation,
 * ordering, trailing newlines, and every unrelated value untouched.
 */
function directStringPropertyRanges(
  input: string,
  topLevelField: "devDependencies" | "dependencies",
  packageNames: ReadonlySet<string>,
): Map<string, TextRange[]> {
  const ranges = new Map<string, TextRange[]>();
  let depth = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      const keyStart = index;
      const keyEnd = jsonStringEnd(input, keyStart);
      if (depth === 1) {
        const colon = skipWhitespace(input, keyEnd);
        if (input[colon] === ":") {
          const key = decodeJsonString(input, keyStart, keyEnd);
          const valueStart = skipWhitespace(input, colon + 1);
          if (key === topLevelField && input[valueStart] === "{") {
            collectDirectStringProperties(input, valueStart, packageNames, ranges);
          }
        }
      }
      index = keyEnd - 1;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
  return ranges;
}

function collectDirectStringProperties(
  input: string,
  objectStart: number,
  packageNames: ReadonlySet<string>,
  ranges: Map<string, TextRange[]>,
): void {
  let depth = 0;
  for (let index = objectStart; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      const keyStart = index;
      const keyEnd = jsonStringEnd(input, keyStart);
      if (depth === 1) {
        const colon = skipWhitespace(input, keyEnd);
        if (input[colon] === ":") {
          const key = decodeJsonString(input, keyStart, keyEnd);
          const valueStart = skipWhitespace(input, colon + 1);
          if (packageNames.has(key) && input[valueStart] === '"') {
            const valueEnd = jsonStringEnd(input, valueStart);
            const existing = ranges.get(key) ?? [];
            existing.push({ start: valueStart + 1, end: valueEnd - 1 });
            ranges.set(key, existing);
          }
        }
      }
      index = keyEnd - 1;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return;
      }
    }
  }
  throw new UpgradeRepoError("package.json has an unterminated dependency block");
}

function rewriteDirectDependencySpecs(
  packageJsonText: string,
  replacements: ReadonlyMap<string, string>,
  requiredPackages: ReadonlySet<string>,
): string {
  const packageNames = new Set(replacements.keys());
  const allRanges = new Map<string, TextRange[]>();
  for (const field of ["devDependencies", "dependencies"] as const) {
    const fieldRanges = directStringPropertyRanges(packageJsonText, field, packageNames);
    for (const [packageName, ranges] of fieldRanges) {
      const existing = allRanges.get(packageName) ?? [];
      existing.push(...ranges);
      allRanges.set(packageName, existing);
    }
  }

  for (const packageName of requiredPackages) {
    if ((allRanges.get(packageName)?.length ?? 0) === 0) {
      throw new UpgradeRepoError(`could not locate the ${packageName} dependency in package.json`);
    }
  }

  const edits = [...allRanges].flatMap(([packageName, ranges]) =>
    ranges.map((range) => ({ ...range, replacement: replacements.get(packageName) ?? "" })),
  );
  edits.sort((left, right) => right.start - left.start);

  let rewritten = packageJsonText;
  for (const edit of edits) {
    rewritten = `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`;
  }
  return rewritten;
}

/**
 * Rewrite the CLI pin, touching only that one direct dependency value.
 *
 * Kept as the compatibility API for callers that deliberately preserve a
 * range such as `^1.2.3`. New upgrade flows should use
 * `rewriteAuthorbotPins` so a deployed book's API cannot lag behind its CLI.
 */
export function rewritePin(packageJsonText: string, newSpec: string): string {
  return rewriteDirectDependencySpecs(
    packageJsonText,
    new Map([[CLI_PACKAGE, newSpec]]),
    new Set([CLI_PACKAGE]),
  );
}

/**
 * Align every installed Authorbot runtime package to one target spec.
 *
 * The CLI is required because it identifies a book repository. The API is
 * updated only when it is already a direct dependency, so static books do not
 * acquire a server package merely by upgrading. The caller may preserve the
 * CLI's range style, such as `^1.2.3`; both packages still receive the same
 * spec. The rewrite is textual and surgical: package.json formatting and
 * unrelated dependency specs survive byte-for-byte.
 */
export function rewriteAuthorbotPins(packageJsonText: string, targetVersion: string): string {
  return rewriteDirectDependencySpecs(
    packageJsonText,
    new Map([
      [CLI_PACKAGE, targetVersion],
      [API_PACKAGE, targetVersion],
    ]),
    new Set([CLI_PACKAGE]),
  );
}

/**
 * Strip `//` and block comments from JSONC, preserving string contents.
 *
 * wrangler.jsonc is documentation as much as configuration in a generated
 * book repository - the template's comments outnumber its settings - so a
 * naive strip would corrupt any URL inside a string.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] ?? "";
    const next = input[i + 1] ?? "";
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i += 1;
      } else if (char === "\n") {
        out += char;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

export interface D1Binding {
  readonly databaseName: string;
}

/**
 * The book's D1 database, if it has one.
 *
 * `undefined` is the normal case for a static book (stage 2 of
 * getting-started): no database, so nothing to migrate. That is a skip with a
 * reason, never a silent success.
 */
export async function readD1Binding(
  fs: UpgradeFs,
  repoPath: string,
): Promise<D1Binding | undefined> {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const target = join(repoPath, name);
    if (!(await fs.exists(target))) {
      continue;
    }
    const text = await fs.readFile(target);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(text));
    } catch (error) {
      throw new UpgradeRepoError(
        `${name} is not valid JSON(C): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const databases = (parsed as Record<string, unknown>).d1_databases;
    if (!Array.isArray(databases) || databases.length === 0) {
      return undefined;
    }
    const first = databases[0];
    if (typeof first !== "object" || first === null) {
      return undefined;
    }
    const databaseName = (first as Record<string, unknown>).database_name;
    if (typeof databaseName !== "string" || databaseName.trim() === "") {
      throw new UpgradeRepoError(
        `${name} declares a d1_databases entry with no database_name; fix it before upgrading`,
      );
    }
    return { databaseName };
  }
  return undefined;
}

/** The branch a pull request should target; defaults to `main`. */
export async function readDefaultBranch(fs: UpgradeFs, repoPath: string): Promise<string> {
  const bookPath = join(repoPath, "book.yml");
  if (!(await fs.exists(bookPath))) {
    return "main";
  }
  try {
    const parsed: unknown = parseYaml(await fs.readFile(bookPath));
    if (typeof parsed === "object" && parsed !== null) {
      const repository = (parsed as Record<string, unknown>).repository;
      if (typeof repository === "object" && repository !== null) {
        const branch = (repository as Record<string, unknown>).default_branch;
        if (typeof branch === "string" && branch.trim() !== "") {
          return branch.trim();
        }
      }
    }
  } catch {
    // book.yml being unparseable is validation's problem to report, not
    // ours; fall back to the conventional default.
  }
  return "main";
}

/** Adapt a directory on disk to the narrow view a migration gets. */
export function migrationRepoFor(fs: UpgradeFs, root: string): MigrationRepo {
  const resolve = (relative: string): string => {
    const normalized = relative.replace(/^\/+/, "");
    if (normalized.split("/").includes("..")) {
      throw new UpgradeRepoError(`migration tried to reach outside the repository: ${relative}`);
    }
    return join(root, normalized);
  };
  // `async` on every method so a rejected path becomes a rejected promise
  // rather than a synchronous throw: a migration awaiting `repo.read` should
  // be able to catch the refusal the same way it catches a missing file.
  return {
    list: async () => fs.listFiles(root),
    exists: async (relative) => fs.exists(resolve(relative)),
    read: async (relative) => fs.readFile(resolve(relative)),
    write: async (relative, content) => fs.writeFile(resolve(relative), content),
    remove: async (relative) => fs.removeFile(resolve(relative)),
  };
}
