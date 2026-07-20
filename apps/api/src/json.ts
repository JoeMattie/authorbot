/**
 * Response body serializers: database records → API JSON (camelCase,
 * RFC 3339 UTC, matching the openapi resource schemas). Sensitive columns
 * (token/session hashes) never appear in any serializer.
 */
import type {
  ActorRecord,
  AgentTokenRecord,
  AnnotationRecord,
  ChapterProjectionRecord,
  GitOperationRecord,
  ProjectMembershipRecord,
  ProjectRecord,
  ReplyRecord,
} from "@authorbot/database";

export function projectJson(project: ProjectRecord): Record<string, unknown> {
  return {
    id: project.id,
    slug: project.slug,
    repoProvider: project.repoProvider,
    repo: project.repo,
    defaultBranch: project.defaultBranch,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function actorJson(actor: ActorRecord): Record<string, unknown> {
  return {
    id: actor.id,
    type: actor.type,
    displayName: actor.displayName,
    externalIdentity: actor.externalIdentity,
    status: actor.status,
    createdAt: actor.createdAt,
  };
}

export function membershipJson(m: ProjectMembershipRecord): Record<string, unknown> {
  return {
    id: m.id,
    projectId: m.projectId,
    actorId: m.actorId,
    role: m.role,
    scopes: m.scopes,
    createdAt: m.createdAt,
    revokedAt: m.revokedAt,
  };
}

export function chapterJson(chapter: ChapterProjectionRecord): Record<string, unknown> {
  return {
    id: chapter.id,
    projectId: chapter.projectId,
    path: chapter.path,
    slug: chapter.slug,
    title: chapter.title,
    status: chapter.status,
    revision: chapter.revision,
    contentHash: chapter.contentHash,
    headCommit: chapter.headCommit,
    lastPublishedCommit: chapter.lastPublishedCommit,
    updatedAt: chapter.updatedAt,
    blockIds: chapter.blockIds,
  };
}

export function annotationJson(a: AnnotationRecord): Record<string, unknown> {
  return {
    id: a.id,
    projectId: a.projectId,
    chapterId: a.chapterId,
    kind: a.kind,
    scope: a.scope,
    chapterRevision: a.chapterRevision,
    target: a.target,
    authorActorId: a.authorActorId,
    body: a.body,
    status: a.status,
    gitOperationId: a.gitOperationId,
    supersededBy: a.supersededBy,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export function replyJson(r: ReplyRecord): Record<string, unknown> {
  return {
    id: r.id,
    projectId: r.projectId,
    annotationId: r.annotationId,
    parentReplyId: r.parentReplyId,
    authorActorId: r.authorActorId,
    body: r.body,
    status: r.status,
    gitOperationId: r.gitOperationId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function operationJson(op: GitOperationRecord): Record<string, unknown> {
  return {
    id: op.id,
    projectId: op.projectId,
    correlationId: op.correlationId,
    state: op.state,
    attempts: op.attempts,
    commitSha: op.commitSha,
    error: op.error,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  };
}

/** Token metadata (list/mint). The plaintext is added only by the mint handler. */
export function agentTokenJson(t: AgentTokenRecord): Record<string, unknown> {
  return {
    id: t.id,
    projectId: t.projectId,
    actorId: t.actorId,
    name: t.name,
    scopes: t.scopes,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    revokedAt: t.revokedAt,
    lastUsedAt: t.lastUsedAt,
  };
}

/** Cursor pagination envelope (design §15.1). */
export function page<T extends { id: string }>(
  items: T[],
  limit: number,
  serialize: (item: T) => Record<string, unknown>,
): { items: Record<string, unknown>[]; nextCursor: string | null } {
  const last = items[items.length - 1];
  return {
    items: items.map(serialize),
    nextCursor: items.length === limit && last !== undefined ? last.id : null,
  };
}
