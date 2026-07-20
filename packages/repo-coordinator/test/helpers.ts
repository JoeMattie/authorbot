/**
 * Test helpers: temp git repos, a migrated in-memory database seeded with a
 * project/actor/chapter, and API-shaped command batches (record +
 * git_operation + outbox in one atomic batch, contract §5).
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  applyMigrations,
  createRepositories,
  openSqliteDatabase,
  type AnnotationRecord,
  type DecisionRecord,
  type GitOperationRecord,
  type OutboxRecord,
  type Repositories,
  type ReplyRecord,
  type SqliteAdapter,
  type WorkItemRecord,
} from "@authorbot/database";
import { toTimestamp } from "@authorbot/domain";

const execFileAsync = promisify(execFile);

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

let uuidCounter = 0;

/** Spec-shaped UUIDv7 with a monotonic 12-bit counter (stable test ordering). */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) {
    bytes[5 - i] = Number((ms >> BigInt(8 * i)) & 0xffn);
  }
  uuidCounter = (uuidCounter + 1) & 0xfff;
  bytes[6] = 0x70 | ((uuidCounter >> 8) & 0x0f);
  bytes[7] = uuidCounter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return toTimestamp(new Date());
}

export interface SeededDatabase {
  db: SqliteAdapter;
  repos: Repositories;
  projectId: string;
  actorId: string;
  /** Actor reference of the seeded actor. */
  actorRef: string;
  chapterId: string;
}

export async function setupDatabase(): Promise<SeededDatabase> {
  const db = openSqliteDatabase(":memory:");
  await applyMigrations(db, MIGRATIONS_DIR);
  const repos = createRepositories(db);
  const ts = nowIso();

  const projectId = uuidv7();
  await repos.projects.insert({
    id: projectId,
    slug: "causal-projector",
    repoProvider: "local",
    repo: "JoeMattie/causal-projector",
    defaultBranch: "main",
    status: "active",
    createdAt: ts,
    updatedAt: ts,
  });

  const actorId = uuidv7();
  const actorRef = "github:jparish";
  await repos.actors.insert({
    id: actorId,
    type: "human",
    displayName: "J. Parish",
    externalIdentity: actorRef,
    ownerActorId: null,
    status: "active",
    createdAt: ts,
  });

  const chapterId = uuidv7();
  await repos.chapters.upsert({
    id: chapterId,
    projectId,
    path: "chapters/01-signal.md",
    slug: "signal",
    title: "Signal",
    status: "draft",
    revision: 2,
    contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    headCommit: null,
    lastPublishedCommit: null,
    blockIds: [],
    updatedAt: ts,
  });

  return { db, repos, projectId, actorId, actorRef, chapterId };
}

export interface TempGitRepo {
  dir: string;
  cleanup(): Promise<void>;
}

export async function initGitRepo(): Promise<TempGitRepo> {
  const dir = await mkdtemp(join(tmpdir(), "authorbot-repo-coordinator-"));
  await git(dir, "init", "--quiet", "-b", "main");
  await writeFile(join(dir, "README.md"), "# fixture book repo\n", "utf8");
  await git(dir, "add", "README.md");
  await git(
    dir,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "initial",
  );
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trimEnd();
}

export function defaultRangeTarget(): unknown {
  return {
    blockId: uuidv7(),
    textPosition: { start: 126, end: 166 },
    textQuote: {
      exact: "the interferometer was telling the truth",
      prefix: " alternative was admitting that ",
      suffix: ".",
    },
  };
}

export interface EnqueuedCommand {
  annotationId?: string;
  replyId?: string;
  operationId: string;
  outboxId: string;
}

