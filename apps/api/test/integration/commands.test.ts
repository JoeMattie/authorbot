/**
 * Idempotency replay + mismatch and annotation revision conflict
 * (contract §7.3) against the full stack: a replay must not create a second
 * annotation or a second git commit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAPTER_1,
  cloneExampleBookRepo,
  devLogin,
  git,
  jsonRequest,
  makeIntegrationApp,
  rangeSuggestionPayload,
  type BookRepoClone,
  type IntegrationApp,
} from "./helpers.js";
import { uuidv7 } from "../../src/ids.js";

describe("idempotency and revision conflicts (integration)", () => {
  let clone: BookRepoClone;
  let app: IntegrationApp;
  let cookie: string;

  beforeAll(async () => {
    clone = await cloneExampleBookRepo();
    app = await makeIntegrationApp({ workTreePath: clone.workTreePath });
    cookie = await devLogin(app, "carl", "contributor");
  });

  afterAll(async () => {
    app.close();
    await clone.cleanup();
  });

  const annotationsPath = (): string =>
    `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`;

  it("replaying the same key + body returns the stored 202 without a second commit", async () => {
    const key = uuidv7();
    const payload = rangeSuggestionPayload();
    const headers = { Cookie: cookie, "Idempotency-Key": key };

    const first = await app.app.request(annotationsPath(), jsonRequest("POST", payload, headers));
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { operationId: string; annotationId: string };
    const commitsAfterFirst = (await git(clone.workTreePath, "rev-list", "--count", "HEAD")).trim();

    const replay = await app.app.request(annotationsPath(), jsonRequest("POST", payload, headers));
    expect(replay.status).toBe(202);
    const replayBody = (await replay.json()) as { operationId: string; annotationId: string };
    expect(replayBody).toEqual(firstBody);

    // Exactly one annotation row and one new commit for the logical mutation.
    const rows = await app.db
      .prepare(`SELECT COUNT(*) AS n FROM annotations WHERE id = ?`)
      .bind(firstBody.annotationId)
      .all();
    expect(Number(rows[0]?.["n"])).toBe(1);
    const commitsAfterReplay = (await git(clone.workTreePath, "rev-list", "--count", "HEAD")).trim();
    expect(commitsAfterReplay).toBe(commitsAfterFirst);
  });

  it("the same key with a different body returns 409 idempotency-key-mismatch", async () => {
    const key = uuidv7();
    const headers = { Cookie: cookie, "Idempotency-Key": key };
    const first = await app.app.request(
      annotationsPath(),
      jsonRequest("POST", rangeSuggestionPayload(), headers),
    );
    expect(first.status).toBe(202);

    const mismatch = await app.app.request(
      annotationsPath(),
      jsonRequest(
        "POST",
        { ...rangeSuggestionPayload(), body: "A different body under the same key." },
        headers,
      ),
    );
    expect(mismatch.status).toBe(409);
    const problem = (await mismatch.json()) as { code: string };
    expect(problem.code).toBe("idempotency-key-mismatch");
  });

  it("a mutation without Idempotency-Key is rejected", async () => {
    const response = await app.app.request(annotationsPath(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost" },
      body: JSON.stringify(rangeSuggestionPayload()),
    });
    expect(response.status).toBe(400);
    const problem = (await response.json()) as { code: string };
    expect(problem.code).toBe("idempotency-key-required");
  });

  it("a stale chapterRevision returns 409 revision-conflict with the projected revision", async () => {
    const response = await app.app.request(
      annotationsPath(),
      jsonRequest(
        "POST",
        { ...rangeSuggestionPayload(), chapterRevision: CHAPTER_1.revision - 1 },
        { Cookie: cookie },
      ),
    );
    expect(response.status).toBe(409);
    const problem = (await response.json()) as { code: string; projectedRevision: number };
    expect(problem.code).toBe("revision-conflict");
    expect(problem.projectedRevision).toBe(CHAPTER_1.revision);
  });

  it("a blockId absent from the projected revision returns 422 unknown-block", async () => {
    const response = await app.app.request(
      annotationsPath(),
      jsonRequest(
        "POST",
        {
          ...rangeSuggestionPayload(),
          target: {
            blockId: "01900000-0000-7000-8000-0000000000ff",
            textPosition: { start: 0, end: 5 },
            textQuote: { exact: "nope" },
          },
        },
        { Cookie: cookie },
      ),
    );
    expect(response.status).toBe(422);
    const problem = (await response.json()) as { code: string };
    expect(problem.code).toBe("unknown-block");
  });
});
