/**
 * Phase 11 Slice 7: bounded chapter history and restore-as-proposal.
 *
 * Listing reads commit metadata only. A detail request resolves one selected
 * snapshot and at most one comparison snapshot, keeping a Worker invocation
 * bounded even for a long-lived book.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  type ChapterProjectionRecord,
  type ProjectRecord,
  type Repositories,
  type RevisionProposalRecord,
  type SqlRow,
  type SqlStatement,
} from "@authorbot/database";
import type { EditorialCapability } from "@authorbot/domain";
import { parseChapterMarkdown, parseProseMarkdown, scanSafety, stripBlockMarkers } from "@authorbot/markdown";
import { chapterFrontmatterSchema } from "@authorbot/schemas";
import { z } from "zod";
import { authOf, requireProjectScope, type AuthServices } from "./auth.js";
import { sha256Hex } from "./crypto.js";
import {
  readRepositoryText,
  type AppDeps,
  type AppEnv,
  type Clock,
  type RepositoryHistoryEntry,
} from "./deps.js";
import { uuidv7 } from "./ids.js";
import { problem } from "./problems.js";
import { proseWriteBlocked } from "./reconcile.js";
import { createRevisionDiff } from "./revision-diff.js";
import type { ProjectSerializer } from "./serializer.js";

const MAX_HISTORY_PAGE = 50;
const revisionParamSchema = z.coerce.number().int().min(1);
const compareSchema = z.enum(["previous", "current"]);

export interface ChapterHistoryContext {
  app: Hono<AppEnv>;
  deps: AppDeps;
  repos: Repositories;
  clock: Clock;
  services: AuthServices;
  auth: MiddlewareHandler<AppEnv>;
  idem: MiddlewareHandler<AppEnv>;
  serialize: ProjectSerializer;
  claimStatements(c: Context<AppEnv>, status: number, body: unknown): SqlStatement[];
  parseLimit(c: Context<AppEnv>): number | Response;
  now(): string;
}

interface HistoryActor {
  id: string;
  displayName: string;
  type: string | null;
}

interface HistoryRevision {
  revision: number;
  contentHash: string | null;
  commitSha: string | null;
  createdAt: string;
  author: HistoryActor | null;
  changeSummary: string | null;
  origin: string | null;
  isCurrent: boolean;
}

interface HistorySnapshot extends HistoryRevision {
  contentHash: string;
  content: string;
}

interface KnownRevision {
  changeSummary: string | null;
  origin: string;
  author: HistoryActor | null;
}

interface KnownRevisionRow extends SqlRow {
  commit_sha: string;
  change_summary: string | null;
  origin: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_type: string | null;
}

export function registerChapterHistoryRoutes(ctx: ChapterHistoryContext): void {
  const { app, deps, repos, clock, services, auth, idem, serialize, now } = ctx;

  const guard = (c: Context<AppEnv>, capabilities: readonly EditorialCapability[]) =>
    requireProjectScope(c, services, null, {
      requireMembership: true,
      editorial: { capabilities },
    });

  const chapterOrProblem = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
  ): Promise<ChapterProjectionRecord | Response> => {
    const chapter = await repos.chapters.getById(c.req.param("chapterId") ?? "");
    if (chapter === null || chapter.projectId !== project.id) {
      return problem(c, "not-found", { detail: "unknown chapter" });
    }
    return chapter;
  };

  const historyReaderOrProblem = (
    c: Context<AppEnv>,
  ): NonNullable<AppDeps["repositoryHistoryReader"]> | Response =>
    deps.repositoryHistoryReader ??
    problem(c, "state-conflict", {
      detail: "this deployment cannot read repository history",
    });

  const knownRevisions = async (
    projectId: string,
    chapterId: string,
    commits: readonly string[],
  ): Promise<Map<string, KnownRevision>> => {
    if (commits.length === 0) return new Map();
    const placeholders = commits.map(() => "?").join(", ");
    const rows = await deps.db
      .prepare(
        `SELECT rp.commit_sha, rp.change_summary, rp.origin,
                actor.id AS actor_id, actor.display_name AS actor_name,
                actor.type AS actor_type
           FROM revision_proposals rp
           LEFT JOIN actors actor ON actor.id = rp.author_actor_id
          WHERE rp.project_id = ? AND rp.chapter_id = ?
            AND rp.commit_sha IN (${placeholders})`,
      )
      .bind(projectId, chapterId, ...commits)
      .all<KnownRevisionRow>();
    return new Map(
      rows.map((row) => [
        row.commit_sha,
        {
          changeSummary: row.change_summary,
          origin: row.origin,
          author:
            row.actor_id === null
              ? null
              : {
                  id: row.actor_id,
                  displayName: row.actor_name ?? row.actor_id,
                  type: row.actor_type,
                },
        },
      ]),
    );
  };

  const revisionRows = async (
    project: ProjectRecord,
    chapter: ChapterProjectionRecord,
    entries: readonly RepositoryHistoryEntry[],
    page: number,
    limit: number,
  ): Promise<HistoryRevision[]> => {
    const known = await knownRevisions(
      project.id,
      chapter.id,
      entries.map(({ commitSha }) => commitSha),
    );
    const offset = (page - 1) * limit;
    return entries.flatMap((entry, index) => {
      const revision = chapter.revision - offset - index;
      if (revision < 1) return [];
      const retained = known.get(entry.commitSha);
      return [
        {
          revision,
          contentHash: revision === chapter.revision ? chapter.contentHash : null,
          commitSha: entry.commitSha,
          createdAt: entry.committedAt ?? entry.authoredAt ?? chapter.updatedAt,
          author: retained?.author ?? actorFromCommit(entry),
          changeSummary: retained?.changeSummary ?? firstCommitLine(entry.message),
          origin: retained?.origin ?? "repository_commit",
          isCurrent: revision === chapter.revision,
        },
      ];
    });
  };

  const currentRevision = (
    chapter: ChapterProjectionRecord,
    firstPage: readonly HistoryRevision[] = [],
  ): HistoryRevision & { status: string } => {
    const row = firstPage.find(({ revision }) => revision === chapter.revision);
    return {
      ...(row ?? {
        revision: chapter.revision,
        contentHash: chapter.contentHash,
        commitSha: chapter.headCommit,
        createdAt: chapter.updatedAt,
        author: null,
        changeSummary: null,
        origin: null,
        isCurrent: true,
      }),
      status: chapter.status,
    };
  };

  const historyPage = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
    chapter: ChapterProjectionRecord,
    page: number,
  ): Promise<RepositoryHistoryEntry[] | Response> => {
    const reader = historyReaderOrProblem(c);
    if (reader instanceof Response) return reader;
    const result = await reader.listFileHistory(project.id, chapter.path, {
      page,
      limit: MAX_HISTORY_PAGE,
    });
    if (result.outcome !== "found") {
      return problem(c, "state-conflict", {
        detail: "repository history is unavailable",
      });
    }
    return result.entries;
  };

  const snapshotFor = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
    chapter: ChapterProjectionRecord,
    revision: number,
  ): Promise<HistorySnapshot | Response> => {
    if (revision > chapter.revision) {
      return problem(c, "not-found", { detail: "unknown chapter revision" });
    }
    const offset = chapter.revision - revision;
    const page = Math.floor(offset / MAX_HISTORY_PAGE) + 1;
    const index = offset % MAX_HISTORY_PAGE;
    const entries = await historyPage(c, project, chapter, page);
    if (entries instanceof Response) return entries;
    const entry = entries[index];
    if (entry === undefined) {
      return problem(c, "not-found", { detail: "unknown chapter revision" });
    }
    let source: string;
    if (revision === chapter.revision) {
      const current = await readRepositoryText(deps, project.id, chapter.path);
      if (current.outcome !== "found") {
        return problem(c, "state-conflict", {
          detail: "the current chapter source is unavailable",
        });
      }
      source = current.source;
    } else {
      const reader = historyReaderOrProblem(c);
      if (reader instanceof Response) return reader;
      const historical = await reader.readTextFileAtCommit(
        project.id,
        chapter.path,
        entry.commitSha,
      );
      if (historical.outcome !== "found") {
        return problem(c, historical.outcome === "not-found" ? "not-found" : "state-conflict", {
          detail: "the selected chapter revision could not be read",
        });
      }
      source = historical.source;
    }
    const parsed = parseChapterMarkdown(source);
    const frontmatter = chapterFrontmatterSchema.safeParse(parsed.frontmatter);
    if (
      !frontmatter.success ||
      frontmatter.data.id !== chapter.id ||
      frontmatter.data.revision !== revision
    ) {
      return problem(c, "state-conflict", {
        detail: "the selected commit does not contain the expected chapter revision",
      });
    }
    const [row] = await revisionRows(project, chapter, [entry], page, MAX_HISTORY_PAGE);
    if (row === undefined) {
      return problem(c, "not-found", { detail: "unknown chapter revision" });
    }
    return {
      ...row,
      revision,
      contentHash: `sha256:${await sha256Hex(source)}`,
      content: stripBlockMarkers(chapterBodyOf(source)).trim(),
      isCurrent: revision === chapter.revision,
    };
  };

  app.get("/v1/projects/:projectId/chapters/:chapterId/history", auth, async (c) => {
    const allowed = await guard(c, ["history:read"]);
    if ("response" in allowed) return allowed.response;
    const chapter = await chapterOrProblem(c, allowed.project);
    if (chapter instanceof Response) return chapter;
    const requestedLimit = ctx.parseLimit(c);
    if (requestedLimit instanceof Response) return requestedLimit;
    const limit = Math.min(requestedLimit, MAX_HISTORY_PAGE);
    const cursor = c.req.query("cursor") ?? "1";
    const page = Number(cursor);
    if (!Number.isSafeInteger(page) || page < 1) {
      return problem(c, "validation-failed", { detail: "history cursor is invalid" });
    }
    const reader = historyReaderOrProblem(c);
    if (reader instanceof Response) return reader;
    const result = await reader.listFileHistory(allowed.project.id, chapter.path, {
      page,
      limit,
    });
    if (result.outcome !== "found") {
      return problem(c, "state-conflict", { detail: "repository history is unavailable" });
    }
    const items = await revisionRows(allowed.project, chapter, result.entries, page, limit);
    return c.json({
      items,
      current: currentRevision(chapter, page === 1 ? items : []),
      nextCursor: result.hasMore ? String(page + 1) : null,
    });
  });

  app.get(
    "/v1/projects/:projectId/chapters/:chapterId/history/:revision",
    auth,
    async (c) => {
      const allowed = await guard(c, ["history:read"]);
      if ("response" in allowed) return allowed.response;
      const parsedRevision = revisionParamSchema.safeParse(c.req.param("revision"));
      const parsedCompare = compareSchema.safeParse(c.req.query("compare") ?? "previous");
      if (!parsedRevision.success || !parsedCompare.success) {
        return problem(c, "validation-failed", {
          detail: "revision and compare must identify a valid history comparison",
        });
      }
      const chapter = await chapterOrProblem(c, allowed.project);
      if (chapter instanceof Response) return chapter;
      const selected = await snapshotFor(c, allowed.project, chapter, parsedRevision.data);
      if (selected instanceof Response) return selected;
      const comparisonRevision =
        parsedCompare.data === "current"
          ? selected.revision === chapter.revision
            ? null
            : chapter.revision
          : selected.revision <= 1
            ? null
            : selected.revision - 1;
      const comparison =
        comparisonRevision === null
          ? null
          : await snapshotFor(c, allowed.project, chapter, comparisonRevision);
      if (comparison instanceof Response) return comparison;
      const diff =
        comparison === null
          ? null
          : createHistoryDiff(
              parsedCompare.data === "previous" ? comparison : selected,
              parsedCompare.data === "previous" ? selected : comparison,
              chapter.path,
            );
      return c.json({
        chapterId: chapter.id,
        compare: parsedCompare.data,
        selected,
        comparison,
        current: currentRevision(chapter, selected.isCurrent ? [selected] : []),
        diff,
      });
    },
  );

  app.post(
    "/v1/projects/:projectId/chapters/:chapterId/history/:revision/restore",
    auth,
    idem,
    async (c) => {
      // A restore request reads deliberately removed or unpublished prose
      // before retaining it in a revision proposal. Requiring only proposal
      // write would let a token pair `revisions:write` with `revisions:read`
      // and use the new proposal as a history-read side channel.
      const allowed = await guard(c, ["history:read", "revisions:write"]);
      if ("response" in allowed) return allowed.response;
      const parsedRevision = revisionParamSchema.safeParse(c.req.param("revision"));
      if (!parsedRevision.success) {
        return problem(c, "validation-failed", { detail: "unknown chapter revision" });
      }
      return serialize(allowed.project.id, async () => {
        const project = (await repos.projects.getById(allowed.project.id)) ?? allowed.project;
        const blocked = proseWriteBlocked(c, project);
        if (blocked !== null) return blocked;
        const chapter = await chapterOrProblem(c, project);
        if (chapter instanceof Response) return chapter;
        if (parsedRevision.data >= chapter.revision) {
          return problem(c, "state-conflict", {
            detail: "only an older chapter revision can be proposed for restoration",
          });
        }
        const [selected, currentRead] = await Promise.all([
          snapshotFor(c, project, chapter, parsedRevision.data),
          readRepositoryText(deps, project.id, chapter.path),
        ]);
        if (selected instanceof Response) return selected;
        if (currentRead.outcome !== "found") {
          return problem(c, "state-conflict", {
            detail: "the current chapter source is unavailable",
          });
        }
        const currentHash = `sha256:${await sha256Hex(currentRead.source)}`;
        if (currentHash !== chapter.contentHash) {
          return problem(c, "revision-conflict", {
            detail: "the chapter moved while the restore proposal was being created",
            currentContentHash: currentHash,
          });
        }
        const baseContent = stripBlockMarkers(chapterBodyOf(currentRead.source)).trim();
        if (baseContent === selected.content) {
          return problem(c, "state-conflict", {
            detail: "the selected historical text is identical to the current chapter",
          });
        }
        const findings = proposedContentFindings(selected.content);
        if (findings.length > 0) {
          return problem(c, "unsafe-content", { findings });
        }

        const actor = authOf(c);
        const proposalId = uuidv7(clock.now());
        const timestamp = now();
        const correlationId = c.get("correlationId");
        const responseBody = { proposalId, status: "pending_review", correlationId };
        const proposal: RevisionProposalRecord = {
          id: proposalId,
          projectId: project.id,
          chapterId: chapter.id,
          targetKind: "chapter",
          targetId: chapter.id,
          targetPath: chapter.path,
          proposalType: "chapter_replacement",
          origin: "history_restore",
          workItemId: null,
          submissionId: null,
          authorActorId: actor.actor.id,
          baseRevision: chapter.revision,
          baseContentHash: chapter.contentHash,
          baseContent,
          proposedContent: selected.content,
          changeSummary: `Propose restoring revision ${String(selected.revision)}`,
          notes: null,
          status: "pending_review",
          reviewedByActorId: null,
          reviewedAt: null,
          reviewReason: null,
          gitOperationId: null,
          resultingRevision: null,
          commitSha: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await deps.db.batch([
          repos.revisionProposals.insertStatement(proposal),
          repos.auditEvents.insertStatement({
            id: uuidv7(clock.now()),
            projectId: project.id,
            actorId: actor.actor.id,
            action: "revision_proposal.restore_history",
            targetType: "revision_proposal",
            targetId: proposalId,
            correlationId,
            metadata: {
              chapterId: chapter.id,
              selectedRevision: selected.revision,
              selectedCommitSha: selected.commitSha,
            },
            createdAt: timestamp,
          }),
          repos.events.appendStatement({
            projectId: project.id,
            type: "revision_proposal_created",
            payload: {
              proposalId,
              chapterId: chapter.id,
              proposalType: proposal.proposalType,
              origin: proposal.origin,
              authorActorId: actor.actor.id,
              correlationId,
            },
            createdAt: timestamp,
          }),
          ...ctx.claimStatements(c, 201, responseBody),
        ]);
        return c.json(responseBody, 201);
      });
    },
  );
}

function actorFromCommit(entry: RepositoryHistoryEntry): HistoryActor | null {
  const displayName = entry.authorName ?? entry.authorLogin;
  if (displayName === null) return null;
  return {
    id: entry.authorLogin === null ? entry.commitSha : `github:${entry.authorLogin}`,
    displayName,
    type: entry.authorLogin === null ? null : "human",
  };
}

function firstCommitLine(message: string): string | null {
  const first = message.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return first === "" ? null : first.slice(0, 2000);
}

function createHistoryDiff(
  from: HistorySnapshot,
  to: HistorySnapshot,
  path: string,
): {
  fromRevision: number;
  toRevision: number;
  unifiedDiff: string | null;
  computationLimited: boolean;
} {
  return {
    fromRevision: from.revision,
    toRevision: to.revision,
    ...createRevisionDiff({
      baseContent: from.content,
      proposedContent: to.content,
      baseRevision: from.revision,
      path,
    }),
  };
}

function chapterBodyOf(source: string): string {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const close = normalized.indexOf("\n---\n", 3);
  return close === -1 ? normalized : normalized.slice(close + 5);
}

function proposedContentFindings(content: string): string[] {
  const findings: string[] = [];
  if (content.includes("<!--") && /authorbot:/iu.test(content)) {
    findings.push("authorbot comments are not allowed in proposed chapter content");
  }
  const scan = scanSafety(parseProseMarkdown(content).ast);
  if (scan.rawHtml.length > 0) findings.push("raw HTML is forbidden");
  for (const url of scan.forbiddenUrls) {
    findings.push(`URL scheme "${url.scheme}" is forbidden`);
  }
  return findings;
}
