import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Stable validation error codes emitted by `authorbot validate`
 * (Phase 0 contract section 5).
 */
export const VALIDATION_ERROR_CODES = [
  "BOOK_CONFIG_MISSING",
  "BOOK_CONFIG_INVALID",
  "CHAPTER_FRONTMATTER_INVALID",
  "CHAPTER_ID_DUPLICATE",
  "CHAPTER_SLUG_DUPLICATE",
  "CHAPTER_ORDER_DUPLICATE",
  "CHAPTER_REF_UNRESOLVED",
  "BLOCK_ID_MISSING",
  "BLOCK_ID_DUPLICATE",
  "BLOCK_ID_INVALID",
  "RAW_HTML_FORBIDDEN",
  "URL_SCHEME_FORBIDDEN",
  "STORY_GRAPH_INVALID",
  "STORY_GRAPH_REF_UNRESOLVED",
  "TIMELINE_INVALID",
  "TIMELINE_REF_UNRESOLVED",
  "CHARACTER_FILE_INVALID",
  "ANNOTATION_INVALID",
  "ANNOTATION_REF_UNRESOLVED",
  "WORK_ITEM_INVALID",
  "WORK_ITEM_DELIMITER_INVALID",
  "WORK_ITEM_REF_UNRESOLVED",
  "DECISION_INVALID",
  "DECISION_REF_UNRESOLVED",
  "RELEASE_INVALID",
  "RELEASE_REF_UNRESOLVED",
  "ATTRIBUTION_INVALID",
  "PATH_UNSAFE",
] as const;
export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];

/**
 * Shape of `expected-errors.json` in each invalid fixture (contract
 * section 5): each listed code must appear at least once in the validator
 * output for that fixture; codes not listed are not asserted either way.
 */
export const expectedErrorsSchema = z.strictObject({
  errors: z.array(z.enum(VALIDATION_ERROR_CODES)).min(1),
});
export type ExpectedErrors = z.infer<typeof expectedErrorsSchema>;

/** Name of the expectation file inside each invalid fixture directory. */
export const EXPECTED_ERRORS_FILENAME = "expected-errors.json";

/** Absolute path to the `fixtures/` directory shipped with this package. */
export const fixturesRoot: string = fileURLToPath(
  new URL("../fixtures/", import.meta.url),
);

/** Absolute path to `fixtures/valid/` (repositories that must validate). */
export const validFixturesRoot: string = path.join(fixturesRoot, "valid");

/** Absolute path to `fixtures/invalid/` (repositories that must fail). */
export const invalidFixturesRoot: string = path.join(fixturesRoot, "invalid");

/** A fixture book repository on disk. */
export interface FixtureDir {
  /** Directory basename, e.g. `minimal` or `chapter-id-duplicate`. */
  readonly name: string;
  /** Absolute path to the fixture's book-repository root. */
  readonly dir: string;
}

/** An invalid fixture plus its documented expected error codes. */
export interface InvalidFixture extends FixtureDir {
  readonly expectedErrors: readonly ValidationErrorCode[];
}

async function listChildDirs(root: string): Promise<FixtureDir[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Enumerate the valid fixture repositories under `fixtures/valid/`. */
export async function listValidFixtures(): Promise<FixtureDir[]> {
  return listChildDirs(validFixturesRoot);
}

/**
 * Read and validate the `expected-errors.json` of one invalid fixture
 * directory. Throws if the file is missing, is not JSON, or does not match
 * the contract shape.
 */
export async function readExpectedErrors(
  fixtureDir: string,
): Promise<readonly ValidationErrorCode[]> {
  const filePath = path.join(fixtureDir, EXPECTED_ERRORS_FILENAME);
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return expectedErrorsSchema.parse(parsed).errors;
}

/**
 * Enumerate the invalid fixture repositories under `fixtures/invalid/`,
 * each paired with its documented expected error codes.
 */
export async function listInvalidFixtures(): Promise<InvalidFixture[]> {
  const dirs = await listChildDirs(invalidFixturesRoot);
  return Promise.all(
    dirs.map(async ({ name, dir }) => ({
      name,
      dir,
      expectedErrors: await readExpectedErrors(dir),
    })),
  );
}
