/**
 * Phase 6 contract §3.5 - the direct authoring path (design §15.2
 * `chapter-submissions`).
 *
 * Phases 2b-4 gave a reader ways to *react* to prose that already exists:
 * annotate it, vote on the annotation, claim the resulting work item, submit a
 * patch. None of that helps the author of an empty book, and routing a book's
 * own author through annotation → vote → work item to write chapter one would
 * be absurd - there is nobody to vote. These two routes are the missing edge:
 * an editor or maintainer writes prose and the server does the rest.
 *
 * **What the server generates, so an author never types it:** the chapter's
 * UUIDv7 id, a block marker for every top-level block of the body, the slug
 * (derived from the title, kebab-cased, path-safe, uniqueness-checked),
 * `order` (last existing + 10), `status: draft` on create, and `revision`
 * (1 on create, +1 on every revise). The author sends `{ title, body }`.
 *
 * **What is checked here, before anything reaches the outbox** (contract
 * §3.5 "validates the result exactly as any other write"): the request shape,
 * `submissions:write` PLUS the editor-or-maintainer role, project divergence
 * (a prose write against a repository we know we mis-model is the clobber the
 * gate exists to refuse), the base-revision check that Phase 4 submissions
 * use - stale is 409, never a silent overwrite - and the Phase 0 rules over a
 * *provisional rendering* of the chapter: frontmatter schema, marker health,
 * no raw HTML, allowed URL schemes. Rendering the author's body into a real
 * chapter file to validate it is what makes "validated exactly as any other
 * write" true rather than aspirational; checking the loose body alone would
 * miss anything the frontmatter fields can break.
 *
 * **What is deliberately NOT decided here:** the final slug, `order`, marker
 * ids, and the committed bytes. Those depend on the branch head and are
 * composed at drain time by `chapter-composer.ts` - see its module docs for
 * why. This route reserves the chapter id and records the intent.
 *
 * **Publication is a separate action.** `publish`/`unpublish` are maintainer
 * routes rather than a `status` field on a submission, because deciding that
 * prose is ready to be read by the public is a different decision from
 * writing it, made by a different person on a different day. Saving never
 * publishes.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ProjectRecord, Repositories, SqlStatement } from "@authorbot/database";
import { slugSchema } from "@authorbot/schemas";
import { z } from "zod";
import { authOf, requireProjectScope, type AuthServices } from "./auth.js";
import {
  chapterValidationFindings,
  deriveSlug,
  renderFrontmatter,
  ORDER_STEP,
} from "./chapter-composer.js";
import type { AppDeps, AppEnv, Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";
import { problem } from "./problems.js";
import { proseWriteBlocked } from "./reconcile.js";
import type { ProjectSerializer } from "./serializer.js";
import { applyChapterReplacement, PatchError } from "@authorbot/markdown";

/** Outbox kind these commands enqueue (repo-coordinator vocabulary). */
export const CHAPTER_WRITE_KIND = "chapter.write";

/** Largest chapter body accepted, matching the Phase 4 submission cap. */
export const MAX_CHAPTER_BODY_BYTES = 512 * 1024;

export interface ChapterSubmissionsContext {
  app: Hono<AppEnv>;
  deps: AppDeps;
  repos: Repositories;
  clock: Clock;
  services: AuthServices;
  auth: MiddlewareHandler<AppEnv>;
  idem: MiddlewareHandler<AppEnv>;
  serialize: ProjectSerializer;
  claimStatements(c: Context<AppEnv>, status: number, body: unknown): SqlStatement[];
  commandStatements(input: {
    project: ProjectRecord;
    correlationId: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    outboxKind: string;
    outboxPayload: unknown;
    metadata?: unknown;
  }): { operationId: string; statements: SqlStatement[] };
  readJson(c: Context<AppEnv>): Promise<unknown | Response>;
  notifyMutation(projectId: string): Promise<void>;
}

const bodyField = z
  .string()
  .min(1, "body must not be empty")
  .refine(
    (value) => new TextEncoder().encode(value).length <= MAX_CHAPTER_BODY_BYTES,
    `body must be at most ${MAX_CHAPTER_BODY_BYTES} bytes`,
  );

const titleField = z.string().trim().min(1, "title must not be empty").max(300);

/**
 * Create: `{ title, body, slug?, summary? }`. Revise: `{ chapterId,
 * baseRevision, title?, body?, summary? }`. The discriminator is
 * `chapterId`'s presence, which is what an author-facing composer naturally
 * sends - a "New chapter" form has no chapter to name yet.
 */
const createChapterSchema = z.strictObject({
  title: titleField,
  body: bodyField,
  slug: slugSchema.optional(),
  summary: z.string().max(2000).optional(),
});

