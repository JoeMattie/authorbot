/**
 * Authenticated, repository-backed story-bible reads for humans and agents.
 *
 * Paths always come from the validated book.yml projection. Singleton reads
 * fetch one file; character reads go through a coordinator-owned page seam
 * whose GitHub implementation fetches at most 20 blobs per invocation.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import { parseChapterMarkdown } from "@authorbot/markdown";
import type { Repositories } from "@authorbot/database";
import {
  bookConfigSchema,
  characterSchema,
  storyGraphSchema,
  timelineSchema,
} from "@authorbot/schemas";
import { parse as parseYaml } from "yaml";
import { requireProjectScope, type AuthServices } from "./auth.js";
import { normalizeBasePath } from "./base-path.js";
import {
  readRepositoryText,
  readRepositoryTextPage,
  type AppDeps,
  type AppEnv,
} from "./deps.js";
import { sha256Hex } from "./crypto.js";
import { problem } from "./problems.js";
import {
  isSafeRepositoryDocumentPath,
  repositoryPathMatchesGlob,
  validateRepositoryDocument,
  type RepositoryDocumentKind,
} from "./repository-documents.js";

export const DEFAULT_OUTLINE_PATH = "story/outline.yml";
export const DEFAULT_TIMELINE_PATH = "story/timeline.yml";
export const DEFAULT_CHARACTERS_GLOB = "story/characters/*.md";
export const MAX_STORY_CHARACTER_PAGE_SIZE = 20;

export interface StoryBibleContext {
  app: Hono<AppEnv>;
  deps: AppDeps;
  repos: Repositories;
  services: AuthServices;
  auth: MiddlewareHandler<AppEnv>;
}

export interface StoryApiLinks {
  outline: string;
  timeline: string;
  characters: string;
}

/** Canonical same-origin links embedded in claim bundles and story responses. */
export function storyApiLinks(basePath: string | undefined, projectId: string): StoryApiLinks {
  const prefix = normalizeBasePath(basePath);
  const root = `${prefix}/v1/projects/${encodeURIComponent(projectId)}/story`;
  return {
    outline: `${root}/outline`,
    timeline: `${root}/timeline`,
    characters: `${root}/characters`,
  };
}

