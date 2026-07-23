/**
 * Node-only BookRepoReader over a local checkout of a book repository
 * (contract §5 "local FS implementation"). Exported via `@authorbot/api/local`
 * so the Worker bundle never imports `node:fs`.
 *
 * Scans with `@authorbot/markdown` + `@authorbot/schemas`:
 * - `chapters/*.md`      → chapter frontmatter, revision, valid block ids
 * - `.authorbot/annotations/<id>/annotation.md`          → annotations
 * - `.authorbot/annotations/<id>/replies/<reply-id>.md`  → replies
 *
 * Malformed artifacts throw: rebuilding a projection from an invalid repo
 * would silently corrupt serving state (design §14.5 marks such repos
 * invalid instead).
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  isContainedRepoPath,
  MAX_TEXT_FILE_BYTES,
  MAX_TEXT_FILE_PAGE_SIZE,
  normalizeRepoPath,
  repoPathMatchesGlob,
} from "@authorbot/git-github";
import { parseChapterMarkdown } from "@authorbot/markdown";
import {
  parseDecisionArtifact,
  parseWorkItemArtifact,
} from "@authorbot/repo-coordinator";
import { annotationSchema, chapterFrontmatterSchema, replySchema } from "@authorbot/schemas";
import { sha256Hex } from "../crypto.js";
import type {
  RepositoryHistoryEntry,
  RepositoryHistoryListResult,
  RepositoryHistoryReader,
  RepositorySourceReadResult,
} from "../deps.js";
import type {
  BookRepoReader,
  BookRepoSnapshot,
  RepoAnnotationSnapshot,
  RepoChapterSnapshot,
  RepoDecisionSnapshot,
  RepoReplySnapshot,
  RepoTextFilePage,
  RepoWorkItemSnapshot,
} from "./reader.js";

const MAX_HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_OUTPUT_BYTES = 2 * 1024 * 1024;

interface GitResult {
  code: number;
  stdout: string;
}

/** Strip a leading YAML frontmatter block; returns the Markdown body. */
export function stripFrontmatter(source: string): string {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return source.trim();
  }
  const close = source.indexOf("\n---", 3);
  if (close === -1) {
    return source.trim();
  }
  const afterClose = source.indexOf("\n", close + 1 + 3);
  return (afterClose === -1 ? "" : source.slice(afterClose + 1)).trim();
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export class LocalFsBookRepoReader implements BookRepoReader, RepositoryHistoryReader {
  /** Absolute, normalized repository root - the containment base. */
  private readonly root: string;

  constructor(private readonly repoPath: string) {
    this.root = resolve(repoPath);
  }

  /**
   * Raw text of one repo-relative file, or null when absent (Phase 4 task
   * bundles and the submission-apply pipeline; reader.ts doc).
   *
   * Path traversal is refused: the resolved path must stay inside the
   * repository. "Inside" means at the root or beneath a separator - a bare
   * `startsWith` on the raw base admitted any SIBLING directory sharing the
   * base's name (`/srv/book` + `../book-secrets/creds.env` normalizes to
   * `/srv/book-secrets/creds.env`, which passes a prefix test), and comparing
   * against an unresolved base made the test meaningless for relative or
   * non-normalized roots. Absolute inputs and `..` segments are rejected
   * outright rather than normalized away, so the guard does not depend on
   * caller discipline. This is the containment boundary the `BookRepoReader`
   * contract documents and the Phase 5 GitHub reader is specified to mirror.
   */
  async readTextFile(path: string): Promise<string | null> {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
      return null;
    }
    const full = resolve(this.root, path);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      return null;
    }
    try {
      return await readFile(full, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /**
   * One bounded, newest-first page of commits that changed exactly one file.
   *
   * The path is validated before spawning Git, is passed after `--`, and Git
   * runs with literal pathspecs so a repository path can never turn into an
   * option or pathspec expression. `limit + 1` is the only lookahead retained
   * in memory; commit output is capped independently as a second bound.
   *
   * `projectId` is intentionally ignored: one Node dev process is wired to
   * exactly one `BOOK_REPO_PATH`.
   */
  async listFileHistory(
    _projectId: string,
    path: string,
    options: { page?: number; limit?: number } = {},
  ): Promise<RepositoryHistoryListResult> {
    const page = safeHistoryPage(options.page);
    const limit = safeHistoryLimit(options.limit);
    if (!isSafeGitPath(path)) {
      return { outcome: "found", entries: [], page, hasMore: false };
    }
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset)) {
      return { outcome: "found", entries: [], page, hasMore: false };
    }
    const normalized = normalizeRepoPath(path);
    let result: GitResult;
    try {
      result = await this.git(
        [
          "--no-pager",
          "--literal-pathspecs",
          "log",
          `--max-count=${String(limit + 1)}`,
          `--skip=${String(offset)}`,
          "--format=%H%x00%aI%x00%cI%x00%an%x00%P%x00%B%x00",
          "--",
          normalized,
        ],
        MAX_HISTORY_OUTPUT_BYTES,
      );
    } catch {
      return { outcome: "unavailable" };
    }
    if (result.code !== 0) {
      return { outcome: "unavailable" };
    }
    const entries = parseHistoryEntries(result.stdout);
    return {
      outcome: "found",
      entries: entries.slice(0, limit),
      page,
      hasMore: entries.length > limit,
    };
  }

  /**
   * Read a contained text file from one immutable commit.
   *
   * Both the object id and path are validated before Git sees them. A size
   * preflight keeps the blob read under the same source bound as configured
   * local file pages. Missing commits and paths are reported as not found;
   * repository/spawn failures stay distinguishable as unavailable.
   */
  async readTextFileAtCommit(
    _projectId: string,
    path: string,
    commitSha: string,
  ): Promise<RepositorySourceReadResult> {
    if (!isSafeGitPath(path) || !/^[0-9a-f]{40}$/u.test(commitSha)) {
      return { outcome: "not-found" };
    }
    const object = `${commitSha}:${normalizeRepoPath(path)}`;
    let sizeResult: GitResult;
    try {
      sizeResult = await this.git(
        ["--no-pager", "cat-file", "-s", object],
        64 * 1024,
      );
    } catch {
      return { outcome: "unavailable" };
    }
    if (sizeResult.code !== 0) {
      return { outcome: "not-found" };
    }
    const size = Number(sizeResult.stdout.trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TEXT_FILE_BYTES) {
      return { outcome: "unavailable" };
    }
    let sourceResult: GitResult;
    try {
      sourceResult = await this.git(
        ["--no-pager", "cat-file", "blob", object],
        MAX_TEXT_FILE_BYTES + 64 * 1024,
      );
    } catch {
      return { outcome: "unavailable" };
    }
    return sourceResult.code === 0
      ? { outcome: "found", source: sourceResult.stdout }
      : { outcome: "unavailable" };
  }

  private git(args: readonly string[], maxBuffer: number): Promise<GitResult> {
    return new Promise((resolveCommand, rejectCommand) => {
      execFile(
        "git",
        args,
        {
          cwd: this.root,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_OPTIONAL_LOCKS: "0",
            LC_ALL: "C",
          },
          encoding: "utf8",
          maxBuffer,
        },
        (error, stdout) => {
          if (error !== null && typeof error.code !== "number") {
            rejectCommand(error);
            return;
          }
          resolveCommand({
            code: error === null ? 0 : Number(error.code),
            stdout,
          });
        },
      );
    });
  }

  /** Local-dev counterpart to the coordinator's bounded configured-glob read. */
  async listTextFiles(
    glob: string,
    options: { after?: string; limit?: number } = {},
  ): Promise<RepoTextFilePage> {
    if (!isContainedRepoPath(glob) ||
        (options.after !== undefined && !isContainedRepoPath(options.after))) {
      return { headCommit: null, files: [], nextAfter: null };
    }
    const limit = Math.max(
      1,
      Math.min(MAX_TEXT_FILE_PAGE_SIZE, Math.trunc(options.limit ?? MAX_TEXT_FILE_PAGE_SIZE)),
    );
    const paths = await this.listMatchingPaths(glob);
    const after = options.after;
    const remaining = after === undefined ? paths : paths.filter((path) => path > after);
    const pagePaths = remaining.slice(0, limit);
    const files: Array<{ path: string; source: string }> = [];
    for (const path of pagePaths) {
      const size = await stat(resolve(this.root, path));
      if (size.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(
          `file ${path} is ${String(size.size)} bytes, above the ${String(MAX_TEXT_FILE_BYTES)}-byte source limit`,
        );
      }
      const source = await this.readTextFile(path);
      if (source !== null) files.push({ path, source });
    }
    return {
      headCommit: null,
      files,
      nextAfter:
        remaining.length > pagePaths.length && pagePaths.length > 0
          ? (pagePaths[pagePaths.length - 1] as string)
          : null,
    };
  }

  /** Walk only below the glob's fixed directory prefix and never follow symlinks. */
  private async listMatchingPaths(glob: string): Promise<string[]> {
    const segments = glob.split("/");
    const wildcard = segments.findIndex((segment) => /[*?]/u.test(segment));
    const fixed = segments.slice(0, wildcard === -1 ? Math.max(0, segments.length - 1) : wildcard);
    const startRelative = fixed.join("/");
    const start = resolve(this.root, startRelative);
    if (start !== this.root && !start.startsWith(this.root + sep)) return [];
    const paths: string[] = [];
    const walk = async (directory: string, relative: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
        const child = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(child, childRelative);
        } else if (entry.isFile() && repoPathMatchesGlob(childRelative, glob)) {
          paths.push(childRelative);
        }
      }
    };
    await walk(start, startRelative);
    return paths.sort();
  }

  async readSnapshot(): Promise<BookRepoSnapshot> {
    const { annotations, replies } = await this.readAnnotationDirs();
    const files = new Map<string, string>();
    return {
      chapters: await this.readChapters(files),
      annotations,
      replies,
      files,
      decisions: await this.readDecisions(),
      workItems: await this.readWorkItems(),
    };
  }

  /** `.authorbot/decisions/<id>.yml` → parsed decision artifacts (§4). */
  private async readDecisions(): Promise<RepoDecisionSnapshot[]> {
    const dir = join(this.repoPath, ".authorbot", "decisions");
    const decisions: RepoDecisionSnapshot[] = [];
    for (const name of (await listDir(dir)).filter((n) => n.endsWith(".yml")).sort()) {
      const source = await readFile(join(dir, name), "utf8");
      try {
        decisions.push({ parsed: parseDecisionArtifact(source) });
      } catch (error) {
        throw new Error(
          `.authorbot/decisions/${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return decisions;
  }

  /** `.authorbot/work-items/<id>.md` → parsed work-item artifacts (§4). */
  private async readWorkItems(): Promise<RepoWorkItemSnapshot[]> {
    const dir = join(this.repoPath, ".authorbot", "work-items");
    const workItems: RepoWorkItemSnapshot[] = [];
    for (const name of (await listDir(dir)).filter((n) => n.endsWith(".md")).sort()) {
      const source = await readFile(join(dir, name), "utf8");
      try {
        workItems.push({ parsed: parseWorkItemArtifact(source) });
      } catch (error) {
        throw new Error(
          `.authorbot/work-items/${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return workItems;
  }

  private async readChapters(
    files: Map<string, string>,
  ): Promise<RepoChapterSnapshot[]> {
    const dir = join(this.repoPath, "chapters");
    const chapters: RepoChapterSnapshot[] = [];
    for (const name of (await listDir(dir)).filter((n) => n.endsWith(".md")).sort()) {
      const path = `chapters/${name}`;
      const source = await readFile(join(dir, name), "utf8");
      const parsed = parseChapterMarkdown(source);
      if (parsed.frontmatterError !== undefined) {
        throw new Error(`${path}: unparseable frontmatter: ${parsed.frontmatterError}`);
      }
      const frontmatter = chapterFrontmatterSchema.safeParse(parsed.frontmatter);
      if (!frontmatter.success) {
        throw new Error(`${path}: invalid chapter frontmatter`);
      }
      // Retained on the snapshot so reconciliation re-anchors against the
      // bytes it classified, rather than re-reading live disk mid-pass.
      files.set(path, source);
      chapters.push({
        frontmatter: frontmatter.data,
        path,
        contentHash: `sha256:${await sha256Hex(source)}`,
        blockIds: parsed.blocks.markers.filter((m) => m.valid).map((m) => m.id),
      });
    }
    return chapters;
  }

  private async readAnnotationDirs(): Promise<{
    annotations: RepoAnnotationSnapshot[];
    replies: RepoReplySnapshot[];
  }> {
    const root = join(this.repoPath, ".authorbot", "annotations");
    const annotations: RepoAnnotationSnapshot[] = [];
    const replies: RepoReplySnapshot[] = [];
    for (const annotationId of (await listDir(root)).sort()) {
      const annotationPath = join(root, annotationId, "annotation.md");
      let source: string;
      try {
        source = await readFile(annotationPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue; // not an annotation directory
        }
        throw error;
      }
      const parsed = parseChapterMarkdown(source);
      const record = annotationSchema.safeParse(parsed.frontmatter);
      if (!record.success) {
        throw new Error(`.authorbot/annotations/${annotationId}/annotation.md: invalid annotation`);
      }
      annotations.push({ record: record.data, body: stripFrontmatter(source) });

      const repliesDir = join(root, annotationId, "replies");
      for (const replyName of (await listDir(repliesDir)).filter((n) => n.endsWith(".md")).sort()) {
        const replySource = await readFile(join(repliesDir, replyName), "utf8");
        const replyParsed = parseChapterMarkdown(replySource);
        const replyRecord = replySchema.safeParse(replyParsed.frontmatter);
        if (!replyRecord.success) {
          throw new Error(
            `.authorbot/annotations/${annotationId}/replies/${replyName}: invalid reply`,
          );
        }
        replies.push({ record: replyRecord.data, body: stripFrontmatter(replySource) });
      }
    }
    return { annotations, replies };
  }
}

function isSafeGitPath(path: string): boolean {
  return !path.includes("\0") && isContainedRepoPath(path);
}

function safeHistoryPage(value: number | undefined): number {
  const candidate = Math.trunc(value ?? 1);
  return Number.isSafeInteger(candidate) && candidate >= 1 ? candidate : 1;
}

function safeHistoryLimit(value: number | undefined): number {
  const candidate = Math.trunc(value ?? 25);
  return Number.isFinite(candidate)
    ? Math.max(1, Math.min(MAX_HISTORY_PAGE_SIZE, candidate))
    : 25;
}

function parseHistoryEntries(stdout: string): RepositoryHistoryEntry[] {
  const fields = stdout.split("\0");
  const entries: RepositoryHistoryEntry[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const commitSha = (fields[index] ?? "").replace(/^[\r\n]+/u, "");
    if (!/^[0-9a-f]{40}$/u.test(commitSha)) continue;
    const authoredAt = fields[index + 1] ?? "";
    const committedAt = fields[index + 2] ?? "";
    const authorName = fields[index + 3] ?? "";
    const parents = fields[index + 4] ?? "";
    const message = fields[index + 5] ?? "";
    entries.push({
      commitSha,
      message: message.trimEnd(),
      authoredAt: authoredAt === "" ? null : authoredAt,
      committedAt: committedAt === "" ? null : committedAt,
      authorName: authorName === "" ? null : authorName,
      authorLogin: null,
      parentShas: parents
        .split(/\s+/u)
        .filter((sha) => /^[0-9a-f]{40}$/u.test(sha)),
    });
  }
  return entries;
}