const reviseChapterSchema = z
  .strictObject({
    chapterId: z.string().min(1),
    baseRevision: z.number().int().min(1),
    title: titleField.optional(),
    body: bodyField.optional(),
    summary: z.string().max(2000).optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined || value.body !== undefined || value.summary !== undefined,
    "a revision must change the title, the body, or the summary",
  );

export function registerChapterSubmissionRoutes(ctx: ChapterSubmissionsContext): void {
  const { app, deps, repos, clock, services, auth, idem, serialize } = ctx;

  /**
   * Contract §3.5: `submissions:write` PLUS the editor-or-maintainer role.
   * The scope alone would very nearly do - its bundle starts at editor - but
   * "very nearly" is not an authorization rule, and a future bundle change
   * must not silently open the authoring path to contributors.
   */
  const requireAuthoringRole = (c: Context<AppEnv>): Response | null => {
    const role = authOf(c).role;
    if (role !== "editor" && role !== "maintainer") {
      return problem(c, "forbidden", {
        detail: "writing chapters requires the editor or maintainer role",
      });
    }
    return null;
  };

  const enqueue = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
    input: {
      chapterId: string;
      action: "create" | "revise" | "publish" | "unpublish";
      intent: Record<string, unknown>;
      auditAction: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Response> => {
    const a = authOf(c);
    const correlationId = c.get("correlationId");
    const command202 = ctx.commandStatements({
      project,
      correlationId,
      actorId: a.actor.id,
      action: input.auditAction,
      targetType: "chapter",
      targetId: input.chapterId,
      outboxKind: CHAPTER_WRITE_KIND,
      outboxPayload: {
        chapterId: input.chapterId,
        action: input.action,
        actorId: a.actor.id,
        intent: input.intent,
      },
      metadata: { action: input.action, ...(input.metadata ?? {}) },
    });
    const responseBody = {
      chapterId: input.chapterId,
      operationId: command202.operationId,
      correlationId,
      status: "queued",
    };
    await deps.db.batch([...command202.statements, ...ctx.claimStatements(c, 202, responseBody)]);
    await ctx.notifyMutation(project.id);
    return c.json(responseBody, 202);
  };

  // ---- create / revise (contract §3.5) --------------------------------------

  app.post("/v1/projects/:projectId/chapter-submissions", auth, idem, async (c) => {
    const guard = await requireProjectScope(c, services, "submissions:write");
    if ("response" in guard) {
      return guard.response;
    }
    const roleDenied = requireAuthoringRole(c);
    if (roleDenied !== null) {
      return roleDenied;
    }
    const raw = await ctx.readJson(c);
    if (raw instanceof Response) {
      return raw;
    }
    const isRevise =
      typeof raw === "object" && raw !== null && "chapterId" in (raw as Record<string, unknown>);
    const parsed = isRevise
      ? reviseChapterSchema.safeParse(raw)
      : createChapterSchema.safeParse(raw);
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }

    return serialize(guard.project.id, async () => {
      // Phase 5 §6 / design §14.5: a diverged repository blocks PROSE writes,
      // and a chapter is the most prose there is. Re-read inside the
      // serializer rather than trusting the guard's cached row - divergence is
      // set by a webhook reconciliation that can land between the auth check
      // and the command.
      const currentProject = await repos.projects.getById(guard.project.id);
      if (currentProject !== null) {
        const blocked = proseWriteBlocked(c, currentProject);
        if (blocked !== null) {
          return blocked;
        }
      }

      if (!isRevise) {
        const command = parsed.data as z.infer<typeof createChapterSchema>;
        // Explicit slugs are the author's word and must not be silently
        // renamed; derived slugs are the server's guess and the composer
        // de-duplicates them (`-2`, `-3`, …) against the branch.
        if (command.slug !== undefined) {
          const clash = await repos.chapters.getBySlug(guard.project.id, command.slug);
          if (clash !== null) {
            return problem(c, "state-conflict", {
              detail: `slug "${command.slug}" is already used by another chapter`,
              chapterId: clash.id,
            });
          }
        }
        const chapterId = uuidv7(clock.now());
        const findings = renderingFindings({
          chapterId,
          slug: command.slug ?? deriveSlug(command.title, ORDER_STEP),
          title: command.title,
          body: command.body,
          revision: 1,
          order: ORDER_STEP,
          status: "draft",
          actorRef: authOf(c).actorRef,
          ...(command.summary === undefined ? {} : { summary: command.summary }),
        });
        if (findings.length > 0) {
          return problem(c, "unsafe-content", { findings });
        }
        return enqueue(c, guard.project, {
          chapterId,
          action: "create",
          intent: {
            title: command.title,
            body: command.body,
            ...(command.slug === undefined ? {} : { slug: command.slug }),
            ...(command.summary === undefined ? {} : { summary: command.summary }),
          },
          auditAction: "chapter.create",
          metadata: { title: command.title },
        });
      }

      const command = parsed.data as z.infer<typeof reviseChapterSchema>;
      const chapter = await repos.chapters.getById(command.chapterId);
      if (chapter === null || chapter.projectId !== guard.project.id) {
        return problem(c, "not-found", { detail: "unknown chapter" });
      }
      // Revision safety, exactly as Phase 4 submissions (contract §3.5).
      if (command.baseRevision !== chapter.revision) {
        return problem(c, "revision-conflict", {
          detail:
            `chapter is at revision ${chapter.revision}; this revision was written against ` +
            `revision ${command.baseRevision}`,
          currentRevision: chapter.revision,
          baseRevision: command.baseRevision,
        });
      }
      if (command.body !== undefined) {
        const findings = renderingFindings({
          chapterId: chapter.id,
          slug: chapter.slug,
          title: command.title ?? chapter.title,
          body: command.body,
          revision: chapter.revision + 1,
          order: ORDER_STEP,
          status: chapter.status,
          actorRef: authOf(c).actorRef,
          ...(command.summary === undefined ? {} : { summary: command.summary }),
        });
        if (findings.length > 0) {
          return problem(c, "unsafe-content", { findings });
        }
      }
      return enqueue(c, guard.project, {
        chapterId: chapter.id,
        action: "revise",
        intent: {
          baseRevision: command.baseRevision,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.body === undefined ? {} : { body: command.body }),
          ...(command.summary === undefined ? {} : { summary: command.summary }),
        },
        auditAction: "chapter.revise",
        metadata: { baseRevision: command.baseRevision },
      });
    });
  });

  // ---- publish / unpublish (contract §3.5, maintainer only) -----------------

  for (const action of ["publish", "unpublish"] as const) {
    app.post(`/v1/projects/:projectId/chapters/:chapterId/${action}`, auth, idem, async (c) => {
      const guard = await requireProjectScope(c, services, "submissions:write");
      if ("response" in guard) {
        return guard.response;
      }
      if (authOf(c).role !== "maintainer") {
        return problem(c, "forbidden", {
          detail: `only a maintainer may ${action} a chapter`,
        });
      }

      return serialize(guard.project.id, async () => {
        const currentProject = await repos.projects.getById(guard.project.id);
        if (currentProject !== null) {
          const blocked = proseWriteBlocked(c, currentProject);
          if (blocked !== null) {
            return blocked;
          }
        }
        const chapter = await repos.chapters.getById(c.req.param("chapterId") ?? "");
        if (chapter === null || chapter.projectId !== guard.project.id) {
          return problem(c, "not-found", { detail: "unknown chapter" });
        }
        const published = chapter.status === "published";
        if (published === (action === "publish")) {
          return problem(c, "state-conflict", {
            detail: `chapter is already ${published ? "published" : "unpublished"}`,
          });
        }
        return enqueue(c, guard.project, {
          chapterId: chapter.id,
          action,
          intent: {},
          auditAction: `chapter.${action}`,
          metadata: { fromStatus: chapter.status },
        });
      });
    });
  }
}

