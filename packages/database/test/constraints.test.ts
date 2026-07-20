import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isConstraintError, isUniqueConstraintError } from "../src/sql.js";
import type {
  AgentTokenRecord,
  AuditEventRecord,
  IdempotencyKeyRecord,
  ProjectMembershipRecord,
  WebhookDeliveryRecord,
} from "../src/records.js";
import { NOW, seedBasics, uuidv7 } from "./helpers.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("contract §2 schema constraints", () => {
  it("rejects a duplicate (project_id, actor_id) membership", async () => {
    const { db, repos, project, actor } = await seedBasics();
    const membership = (id: string): ProjectMembershipRecord => ({
      id,
      projectId: project.id,
      actorId: actor.id,
      role: "maintainer",
      scopes: ["tokens:manage", "members:manage"],
      createdAt: NOW,
      revokedAt: null,
    });
    await repos.projectMemberships.insert(membership(uuidv7()));
    await expect(repos.projectMemberships.insert(membership(uuidv7()))).rejects.toSatisfy(
      isUniqueConstraintError,
    );
    db.close();
  });

  it("rejects a duplicate agent-token hash", async () => {
    const { db, repos, project, actor } = await seedBasics();
    const hash = sha256("fake-token-material-for-tests");
    const token = (id: string): AgentTokenRecord => ({
      id,
      projectId: project.id,
      actorId: actor.id,
      name: "ci-agent",
      tokenHash: hash,
      scopes: ["chapters:read"],
      createdBy: actor.id,
      createdAt: NOW,
      expiresAt: "2026-08-18T18:00:00Z",
      revokedAt: null,
      lastUsedAt: null,
    });
    await repos.agentTokens.insert(token(uuidv7()));
    await expect(repos.agentTokens.insert(token(uuidv7()))).rejects.toSatisfy(
      isUniqueConstraintError,
    );
    db.close();
  });

  it("rejects a duplicate idempotency (project_id, actor_id, key)", async () => {
    const { db, repos, project, actor } = await seedBasics();
    const record = (id: string, requestHash: string): IdempotencyKeyRecord => ({
      id,
      projectId: project.id,
      actorId: actor.id,
      key: "client-key-1",
      requestHash,
      responseStatus: null,
      responseBody: null,
      createdAt: NOW,
    });
    await repos.idempotencyKeys.insert(record(uuidv7(), sha256("request-a")));
    await expect(
      repos.idempotencyKeys.insert(record(uuidv7(), sha256("request-b"))),
    ).rejects.toSatisfy(isUniqueConstraintError);
    db.close();
  });

  it("rejects a duplicate webhook delivery id", async () => {
    const { db, repos } = await seedBasics();
    const delivery = (id: string): WebhookDeliveryRecord => ({
      id,
      deliveryId: "gh-delivery-123",
      event: "push",
      status: "received",
      receivedAt: NOW,
      processedAt: null,
    });
    await repos.webhookDeliveries.insert(delivery(uuidv7()));
    await expect(repos.webhookDeliveries.insert(delivery(uuidv7()))).rejects.toSatisfy(
      isUniqueConstraintError,
    );
    db.close();
  });

  it("rejects a duplicate human-session hash and duplicate actor external identity", async () => {
    const { db, repos, actor } = await seedBasics();
    const hash = sha256("fake-session-material-for-tests");
    await repos.humanSessions.insert({
      id: uuidv7(),
      sessionHash: hash,
      actorId: actor.id,
      createdAt: NOW,
      expiresAt: "2026-07-26T18:00:00Z",
      revokedAt: null,
    });
    await expect(
      repos.humanSessions.insert({
        id: uuidv7(),
        sessionHash: hash,
        actorId: actor.id,
        createdAt: NOW,
        expiresAt: "2026-07-26T18:00:00Z",
        revokedAt: null,
      }),
    ).rejects.toSatisfy(isUniqueConstraintError);

    await expect(
      repos.actors.insert({
        id: uuidv7(),
        type: "human",
        displayName: "Impostor",
        externalIdentity: actor.externalIdentity,
        ownerActorId: null,
        status: "active",
        createdAt: NOW,
      }),
    ).rejects.toSatisfy(isUniqueConstraintError);
    db.close();
  });

  it("enforces CHECK and FOREIGN KEY constraints", async () => {
    const { db, project, actor } = await seedBasics();
    // Invalid role fails the CHECK constraint.
    await expect(
      db
        .prepare(
          `INSERT INTO project_memberships (id, project_id, actor_id, role, scopes, created_at)
           VALUES (?, ?, ?, 'emperor', '[]', ?)`,
        )
        .bind(uuidv7(), project.id, actor.id, NOW)
        .run(),
    ).rejects.toSatisfy(isConstraintError);
    // Unknown project fails the FK constraint.
    await expect(
      db
        .prepare(
          `INSERT INTO project_memberships (id, project_id, actor_id, role, scopes, created_at)
           VALUES (?, ?, ?, 'reader', '[]', ?)`,
        )
        .bind(uuidv7(), uuidv7(), actor.id, NOW)
        .run(),
    ).rejects.toSatisfy(isConstraintError);
    // Chapter revision must be >= 1.
    await expect(
      db
        .prepare(
          `INSERT INTO chapters (id, project_id, path, slug, title, status, revision,
                                 content_hash, updated_at)
           VALUES (?, ?, 'chapters/x.md', 'x', 'X', 'draft', 0, 'sha256:1', ?)`,
        )
        .bind(uuidv7(), project.id, NOW)
        .run(),
    ).rejects.toSatisfy(isConstraintError);
    db.close();
  });

  it("audit_events is append-only: UPDATE and DELETE abort", async () => {
    const { db, repos, project, actor } = await seedBasics();
    const event: AuditEventRecord = {
      id: uuidv7(),
      projectId: project.id,
      actorId: actor.id,
      action: "annotation.create",
      targetType: "annotation",
      targetId: uuidv7(),
      correlationId: uuidv7(),
      metadata: { scope: "range" },
      createdAt: NOW,
    };
    await repos.auditEvents.insert(event);

    await expect(
      db.prepare(`UPDATE audit_events SET action = 'tampered' WHERE id = ?`).bind(event.id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`DELETE FROM audit_events WHERE id = ?`).bind(event.id).run(),
    ).rejects.toThrow(/append-only/);

    const rows = await repos.auditEvents.listByProject(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("annotation.create");
    db.close();
  });

  it("stores only hashes: no token or session plaintext appears anywhere in the DB", async () => {
    const { db, repos, project, actor } = await seedBasics();
    // Clearly-fake secret material; only its hash is handed to the repository.
    const fakeTokenPlaintext = "authorbot_THISISAFAKETESTTOKENxxxxxxxxxxxxxxxxxxxxxxx";
    const fakeSessionPlaintext = "fake-session-id-plaintext-for-tests";
    await repos.agentTokens.insert({
      id: uuidv7(),
      projectId: project.id,
      actorId: actor.id,
      name: "hash-only",
      tokenHash: sha256(fakeTokenPlaintext),
      scopes: ["chapters:read"],
      createdBy: actor.id,
      createdAt: NOW,
      expiresAt: "2026-08-18T18:00:00Z",
      revokedAt: null,
      lastUsedAt: null,
    });
    await repos.humanSessions.insert({
      id: uuidv7(),
      sessionHash: sha256(fakeSessionPlaintext),
      actorId: actor.id,
      createdAt: NOW,
      expiresAt: "2026-07-26T18:00:00Z",
      revokedAt: null,
    });

    const tables = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all<{ name: string }>();
    for (const { name } of tables) {
      const rows = await db.prepare(`SELECT * FROM "${name}"`).all();
      const dump = JSON.stringify(rows);
      expect(dump.includes(fakeTokenPlaintext)).toBe(false);
      expect(dump.includes(fakeSessionPlaintext)).toBe(false);
    }
    db.close();
  });
});