export function registerStoryBibleRoutes(ctx: StoryBibleContext): void {
  const { app, deps, repos, services, auth } = ctx;

  const guard = (c: Context<AppEnv>) =>
    requireProjectScope(c, services, "chapters:read", {
      editorial: { capabilities: ["chapters:read"] },
    });

  const planningFor = async (projectId: string) => {
    const row = await repos.bookConfigs.get(projectId);
    const parsed = bookConfigSchema.safeParse(row?.config);
    return parsed.success ? parsed.data.planning : undefined;
  };

  const singleton = async (
    c: Context<AppEnv>,
    kind: Extract<RepositoryDocumentKind, "outline" | "timeline">,
  ): Promise<Response> => {
    const allowed = await guard(c);
    if ("response" in allowed) return allowed.response;
    const planning = await planningFor(allowed.project.id);
    const path =
      kind === "outline"
        ? (planning?.outline ?? DEFAULT_OUTLINE_PATH)
        : (planning?.timeline ?? DEFAULT_TIMELINE_PATH);
    if (!isSafeRepositoryDocumentPath(path)) {
      return problem(c, "state-conflict", {
        detail: `book.yml configures an unsafe ${kind} path`,
      });
    }
    const read = await readRepositoryText(deps, allowed.project.id, path);
    if (read.outcome !== "found") {
      return problem(c, read.outcome === "not-found" ? "not-found" : "state-conflict", {
        detail:
          read.outcome === "not-found"
            ? `the configured ${kind} document does not exist`
            : "this deployment cannot read repository story documents",
      });
    }
    const validated = await validateRepositoryDocument({ kind, path, content: read.source });
    if (!validated.ok) {
      return problem(c, "state-conflict", {
        detail: `the configured ${kind} document failed validation`,
        issues: validated.issues,
      });
    }
    const raw = parseYaml(validated.document.content) as unknown;
    const parsed = kind === "outline" ? storyGraphSchema.safeParse(raw) : timelineSchema.safeParse(raw);
    if (!parsed.success) {
      return problem(c, "state-conflict", {
        detail: `the configured ${kind} document failed validation`,
      });
    }
    const links = storyApiLinks(deps.config.basePath, allowed.project.id);
    const common = {
      path,
      contentHash: `sha256:${await sha256Hex(read.source)}`,
      links,
    };
    return kind === "outline"
      ? c.json({ ...common, outline: parsed.data })
      : c.json({ ...common, timeline: parsed.data });
  };

  app.get("/v1/projects/:projectId/story/outline", auth, (c) => singleton(c, "outline"));
  app.get("/v1/projects/:projectId/story/timeline", auth, (c) => singleton(c, "timeline"));

  app.get("/v1/projects/:projectId/story/characters", auth, async (c) => {
    const allowed = await guard(c);
    if ("response" in allowed) return allowed.response;
    const limit = parseCharacterLimit(c);
    if (limit instanceof Response) return limit;
    const after = decodeCursor(c.req.query("cursor"));
    if (after instanceof Error) {
      return problem(c, "validation-failed", { detail: "character cursor is invalid" });
    }
    const planning = await planningFor(allowed.project.id);
    const glob = planning?.characters_glob ?? DEFAULT_CHARACTERS_GLOB;
    if (!isSafeRepositoryDocumentPath(glob)) {
      return problem(c, "state-conflict", {
        detail: "book.yml configures an unsafe character-document glob",
      });
    }
    const page = await readRepositoryTextPage(deps, allowed.project.id, glob, {
      limit,
      ...(after === null ? {} : { after }),
    });
    if (page.outcome !== "found") {
      return problem(c, "state-conflict", {
        detail: "this deployment cannot list repository character documents",
      });
    }
    const items = [];
    for (const file of page.files) {
      if (!repositoryPathMatchesGlob(file.path, glob)) {
        return problem(c, "state-conflict", {
          detail: "repository reader returned a path outside the configured character glob",
        });
      }
      const validated = await validateRepositoryDocument({
        kind: "character",
        path: file.path,
        content: file.source,
      });
      if (!validated.ok) {
        return problem(c, "state-conflict", {
          detail: `character document ${file.path} failed validation`,
          issues: validated.issues,
        });
      }
      const parsed = parseChapterMarkdown(validated.document.content);
      const character = characterSchema.safeParse(parsed.frontmatter);
      if (!character.success) {
        return problem(c, "state-conflict", {
          detail: `character document ${file.path} failed validation`,
        });
      }
      items.push({
        path: file.path,
        contentHash: `sha256:${await sha256Hex(file.source)}`,
        character: character.data,
        body: markdownBodyOf(validated.document.content),
      });
    }
    const nextAfter = page.nextAfter;
    if (
      nextAfter !== null &&
      (!isSafeRepositoryDocumentPath(nextAfter) || !repositoryPathMatchesGlob(nextAfter, glob))
    ) {
      return problem(c, "state-conflict", {
        detail: "repository reader returned an invalid character cursor",
      });
    }
    return c.json({
      items,
      nextCursor: nextAfter === null ? null : encodeCursor(nextAfter),
      links: storyApiLinks(deps.config.basePath, allowed.project.id),
    });
  });
}

function parseCharacterLimit(c: Context<AppEnv>): number | Response {
  const raw = c.req.query("limit");
  if (raw === undefined) return MAX_STORY_CHARACTER_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_STORY_CHARACTER_PAGE_SIZE) {
    return problem(c, "validation-failed", {
      detail: `limit must be an integer in 1..${MAX_STORY_CHARACTER_PAGE_SIZE}`,
    });
  }
  return value;
}

function encodeCursor(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeCursor(raw: string | undefined): string | null | Error {
  if (raw === undefined) return null;
  if (raw.length === 0 || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(raw)) {
    return new Error("invalid cursor");
  }
  try {
    const padded = raw.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(raw.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return isSafeRepositoryDocumentPath(path) ? path : new Error("invalid cursor");
  } catch {
    return new Error("invalid cursor");
  }
}

function markdownBodyOf(source: string): string {
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const close = normalized.indexOf("\n---", 4);
  if (close === -1) return "";
  const after = normalized.indexOf("\n", close + 4);
  return (after === -1 ? "" : normalized.slice(after + 1)).trim();
}
