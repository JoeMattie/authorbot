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
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseChapterMarkdown } from "@authorbot/markdown";
import {
  parseDecisionArtifact,
  parseWorkItemArtifact,
} from "@authorbot/repo-coordinator";
import { annotationSchema, chapterFrontmatterSchema, replySchema } from "@authorbot/schemas";
import { sha256Hex } from "../crypto.js";
import type {
  BookRepoReader,
  BookRepoSnapshot,
  RepoAnnotationSnapshot,
  RepoChapterSnapshot,
  RepoDecisionSnapshot,
  RepoReplySnapshot,
  RepoWorkItemSnapshot,
} from "./reader.js";

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

export class LocalFsBookRepoReader implements BookRepoReader {
  constructor(private readonly repoPath: string) {}

  /**
   * Raw text of one repo-relative file, or null when absent (Phase 4 task
   * bundles and the submission-apply pipeline; reader.ts doc). Path traversal
   * is refused: the resolved path must stay inside the repository.
   */
  async readTextFile(path: string): Promise<string | null> {
    const full = join(this.repoPath, path);
    if (!full.startsWith(this.repoPath)) {
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

  async readSnapshot(): Promise<BookRepoSnapshot> {
    const { annotations, replies } = await this.readAnnotationDirs();
    return {
      chapters: await this.readChapters(),
      annotations,
      replies,
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

  private async readChapters(): Promise<RepoChapterSnapshot[]> {
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
