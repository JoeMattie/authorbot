import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  BOOK_REPO_MIGRATIONS,
  MigrationApplyError,
  MigrationRegistryError,
  selectMigrations,
  type BookRepoMigration,
} from "../src/upgrade/migrations.js";
import { nodeFs } from "../src/upgrade/node-ports.js";
import { migrationRepoFor, stripJsonComments, UpgradeRepoError } from "../src/upgrade/repo.js";
import { mustParseVersion } from "../src/upgrade/semver.js";
import { validateBookRepo } from "../src/validate/index.js";
import {
  cleanupTempDirs,
  makeBookRepo,
  markerMigration,
  nonIdempotentMigration,
  snapshot,
  snapshotsEqual,
} from "./upgrade-fakes.js";

afterEach(cleanupTempDirs);

const at = mustParseVersion;

describe("the shipped registry", () => {
  it("is empty, and every entry it ever gains is well-formed", () => {
    // Empty is the correct state until a format change actually ships:
    // inventing a migration to exercise the mechanism would rewrite author
    // files for no reason. selectMigrations validates whatever lands here.
    expect(BOOK_REPO_MIGRATIONS).toHaveLength(0);
    expect(selectMigrations(BOOK_REPO_MIGRATIONS, at("1.0.0"), at("9.9.9"))).toEqual([]);
  });
});

describe("selectMigrations", () => {
  const a = markerMigration("0001-a", "1.0.0", "1.1.0");
  const b = markerMigration("0002-b", "1.1.0", "1.2.0");
  const c = markerMigration("0003-c", "1.2.0", "2.0.0");
  const registry = [c, a, b];

  it("selects what sits strictly between the current pin and the target", () => {
    expect(selectMigrations(registry, at("1.0.0"), at("1.2.0")).map((s) => s.migration.id)).toEqual([
      "0001-a",
      "0002-b",
    ]);
    expect(selectMigrations(registry, at("1.1.0"), at("1.2.0")).map((s) => s.migration.id)).toEqual([
      "0002-b",
    ]);
  });

  it("replays a chain in the order it shipped, not registry order", () => {
    expect(selectMigrations(registry, at("1.0.0"), at("2.0.0")).map((s) => s.migration.id)).toEqual([
      "0001-a",
      "0002-b",
      "0003-c",
    ]);
  });

  it("excludes migrations already applied and migrations beyond the target", () => {
    expect(selectMigrations(registry, at("1.2.0"), at("1.2.0"))).toEqual([]);
    expect(selectMigrations(registry, at("2.0.0"), at("2.0.0"))).toEqual([]);
    // A patch release between two format changes needs neither.
    expect(selectMigrations(registry, at("1.1.0"), at("1.1.3"))).toEqual([]);
  });

  it("refuses a book too old for a migration to understand", () => {
    const late: BookRepoMigration = markerMigration("0004-late", "1.5.0", "1.6.0");
    expect(() => selectMigrations([late], at("1.0.0"), at("1.6.0"))).toThrow(
      /needs a book pinned at 1\.5\.0 or newer/,
    );
  });

  it("rejects a malformed registry as a bug in the toolchain", () => {
    expect(() => selectMigrations([a, a], at("1.0.0"), at("2.0.0"))).toThrow(
      MigrationRegistryError,
    );
    expect(() =>
      selectMigrations([markerMigration("bad", "1.0.0", "not-a-version")], at("1.0.0"), at("2.0.0")),
    ).toThrow(/invalid to/);
    expect(() =>
      selectMigrations([markerMigration("backwards", "1.2.0", "1.1.0")], at("1.0.0"), at("2.0.0")),
    ).toThrow(/from \(1\.2\.0\) after to \(1\.1\.0\)/);
  });
});

