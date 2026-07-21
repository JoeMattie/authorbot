/**
 * Phase 7 access control against a REAL Git repository (exit criteria 8 and 10).
 *
 * The unit suite (test/access-control.test.ts) proves the database side: a
 * queued annotation writes no `annotations` row and no outbox row. That is
 * necessary but not sufficient, because the claim the contract actually makes
 * is about the repository — "committing unreviewed submissions to the permanent
 * record would put spam in the book's history forever, where removing it means
 * rewriting history". Only a real work tree, a real `git log`, and a real drain
 * can show that nothing reached it.
 *
 * So everything here is asserted against the commit graph and the file system,
 * after draining the mirror, not against the tables.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BookConfig } from "@authorbot/schemas";
import type { AnnotationPolicy } from "@authorbot/domain";
import { uuidv7 } from "../../src/ids.js";
import {
  CHAPTER_1,
  cloneExampleBookRepo,
  devLogin,
  git,
  jsonRequest,
  makeIntegrationApp,
  mintToken,
  rangeSuggestionPayload,
  type BookRepoClone,
  type IntegrationApp,
} from "./helpers.js";

describe("Phase 7 access control (integration, against a real repository)", () => {
  let repo: BookRepoClone;
  let app: IntegrationApp;

  beforeEach(async () => {
    repo = await cloneExampleBookRepo();
    app = await makeIntegrationApp({ workTreePath: repo.workTreePath });
  });
  afterEach(async () => {
    app.close();
    await repo.cleanup();
  });

  // -- helpers -------------------------------------------------------------

  async function setPolicy(policy: AnnotationPolicy): Promise<void> {
    const existing = await app.repos.bookConfigs.get(app.projectId);
    const base = (existing?.config ?? {
      schema: "authorbot.book/v1",
      id: uuidv7(),
      title: "Hollow Creek Anomaly",
      slug: "hollow-creek-anomaly",
      language: "en",
    }) as BookConfig;
    await app.repos.bookConfigs.upsert({
      projectId: app.projectId,
      config: { ...base, collaboration: { annotation_policy: policy } },
      status: "committed",
      gitOperationId: null,
      sourceCommit: null,
      createdAt: existing?.createdAt ?? "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:00:00Z",
    });
  }

  /** A signed-in identity with no membership — a stranger on a public book. */
  async function signedInStranger(login: string): Promise<string> {
    const cookie = await devLogin(app, login, "contributor");
    const actor = await app.repos.actors.getByExternalIdentity(`github:${login}`);
    const membership = await app.repos.projectMemberships.getByProjectAndActor(
      app.projectId,
      actor!.id,
    );
    await app.repos.projectMemberships.revoke(membership!.id, "2026-07-19T00:00:00Z");
    return cookie;
  }

  const headCommit = (): Promise<string> => git(repo.workTreePath, "rev-parse", "HEAD");

  /** Every commit subject + body currently reachable, for "no trace" claims. */
  const fullLog = (): Promise<string> =>
    git(repo.workTreePath, "log", "--all", "--format=%H%n%B%n%an%n%s");

  const annotationDir = (id: string): string =>
    join(repo.workTreePath, ".authorbot", "annotations", id);

  // =========================================================================
  // Exit criterion 10
  // =========================================================================

  it("a pending annotation reaches no Git commit, and approval mirrors it as a normal one", async () => {
    const maintainer = await devLogin(app, "JoeMattie", "maintainer");
    await setPolicy("approval-gated");
    const stranger = await signedInStranger("drive-by-reader");

    const before = await headCommit();

    const submit = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: stranger }),
    );
    expect(submit.status).toBe(202);
    const { pendingId } = (await submit.json()) as { pendingId: string };

    // Drain hard: even if something HAD queued an outbox row, this would find
    // it. Nothing moves, because nothing was enqueued.
    await app.mirror.drain(app.projectId);

    expect(await headCommit()).toBe(before);
    expect(existsSync(annotationDir(pendingId))).toBe(false);
    expect(await fullLog()).not.toContain(pendingId);

    // --- approval makes it durable ---------------------------------------
    const approve = await app.app.request(
      `/v1/projects/${app.projectId}/moderation/${pendingId}/approve`,
      jsonRequest("POST", undefined, { Cookie: maintainer }),
    );
    expect(approve.status).toBe(202);
    await app.mirror.drain(app.projectId);

    // A commit landed, and the artifact is at the ordinary Phase 0 §4 path —
    // "approval mirrors it to Git as a normal annotation", with no marker
    // anywhere saying it came through moderation.
    expect(await headCommit()).not.toBe(before);
    const artifact = join(annotationDir(pendingId), "annotation.md");
    expect(existsSync(artifact)).toBe(true);

    const trailers = await git(repo.workTreePath, "log", "-1", "--format=%B");
    // Attribution follows the words: the trailer credits the SUBMITTER, not
    // the maintainer who approved.
    expect(trailers).toContain("Authorbot-Actor: github:drive-by-reader");
    expect(trailers).not.toContain("Authorbot-Actor: github:JoeMattie");
    expect(trailers).toContain(`Authorbot-Annotation: ${pendingId}`);

    // And it is an ordinary annotation from here on: `open`, votable, and
    // indistinguishable in the database from one written under `open`.
    const annotation = await app.repos.annotations.getById(pendingId);
    expect(annotation?.status).toBe("open");
  });

  it("rejection leaves no trace in the repository", async () => {
    const maintainer = await devLogin(app, "JoeMattie", "maintainer");
    await setPolicy("approval-gated");
    const stranger = await signedInStranger("spammer");

    const before = await headCommit();
    const submit = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: stranger }),
    );
    const { pendingId } = (await submit.json()) as { pendingId: string };

    const reject = await app.app.request(
      `/v1/projects/${app.projectId}/moderation/${pendingId}/reject`,
      jsonRequest("POST", { reason: "unrelated promotional text" }, { Cookie: maintainer }),
    );
    expect(reject.status).toBe(200);
    await app.mirror.drain(app.projectId);

    // Nothing committed, nothing written, nothing named anywhere in history.
    // This is the property that makes the whole design worthwhile: rejecting
    // spam requires no history rewrite because the spam was never in history.
    expect(await headCommit()).toBe(before);
    expect(await fullLog()).not.toContain(pendingId);
    const annotationsRoot = join(repo.workTreePath, ".authorbot", "annotations");
    const dirs = existsSync(annotationsRoot) ? readdirSync(annotationsRoot) : [];
    expect(dirs).not.toContain(pendingId);

    // The record survives in the database, so a mistake is recoverable and a
    // pattern of abuse is visible.
    const retained = await app.repos.pendingAnnotations.getById(pendingId);
    expect(retained?.status).toBe("rejected");
    expect(retained?.rejectionReason).toBe("unrelated promotional text");
    expect(retained?.body).toBe(rangeSuggestionPayload()["body"]);
  });

  it("a queued annotation never enters the projection, so a rebuild cannot resurrect it", async () => {
    await devLogin(app, "JoeMattie", "maintainer");
    await setPolicy("approval-gated");
    const stranger = await signedInStranger("drive-by-reader");
    const submit = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: stranger }),
    );
    const { pendingId } = (await submit.json()) as { pendingId: string };
    await app.mirror.drain(app.projectId);

    // The projection is rebuilt from committed artifacts. A pending row has
    // none, so a rebuild is exactly where a leak would show up.
    await app.api.rebuild();
    expect(await app.repos.annotations.getById(pendingId)).toBeNull();
    expect((await app.repos.pendingAnnotations.getById(pendingId))?.status).toBe("pending");
  });

  // =========================================================================
  // Exit criterion 8 — freeze, against the repository
  // =========================================================================

  it("a freeze stops every commit while reads and the published tree keep serving", async () => {
    const maintainer = await devLogin(app, "JoeMattie", "maintainer");
    const editor = await devLogin(app, "vera", "editor");

    // One committed contribution before the freeze, so there is something to
    // keep serving.
    const first = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: editor }),
    );
    const { annotationId } = (await first.json()) as { annotationId: string };
    await app.mirror.drain(app.projectId);
    const frozenHead = await headCommit();

    const freeze = await app.app.request(
      `/v1/projects/${app.projectId}/access/freeze`,
      jsonRequest("POST", { reason: "investigating a bad merge" }, { Cookie: maintainer }),
    );
    expect(freeze.status).toBe(200);

    for (const cookie of [editor, maintainer]) {
      const blocked = await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie }),
      );
      expect(blocked.status).toBe(423);
    }
    await app.mirror.drain(app.projectId);

    // Not one commit while frozen — including from the maintainer who froze it.
    expect(await headCommit()).toBe(frozenHead);

    // Reads are provably unaffected: the earlier contribution still serves,
    // and the chapter files are untouched on disk.
    const read = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${annotationId}`,
      { headers: { Cookie: editor } },
    );
    expect(read.status).toBe(200);
    expect(existsSync(join(repo.workTreePath, ".authorbot", "annotations", annotationId))).toBe(
      true,
    );
    const status = await git(repo.workTreePath, "status", "--porcelain");
    expect(status.trim()).toBe("");

    // Unfreezing restores writing, and the next commit chains off the same head.
    await app.app.request(
      `/v1/projects/${app.projectId}/access/unfreeze`,
      jsonRequest("POST", { reason: "resolved" }, { Cookie: maintainer }),
    );
    const after = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: editor }),
    );
    expect(after.status).toBe(202);
    await app.mirror.drain(app.projectId);
    const parent = (await git(repo.workTreePath, "rev-parse", "HEAD^")).trim();
    expect(parent).toBe(frozenHead.trim());
  });

  // =========================================================================
  // Exit criterion 7 — revocation preserves what is already committed
  // =========================================================================

  it("revoking an agent leaves its committed contributions and their attribution in Git", async () => {
    const maintainer = await devLogin(app, "JoeMattie", "maintainer");
    const { token, tokenId } = await mintToken(app, maintainer, [
      "chapters:read",
      "annotations:read",
      "annotations:write",
    ], "drafting-agent");

    const write = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Authorization: `Bearer ${token}` }),
    );
    expect(write.status).toBe(202);
    const { annotationId } = (await write.json()) as { annotationId: string };
    await app.mirror.drain(app.projectId);
    const committedHead = await headCommit();
    expect(existsSync(join(annotationDir(annotationId), "annotation.md"))).toBe(true);

    const revoke = await app.app.request(
      `/v1/projects/${app.projectId}/agent-tokens/${tokenId}`,
      jsonRequest("DELETE", undefined, { Cookie: maintainer }),
    );
    expect(revoke.status).toBe(204);

    // Effective on the next request.
    const afterRevoke = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Authorization: `Bearer ${token}` }),
    );
    expect(afterRevoke.status).toBe(401);
    await app.mirror.drain(app.projectId);

    // "Removing someone is not erasing them": the commit, the artifact, and
    // the attribution are all exactly where they were. Nothing here deletes
    // content, and revocation is not a history rewrite.
    expect(await headCommit()).toBe(committedHead);
    expect(existsSync(join(annotationDir(annotationId), "annotation.md"))).toBe(true);
    expect(await app.repos.annotations.getById(annotationId)).not.toBeNull();
    const log = await git(repo.workTreePath, "log", "--format=%B", "-n", "20");
    expect(log).toContain(`Authorbot-Annotation: ${annotationId}`);
  });
});
