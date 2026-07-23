/**
 * Phase 2 exit criterion (contract §7.1, design §23): a range suggestion
 * survives refresh, repository rebuild, and service restart - proved via the
 * API against a real git clone of examples/book-repo, better-sqlite3, and
 * the repo-coordinator LocalGitAdapter wired inline.
 *
 * Also covers §7.5 (DB stores only hashes - no token/session plaintext) and
 * the MIRROR_MODE=queue behavior (outbox recorded, drained later).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@authorbot/database/testing";
import {
  CHAPTER_1,
  EXAMPLE_ANNOTATION_ID,
  cloneExampleBookRepo,
  devLogin,
  git,
  jsonRequest,
  makeIntegrationApp,
  mintToken,
  rangeSuggestionPayload,
  type BookRepoClone,
} from "./helpers.js";

interface Accepted {
  operationId: string;
  annotationId: string;
  correlationId: string;
  status: string;
}

describe("exit criterion: range suggestion survives restart and rebuild", () => {
  let clone: BookRepoClone;

  beforeAll(async () => {
    clone = await cloneExampleBookRepo();
  });
  afterAll(async () => {
    await clone.cleanup();
  });

  it("dev-login → 202 → committed artifact → same-DB restart → fresh-DB rebuild", async () => {
    const dbPath = join(clone.root, "authorbot.db");

    // ---- instance 1: create the suggestion --------------------------------
    const app1 = await makeIntegrationApp({ dbPath, workTreePath: clone.workTreePath });
    const cookie1 = await devLogin(app1, "ivy-chen", "contributor");

    const createResponse = await app1.app.request(
      `/v1/projects/${app1.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie1 }),
    );
    expect(createResponse.status).toBe(202);
    const accepted = (await createResponse.json()) as Accepted;
    expect(accepted.status).toBe("queued");

    // Operation reached `committed` (the inline mirror drained synchronously).
    const operationResponse = await app1.app.request(
      `/v1/projects/${app1.projectId}/operations/${accepted.operationId}`,
      { headers: { Cookie: cookie1 } },
    );
    expect(operationResponse.status).toBe(200);
    const operation = (await operationResponse.json()) as {
      state: string;
      commitSha: string | null;
    };
    expect(operation.state).toBe("committed");
    expect(operation.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Artifact file exists in the git work tree with correct frontmatter.
    const artifactPath = join(
      clone.workTreePath,
      ".authorbot",
      "annotations",
      accepted.annotationId,
      "annotation.md",
    );
    const artifact = await readFile(artifactPath, "utf8");
    expect(artifact).toContain("schema: authorbot.annotation/v1");
    expect(artifact).toContain(`id: ${accepted.annotationId}`);
    expect(artifact).toContain("kind: suggestion");
    expect(artifact).toContain("scope: range");
    expect(artifact).toContain(`chapter_id: ${CHAPTER_1.id}`);
    expect(artifact).toContain(`chapter_revision: ${CHAPTER_1.revision}`);
    expect(artifact).toContain("author: github:ivy-chen");
    expect(artifact).toContain("status: open");
    expect(artifact).toContain(`blockId: ${CHAPTER_1.firstBlockId}`);
    expect(artifact).toContain("Consider tightening this opening line.");

    // Trailer-bearing commit, authored by Authorbot, at the branch head.
    const head = (await git(clone.workTreePath, "rev-parse", "HEAD")).trim();
    expect(head).toBe(operation.commitSha);
    const log = await git(clone.workTreePath, "log", "-1", "--format=%an <%ae>%n%B");
    expect(log).toContain("Authorbot <authorbot@localhost>");
    expect(log).toContain("Authorbot-Actor: github:ivy-chen");
    expect(log).toContain(`Authorbot-Annotation: ${accepted.annotationId}`);
    expect(log).toContain(`Authorbot-Operation: ${accepted.operationId}`);

    // The record left pending_git.
    const listed1 = (await (
      await app1.app.request(
        `/v1/projects/${app1.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        { headers: { Cookie: cookie1 } },
      )
    ).json()) as { items: { id: string; status: string }[] };
    expect(listed1.items.map((a) => [a.id, a.status])).toContainEqual([
      accepted.annotationId,
      "open",
    ]);
    app1.close();

    // ---- instance 2: NEW app, SAME DB, no repo access ----------------------
    const app2 = await makeIntegrationApp({
      dbPath,
      workTreePath: clone.workTreePath,
      withReader: false,
    });
    const cookie2 = await devLogin(app2, "ivy-chen", "contributor");
    const listed2 = (await (
      await app2.app.request(
        `/v1/projects/${app2.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        { headers: { Cookie: cookie2 } },
      )
    ).json()) as { items: { id: string; status: string; body: string }[] };
    const survived = listed2.items.find((a) => a.id === accepted.annotationId);
    expect(survived).toBeDefined();
    expect(survived?.status).toBe("open");
    expect(survived?.body).toBe("Consider tightening this opening line.");
    app2.close();

    // ---- instance 3: FRESH DB, projection rebuilt from the repository ------
    const app3 = await makeIntegrationApp({
      db: openSqliteDatabase(":memory:"),
      workTreePath: clone.workTreePath,
    });
    const cookie3 = await devLogin(app3, "someone-else", "reader");
    const listed3 = (await (
      await app3.app.request(
        `/v1/projects/${app3.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        { headers: { Cookie: cookie3 } },
      )
    ).json()) as {
      items: { id: string; status: string; body: string; authorActorId: string }[];
    };
    const rebuilt = listed3.items.find((a) => a.id === accepted.annotationId);
    expect(rebuilt).toBeDefined();
    expect(rebuilt?.status).toBe("open");
    expect(rebuilt?.body).toBe("Consider tightening this opening line.");
    const author = await app3.repos.actors.getById(rebuilt?.authorActorId ?? "");
    expect(author?.externalIdentity).toBe("github:ivy-chen");

    // The example repo's committed annotation also came back through rebuild.
    const example = await app3.repos.annotations.getById(EXAMPLE_ANNOTATION_ID);
    expect(example).not.toBeNull();
    app3.close();
  });
});

describe("reply and withdraw round-trip through git", () => {
  let clone: BookRepoClone;

  beforeAll(async () => {
    clone = await cloneExampleBookRepo();
  });
  afterAll(async () => {
    await clone.cleanup();
  });

  it("commits the reply artifact and rewrites frontmatter status on withdraw", async () => {
    const app = await makeIntegrationApp({ workTreePath: clone.workTreePath });
    const cookie = await devLogin(app, "ivy-chen", "contributor");

    const created = (await (
      await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      )
    ).json()) as Accepted;

    // Reply.
    const replyResponse = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${created.annotationId}/replies`,
      jsonRequest("POST", { body: "Agreed - the second clause drags." }, { Cookie: cookie }),
    );
    expect(replyResponse.status).toBe(202);
    const reply = (await replyResponse.json()) as { replyId: string; operationId: string };
    const replyPath = join(
      clone.workTreePath,
      ".authorbot",
      "annotations",
      created.annotationId,
      "replies",
      `${reply.replyId}.md`,
    );
    const replyArtifact = await readFile(replyPath, "utf8");
    expect(replyArtifact).toContain("schema: authorbot.reply/v1");
    expect(replyArtifact).toContain(`annotation_id: ${created.annotationId}`);
    expect(replyArtifact).toContain("status: open");
    expect(replyArtifact).toContain("Agreed - the second clause drags.");

    // The reply author can withdraw just that reply. The body remains in Git
    // history, while the current artifact and rebuilt projection carry the
    // withdrawn state.
    const replyWithdrawResponse = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${created.annotationId}/replies/${reply.replyId}/withdraw`,
      jsonRequest("POST", undefined, { Cookie: cookie }),
    );
    expect(replyWithdrawResponse.status).toBe(202);
    const replyWithdraw = (await replyWithdrawResponse.json()) as { operationId: string };
    expect(await readFile(replyPath, "utf8")).toContain("status: withdrawn");
    expect((await app.repos.replies.getById(reply.replyId))?.status).toBe("withdrawn");
    const replyLog = await git(clone.workTreePath, "log", "-1", "--format=%B");
    expect(replyLog).toContain("Authorbot-Actor: github:ivy-chen");
    expect(replyLog).toContain(`Authorbot-Operation: ${replyWithdraw.operationId}`);

    // Withdraw by a maintainer (author-or-maintainer rule) - the artifact is
    // re-rendered with status: withdrawn and credited to the withdrawer.
    const maintainerCookie = await devLogin(app, "marta", "maintainer");
    const withdrawResponse = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${created.annotationId}/withdraw`,
      jsonRequest("POST", undefined, { Cookie: maintainerCookie }),
    );
    expect(withdrawResponse.status).toBe(202);
    const withdraw = (await withdrawResponse.json()) as { operationId: string };

    const artifact = await readFile(
      join(clone.workTreePath, ".authorbot", "annotations", created.annotationId, "annotation.md"),
      "utf8",
    );
    expect(artifact).toContain("status: withdrawn");
    expect(artifact).toContain("author: github:ivy-chen"); // author unchanged
    const log = await git(clone.workTreePath, "log", "-1", "--format=%B");
    expect(log).toContain("Authorbot-Actor: github:marta");
    expect(log).toContain(`Authorbot-Operation: ${withdraw.operationId}`);

    const record = await app.repos.annotations.getById(created.annotationId);
    expect(record?.status).toBe("withdrawn");
    app.close();
  });
});

describe("MIRROR_MODE=queue", () => {
  let clone: BookRepoClone;

  beforeAll(async () => {
    clone = await cloneExampleBookRepo();
  });
  afterAll(async () => {
    await clone.cleanup();
  });

  it("records the outbox row without draining; a later drain commits it", async () => {
    const app = await makeIntegrationApp({
      workTreePath: clone.workTreePath,
      config: { mirrorMode: "queue" },
    });
    const cookie = await devLogin(app, "ivy-chen", "contributor");

    const accepted = (await (
      await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      )
    ).json()) as Accepted;

    // Not drained inline: operation still queued, record still pending_git.
    const queuedOp = await app.repos.gitOperations.getById(accepted.operationId);
    expect(queuedOp?.state).toBe("queued");
    expect((await app.repos.annotations.getById(accepted.annotationId))?.status).toBe(
      "pending_git",
    );

    // Manual drain (what a Phase 5 alarm would do) commits it.
    const drained = await app.mirror.drain(app.projectId);
    expect(drained.outcomes).toHaveLength(1);
    expect(drained.outcomes[0]?.result).toBe("committed");
    expect((await app.repos.gitOperations.getById(accepted.operationId))?.state).toBe("committed");
    expect((await app.repos.annotations.getById(accepted.annotationId))?.status).toBe("open");
    app.close();
  });
});

describe("token and session storage (contract §7.5)", () => {
  let clone: BookRepoClone;

  beforeAll(async () => {
    clone = await cloneExampleBookRepo();
  });
  afterAll(async () => {
    await clone.cleanup();
  });

  it("neither token plaintext nor session ids appear anywhere in the database", async () => {
    const dbPath = join(clone.root, "secrets-scan.db");
    const app = await makeIntegrationApp({ dbPath, workTreePath: clone.workTreePath });
    const cookie = await devLogin(app, "joe", "maintainer");
    const sessionId = (cookie.split("=")[1] ?? "").split(".")[0] ?? "";
    expect(sessionId.length).toBeGreaterThan(20);

    const { token } = await mintToken(app, cookie, ["chapters:read", "annotations:write"]);
    expect(token.startsWith("authorbot_")).toBe(true);

    // Dump every row of every table and assert the secrets never appear.
    const tables = await app.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all();
    let dump = "";
    for (const table of tables) {
      const rows = await app.db.prepare(`SELECT * FROM "${String(table["name"])}"`).all();
      dump += JSON.stringify(rows);
    }
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(sessionId);
    app.close();

    // Belt and braces: scan the raw database file bytes too.
    const raw = await readFile(dbPath);
    expect(raw.includes(token)).toBe(false);
    expect(raw.includes(sessionId)).toBe(false);
  });
});
