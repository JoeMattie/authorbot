/**
 * Phase 4 test harness: the real app + the real Phase 4 processor over an
 * in-memory "book repository" (a Map standing in for the committed work
 * tree) and a controllable clock. The MemoryWriter applies committed files
 * back into the same Map, so post-commit `readTextFile` calls observe
 * exactly what a git work tree would.
 */
import type { AppConfig } from "../src/deps.js";
import { createInlineMirror, type InlineMirror } from "../src/mirror.js";
import { uuidv7 } from "../src/ids.js";
import {
  formatCommitMessage,
  type BookRepoWriter,
  type CommitFilesInput,
  type CommitFilesResult,
} from "@authorbot/repo-coordinator";
import type { WorkItemRecord } from "@authorbot/database";
import {
  BLOCK_ID_1,
  BLOCK_ID_2,
  CHAPTER_ID,
  FakeReader,
  fixtureSnapshot,
  makeHarness,
  type TestHarness,
} from "./helpers.js";

export const BLOCK_1_TEXT = "The drift appeared on the ridge at dawn.";
export const BLOCK_2_TEXT = "Nobody in Hollow Creek spoke of it.";

export const CHAPTER_PATH = "chapters/001-baseline.md";

/** The fixture chapter at revision 3 — parseable, marker-valid, schema-valid. */
export const CHAPTER_SOURCE = `---
schema: authorbot.chapter/v1
id: ${CHAPTER_ID}
slug: baseline
title: Baseline
order: 10
status: published
revision: 3
authors:
  - actor: github:avery-cole
summary: The anomaly is first sighted.
---

<!-- authorbot:block id="${BLOCK_ID_1}" -->
${BLOCK_1_TEXT}

<!-- authorbot:block id="${BLOCK_ID_2}" -->
${BLOCK_2_TEXT}
`;

/** The stored range selector used by fixture work items ("drift appeared on"). */
export function fixtureRangeTarget(): Record<string, unknown> {
  return {
    blockId: BLOCK_ID_1,
    textPosition: { start: 4, end: 21 },
    textQuote: { exact: "drift appeared on", prefix: "The ", suffix: " the ridge" },
  };
}

export class FakeClock {
  private current: number;

  constructor(startIso = "2026-07-19T18:00:00Z") {
    this.current = Date.parse(startIso);
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceMs(ms: number): void {
    this.current += ms;
  }
}

export interface RecordedCommit {
  files: { path: string; content: string }[];
  message: string;
  trailers: Record<string, string>;
  sha: string;
}

/** In-memory BookRepoWriter: applies files into the shared repo Map. */
export class MemoryWriter implements BookRepoWriter {
  commits: RecordedCommit[] = [];

  constructor(private readonly repoFiles: Map<string, string>) {}

  async readFile(_branch: string, filePath: string): Promise<string | null> {
    return this.repoFiles.get(filePath) ?? null;
  }

  async commitFiles(input: CommitFilesInput): Promise<CommitFilesResult> {
    // Validate trailers the way the real adapter would.
    formatCommitMessage(input.message, input.trailers);
    const sha = `sha-${(this.commits.length + 1).toString().padStart(4, "0")}`;
    for (const file of input.files) {
      this.repoFiles.set(file.path, file.content);
    }
    this.commits.push({
      files: input.files.map((f) => ({ path: f.path, content: f.content })),
      message: input.message,
      trailers: { ...input.trailers },
      sha,
    });
    return { commitSha: sha };
  }
}

export interface Phase4Harness extends TestHarness {
  clock: FakeClock;
  writer: MemoryWriter;
  mirror: InlineMirror;
  /** The shared "committed repository" file map. */
  repoFiles: Map<string, string>;
}

export async function makePhase4Harness(options: {
  config?: Partial<AppConfig>;
} = {}): Promise<Phase4Harness> {
  const clock = new FakeClock();
  const reader = new FakeReader(fixtureSnapshot());
  reader.files.set(CHAPTER_PATH, CHAPTER_SOURCE);

  const harness = await makeHarness({
    reader,
    clock,
    ...(options.config !== undefined ? { config: options.config } : {}),
  });
  const writer = new MemoryWriter(reader.files);
  const mirror = createInlineMirror({ db: harness.db, writer, clock });
  harness.setMutationHook(mirror.onMutationCommitted);

  return { ...harness, clock, writer, mirror, repoFiles: reader.files };
}

/**
 * Insert a `ready` work item (plus its open source annotation) directly —
 * the Phase 3 creation path is covered by its own suites; Phase 4 tests
 * start from the queue state the contract's §2 assumes.
 */
export async function createReadyWorkItem(
  harness: Phase4Harness,
  options: {
    type?: WorkItemRecord["type"];
    target?: unknown;
    baseRevision?: number;
    authorActorId?: string;
  } = {},
): Promise<{ workItemId: string; annotationId: string }> {
  const { repos, clock } = harness;
  const timestamp = clock.now().toISOString().replace(/\.\d{3}Z$/, "Z");
  const type = options.type ?? "revise_range";
  let authorId = options.authorActorId;
  if (authorId === undefined) {
    const existing = await repos.actors.getByExternalIdentity("github:fixture-author");
    if (existing !== null) {
      authorId = existing.id;
    } else {
      authorId = uuidv7(clock.now());
      await repos.actors.insert({
        id: authorId,
        type: "human",
        displayName: "fixture-author",
        externalIdentity: "github:fixture-author",
        ownerActorId: null,
        status: "active",
        createdAt: timestamp,
      });
    }
  }
  const scope = type === "revise_chapter" ? "chapter" : type === "revise_block" ? "block" : "range";
  const target =
    options.target !== undefined
      ? options.target
      : scope === "chapter"
        ? null
        : scope === "block"
          ? { blockId: BLOCK_ID_1 }
          : fixtureRangeTarget();
  const annotationId = uuidv7(clock.now());
  await repos.annotations.insert({
    id: annotationId,
    projectId: harness.projectId,
    chapterId: CHAPTER_ID,
    kind: "suggestion",
    scope,
    chapterRevision: options.baseRevision ?? 3,
    target,
    authorActorId: authorId,
    body: "Consider tightening this opening line.",
    status: "work_item_created",
    gitOperationId: null,
    supersededBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const workItemId = uuidv7(clock.now());
  await repos.workItems.insert({
    id: workItemId,
    projectId: harness.projectId,
    type,
    status: "ready",
    sourceAnnotationId: annotationId,
    chapterId: CHAPTER_ID,
    baseRevision: options.baseRevision ?? 3,
    target,
    priority: "normal",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return { workItemId, annotationId };
}

/** POST claim and return the parsed body + status. */
export async function claimWorkItem(
  harness: Phase4Harness,
  credential: { cookie?: string; token?: string },
  workItemId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": uuidv7(),
    Origin: "http://localhost",
  };
  if (credential.cookie !== undefined) {
    headers["Cookie"] = credential.cookie;
  }
  if (credential.token !== undefined) {
    headers["Authorization"] = `Bearer ${credential.token}`;
  }
  const response = await harness.app.request(
    `/v1/projects/${harness.projectId}/work-items/${workItemId}/claim`,
    { method: "POST", headers },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
