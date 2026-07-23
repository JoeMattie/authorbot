import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { openSqliteDatabase, type SqliteAdapter } from "../src/adapters/better-sqlite3.js";
import { applyMigrations } from "../src/migrate.js";
import { createRepositories, type Repositories } from "../src/repositories/index.js";
import type {
  ActorRecord,
  ChapterProjectionRecord,
  ProjectRecord,
} from "../src/records.js";

/** Repo-root migrations directory (contract §2: migrations live at the root). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

export const NOW = "2026-07-19T18:00:00Z";

/** Test-only UUIDv7 generator (ids are caller-generated per contract §2). */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) {
    bytes[5 - i] = Number((ts >> BigInt(8 * i)) & 0xffn);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function openMigratedDb(): Promise<SqliteAdapter> {
  const db = openSqliteDatabase(":memory:");
  await applyMigrations(db, MIGRATIONS_DIR);
  return db;
}

export interface Seeded {
  db: SqliteAdapter;
  repos: Repositories;
  project: ProjectRecord;
  actor: ActorRecord;
  chapter: ChapterProjectionRecord;
}

/** Migrated in-memory DB with one project, one human actor, one chapter. */
export async function seedBasics(): Promise<Seeded> {
  const db = await openMigratedDb();
  const repos = createRepositories(db);

  const project: ProjectRecord = {
    id: uuidv7(),
    slug: "causal-projector",
    repoProvider: "github",
    repo: "JoeMattie/causal-projector",
    defaultBranch: "main",
    status: "active",
    projectionStale: false,
    projectedCommit: null,
    divergenceReason: null,
    divergedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const actor: ActorRecord = {
    id: uuidv7(),
    type: "human",
    displayName: "Joe",
    externalIdentity: "github:JoeMattie",
    ownerActorId: null,
    status: "active",
    createdAt: NOW,
  };
  const chapter: ChapterProjectionRecord = {
    id: uuidv7(),
    projectId: project.id,
    path: "chapters/01-signal.md",
    slug: "signal",
    title: "Signal",
    summary: "A signal appears where nobody expected one.",
    order: 10,
    status: "draft",
    revision: 1,
    contentHash: "sha256:0000",
    headCommit: null,
    lastPublishedCommit: null,
    blockIds: [],
    updatedAt: NOW,
  };

  await repos.projects.insert(project);
  await repos.actors.insert(actor);
  await repos.chapters.upsert(chapter);
  return { db, repos, project, actor, chapter };
}
