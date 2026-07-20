/**
 * Projection of `book.yml` into `book_configs` (Phase 6 contract §3.6).
 *
 * The settings API needs the book's current config on the request path — to
 * render the Settings view, to read-modify-write a PATCH, and to resolve
 * governance rules on every vote. Reading it from GitHub each time would put a
 * network round trip in front of every vote, so it is projected exactly like
 * chapters and annotations are: Git is the truth, this table is the copy.
 *
 * The one rule that makes the copy safe is `pending_git` deference. A settings
 * PATCH writes the new config to `book_configs` immediately (so the change is
 * live on the next request) and queues the commit. Until that commit lands, the
 * repository still holds the OLD `book.yml` — so a projection pass that ran in
 * the meantime and blindly wrote what it read would silently revert the
 * maintainer's change while its commit was still in the outbox. A pending row
 * is therefore left alone; the finalize batch flips it to `committed` when the
 * commit lands, and the next pass reads back the same bytes and agrees.
 */
import type { Repositories, SqlDatabase } from "@authorbot/database";
import { bookConfigSchema, type BookConfig } from "@authorbot/schemas";
import { toTimestamp } from "@authorbot/domain";
import { parse as parseYaml } from "yaml";
import type { Clock } from "./deps.js";
import type { BookRepoReader } from "./projection/reader.js";

/**
 * Repo-relative path of the book config (design section 8.2).
 *
 * Declared here rather than imported from `@authorbot/repo-coordinator`, whose
 * barrel pulls in `LocalGitAdapter` and therefore `node:child_process` — this
 * module is reached from `reconcile.ts` and must stay Worker-safe. A test in
 * the repo-coordinator suite pins the two constants equal.
 */
export const BOOK_CONFIG_PATH = "book.yml";

export interface ProjectBookConfigContext {
  db: SqlDatabase;
  repos: Repositories;
  clock: Clock;
}

export type ProjectBookConfigOutcome =
  /** `book.yml` read, validated, and written to `book_configs`. */
  | { outcome: "projected"; config: BookConfig }
  /** No `book.yml` in the repository (or the reader could not produce it). */
  | { outcome: "absent" }
  /** A local settings write has not reached Git yet; the row is left alone. */
  | { outcome: "deferred-to-pending" }
  /**
   * `book.yml` exists but is not a valid `authorbot.book/v1` document. NOT an
   * error that aborts the projection pass: the chapters and annotations in the
   * same snapshot are still projectable, and refusing them because the config
   * is malformed would take a book offline over a typo in its title. The
   * previous config row is kept and the reason is returned for auditing.
   */
  | { outcome: "invalid"; reason: string };

/**
 * Read `book.yml` from the snapshot's tree and project it. Never throws for
 * repository-content reasons — only for genuine infrastructure failures, which
 * the caller already handles.
 */
export async function projectBookConfig(
  ctx: ProjectBookConfigContext,
  projectId: string,
  reader: BookRepoReader,
  options: { sourceCommit?: string | null; files?: ReadonlyMap<string, string> } = {},
): Promise<ProjectBookConfigOutcome> {
  const existing = await ctx.repos.bookConfigs.get(projectId);
  if (existing !== null && existing.status === "pending_git") {
    return { outcome: "deferred-to-pending" };
  }

  // Prefer the snapshot's own file text so the config comes from the SAME tree
  // as the chapters projected beside it — the invariant reader.ts documents.
  const source =
    options.files?.get(BOOK_CONFIG_PATH) ??
    // `readTextFile` is optional on the reader interface; a reader without it
    // simply cannot supply the config, which is the `absent` outcome.
    (reader.readTextFile === undefined ? null : await reader.readTextFile(BOOK_CONFIG_PATH));
  if (source === null || source === undefined) {
    return { outcome: "absent" };
  }

  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return { outcome: "invalid", reason: `book.yml is not valid YAML: ${String(error)}` };
  }
  const parsed = bookConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { outcome: "invalid", reason: `book.yml failed authorbot.book/v1 validation: ${issues}` };
  }

  const at = toTimestamp(ctx.clock.now());
  await ctx.repos.bookConfigs.upsert({
    projectId,
    config: parsed.data,
    status: "committed",
    gitOperationId: null,
    sourceCommit: options.sourceCommit ?? null,
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  });
  return { outcome: "projected", config: parsed.data };
}