/** API-shaped create-annotation command: one atomic batch (contract §5). */
export async function enqueueAnnotationCreate(
  seed: SeededDatabase,
  overrides: Partial<Pick<AnnotationRecord, "kind" | "scope" | "target" | "body">> = {},
): Promise<Required<Pick<EnqueuedCommand, "annotationId" | "operationId" | "outboxId">>> {
  const { db, repos, projectId, actorId, chapterId } = seed;
  const ts = nowIso();
  const annotationId = uuidv7();
  const operationId = uuidv7();
  const outboxId = uuidv7();

  const operation: GitOperationRecord = {
    id: operationId,
    projectId,
    correlationId: uuidv7(),
    expectedHead: null,
    state: "queued",
    attempts: 0,
    commitSha: null,
    error: null,
    createdAt: ts,
    updatedAt: ts,
  };
  const annotation: AnnotationRecord = {
    id: annotationId,
    projectId,
    chapterId,
    kind: "suggestion",
    scope: "range",
    chapterRevision: 2,
    target: defaultRangeTarget(),
    authorActorId: actorId,
    body: 'Suggest replacing with "honest from the first pass".',
    status: "pending_git",
    gitOperationId: operationId,
    supersededBy: null,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
  const outbox: OutboxRecord = {
    id: outboxId,
    projectId,
    gitOperationId: operationId,
    kind: "annotation.create",
    payload: { annotationId },
    status: "pending",
    attempts: 0,
    createdAt: ts,
    processedAt: null,
  };
  await db.batch([
    repos.gitOperations.insertStatement(operation),
    repos.annotations.insertStatement(annotation),
    repos.outbox.insertStatement(outbox),
  ]);
  return { annotationId, operationId, outboxId };
}

/** API-shaped create-reply command batch. */
export async function enqueueReplyCreate(
  seed: SeededDatabase,
  annotationId: string,
  overrides: Partial<Pick<ReplyRecord, "body" | "parentReplyId">> = {},
): Promise<Required<Pick<EnqueuedCommand, "replyId" | "operationId" | "outboxId">>> {
  const { db, repos, projectId, actorId } = seed;
  const ts = nowIso();
  const replyId = uuidv7();
  const operationId = uuidv7();
  const outboxId = uuidv7();

  const operation: GitOperationRecord = {
    id: operationId,
    projectId,
    correlationId: uuidv7(),
    expectedHead: null,
    state: "queued",
    attempts: 0,
    commitSha: null,
    error: null,
    createdAt: ts,
    updatedAt: ts,
  };
  const reply: ReplyRecord = {
    id: replyId,
    projectId,
    annotationId,
    parentReplyId: null,
    authorActorId: actorId,
    body: "Agreed, approving.",
    status: "pending_git",
    gitOperationId: operationId,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
  const outbox: OutboxRecord = {
    id: outboxId,
    projectId,
    gitOperationId: operationId,
    kind: "reply.create",
    payload: { replyId },
    status: "pending",
    attempts: 0,
    createdAt: ts,
    processedAt: null,
  };
  await db.batch([
    repos.gitOperations.insertStatement(operation),
    repos.replies.insertStatement(reply),
    repos.outbox.insertStatement(outbox),
  ]);
  return { replyId, operationId, outboxId };
}

function newOperation(seed: SeededDatabase, operationId: string, ts: string): GitOperationRecord {
  return {
    id: operationId,
    projectId: seed.projectId,
    correlationId: uuidv7(),
    expectedHead: null,
    state: "queued",
    attempts: 0,
    commitSha: null,
    error: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

export interface EnqueuedCrossing {
  annotationId: string;
  decisionId: string;
  workItemId: string;
  operationId: string;
  outboxId: string;
}

/**
 * Phase 3 contract §4 crossing batch (the parts the processor consumes):
 * decision row + work-item row + annotation transition + one outbox row for
 * both Git artifacts. `metrics`/`ruleVersion`/`overrideReason` overridable
 * for force-create shapes.
 */
export async function enqueueDecisionCreate(
  seed: SeededDatabase,
  options: {
    annotationId?: string;
    workItem?: boolean;
    workItemStatus?: WorkItemRecord["status"];
    decision?: Partial<DecisionRecord>;
    payloadExtra?: Record<string, unknown>;
  } = {},
): Promise<EnqueuedCrossing> {
  const { db, repos, projectId, chapterId } = seed;
  const ts = nowIso();
  const annotationId =
    options.annotationId ?? (await enqueueAnnotationCreate(seed)).annotationId;
  const decisionId = uuidv7();
  const workItemId = uuidv7();
  const operationId = uuidv7();
  const outboxId = uuidv7();
  const withWorkItem = options.workItem ?? true;

  const annotation = await repos.annotations.getById(annotationId);
  const decision: DecisionRecord = {
    id: decisionId,
    projectId,
    sourceAnnotationId: annotationId,
    actionType: "create_work_item",
    rule: "suggestion_to_work_item",
    ruleVersion: 1,
    metrics: { approvals: 3, net_score: 2, human_approvals: 1 },
    result: "create_work_item",
    supportChanged: false,
    overrideReason: null,
    workItemId: withWorkItem ? workItemId : null,
    createdAt: ts,
    updatedAt: ts,
    ...options.decision,
  };
  const workItem: WorkItemRecord = {
    id: workItemId,
    projectId,
    type: "revise_range",
    status: options.workItemStatus ?? "ready",
    sourceAnnotationId: annotationId,
    chapterId,
    baseRevision: 2,
    target: annotation?.target ?? null,
    priority: "normal",
    createdAt: ts,
    updatedAt: ts,
  };
  const outbox: OutboxRecord = {
    id: outboxId,
    projectId,
    gitOperationId: operationId,
    kind: "decision.create",
    payload: { decisionId, ...options.payloadExtra },
    status: "pending",
    attempts: 0,
    createdAt: ts,
    processedAt: null,
  };
  await db.batch([
    repos.gitOperations.insertStatement(newOperation(seed, operationId, ts)),
    repos.decisions.insertStatement(decision),
    ...(withWorkItem ? [repos.workItems.insertStatement(workItem)] : []),
    repos.annotations.updateStatusStatement(annotationId, "work_item_created", ts),
    repos.outbox.insertStatement(outbox),
  ]);
  return { annotationId, decisionId, workItemId, operationId, outboxId };
}

/** Enqueue a `decision.update` re-render row (support_changed toggles). */
export async function enqueueDecisionUpdate(
  seed: SeededDatabase,
  decisionId: string,
  payloadExtra: Record<string, unknown> = {},
): Promise<{ operationId: string; outboxId: string }> {
  const { db, repos, projectId } = seed;
  const ts = nowIso();
  const operationId = uuidv7();
  const outboxId = uuidv7();
  const outbox: OutboxRecord = {
    id: outboxId,
    projectId,
    gitOperationId: operationId,
    kind: "decision.update",
    payload: { decisionId, ...payloadExtra },
    status: "pending",
    attempts: 0,
    createdAt: ts,
    processedAt: null,
  };
  await db.batch([
    repos.gitOperations.insertStatement(newOperation(seed, operationId, ts)),
    repos.outbox.insertStatement(outbox),
  ]);
  return { operationId, outboxId };
}

/** Enqueue a `work_item.update` re-render row. */
export async function enqueueWorkItemUpdate(
  seed: SeededDatabase,
  workItemId: string,
  payloadExtra: Record<string, unknown> = {},
): Promise<{ operationId: string; outboxId: string }> {
  const { db, repos, projectId } = seed;
  const ts = nowIso();
  const operationId = uuidv7();
  const outboxId = uuidv7();
  const outbox: OutboxRecord = {
    id: outboxId,
    projectId,
    gitOperationId: operationId,
    kind: "work_item.update",
    payload: { workItemId, ...payloadExtra },
    status: "pending",
    attempts: 0,
    createdAt: ts,
    processedAt: null,
  };
  await db.batch([
    repos.gitOperations.insertStatement(newOperation(seed, operationId, ts)),
    repos.outbox.insertStatement(outbox),
  ]);
  return { operationId, outboxId };
}

/** API-shaped withdraw command batch (new operation + outbox row). */
export async function enqueueAnnotationWithdraw(
  seed: SeededDatabase,
  annotationId: string,
  actorId?: string,
): Promise<Required<Pick<EnqueuedCommand, "annotationId" | "operationId" | "outboxId">>> {
  const { db, repos, projectId } = seed;
  const ts = nowIso();
  const operationId = uuidv7();
  const outboxId = uuidv7();

  const operation: GitOperationRecord = {
    id: operationId,
    projectId,
    correlationId: uuidv7(),
    expectedHead: null,
    state: "queued",
    attempts: 0,
    commitSha: null,
    error: null,
    createdAt: ts,
    updatedAt: ts,
  };
  const outbox: OutboxRecord = {
    id: outboxId,
    projectId,
    gitOperationId: operationId,
    kind: "annotation.withdraw",
    payload: actorId === undefined ? { annotationId } : { annotationId, actorId },
    status: "pending",
    attempts: 0,
    createdAt: ts,
    processedAt: null,
  };
  await db.batch([
    repos.gitOperations.insertStatement(operation),
    repos.outbox.insertStatement(outbox),
  ]);
  return { annotationId, operationId, outboxId };
}
