import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildManifestSchema,
  type BuildManifest,
  type BuildManifestChapter,
} from "@authorbot/schemas";
import type { SiteChapter } from "./model.js";

/**
 * Build manifest assembly — `authorbot.build/v1` (Phase 1 contract
 * section 3, design section 17.2).
 */

const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

function git(args: string[], cwd: string): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
}

/**
 * `git rev-parse HEAD` when `repoPath` is inside a git work tree, else null
 * (also null when git is unavailable or the repo has no commits yet).
 */
export function detectGitCommit(repoPath: string): string | null {
  if (git(["rev-parse", "--is-inside-work-tree"], repoPath) !== "true") {
    return null;
  }
  const head = git(["rev-parse", "HEAD"], repoPath);
  return head !== undefined && COMMIT_SHA.test(head) ? head : null;
}

/** The publisher's own package version (manifest `publisher_version`). */
export function publisherVersion(): string {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), "utf8")) as {
    version?: unknown;
  };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

export interface CreateManifestOptions {
  commit: string | null;
  builtAt?: string;
  baseUrl?: string | undefined;
  chapters: readonly SiteChapter[];
}

/** Assemble and self-validate the manifest for a finished build. */
export function createManifest(options: CreateManifestOptions): BuildManifest {
  const chapters: BuildManifestChapter[] = options.chapters.map((chapter) => ({
    id: chapter.id,
    slug: chapter.slug,
    revision: chapter.revision,
    title: chapter.title,
    status: chapter.status,
  }));
  const manifest: BuildManifest = {
    schema: "authorbot.build/v1",
    commit: options.commit,
    built_at: options.builtAt ?? new Date().toISOString(),
    publisher_version: publisherVersion(),
    chapters,
  };
  if (options.baseUrl !== undefined && options.baseUrl !== "") {
    manifest.base_url = options.baseUrl;
  }
  return buildManifestSchema.parse(manifest);
}