describe("applyMigrations", () => {
  it("applies in order and reports every changed path", async () => {
    const repoPath = await makeBookRepo();
    const repo = migrationRepoFor(nodeFs, repoPath);
    const selected = selectMigrations(
      [markerMigration("0001-a", "1.0.0", "1.1.0"), markerMigration("0002-b", "1.1.0", "1.2.0")],
      at("1.0.0"),
      at("1.2.0"),
    );
    const result = await applyMigrations(selected, repo);
    expect(result.applied.map((entry) => entry.id)).toEqual(["0001-a", "0002-b"]);
    expect(result.changed).toEqual(["README.md"]);
    const readme = await nodeFs.readFile(path.join(repoPath, "README.md"));
    expect(readme).toContain("<!-- migrated by 0001-a -->");
    expect(readme).toContain("<!-- migrated by 0002-b -->");
  });

  it("is a no-op the second time, and leaves a repository that validates", async () => {
    const repoPath = await makeBookRepo();
    const repo = migrationRepoFor(nodeFs, repoPath);
    const selected = selectMigrations([markerMigration("0001-a", "1.0.0", "1.1.0")], at("1.0.0"), at("1.1.0"));

    const first = await applyMigrations(selected, repo);
    expect(first.changed).toEqual(["README.md"]);
    const afterFirst = await snapshot(repoPath);

    const second = await applyMigrations(selected, repo);
    expect(second.changed).toEqual([]);
    expect(second.applied[0]?.changed).toEqual([]);
    expect(snapshotsEqual(afterFirst, await snapshot(repoPath))).toBe(true);

    const report = await validateBookRepo(repoPath);
    expect(report.valid).toBe(true);
  });

  it("catches a migration that is not idempotent", async () => {
    const repoPath = await makeBookRepo();
    const repo = migrationRepoFor(nodeFs, repoPath);
    const selected = selectMigrations([nonIdempotentMigration()], at("1.0.0"), at("1.1.0"));
    await applyMigrations(selected, repo);
    const second = await applyMigrations(selected, repo);
    expect(second.changed).toEqual(["README.md"]);
  });

  it("wraps a failure in the migration itself", async () => {
    const repoPath = await makeBookRepo();
    const repo = migrationRepoFor(nodeFs, repoPath);
    const exploding: BookRepoMigration = {
      id: "0001-explodes",
      from: "1.0.0",
      to: "1.1.0",
      description: "throws",
      async apply() {
        throw new Error("boom");
      },
    };
    const selected = selectMigrations([exploding], at("1.0.0"), at("1.1.0"));
    await expect(applyMigrations(selected, repo)).rejects.toThrow(MigrationApplyError);
    await expect(applyMigrations(selected, repo)).rejects.toThrow(/0001-explodes failed: boom/);
  });

  it("does not let a migration reach outside the repository", async () => {
    const repoPath = await makeBookRepo();
    const repo = migrationRepoFor(nodeFs, repoPath);
    await expect(repo.read("../../etc/passwd")).rejects.toThrow(UpgradeRepoError);
    await expect(repo.write("../escape.txt", "x")).rejects.toThrow(/outside the repository/);
  });

  it("hides .git and node_modules from the file listing", async () => {
    const repoPath = await makeBookRepo();
    await nodeFs.writeFile(path.join(repoPath, "book.yml.bak"), "x");
    const files = await migrationRepoFor(nodeFs, repoPath).list();
    expect(files).toContain("book.yml");
    expect(files.some((file) => file.startsWith(".git/") || file.includes("node_modules"))).toBe(
      false,
    );
  });
});

describe("stripJsonComments", () => {
  it("removes comments without touching string contents", () => {
    const source = `{
      // the name
      "name": "my-book", /* inline */
      "url": "https://example.com/a//b",
      "note": "a /* not a comment */ b",
      "escaped": "quote \\" then // not a comment"
    }`;
    const parsed: unknown = JSON.parse(stripJsonComments(source));
    expect(parsed).toEqual({
      name: "my-book",
      url: "https://example.com/a//b",
      note: "a /* not a comment */ b",
      escaped: 'quote " then // not a comment',
    });
  });
});