/**
 * Phase 0 findings for the chapter this request WOULD produce: the author's
 * body rendered under real frontmatter, with markers assigned exactly as the
 * composer will assign them. `order` and the final slug are provisional (the
 * composer decides them against the branch), but neither can turn a valid
 * chapter invalid, so a clean result here means the drain will not be
 * refusing prose the author was told was accepted.
 */
function renderingFindings(input: {
  chapterId: string;
  slug: string;
  title: string;
  body: string;
  revision: number;
  order: number;
  status: "draft" | "proposed" | "published" | "archived";
  actorRef: string;
  summary?: string;
}): string[] {
  const head = renderFrontmatter({
    schema: "authorbot.chapter/v1",
    id: input.chapterId,
    slug: input.slug,
    title: input.title,
    order: input.order,
    status: input.status,
    revision: input.revision,
    authors: [{ actor: input.actorRef }],
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  });
  let rendered: string;
  try {
    rendered = applyChapterReplacement(head, input.body).source;
  } catch (error) {
    if (error instanceof PatchError) {
      // The engine refuses author-supplied marker comments and bodies with no
      // markable block at all; both are the author's problem to fix, so they
      // are findings rather than a 500.
      return [error.message];
    }
    throw error;
  }
  return chapterValidationFindings(rendered, input.chapterId);
}

function issueList(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
