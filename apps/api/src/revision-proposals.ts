/**
 * Phase 11 chapter and summary revision proposals.
 *
 * Proposal snapshots are immutable. Review is a compare-and-swap transition,
 * batched with every linked submission/work transition and Git outbox row so
 * two reviewers cannot enqueue two applications of the same proposal.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  isConstraintError,
  type ChapterProjectionRecord,
  type ProjectRecord,
  type Repositories,
  type RevisionProposalRecord,
  type RevisionProposalStatus,
  type SqlRow,
  type SqlStatement,
} from "@authorbot/database";
import { parseChapterMarkdown, parseProseMarkdown, scanSafety, stripBlockMarkers } from "@authorbot/markdown";
import { bookConfigSchema, chapterFrontmatterSchema } from "@authorbot/schemas";
import { z } from "zod";
import { authOf, requireProjectScope, type AuthServices } from "./auth.js";
import { CHAPTER_WRITE_KIND, MAX_CHAPTER_BODY_BYTES } from "./chapter-submissions.js";
import { readRepositoryText, type AppDeps, type AppEnv, type Clock } from "./deps.js";
import { sha256Hex } from "./crypto.js";
import { uuidv7 } from "./ids.js";
import { SUBMISSION_APPLY_KIND } from "./phase4.js";
import { problem } from "./problems.js";
import { proseWriteBlocked } from "./reconcile.js";
import {
  isSafeRepositoryDocumentPath,
  repositoryPathMatchesGlob,
  validateRepositoryDocument,
  type RepositoryDocumentKind,
  type ValidatedRepositoryDocument,
} from "./repository-documents.js";
import { createRevisionDiff } from "./revision-diff.js";
import type { ProjectSerializer } from "./serializer.js";

export interface RevisionProposalsContext {
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
  parseLimit(c: Context<AppEnv>): number | Response;
  notifyMutation(projectId: string): Promise<void>;
  now(): string;
}

const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const proposalControlFields = {
  changeSummary: z.string().trim().min(1).max(2000).optional(),
  notes: z.string().max(10_000).optional(),
  applyImmediately: z.boolean().optional(),
};

const chapterBaseFields = {
  chapterId: z.string().min(1),
  baseRevision: z.number().int().min(1),
  baseContentHash: contentHashSchema,
  ...proposalControlFields,
};

const chapterProposalSchema = z.strictObject({
  ...chapterBaseFields,
  proposalType: z.literal("chapter_replacement"),
  proposedContent: z
    .string()
    .min(1, "proposedContent must not be empty")
    .refine(
      (value) => new TextEncoder().encode(value).length <= MAX_CHAPTER_BODY_BYTES,
      `proposedContent must be at most ${MAX_CHAPTER_BODY_BYTES} bytes`,
    ),
});

const summaryProposalSchema = z.strictObject({
  ...chapterBaseFields,
  proposalType: z.literal("chapter_summary"),
  proposedContent: z.string().max(2000),
});

const repositoryDocumentProposalSchema = z.strictObject({
  ...proposalControlFields,
  proposalType: z.literal("repository_document"),
  targetKind: z.enum(["outline", "timeline", "character"]),
  targetPath: z.string().min(1).max(1024),
  baseContentHash: contentHashSchema,
  proposedContent: z.string().min(1),
});

const createProposalSchema = z.discriminatedUnion("proposalType", [
  chapterProposalSchema,
  summaryProposalSchema,
  repositoryDocumentProposalSchema,
]);

const reviewSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000).optional(),
});

const proposalStatusSchema = z.enum([
  "pending_review",
  "applying",
  "approved",
  "rejected",
  "conflicted",
  "withdrawn",
]);

type CreateProposalCommand = z.infer<typeof createProposalSchema>;

interface ProposalMetadata {
  target: { kind: string; id: string; path: string; label: string };
  currentRevision: number | null;
  currentContentHash: string | null;
  conflictWarning: boolean;
  author: { id: string; displayName: string; type: string | null } | null;
  reviewedBy: { id: string; displayName: string; type: string | null } | null;
  workItem: { id: string; type: string; status: string } | null;
  chapter: {
    id: string;
    title: string;
    slug: string;
    path: string;
    revision: number;
  } | null;
}

interface ProposalMetadataRow extends SqlRow {
  proposal_id: string;
  current_chapter_id: string | null;
  chapter_path: string | null;
  chapter_title: string | null;
  chapter_slug: string | null;
  chapter_revision: number | null;
  chapter_content_hash: string | null;
  author_id: string | null;
  author_display_name: string | null;
  author_type: string | null;
  reviewer_id: string | null;
  reviewer_display_name: string | null;
  reviewer_type: string | null;
  linked_work_item_id: string | null;
  work_item_type: string | null;
  work_item_status: string | null;
}

export function registerRevisionProposalRoutes(ctx: RevisionProposalsContext): void {
  const { app, deps, repos, clock, services, auth, idem, serialize, now } = ctx;

  const guard = (
    c: Context<AppEnv>,
    capabilities: readonly (
      | "revisions:read"
      | "revisions:write"
      | "revisions:review"
      | "chapters:read"
      | "summaries:write"
    )[],
  ) =>
    requireProjectScope(c, services, null, {
      requireMembership: true,
      editorial: { capabilities },
    });

  const eventStatement = (projectId: string, type: string, payload: unknown): SqlStatement =>
    repos.events.appendStatement({ projectId, type, payload, createdAt: now() });

  const auditStatement = (input: {
    projectId: string;
    actorId: string;
    action: string;
    proposalId: string;
    correlationId: string;
    metadata?: unknown;
  }): SqlStatement =>
    repos.auditEvents.insertStatement({
      id: uuidv7(clock.now()),
      projectId: input.projectId,
      actorId: input.actorId,
      action: input.action,
      targetType: "revision_proposal",
      targetId: input.proposalId,
      correlationId: input.correlationId,
      metadata: input.metadata ?? null,
      createdAt: now(),
    });

  const workItemCas = (
    id: string,
    fromStatus: "submitted",
    toStatus: "applying" | "ready",
    updatedAt: string,
  ): SqlStatement =>
    deps.db
      .prepare(
        `UPDATE work_items
            SET status = CASE WHEN status = ? THEN ? ELSE NULL END,
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(fromStatus, toStatus, updatedAt, id);

  const submissionCas = (
    id: string,
    workItemId: string,
    toState: "applying" | "rejected",
    gitOperationId: string | null,
    updatedAt: string,
  ): SqlStatement =>
    deps.db
      .prepare(
        `UPDATE submissions
            SET state = CASE
                  WHEN state = 'received' AND work_item_id = ? AND git_operation_id IS NULL
                    THEN ?
                  ELSE NULL
                END,
                git_operation_id = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(workItemId, toState, gitOperationId, updatedAt, id);

  const getProposal = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
  ): Promise<RevisionProposalRecord | Response> => {
    const proposal = await repos.revisionProposals.getById(c.req.param("proposalId") ?? "");
    if (proposal === null || proposal.projectId !== project.id) {
      return problem(c, "not-found", { detail: "unknown revision proposal" });
    }
    return proposal;
  };

  /**
   * One bounded enrichment read for an already-bounded proposal page. No Git
   * reads and no per-row database fan-out: list, detail, and diff all consume
   * the same generic target/attribution shape.
   */
  const proposalMetadata = async (
    proposals: readonly RevisionProposalRecord[],
  ): Promise<Map<string, ProposalMetadata>> => {
    if (proposals.length === 0) return new Map();
    const placeholders = proposals.map(() => "?").join(", ");
    const rows = await deps.db
      .prepare(
        `SELECT rp.id AS proposal_id,
                c.id AS current_chapter_id,
                c.path AS chapter_path,
                c.title AS chapter_title,
                c.slug AS chapter_slug,
                c.revision AS chapter_revision,
                c.content_hash AS chapter_content_hash,
                author.id AS author_id,
                author.display_name AS author_display_name,
                author.type AS author_type,
                reviewer.id AS reviewer_id,
                reviewer.display_name AS reviewer_display_name,
                reviewer.type AS reviewer_type,
                w.id AS linked_work_item_id,
                w.type AS work_item_type,
                w.status AS work_item_status
           FROM revision_proposals rp
           LEFT JOIN chapters c
             ON c.id = rp.chapter_id AND c.project_id = rp.project_id
           LEFT JOIN actors author ON author.id = rp.author_actor_id
           LEFT JOIN actors reviewer ON reviewer.id = rp.reviewed_by_actor_id
           LEFT JOIN work_items w
             ON w.id = rp.work_item_id AND w.project_id = rp.project_id
          WHERE rp.id IN (${placeholders})`,
      )
      .bind(...proposals.map(({ id }) => id))
      .all<ProposalMetadataRow>();
    const rowById = new Map(rows.map((row) => [row.proposal_id, row]));
    const result = new Map<string, ProposalMetadata>();
    for (const proposal of proposals) {
      const row = rowById.get(proposal.id);
      const currentRevision = row?.chapter_revision ?? null;
      const currentContentHash = row?.chapter_content_hash ?? null;
      const chapterTitle = row?.chapter_title ?? targetLabel(proposal);
      const chapterPath = row?.chapter_path ?? proposal.targetPath;
      result.set(proposal.id, {
        target: {
          kind: proposal.targetKind,
          id: proposal.targetId,
          path: proposal.targetPath,
          label: chapterTitle,
        },
        currentRevision,
        currentContentHash,
        conflictWarning:
          proposal.targetKind === "chapter" &&
          (currentRevision === null ||
            currentContentHash === null ||
            currentRevision !== proposal.baseRevision ||
            currentContentHash !== proposal.baseContentHash),
        author:
          row?.author_id === null || row?.author_id === undefined
            ? null
            : {
                id: row.author_id,
                displayName: row.author_display_name ?? row.author_id,
                type: row.author_type,
              },
        reviewedBy:
          row?.reviewer_id === null || row?.reviewer_id === undefined
            ? null
            : {
                id: row.reviewer_id,
                displayName: row.reviewer_display_name ?? row.reviewer_id,
                type: row.reviewer_type,
              },
        workItem:
          row?.linked_work_item_id === null || row?.linked_work_item_id === undefined
            ? null
            : {
                id: row.linked_work_item_id,
                type: row.work_item_type ?? "unknown",
                status: row.work_item_status ?? "unknown",
              },
        chapter:
          row?.current_chapter_id === null || row?.current_chapter_id === undefined
            ? null
            : {
                id: row.current_chapter_id,
                title: chapterTitle,
                slug: row.chapter_slug ?? "",
                path: chapterPath,
                revision: currentRevision as number,
              },
      });
    }
    return result;
  };

  const proposalJson = (
    proposal: RevisionProposalRecord,
    metadata: ProposalMetadata,
    options: {
      includeContent?: boolean;
    } = {},
  ): Record<string, unknown> => ({
    id: proposal.id,
    projectId: proposal.projectId,
    chapterId: proposal.chapterId,
    targetKind: proposal.targetKind,
    targetId: proposal.targetId,
    targetPath: proposal.targetPath,
    proposalType: proposal.proposalType,
    origin: proposal.origin,
    workItemId: proposal.workItemId,
    submissionId: proposal.submissionId,
    authorActorId: proposal.authorActorId,
    baseRevision: proposal.baseRevision,
    baseContentHash: proposal.baseContentHash,
    changeSummary: proposal.changeSummary,
    notes: proposal.notes,
    status: proposal.status,
    reviewedByActorId: proposal.reviewedByActorId,
    reviewedAt: proposal.reviewedAt,
    reviewReason: proposal.reviewReason,
    gitOperationId: proposal.gitOperationId,
    operationId: proposal.gitOperationId,
    resultingRevision: proposal.resultingRevision,
    commitSha: proposal.commitSha,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    target: metadata.target,
    currentRevision: metadata.currentRevision,
    currentContentHash: metadata.currentContentHash,
    conflictWarning: metadata.conflictWarning,
    author: metadata.author,
    reviewedBy: metadata.reviewedBy,
    workItem: metadata.workItem,
    chapter: metadata.chapter,
    ...(options.includeContent === true
      ? { baseContent: proposal.baseContent, proposedContent: proposal.proposedContent }
      : {}),
  });

  const currentBaseOrProblem = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
    chapterId: string,
    baseRevision: number,
    baseContentHash: string,
  ): Promise<{ chapter: ChapterProjectionRecord; source: string } | Response> => {
    const chapter = await repos.chapters.getById(chapterId);
    if (chapter === null || chapter.projectId !== project.id) {
      return problem(c, "not-found", { detail: "unknown chapter" });
    }
    const read = await readRepositoryText(deps, project.id, chapter.path);
    if (read.outcome !== "found") {
      return problem(c, "state-conflict", {
        detail:
          read.outcome === "unavailable"
            ? "this deployment cannot read the chapter source"
            : "the chapter source is missing from the repository",
      });
    }
    const actualHash = `sha256:${await sha256Hex(read.source)}`;
    if (
      chapter.revision !== baseRevision ||
      chapter.contentHash !== baseContentHash ||
      actualHash !== baseContentHash
    ) {
      return problem(c, "revision-conflict", {
        detail: "the chapter content no longer matches the proposal base",
        baseRevision,
        baseContentHash,
        currentRevision: chapter.revision,
        currentContentHash: actualHash,
      });
    }
    return { chapter, source: read.source };
  };

  const configuredDocumentPathIsAllowed = async (
    projectId: string,
    kind: RepositoryDocumentKind,
    path: string,
  ): Promise<boolean> => {
    if (!isSafeRepositoryDocumentPath(path)) return false;
    const row = await repos.bookConfigs.get(projectId);
    const parsed = bookConfigSchema.safeParse(row?.config);
    const planning = parsed.success ? parsed.data.planning : undefined;
    if (kind === "outline") {
      return path === (planning?.outline ?? "story/outline.yml");
    }
    if (kind === "timeline") {
      return path === (planning?.timeline ?? "story/timeline.yml");
    }
    return repositoryPathMatchesGlob(
      path,
      planning?.characters_glob ?? "story/characters/*.md",
    );
  };

  const repositoryDocumentBaseOrProblem = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
    input: {
      targetKind: RepositoryDocumentKind;
      targetPath: string;
      baseContentHash: string;
      targetId?: string;
    },
  ): Promise<{ source: string; document: ValidatedRepositoryDocument } | Response> => {
    if (
      !(await configuredDocumentPathIsAllowed(
        project.id,
        input.targetKind,
        input.targetPath,
      ))
    ) {
      return problem(c, "validation-failed", {
        detail: "targetPath is not the configured repository document for this target kind",
      });
    }
    const read = await readRepositoryText(deps, project.id, input.targetPath);
    if (read.outcome !== "found") {
      return problem(c, read.outcome === "not-found" ? "not-found" : "state-conflict", {
        detail:
          read.outcome === "unavailable"
            ? "this deployment cannot read repository document source"
            : "repository document source not found at the branch head",
      });
    }
    const validated = await validateRepositoryDocument({
      kind: input.targetKind,
      path: input.targetPath,
      content: read.source,
    });
    if (!validated.ok) {
      return problem(c, "state-conflict", {
        detail: "the current repository document failed validation",
        issues: validated.issues,
      });
    }
    if (input.targetId !== undefined && validated.document.targetId !== input.targetId) {
      return problem(c, "state-conflict", {
        detail: "the repository document identity no longer matches this proposal",
      });
    }
    const actualHash = `sha256:${await sha256Hex(read.source)}`;
    if (actualHash !== input.baseContentHash) {
      return problem(c, "revision-conflict", {
        detail: "the repository document no longer matches the proposal base",
        baseContentHash: input.baseContentHash,
        currentContentHash: actualHash,
      });
    }
    return { source: read.source, document: validated.document };
  };

  const proposalBaseOrProblem = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
    proposal: RevisionProposalRecord,
  ): Promise<Response | null> => {
    if (proposal.targetKind !== "chapter") {
      const current = await repositoryDocumentBaseOrProblem(c, project, {
        targetKind: proposal.targetKind,
        targetPath: proposal.targetPath,
        targetId: proposal.targetId,
        baseContentHash: proposal.baseContentHash,
      });
      return current instanceof Response ? current : null;
    }
    if (proposal.chapterId === null || proposal.baseRevision === null) {
      return problem(c, "state-conflict", {
        detail: "chapter proposal is missing its chapter base identity",
      });
    }
    const current = await currentBaseOrProblem(
      c,
      project,
      proposal.chapterId,
      proposal.baseRevision,
      proposal.baseContentHash,
    );
    return current instanceof Response ? current : null;
  };

  app.get("/v1/projects/:projectId/repository-documents/source", auth, async (c) => {
    const allowed = await guard(c, ["revisions:write"]);
    if ("response" in allowed) return allowed.response;
    const kind = z.enum(["outline", "timeline", "character"]).safeParse(c.req.query("kind"));
    const path = c.req.query("path");
    if (!kind.success || path === undefined) {
      return problem(c, "validation-failed", {
        detail: "kind and path identify the repository document to edit",
      });
    }
    if (!(await configuredDocumentPathIsAllowed(allowed.project.id, kind.data, path))) {
      return problem(c, "validation-failed", {
        detail: "path is not the configured repository document for this target kind",
      });
    }
    const read = await readRepositoryText(deps, allowed.project.id, path);
    if (read.outcome !== "found") {
      return problem(c, read.outcome === "not-found" ? "not-found" : "state-conflict", {
        detail:
          read.outcome === "unavailable"
            ? "this deployment cannot read repository document source"
            : "repository document source not found at the branch head",
      });
    }
    const validated = await validateRepositoryDocument({
      kind: kind.data,
      path,
      content: read.source,
    });
    if (!validated.ok) {
      return problem(c, "state-conflict", {
        detail: "the current repository document failed validation",
        issues: validated.issues,
      });
    }
    return c.json({
      target: {
        kind: validated.document.kind,
        id: validated.document.targetId,
        path: validated.document.path,
        label: validated.document.label,
      },
      content: read.source,
      contentHash: `sha256:${await sha256Hex(read.source)}`,
    });
  });

  // Proposal metadata intentionally omits both immutable snapshots. Clients
  // fetch one selected proposal/diff after the revisions:read guard succeeds.
  app.get("/v1/projects/:projectId/revision-proposals", auth, async (c) => {
    const allowed = await guard(c, ["revisions:read"]);
    if ("response" in allowed) return allowed.response;
    const limit = ctx.parseLimit(c);
    if (limit instanceof Response) return limit;
    const statusRaw = c.req.query("status");
    const status =
      statusRaw === undefined ? undefined : proposalStatusSchema.safeParse(statusRaw);
    if (status !== undefined && !status.success) {
      return problem(c, "validation-failed", { detail: "unknown proposal status" });
    }
    const rows = await repos.revisionProposals.listByProject(allowed.project.id, {
      afterId: c.req.query("cursor") ?? "",
      limit,
      ...(status?.success === true ? { status: status.data } : {}),
      ...(c.req.query("chapterId") === undefined
        ? {}
        : { chapterId: c.req.query("chapterId") as string }),
    });
    const metadata = await proposalMetadata(rows);
    const last = rows[rows.length - 1];
    return c.json({
      items: rows.map((proposal) =>
        proposalJson(proposal, metadata.get(proposal.id) as ProposalMetadata),
      ),
      nextCursor: rows.length === limit && last !== undefined ? last.id : null,
    });
  });

  app.get("/v1/projects/:projectId/revision-proposals/:proposalId", auth, async (c) => {
    const allowed = await guard(c, ["revisions:read"]);
    if ("response" in allowed) return allowed.response;
    const proposal = await getProposal(c, allowed.project);
    if (proposal instanceof Response) return proposal;
    const metadata = await proposalMetadata([proposal]);
    return c.json(
      proposalJson(proposal, metadata.get(proposal.id) as ProposalMetadata, {
        includeContent: true,
      }),
    );
  });

  app.get(
    "/v1/projects/:projectId/revision-proposals/:proposalId/diff",
    auth,
    async (c) => {
      const allowed = await guard(c, ["revisions:read"]);
      if ("response" in allowed) return allowed.response;
      const proposal = await getProposal(c, allowed.project);
      if (proposal instanceof Response) return proposal;
      const metadata = await proposalMetadata([proposal]);
      const proposalMeta = metadata.get(proposal.id) as ProposalMetadata;
      const diff = createRevisionDiff({
        baseContent: proposal.baseContent,
        proposedContent: proposal.proposedContent,
        baseRevision: proposal.baseRevision,
        ...(proposal.proposalType === "chapter_summary"
          ? { path: `${proposalMeta.target.path || "chapter.md"}#summary` }
          : proposalMeta.target.path === ""
            ? {}
            : { path: proposalMeta.target.path }),
      });
      return c.json({
        proposalId: proposal.id,
        proposal: proposalJson(proposal, proposalMeta),
        target: proposalMeta.target,
        author: proposalMeta.author,
        baseContent: proposal.baseContent,
        proposedContent: proposal.proposedContent,
        ...diff,
      });
    },
  );

  app.post("/v1/projects/:projectId/revision-proposals", auth, idem, async (c) => {
    const raw = await ctx.readJson(c);
    if (raw instanceof Response) return raw;
    const parsed = createProposalSchema.safeParse(raw);
    if (!parsed.success) {
      return problem(c, "validation-failed", { issues: issueList(parsed.error) });
    }
    const command = parsed.data;
    const writeCapabilities =
      command.proposalType === "chapter_summary"
        ? (["chapters:read", "summaries:write"] as const)
        : (["revisions:write"] as const);
    const required =
      command.applyImmediately === true
        ? ([...writeCapabilities, "revisions:review"] as const)
        : writeCapabilities;
    const allowed = await guard(c, required);
    if ("response" in allowed) return allowed.response;

    return serialize(allowed.project.id, async () => {
      const project = (await repos.projects.getById(allowed.project.id)) ?? allowed.project;
      const blocked = proseWriteBlocked(c, project);
      if (blocked !== null) return blocked;
      if (command.proposalType === "repository_document") {
        return createRepositoryDocumentProposal(c, project, command);
      }
      const current = await currentBaseOrProblem(
        c,
        project,
        command.chapterId,
        command.baseRevision,
        command.baseContentHash,
      );
      if (current instanceof Response) return current;
      const baseContent = proposalBaseContent(command, current.source);
      if (baseContent === null) {
        return problem(c, "state-conflict", {
          detail: "the current chapter source has invalid frontmatter",
        });
      }
      if (baseContent === command.proposedContent) {
        return problem(c, "state-conflict", {
          detail: "the proposed content is identical to the current content",
        });
      }
      const findings = proposedContentFindings(command.proposedContent);
      if (findings.length > 0) {
        return problem(c, "unsafe-content", { findings });
      }

      const a = authOf(c);
      const proposalId = uuidv7(clock.now());
      const timestamp = now();
      const correlationId = c.get("correlationId");
      const origin =
        command.proposalType === "chapter_summary" ? "summary_proposal" : "direct_edit";
      const applying = command.applyImmediately === true;
      const command202 = applying
        ? chapterWriteCommand(ctx, {
            project,
            proposalId,
            chapterId: current.chapter.id,
            proposalType: command.proposalType,
            proposedContent: command.proposedContent,
            baseRevision: command.baseRevision,
            authorActorId: a.actor.id,
            reviewerActorId: a.actor.id,
            correlationId,
          })
        : null;
      const responseStatus = applying ? 202 : 201;
      const responseBody = {
        proposalId,
        operationId: command202?.operationId ?? null,
        correlationId,
        status: applying ? "applying" : "pending_review",
      };
      const proposal: RevisionProposalRecord = {
        id: proposalId,
        projectId: project.id,
        chapterId: current.chapter.id,
        targetKind: "chapter",
        targetId: current.chapter.id,
        targetPath: current.chapter.path,
        proposalType: command.proposalType,
        origin,
        workItemId: null,
        submissionId: null,
        authorActorId: a.actor.id,
        baseRevision: command.baseRevision,
        baseContentHash: command.baseContentHash,
        baseContent,
        proposedContent: command.proposedContent,
        changeSummary: command.changeSummary ?? null,
        notes: command.notes ?? null,
        status: applying ? "applying" : "pending_review",
        reviewedByActorId: applying ? a.actor.id : null,
        reviewedAt: applying ? timestamp : null,
        reviewReason: null,
        gitOperationId: command202?.operationId ?? null,
        resultingRevision: null,
        commitSha: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const statements: SqlStatement[] = [
        ...(command202 === null ? [] : [command202.statements[0] as SqlStatement]),
        repos.revisionProposals.insertStatement(proposal),
        auditStatement({
          projectId: project.id,
          actorId: a.actor.id,
          action: "revision_proposal.create",
          proposalId,
          correlationId,
          metadata: { proposalType: command.proposalType, origin, applyImmediately: applying },
        }),
        eventStatement(project.id, "revision_proposal_created", {
          proposalId,
          chapterId: current.chapter.id,
          proposalType: command.proposalType,
          authorActorId: a.actor.id,
          correlationId,
        }),
        ...(command202 === null ? [] : command202.statements.slice(1)),
        ...(command202 === null
          ? []
          : [
              eventStatement(project.id, "revision_proposal_approved", {
                proposalId,
                chapterId: current.chapter.id,
                operationId: command202.operationId,
                reviewerActorId: a.actor.id,
                applyImmediately: true,
                correlationId,
              }),
            ]),
        ...ctx.claimStatements(c, responseStatus, responseBody),
      ];
      await deps.db.batch(statements);
      if (applying) await ctx.notifyMutation(project.id);
      return c.json(responseBody, responseStatus);
    });
  });

  async function createRepositoryDocumentProposal(
    c: Context<AppEnv>,
    project: ProjectRecord,
    command: Extract<CreateProposalCommand, { proposalType: "repository_document" }>,
  ): Promise<Response> {
    const current = await repositoryDocumentBaseOrProblem(c, project, {
      targetKind: command.targetKind,
      targetPath: command.targetPath,
      baseContentHash: command.baseContentHash,
    });
    if (current instanceof Response) return current;
    const proposed = await validateRepositoryDocument({
      kind: command.targetKind,
      path: command.targetPath,
      content: command.proposedContent,
    });
    if (!proposed.ok) {
      return problem(c, "validation-failed", { issues: proposed.issues });
    }
    if (proposed.document.targetId !== current.document.targetId) {
      return problem(c, "validation-failed", {
        detail: "editing a repository document cannot change its canonical identity",
      });
    }
    if (proposed.document.content === current.source) {
      return problem(c, "state-conflict", {
        detail: "the proposed content is identical to the current repository document",
      });
    }

    const actor = authOf(c);
    const proposalId = uuidv7(clock.now());
    const timestamp = now();
    const correlationId = c.get("correlationId");
    const applying = command.applyImmediately === true;
    const command202 = applying
      ? repositoryDocumentWriteCommand(ctx, {
          project,
          proposalId,
          reviewerActorId: actor.actor.id,
          correlationId,
        })
      : null;
    const responseStatus = applying ? 202 : 201;
    const responseBody = {
      proposalId,
      operationId: command202?.operationId ?? null,
      correlationId,
      status: applying ? "applying" : "pending_review",
    };
    const proposal: RevisionProposalRecord = {
      id: proposalId,
      projectId: project.id,
      chapterId: null,
      targetKind: proposed.document.kind,
      targetId: proposed.document.targetId,
      targetPath: proposed.document.path,
      proposalType: "repository_document",
      origin: "document_edit",
      workItemId: null,
      submissionId: null,
      authorActorId: actor.actor.id,
      baseRevision: null,
      baseContentHash: command.baseContentHash,
      baseContent: current.source,
      proposedContent: proposed.document.content,
      changeSummary: command.changeSummary ?? null,
      notes: command.notes ?? null,
      status: applying ? "applying" : "pending_review",
      reviewedByActorId: applying ? actor.actor.id : null,
      reviewedAt: applying ? timestamp : null,
      reviewReason: null,
      gitOperationId: command202?.operationId ?? null,
      resultingRevision: null,
      commitSha: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const statements: SqlStatement[] = [
      ...(command202 === null ? [] : [command202.statements[0] as SqlStatement]),
      repos.revisionProposals.insertStatement(proposal),
      auditStatement({
        projectId: project.id,
        actorId: actor.actor.id,
        action: "revision_proposal.create",
        proposalId,
        correlationId,
        metadata: {
          proposalType: "repository_document",
          targetKind: proposal.targetKind,
          targetId: proposal.targetId,
          targetPath: proposal.targetPath,
          applyImmediately: applying,
        },
      }),
      eventStatement(project.id, "revision_proposal_created", {
        proposalId,
        targetKind: proposal.targetKind,
        targetId: proposal.targetId,
        targetPath: proposal.targetPath,
        authorActorId: actor.actor.id,
        correlationId,
      }),
      ...(command202 === null ? [] : command202.statements.slice(1)),
      ...(command202 === null
        ? []
        : [
            eventStatement(project.id, "revision_proposal_approved", {
              proposalId,
              targetKind: proposal.targetKind,
              targetId: proposal.targetId,
              targetPath: proposal.targetPath,
              operationId: command202.operationId,
              reviewerActorId: actor.actor.id,
              applyImmediately: true,
              correlationId,
            }),
          ]),
      ...ctx.claimStatements(c, responseStatus, responseBody),
    ];
    await deps.db.batch(statements);
    if (applying) await ctx.notifyMutation(project.id);
    return c.json(responseBody, responseStatus);
  }

  app.post(
    "/v1/projects/:projectId/revision-proposals/:proposalId/approve",
    auth,
    idem,
    async (c) => {
      const allowed = await guard(c, ["revisions:review"]);
      if ("response" in allowed) return allowed.response;
      const raw = await ctx.readJson(c);
      if (raw instanceof Response) return raw;
      const parsed = reviewSchema.safeParse(raw);
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }
      return serialize(allowed.project.id, async () => {
        const proposal = await getProposal(c, allowed.project);
        if (proposal instanceof Response) return proposal;
        if (proposal.status !== "pending_review") return reviewConflict(c, proposal);
        const project = (await repos.projects.getById(allowed.project.id)) ?? allowed.project;
        const blocked = proseWriteBlocked(c, project);
        if (blocked !== null) return blocked;
        const current = await proposalBaseOrProblem(c, project, proposal);
        if (current instanceof Response) return current;
        return approveProposal(c, project, proposal, parsed.data.reason ?? null);
      });
    },
  );

  app.post(
    "/v1/projects/:projectId/revision-proposals/:proposalId/reject",
    auth,
    idem,
    async (c) => {
      const allowed = await guard(c, ["revisions:review"]);
      if ("response" in allowed) return allowed.response;
      const raw = await ctx.readJson(c);
      if (raw instanceof Response) return raw;
      const parsed = reviewSchema.safeParse(raw);
      if (!parsed.success) {
        return problem(c, "validation-failed", { issues: issueList(parsed.error) });
      }
      return serialize(allowed.project.id, async () => {
        const proposal = await getProposal(c, allowed.project);
        if (proposal instanceof Response) return proposal;
        if (proposal.status !== "pending_review") return reviewConflict(c, proposal);
        return rejectProposal(c, allowed.project, proposal, parsed.data.reason ?? null);
      });
    },
  );

  async function approveProposal(
    c: Context<AppEnv>,
    project: ProjectRecord,
    proposal: RevisionProposalRecord,
    reason: string | null,
  ): Promise<Response> {
    const reviewer = authOf(c);
    const correlationId = c.get("correlationId");
    const timestamp = now();
    let command202;
    let linkedStatements: SqlStatement[] = [];

    if (proposal.origin === "work_submission") {
      if (proposal.workItemId === null || proposal.submissionId === null) {
        return problem(c, "state-conflict", { detail: "work proposal is missing its links" });
      }
      const [workItem, submission] = await Promise.all([
        repos.workItems.getById(proposal.workItemId),
        repos.submissions.getById(proposal.submissionId),
      ]);
      if (
        workItem === null ||
        submission === null ||
        workItem.projectId !== project.id ||
        submission.projectId !== project.id ||
        submission.workItemId !== workItem.id ||
        proposal.chapterId === null ||
        proposal.baseRevision === null ||
        workItem.chapterId !== proposal.chapterId ||
        workItem.baseRevision !== proposal.baseRevision ||
        proposal.proposalType !== "chapter_replacement" ||
        submission.type !== "chapter_replacement" ||
        submission.actorId !== proposal.authorActorId ||
        submission.baseRevision !== proposal.baseRevision ||
        submission.baseContentHash !== proposal.baseContentHash ||
        submission.content !== proposal.proposedContent ||
        workItem.status !== "submitted" ||
        submission.state !== "received" ||
        submission.gitOperationId !== null
      ) {
        return problem(c, "state-conflict", {
          detail: "the linked work item or submission is no longer awaiting review",
        });
      }
      command202 = ctx.commandStatements({
        project,
        correlationId,
        actorId: reviewer.actor.id,
        action: "revision_proposal.approve",
        targetType: "revision_proposal",
        targetId: proposal.id,
        outboxKind: SUBMISSION_APPLY_KIND,
        outboxPayload: { submissionId: submission.id, workItemId: workItem.id },
        metadata: { proposalId: proposal.id, workItemId: workItem.id, reason },
      });
      linkedStatements = [
        submissionCas(
          submission.id,
          workItem.id,
          "applying",
          command202.operationId,
          timestamp,
        ),
        workItemCas(workItem.id, "submitted", "applying", timestamp),
      ];
    } else if (proposal.targetKind === "chapter") {
      if (
        proposal.chapterId === null ||
        proposal.baseRevision === null ||
        proposal.proposalType === "repository_document"
      ) {
        return problem(c, "state-conflict", {
          detail: "chapter proposal is missing its chapter base identity",
        });
      }
      command202 = chapterWriteCommand(ctx, {
        project,
        proposalId: proposal.id,
        chapterId: proposal.chapterId,
        proposalType: proposal.proposalType,
        proposedContent: proposal.proposedContent,
        baseRevision: proposal.baseRevision,
        authorActorId: proposal.authorActorId,
        reviewerActorId: reviewer.actor.id,
        correlationId,
        reason,
      });
    } else {
      command202 = repositoryDocumentWriteCommand(ctx, {
        project,
        proposalId: proposal.id,
        reviewerActorId: reviewer.actor.id,
        correlationId,
        reason,
      });
    }

    const responseBody = {
      proposalId: proposal.id,
      operationId: command202.operationId,
      correlationId,
      status: "applying",
    };
    const batch: SqlStatement[] = [
      command202.statements[0] as SqlStatement,
      repos.revisionProposals.transitionReviewOrAbortStatement(proposal.id, "pending_review", {
        status: "applying",
        reviewedByActorId: reviewer.actor.id,
        reviewedAt: timestamp,
        reviewReason: reason,
        gitOperationId: command202.operationId,
        updatedAt: timestamp,
      }),
      ...linkedStatements,
      ...command202.statements.slice(1),
      eventStatement(project.id, "revision_proposal_approved", {
        proposalId: proposal.id,
        chapterId: proposal.chapterId,
        targetKind: proposal.targetKind,
        targetId: proposal.targetId,
        targetPath: proposal.targetPath,
        operationId: command202.operationId,
        reviewerActorId: reviewer.actor.id,
        correlationId,
      }),
      ...ctx.claimStatements(c, 202, responseBody),
    ];
    try {
      await deps.db.batch(batch);
    } catch (error) {
      if (isConstraintError(error)) {
        const fresh = await repos.revisionProposals.getById(proposal.id);
        return problem(c, "state-conflict", {
          detail: "the proposal or one of its linked records changed during review",
          status: fresh?.status ?? null,
        });
      }
      throw error;
    }
    await ctx.notifyMutation(project.id);
    return c.json(responseBody, 202);
  }

  async function rejectProposal(
    c: Context<AppEnv>,
    project: ProjectRecord,
    proposal: RevisionProposalRecord,
    reason: string | null,
  ): Promise<Response> {
    const reviewer = authOf(c);
    const timestamp = now();
    const correlationId = c.get("correlationId");
    const linkedStatements: SqlStatement[] = [];
    if (proposal.origin === "work_submission") {
      if (proposal.workItemId === null || proposal.submissionId === null) {
        return problem(c, "state-conflict", { detail: "work proposal is missing its links" });
      }
      const [workItem, submission] = await Promise.all([
        repos.workItems.getById(proposal.workItemId),
        repos.submissions.getById(proposal.submissionId),
      ]);
      if (
        workItem === null ||
        submission === null ||
        workItem.projectId !== project.id ||
        submission.projectId !== project.id ||
        submission.workItemId !== workItem.id ||
        proposal.chapterId === null ||
        proposal.baseRevision === null ||
        workItem.chapterId !== proposal.chapterId ||
        workItem.baseRevision !== proposal.baseRevision ||
        proposal.proposalType !== "chapter_replacement" ||
        submission.type !== "chapter_replacement" ||
        submission.actorId !== proposal.authorActorId ||
        submission.baseRevision !== proposal.baseRevision ||
        submission.baseContentHash !== proposal.baseContentHash ||
        submission.content !== proposal.proposedContent ||
        workItem.status !== "submitted" ||
        submission.state !== "received" ||
        submission.gitOperationId !== null
      ) {
        return problem(c, "state-conflict", {
          detail: "the linked work item or submission is no longer awaiting review",
        });
      }
      linkedStatements.push(
        submissionCas(submission.id, workItem.id, "rejected", null, timestamp),
        workItemCas(workItem.id, "submitted", "ready", timestamp),
      );
    }
    const responseBody = {
      proposalId: proposal.id,
      operationId: null,
      correlationId,
      status: "rejected",
    };
    try {
      await deps.db.batch([
        repos.revisionProposals.transitionReviewOrAbortStatement(
          proposal.id,
          "pending_review",
          {
            status: "rejected",
            reviewedByActorId: reviewer.actor.id,
            reviewedAt: timestamp,
            reviewReason: reason,
            gitOperationId: null,
            updatedAt: timestamp,
          },
        ),
        ...linkedStatements,
        auditStatement({
          projectId: project.id,
          actorId: reviewer.actor.id,
          action: "revision_proposal.reject",
          proposalId: proposal.id,
          correlationId,
          metadata: { reason, workItemId: proposal.workItemId },
        }),
        eventStatement(project.id, "revision_proposal_rejected", {
          proposalId: proposal.id,
          chapterId: proposal.chapterId,
          targetKind: proposal.targetKind,
          targetId: proposal.targetId,
          targetPath: proposal.targetPath,
          reviewerActorId: reviewer.actor.id,
          workItemId: proposal.workItemId,
          correlationId,
        }),
        ...ctx.claimStatements(c, 200, responseBody),
      ]);
    } catch (error) {
      if (isConstraintError(error)) {
        const fresh = await repos.revisionProposals.getById(proposal.id);
        return problem(c, "state-conflict", {
          detail: "the proposal or one of its linked records changed during review",
          status: fresh?.status ?? null,
        });
      }
      throw error;
    }
    return c.json(responseBody, 200);
  }
}

