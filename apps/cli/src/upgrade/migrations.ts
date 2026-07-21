/**
 * Book-repo format migrations (ADR-0021 §2, §3 step 2).
 *
 * The compatibility promise is that "every format change ships with an
 * automated migration". This module is where such a migration lives. A
 * release declares migrations here; `authorbot upgrade` selects the ones that
 * sit between the book's current pin and the target release, applies them to
 * a *working copy*, and only then decides whether the result is committable.
 *
 * ## Writing a migration
 *
 * ```ts
 * export const migration: BookRepoMigration = {
 *   id: "0001-chapter-v2",
 *   from: "1.4.0",   // the oldest pin this transform understands
 *   to: "1.5.0",     // the release that introduced the format change
 *   description: "Rewrite chapter frontmatter to authorbot.chapter/v2",
 *   async apply(repo) {
 *     const changed: string[] = [];
 *     for (const file of await repo.list()) {
 *       if (!file.startsWith("chapters/")) continue;
 *       const before = await repo.read(file);
 *       const after = before.replace("authorbot.chapter/v1", "authorbot.chapter/v2");
 *       if (after !== before) {
 *         await repo.write(file, after);
 *         changed.push(file);
 *       }
 *     }
 *     return changed;
 *   },
 * };
 * ```
 *
 * Two rules are not negotiable, and both are enforced by the upgrade command
 * rather than trusted:
 *
 * 1. **Idempotent.** Applying a migration to an already-migrated repository
 *    must change nothing and report no changed paths. `upgrade` may run a
 *    migration against a working copy more than once (a dry run followed by
 *    the real thing), and an author may re-run `upgrade` after a failure.
 * 2. **Leaves a repository that validates.** `upgrade` validates before and
 *    after and aborts the whole operation on any *new* error, so a migration
 *    that breaks a book cannot reach a pull request. That is a backstop, not
 *    a licence: the migration is expected to be correct.
 *
 * Report every path you touched. The changed set is what gets written back to
 * the author's repository and what goes into the migration commit; a path you
 * modify but do not report is a change that silently does not ship.
 */

import { compareVersions, mustParseVersion, type SemVer } from "./semver.js";

/**
 * A migration's view of the book repository: a flat, path-addressed file
 * store rooted at the repository root, using repo-relative posix paths.
 *
 * It is deliberately narrower than `node:fs`. A migration cannot escape the
 * repository, cannot reach the network, and cannot see `.git`, so the worst a
 * buggy migration can do is produce a bad diff — which validation then
 * catches before it becomes a commit.
 */
export interface MigrationRepo {
  /** Every file in the repository, repo-relative posix paths, sorted. */
  list(): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  /** Read a UTF-8 file. Rejects if the path does not exist. */
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface BookRepoMigration {
  /** Stable identifier, used in output and in the commit message. */
  readonly id: string;
  /** Oldest pin this transform understands. */
  readonly from: string;
  /** The release that introduced the format change. */
  readonly to: string;
  /** One line, author-facing: what changes in their files and why. */
  readonly description: string;
  /**
   * Transform the repository in place. Returns the repo-relative paths that
   * were changed — empty when there was nothing to do, which is what a
   * second application must always return.
   */
  apply(repo: MigrationRepo): Promise<string[]>;
}

/**
 * The migrations this release of the toolchain knows how to run.
 *
 * Empty, and correctly so: no book-repo format change has shipped yet, and
 * inventing one to exercise the mechanism would rewrite author files for no
 * reason. The mechanism itself is tested against fixture migrations; when a
 * real format change lands, its migration is appended here and the upgrade
 * path already works.
 */
export const BOOK_REPO_MIGRATIONS: readonly BookRepoMigration[] = [];

export interface SelectedMigration {
  readonly migration: BookRepoMigration;
  readonly to: SemVer;
}

/** Thrown when a migration in the registry is malformed (a bug in us). */
export class MigrationRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationRegistryError";
  }
}

