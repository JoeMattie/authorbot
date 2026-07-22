import { createHash } from "node:crypto";
import type {
  GitOperationRecord,
  OutboxRecord,
  RevisionProposalRecord,
} from "@authorbot/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProcessor,
  REVISION_PROPOSAL_TRAILER,
  type BookRepoWriter,
  type CommitFilesInput,
} from "../src/index.js";
import {
  nowIso,
  setupDatabase,
  uuidv7,
  type SeededDatabase,
} from "./helpers.js";

const BASE = [
  "schema: authorbot.story-graph/v1",
  "nodes: []",
  "",
].join("\n");
const PROPOSED = [
  "schema: authorbot.story-graph/v1",
  "nodes:",
  "  - id: premise:signal",
  "    type: premise",
  "    title: Signal",
  "    order: 10",
  "",
].join("\n");
const COMMIT_SHA = "c".repeat(40);
const HEAD_SHA = "a".repeat(40);

let seed: SeededDatabase;

beforeEach(async () => {
  seed = await setupDatabase();
});

afterEach(() => {
  seed.db.close();
});

class MemoryWriter implements BookRepoWriter {
  readonly commits: CommitFilesInput[] = [];

  constructor(readonly source: string | null = BASE) {}

  commitFiles(input: CommitFilesInput): Promise<{ commitSha: string }> {
    this.commits.push(input);
    return Promise.resolve({ commitSha: COMMIT_SHA });
  }

  readFile(): Promise<string | null> {
    return Promise.resolve(this.source);
  }

  resolveHead(): Promise<string> {
    return Promise.resolve(HEAD_SHA);
  }
}

function hash(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

async function enqueue(
  overrides: Partial<RevisionProposalRecord> = {},
): Promise<{ proposal: RevisionProposalRecord; operationId: string }> {
  const ts = nowIso();
  const operationId = uuidv7();
  const proposal: RevisionProposalRecord = {
    id: uuidv7(),
    projectId: seed.projectId,
    chapterId: null,
    targetKind: "outline",
    targetId: "outline",
    targetPath: "story/outline.yml",
    proposalType: "repository_document",
    origin: "document_edit",
    workItemId: null,
    submissionId: null,
    authorActorId: seed.actorId,
    baseRevision: null,
    baseContentHash: hash(BASE),
    baseContent: BASE,
    proposedContent: PROPOSED,
    changeSummary: "Add the premise.",
    notes: null,
    status: "applying",
    reviewedByActorId: seed.actorId,
    reviewedAt: ts,
    reviewReason: null,
    gitOperationId: operationId,
    resultingRevision: null,
    commitSha: null,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
  const operation: GitOperationRecord = {
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
  const outbox: OutboxRecord = {
    id: uuidv7(),
    projectId: seed.projectId,
    gitOperationId: operationId,
    kind: "repository_document.write",
    payload: { revisionProposalId: proposal.id },
    status: "pending",
    attempts: 0,
    createdAt: ts,
    processedAt: null,
  };
  await seed.db.batch([
    seed.repos.gitOperations.insertStatement(operation),
    seed.repos.revisionProposals.insertStatement(proposal),
    seed.repos.outbox.insertStatement(outbox),
  ]);
  return { proposal, operationId };
}

async function event(type: string): Promise<Record<string, unknown> | null> {
  const row = await seed.db
    .prepare(`SELECT payload FROM events WHERE project_id = ? AND type = ? ORDER BY id DESC`)
    .bind(seed.projectId, type)
    .first<{ payload: string }>();
  return row === null ? null : JSON.parse(row.payload) as Record<string, unknown>;
}

describe("reviewed repository document writes", () => {
  it("commits the reviewed bytes and finalizes the proposal atomically", async () => {
    const { proposal, operationId } = await enqueue();
    const writer = new MemoryWriter();

    const result = await createProcessor({ db: seed.db, writer }).drain(seed.projectId);

    expect(result.outcomes[0]).toMatchObject({ result: "committed", commitSha: COMMIT_SHA });
    expect(writer.commits).toHaveLength(1);
    expect(writer.commits[0]).toMatchObject({
      expectedHeadOverride: HEAD_SHA,
      files: [{ path: "story/outline.yml", content: PROPOSED }],
      message: "Revise outline",
      trailers: {
        "Authorbot-Actor": seed.actorRef,
        [REVISION_PROPOSAL_TRAILER]: proposal.id,
        "Authorbot-Operation": operationId,
      },
    });
    expect(await seed.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "approved",
      resultingRevision: null,
      commitSha: COMMIT_SHA,
    });
    expect(await event("revision_proposal_applied")).toMatchObject({
      revisionProposalId: proposal.id,
      targetKind: "outline",
      targetPath: "story/outline.yml",
      commitSha: COMMIT_SHA,
    });
  });

  it("conflicts without writing when the repository document moved", async () => {
    const { proposal } = await enqueue();
    const writer = new MemoryWriter(`${BASE}# externally changed\n`);

    const result = await createProcessor({ db: seed.db, writer }).drain(seed.projectId);

    expect(result.outcomes[0]).toMatchObject({ result: "failed" });
    expect(result.outcomes[0]?.error).toContain("changed after revision proposal");
    expect(writer.commits).toHaveLength(0);
    expect(await seed.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "conflicted",
      commitSha: null,
    });
    expect(await event("revision_proposal_conflicted")).toMatchObject({
      revisionProposalId: proposal.id,
      targetKind: "outline",
    });
  });

  it("refuses an unreviewed proposal and leaves it untouched", async () => {
    const { proposal } = await enqueue({
      status: "pending_review",
      reviewedByActorId: null,
      reviewedAt: null,
      gitOperationId: null,
    });
    const writer = new MemoryWriter();

    const result = await createProcessor({ db: seed.db, writer }).drain(seed.projectId);

    expect(result.outcomes[0]).toMatchObject({ result: "failed" });
    expect(result.outcomes[0]?.error).toContain("pending_review, not applying");
    expect(writer.commits).toHaveLength(0);
    expect(await seed.repos.revisionProposals.getById(proposal.id)).toMatchObject({
      status: "pending_review",
      gitOperationId: null,
    });
  });

  it("rejects a tampered retained base before comparing the live file", async () => {
    const { proposal } = await enqueue({ baseContentHash: hash("different") });
    const writer = new MemoryWriter();

    const result = await createProcessor({ db: seed.db, writer }).drain(seed.projectId);

    expect(result.outcomes[0]?.error).toContain("retained an invalid base snapshot");
    expect(writer.commits).toHaveLength(0);
    expect((await seed.repos.revisionProposals.getById(proposal.id))?.status).toBe("conflicted");
  });
});
