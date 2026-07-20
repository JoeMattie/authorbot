import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BLOCK_ID_1,
  CHAPTER_ID,
  devLogin,
  jsonRequest,
  makeHarness,
  validAnnotationPayload,
  type TestHarness,
} from "./helpers.js";

describe("annotation, reply, and withdraw commands", () => {
  let h: TestHarness;
  let cookie: string;
  const path = (): string =>
    `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`;

  beforeEach(async () => {
    h = await makeHarness();
    cookie = await devLogin(h, "author", "contributor");
  });
  afterEach(() => h.close());

  async function createAnnotation(): Promise<{ annotationId: string; operationId: string }> {
    const res = await h.app.request(
      path(),
      jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie }),
    );
    expect(res.status).toBe(202);
    return (await res.json()) as { annotationId: string; operationId: string };
  }

  it("202: writes record + git operation + outbox + audit in one batch", async () => {
    const { annotationId, operationId } = await createAnnotation();

    const annotation = await h.repos.annotations.getById(annotationId);
    expect(annotation?.status).toBe("pending_git");
    expect(annotation?.gitOperationId).toBe(operationId);
    expect(annotation?.target).toEqual(validAnnotationPayload()["target"]);

    const operation = await h.repos.gitOperations.getById(operationId);
    expect(operation?.state).toBe("queued");

    const pending = await h.repos.outbox.listPending(h.projectId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("annotation.create");
    expect(pending[0]?.gitOperationId).toBe(operationId);

    expect(h.mutationsCommitted).toEqual([h.projectId]);

    // the operation is pollable
    const opRes = await h.app.request(
      `/v1/projects/${h.projectId}/operations/${operationId}`,
      { headers: { Cookie: cookie } },
    );
    expect(opRes.status).toBe(200);
    expect(((await opRes.json()) as { state: string }).state).toBe("queued");
  });

  it("400 on shape violations (strict command schema)", async () => {
    const bad = { ...validAnnotationPayload(), kind: "praise" };
    const res = await h.app.request(path(), jsonRequest("POST", bad, { Cookie: cookie }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; issues: unknown[] };
    expect(body.code).toBe("validation-failed");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("400 when textPosition.end <= start", async () => {
    const bad = validAnnotationPayload();
    (bad["target"] as { textPosition: { start: number; end: number } }).textPosition = {
      start: 10,
      end: 10,
    };
    const res = await h.app.request(path(), jsonRequest("POST", bad, { Cookie: cookie }));
    expect(res.status).toBe(400);
  });

  it("404 on unknown chapter", async () => {
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/01900000-0000-7000-8000-0000000000ff/annotations`,
      jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie }),
    );
    expect(res.status).toBe(404);
  });

  it("409 revision-conflict on stale chapterRevision", async () => {
    const stale = { ...validAnnotationPayload(), chapterRevision: 2 };
    const res = await h.app.request(path(), jsonRequest("POST", stale, { Cookie: cookie }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; projectedRevision: number };
    expect(body.code).toBe("revision-conflict");
    expect(body.projectedRevision).toBe(3);
  });

  it("422 unknown-block when the blockId is not in the projected revision", async () => {
    const bad = validAnnotationPayload();
    (bad["target"] as { blockId: string }).blockId = "01900000-0000-7000-8000-00000000dead";
    const res = await h.app.request(path(), jsonRequest("POST", bad, { Cookie: cookie }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("unknown-block");
  });

  it("422 unsafe-content on raw HTML and forbidden URL schemes", async () => {
    for (const body of [
      "hello <script>alert(1)</script>",
      "[click](javascript:alert(1))",
    ]) {
      const res = await h.app.request(
        path(),
        jsonRequest("POST", { ...validAnnotationPayload(), body }, { Cookie: cookie }),
      );
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("unsafe-content");
    }
  });

  it("400 when the body exceeds 32 KiB", async () => {
    const res = await h.app.request(
      path(),
      jsonRequest(
        "POST",
        { ...validAnnotationPayload(), body: "x".repeat(32 * 1024 + 1) },
        { Cookie: cookie },
      ),
    );
    expect(res.status).toBe(400);
  });

  it("chapter-scope annotations reject a target", async () => {
    const res = await h.app.request(
      path(),
      jsonRequest(
        "POST",
        {
          kind: "comment",
          scope: "chapter",
          chapterRevision: 3,
          target: { blockId: BLOCK_ID_1 },
          body: "chapter-wide note",
        },
        { Cookie: cookie },
      ),
    );
    expect(res.status).toBe(400);

    const ok = await h.app.request(
      path(),
      jsonRequest(
        "POST",
        { kind: "comment", scope: "chapter", chapterRevision: 3, body: "chapter-wide note" },
        { Cookie: cookie },
      ),
    );
    expect(ok.status).toBe(202);
  });

  describe("replies", () => {
    it("202 creates a pending_git reply with outbox + audit", async () => {
      const { annotationId } = await createAnnotation();
      const res = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/replies`,
        jsonRequest("POST", { body: "good point" }, { Cookie: cookie }),
      );
      expect(res.status).toBe(202);
      const { replyId } = (await res.json()) as { replyId: string };
      const reply = await h.repos.replies.getById(replyId);
      expect(reply?.status).toBe("pending_git");
      expect(reply?.annotationId).toBe(annotationId);
    });

    it("404 unknown annotation; 422 foreign parent reply", async () => {
      const missing = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/01900000-0000-7000-8000-00000000beef/replies`,
        jsonRequest("POST", { body: "hi" }, { Cookie: cookie }),
      );
      expect(missing.status).toBe(404);

      const { annotationId } = await createAnnotation();
      const badParent = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/replies`,
        jsonRequest(
          "POST",
          { body: "hi", parentReplyId: "01900000-0000-7000-8000-00000000cafe" },
          { Cookie: cookie },
        ),
      );
      expect(badParent.status).toBe(422);
    });
  });

  describe("withdraw", () => {
    /** Simulate the create commit landing: op committed, record open. */
    async function commitCreate(annotationId: string): Promise<void> {
      const annotation = await h.repos.annotations.getById(annotationId);
      if (annotation?.gitOperationId != null) {
        await h.repos.gitOperations.updateState(annotation.gitOperationId, {
          state: "committed",
          updatedAt: "2026-07-19T18:30:00Z",
          commitSha: "a".repeat(40),
        });
      }
      await h.repos.annotations.updateStatus(annotationId, "open", "2026-07-19T18:30:00Z");
    }

    it("409 while the annotation is still pending_git", async () => {
      const { annotationId } = await createAnnotation();
      const res = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/withdraw`,
        jsonRequest("POST", undefined, { Cookie: cookie }),
      );
      expect(res.status).toBe(409);
    });

    it("author withdraws an open annotation → 202 + new operation; status flips only post-commit", async () => {
      const { annotationId } = await createAnnotation();
      await commitCreate(annotationId);

      const res = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/withdraw`,
        jsonRequest("POST", undefined, { Cookie: cookie }),
      );
      expect(res.status).toBe(202);
      const { operationId } = (await res.json()) as { operationId: string };

      // Contract §5 regression: the record must NOT read `withdrawn` before
      // the git operation commits — the processor's sync batch flips it.
      const annotation = await h.repos.annotations.getById(annotationId);
      expect(annotation?.status).toBe("open");
      expect(annotation?.gitOperationId).toBe(operationId);
      expect((await h.repos.gitOperations.getById(operationId))?.state).toBe("queued");
    });

    it("non-author non-maintainer gets 403; maintainer succeeds", async () => {
      const { annotationId } = await createAnnotation();
      await commitCreate(annotationId);

      const stranger = await devLogin(h, "stranger", "contributor");
      const denied = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/withdraw`,
        jsonRequest("POST", undefined, { Cookie: stranger }),
      );
      expect(denied.status).toBe(403);

      const maintainer = await devLogin(h, "boss", "maintainer");
      const ok = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/withdraw`,
        jsonRequest("POST", undefined, { Cookie: maintainer }),
      );
      expect(ok.status).toBe(202);
    });

    it("409 while a withdraw operation for the annotation is still in flight", async () => {
      const { annotationId } = await createAnnotation();
      await commitCreate(annotationId);
      const first = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/withdraw`,
        jsonRequest("POST", undefined, { Cookie: cookie }),
      );
      expect(first.status).toBe(202);
      const second = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/withdraw`,
        jsonRequest("POST", undefined, { Cookie: cookie }),
      );
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe("state-conflict");
    });

    it("a withdraw whose git operation failed stays `open` and can be retried (no stuck state)", async () => {
      const { annotationId } = await createAnnotation();
      await commitCreate(annotationId);

      const first = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/withdraw`,
        jsonRequest("POST", undefined, { Cookie: cookie }),
      );
      expect(first.status).toBe(202);
      const { operationId } = (await first.json()) as { operationId: string };

      // Simulate the processor exhausting retries: operation failed.
      await h.repos.gitOperations.updateState(operationId, {
        state: "failed",
        updatedAt: "2026-07-19T18:40:00Z",
        error: "simulated exhaustion",
      });

      // DB still matches Git (annotation open) and a retry is NOT 409-blocked.
      expect((await h.repos.annotations.getById(annotationId))?.status).toBe("open");
      const retry = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/withdraw`,
        jsonRequest("POST", undefined, { Cookie: cookie }),
      );
      expect(retry.status).toBe(202);
    });

    it("409 illegal transition once the annotation is actually withdrawn", async () => {
      const { annotationId } = await createAnnotation();
      await commitCreate(annotationId);
      await h.repos.annotations.updateStatus(annotationId, "withdrawn", "2026-07-19T18:45:00Z");
      const res = await h.app.request(
        `/v1/projects/${h.projectId}/annotations/${annotationId}/withdraw`,
        jsonRequest("POST", undefined, { Cookie: cookie }),
      );
      expect(res.status).toBe(409);
    });
  });
});