function chapterWriteCommand(
  ctx: RevisionProposalsContext,
  input: {
    project: ProjectRecord;
    proposalId: string;
    chapterId: string;
    proposalType: "chapter_replacement" | "chapter_summary";
    proposedContent: string;
    baseRevision: number;
    authorActorId: string;
    reviewerActorId: string;
    correlationId: string;
    reason?: string | null;
  },
) {
  return ctx.commandStatements({
    project: input.project,
    correlationId: input.correlationId,
    actorId: input.reviewerActorId,
    action: "revision_proposal.approve",
    targetType: "revision_proposal",
    targetId: input.proposalId,
    outboxKind: CHAPTER_WRITE_KIND,
    outboxPayload: {
      chapterId: input.chapterId,
      action: "revise",
      actorId: input.authorActorId,
      revisionProposalId: input.proposalId,
      intent: {
        baseRevision: input.baseRevision,
        ...(input.proposalType === "chapter_summary"
          ? { summary: input.proposedContent === "" ? null : input.proposedContent }
          : { body: input.proposedContent }),
      },
    },
    metadata: {
      proposalId: input.proposalId,
      proposalType: input.proposalType,
      authorActorId: input.authorActorId,
      reason: input.reason ?? null,
    },
  });
}

function repositoryDocumentWriteCommand(
  ctx: RevisionProposalsContext,
  input: {
    project: ProjectRecord;
    proposalId: string;
    reviewerActorId: string;
    correlationId: string;
    reason?: string | null;
  },
) {
  return ctx.commandStatements({
    project: input.project,
    correlationId: input.correlationId,
    actorId: input.reviewerActorId,
    action: "revision_proposal.approve",
    targetType: "revision_proposal",
    targetId: input.proposalId,
    outboxKind: "repository_document.write",
    outboxPayload: { revisionProposalId: input.proposalId },
    metadata: {
      proposalId: input.proposalId,
      reason: input.reason ?? null,
    },
  });
}

