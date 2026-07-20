import { describe, expect, it } from "vitest";
import { createRepositories } from "../src/repositories/index.js";
import type { AnnotationRecord, AuditEventRecord, OutboxRecord } from "../src/records.js";
import { NOW, seedBasics, uuidv7 } from "./helpers.js";

describe("batch atomicity", () => {
  it("executes a multi-table command batch atomically (contract §5 command flow)", async () => {
    const { db, repos, project, actor, chapter } = await seedBasics();
    const operationId = uuidv7();
    const annotation: AnnotationRecord = {
      id: uuidv7(),
      projectId: project.id,
      chapterId: chapter.id,
      kind: "suggestion",
      scope: "range",
      chapterRevision: 1,
      target: {
        blockId: uuidv7(),
        textPosition: { start: 48, end: 74 },
        textQuote: { exact: "two incompatible histories" },
      },
      authorActorId: actor.id,
      body: "Consider tightening this clause.",
      status: "pending_git",
      gitOperationId: operationId,
      supersededBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const audit: AuditEventRecord = {
      id: uuidv7(),
      projectId: project.id,
      actorId: actor.id,
      action: "annotation.create",
      targetType: "annotation",
      targetId: annotation.id,
      correlationId: uuidv7(),
      metadata: null,
      createdAt: NOW,
    };
    const outbox: OutboxRecord = {
      id: uuidv7(),
      projectId: project.id,
      gitOperationId: operationId,
      kind: "annotation.create",
      payload: { annotationId: annotation.id },
      status: "pending",
      attempts: 0,
      createdAt: NOW,
      processedAt: null,
    };

    const results = await db.batch([
      repos.gitOperations.insertStatement({
        id: operationId,
        projectId: project.id,
        correlationId: audit.correlationId,
        expectedHead: null,
        state: "queued",
        attempts: 0,
        commitSha: null,
        error: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
      repos.annotations.insertStatement(annotation),
      repos.auditEvents.insertStatement(audit),
      repos.outbox.insertStatement(outbox),
    ]);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.changes === 1)).toBe(true);

    expect(await repos.annotations.getById(annotation.id)).not.toBeNull();
    expect(await repos.outbox.nextPending(project.id)).not.toBeNull();
    db.close();
  });

  it("rolls back everything when a mid-batch statement fails", async () => {
    const { db, repos, project, actor, chapter } = await seedBasics();
    const annotationId = uuidv7();
    const goodAnnotation = repos.annotations.insertStatement({
      id: annotationId,
      projectId: project.id,
      chapterId: chapter.id,
      kind: "comment",
      scope: "chapter",
      chapterRevision: 1,
      target: null,
      authorActorId: actor.id,
      body: "First statement succeeds.",
      status: "pending_git",
      gitOperationId: null,
      supersededBy: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Fails: FK to a nonexistent chapter.
    const badReply = db
      .prepare(
        `INSERT INTO replies (id, project_id, annotation_id, author_actor_id, body,
                              status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'x', 'pending_git', ?, ?)`,
      )
      .bind(uuidv7(), project.id, uuidv7(), actor.id, NOW, NOW);

    await expect(db.batch([goodAnnotation, badReply])).rejects.toThrow();
    expect(await repos.annotations.getById(annotationId)).toBeNull();
    db.close();
  });

  it("rejects statements prepared by a different adapter", async () => {
    const { db } = await seedBasics();
    const foreign = {
      bind: () => foreign,
      first: async () => null,
      all: async () => [],
      run: async () => ({ changes: 0, lastRowId: null }),
    };
    await expect(db.batch([foreign])).rejects.toThrow(/different adapter/);
    db.close();
  });

  it("repositories share one database, so a fresh connection sees committed batches", async () => {
    const { db, project } = await seedBasics();
    const repos = createRepositories(db);
    const stored = await repos.projects.getBySlug(project.slug);
    expect(stored?.id).toBe(project.id);
    db.close();
  });
});