/**
 * The migrations that must run to move a book from `current` to `target`.
 *
 * A migration is selected when the target release includes it (`to <=
 * target`) and the book has not already had it applied (`to > current`).
 *
 * `from` is a floor, checked against the version the book has reached *so far
 * in the chain* rather than against its starting pin. That distinction is the
 * whole point of a chain: a book at 1.0.0 moving to 1.2.0 may legitimately
 * run a 1.0.0→1.1.0 migration and then a 1.1.0→1.2.0 one, and only a book
 * that no migration can bridge up to the floor is genuinely too old.
 *
 * The result is ordered by the release that introduced each migration, so a
 * chain of format changes replays in the order it shipped.
 */
export function selectMigrations(
  registry: readonly BookRepoMigration[],
  current: SemVer,
  target: SemVer,
): SelectedMigration[] {
  const candidates: SelectedMigration[] = [];
  const seen = new Set<string>();
  for (const migration of registry) {
    if (seen.has(migration.id)) {
      throw new MigrationRegistryError(`duplicate migration id: ${migration.id}`);
    }
    seen.add(migration.id);
    const to = parseOrThrow(migration, "to", migration.to);
    const from = parseOrThrow(migration, "from", migration.from);
    if (compareVersions(from, to) > 0) {
      throw new MigrationRegistryError(
        `migration ${migration.id} has from (${migration.from}) after to (${migration.to})`,
      );
    }
    if (compareVersions(to, current) <= 0 || compareVersions(to, target) > 0) {
      continue;
    }
    candidates.push({ migration, to });
  }
  candidates.sort((a, b) => {
    const byVersion = compareVersions(a.to, b.to);
    return byVersion !== 0 ? byVersion : a.migration.id.localeCompare(b.migration.id);
  });

  let reached = current;
  for (const { migration, to } of candidates) {
    const from = mustParseVersion(migration.from);
    if (compareVersions(reached, from) < 0) {
      throw new MigrationRegistryError(
        `migration ${migration.id} needs a book pinned at ${migration.from} or newer, ` +
          `but this book is at ${reached.raw}; upgrade to ${migration.from} first`,
      );
    }
    reached = compareVersions(to, reached) > 0 ? to : reached;
  }
  return candidates;
}

function parseOrThrow(migration: BookRepoMigration, field: string, value: string): SemVer {
  try {
    return mustParseVersion(value);
  } catch {
    throw new MigrationRegistryError(`migration ${migration.id} has an invalid ${field}: ${value}`);
  }
}

export interface AppliedMigration {
  readonly id: string;
  readonly description: string;
  readonly to: string;
  /** Repo-relative paths this migration changed, sorted and de-duplicated. */
  readonly changed: string[];
}

export interface MigrationRunResult {
  readonly applied: AppliedMigration[];
  /** Union of every changed path, sorted. */
  readonly changed: string[];
}

/** Thrown when a migration's own `apply` fails. */
export class MigrationApplyError extends Error {
  readonly migrationId: string;
  constructor(migrationId: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`migration ${migrationId} failed: ${detail}`);
    this.name = "MigrationApplyError";
    this.migrationId = migrationId;
  }
}

/** Apply the selected migrations, in order, to a working copy. */
export async function applyMigrations(
  selected: readonly SelectedMigration[],
  repo: MigrationRepo,
): Promise<MigrationRunResult> {
  const applied: AppliedMigration[] = [];
  const allChanged = new Set<string>();
  for (const { migration, to } of selected) {
    let changed: string[];
    try {
      changed = await migration.apply(repo);
    } catch (error) {
      throw new MigrationApplyError(migration.id, error);
    }
    const unique = [...new Set(changed)].sort();
    for (const file of unique) {
      allChanged.add(file);
    }
    applied.push({
      id: migration.id,
      description: migration.description,
      to: to.raw,
      changed: unique,
    });
  }
  return { applied, changed: [...allChanged].sort() };
}