function proposalBaseContent(
  command: Exclude<CreateProposalCommand, { proposalType: "repository_document" }>,
  source: string,
): string | null {
  const parsed = parseChapterMarkdown(source);
  const frontmatter = chapterFrontmatterSchema.safeParse(parsed.frontmatter);
  if (
    !frontmatter.success ||
    frontmatter.data.id !== command.chapterId ||
    frontmatter.data.revision !== command.baseRevision
  ) {
    return null;
  }
  return command.proposalType === "chapter_summary"
    ? (frontmatter.data.summary ?? "")
    : stripBlockMarkers(chapterBodyOf(source)).trim();
}

function targetLabel(proposal: RevisionProposalRecord): string {
  if (proposal.targetKind === "outline") return "Outline";
  if (proposal.targetKind === "timeline") return "Timeline";
  if (proposal.targetKind === "character") {
    const id = proposal.targetId.startsWith("character:")
      ? proposal.targetId.slice("character:".length)
      : proposal.targetId;
    return id || "Character";
  }
  return "Chapter revision";
}

function proposedContentFindings(content: string): string[] {
  const findings: string[] = [];
  if (content.includes("<!--") && /authorbot:/i.test(content)) {
    findings.push("authorbot comments are not allowed in proposed chapter content");
  }
  const scan = scanSafety(parseProseMarkdown(content).ast);
  if (scan.rawHtml.length > 0) findings.push("raw HTML is forbidden");
  for (const url of scan.forbiddenUrls) {
    findings.push(`URL scheme "${url.scheme}" is forbidden`);
  }
  return findings;
}

function chapterBodyOf(source: string): string {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const close = normalized.indexOf("\n---\n", 3);
  return close === -1 ? normalized : normalized.slice(close + 5);
}

function reviewConflict(c: Context<AppEnv>, proposal: RevisionProposalRecord): Response {
  return problem(c, "state-conflict", {
    detail: `revision proposal is already ${proposal.status}`,
    status: proposal.status,
  });
}

function issueList(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
