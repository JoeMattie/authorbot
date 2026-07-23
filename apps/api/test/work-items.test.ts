/**
 * Phase 3 contract §4/§5: work-queue reads (GET work-items with status
 * filter + cursor, GET work-items/{id}) and RULES_JSON boot validation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAPTER_ID,
  createOpenSuggestion,
  devLogin,
  jsonRequest,
  makeHarness,
  mintCanonicalToken,
  type TestHarness,
} from "./helpers.js";

describe("work-queue reads", () => {
  let h: TestHarness;
  let maintainer: string;

  async function forceItem(id: string): Promise<string> {
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/force-create-work-item`,
      jsonRequest("POST", { reason: "seed queue" }, { Cookie: maintainer }),
    );
    return ((await res.json()) as { workItemId: string }).workItemId;
  }

  beforeEach(async () => {
    h = await makeHarness();
    maintainer = await devLogin(h, "quill", "maintainer");
  });
  afterEach(() => h.close());

  it("lists ready work items with support summary and serves one by id", async () => {
    const a1 = await createOpenSuggestion(h, maintainer);
    const w1 = await forceItem(a1);
    const list = await h.app.request(
      `/v1/projects/${h.projectId}/work-items?status=ready`,
      { headers: { Cookie: maintainer } },
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      items: { id: string; status: string; support: { approvals: number } }[];
    };
    expect(body.items.map((w) => w.id)).toContain(w1);
    expect(body.items[0]?.support).toBeDefined();

    const one = await h.app.request(
      `/v1/projects/${h.projectId}/work-items/${w1}`,
      { headers: { Cookie: maintainer } },
    );
    expect(one.status).toBe(200);
    const oneBody = (await one.json()) as { id: string; decision: { id: string } | null };
    expect(oneBody.id).toBe(w1);
    expect(oneBody.decision).not.toBeNull();
  });

  it("filters by status", async () => {
    const a1 = await createOpenSuggestion(h, maintainer);
    const w1 = await forceItem(a1);
    await h.app.request(
      `/v1/projects/${h.projectId}/work-items/${w1}/cancel`,
      jsonRequest("POST", { reason: "dropped" }, { Cookie: maintainer }),
    );
    const ready = await h.app.request(
      `/v1/projects/${h.projectId}/work-items?status=ready`,
      { headers: { Cookie: maintainer } },
    );
    expect(((await ready.json()) as { items: unknown[] }).items).toHaveLength(0);
    const cancelled = await h.app.request(
      `/v1/projects/${h.projectId}/work-items?status=cancelled`,
      { headers: { Cookie: maintainer } },
    );
    expect(((await cancelled.json()) as { items: { id: string }[] }).items[0]?.id).toBe(w1);
  });

  it("returns bounded completed stubs with source, chapter, submitter, and commit", async () => {
    const annotationId = await createOpenSuggestion(h, maintainer);
    const workItemId = await forceItem(annotationId);
    const submitter = await h.repos.actors.getByExternalIdentity("github:quill");
    expect(submitter).not.toBeNull();
    const now = "2026-07-22T20:00:00.000Z";
    const operationId = "01910000-0000-7000-8000-000000000001";
    await h.repos.gitOperations.insert({
      id: operationId,
      projectId: h.projectId,
      correlationId: "01910000-0000-7000-8000-000000000002",
      expectedHead: null,
      state: "committed",
      attempts: 1,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    await h.repos.submissions.insert({
      id: "01910000-0000-7000-8000-000000000003",
      projectId: h.projectId,
      workItemId,
      leaseId: "01910000-0000-7000-8000-000000000004",
      actorId: submitter!.id,
      type: "range_replacement",
      baseRevision: 3,
      baseContentHash: `sha256:${"0".repeat(64)}`,
      content: "Retained prose must not appear in a completed stub.",
      summary: "Tightened the passage.",
      notes: null,
      state: "applied",
      gitOperationId: operationId,
      createdAt: now,
      updatedAt: now,
    });
    await h.repos.workItems.updateStatus(workItemId, "completed", now);

    const response = await h.app.request(
      `/v1/projects/${h.projectId}/work-items/completed?limit=1`,
      { headers: { Cookie: maintainer } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        id: string;
        source: { kind: string; body: string } | null;
        chapter: { id: string; title: string } | null;
        completedBy: { displayName: string } | null;
        completedAt: string;
        commitSha: string | null;
        content?: string;
      }>;
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: workItemId,
      source: { kind: "suggestion" },
      chapter: { id: CHAPTER_ID, title: "Baseline" },
      completedBy: { displayName: "quill" },
      completedAt: now,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(body.items[0]?.source?.body).toBeTruthy();
    expect(body.items[0]).not.toHaveProperty("content");
    expect(body.nextCursor).toBe(workItemId);
  });

  it.each([
    {
      label: "work-only",
      capabilities: ["work:read"],
      commentVisible: false,
      suggestionVisible: false,
    },
    {
      label: "comments-only",
      capabilities: ["work:read", "comments:read"],
      commentVisible: true,
      suggestionVisible: false,
    },
    {
      label: "suggestions-only",
      capabilities: ["work:read", "suggestions:read"],
      commentVisible: false,
      suggestionVisible: true,
    },
  ])(
    "projects completed source feedback by exact kind for a $label token",
    async ({ label, capabilities, commentVisible, suggestionVisible }) => {
      const commentBody = `private completed comment for ${label}`;
      const suggestionBody = `private completed suggestion for ${label}`;
      const commentId = await createOpenSuggestion(h, maintainer, {
        kind: "comment",
        body: commentBody,
      });
      const suggestionId = await createOpenSuggestion(h, maintainer, {
        body: suggestionBody,
      });
      const commentWorkItemId = await forceItem(commentId);
      const suggestionWorkItemId = await forceItem(suggestionId);
      await h.repos.workItems.updateStatus(
        commentWorkItemId,
        "completed",
        "2026-07-22T20:01:00.000Z",
      );
      await h.repos.workItems.updateStatus(
        suggestionWorkItemId,
        "completed",
        "2026-07-22T20:02:00.000Z",
      );

      const agent = await mintCanonicalToken(h, maintainer, capabilities, label);
      const response = await h.app.request(
        `/v1/projects/${h.projectId}/work-items/completed`,
        { headers: { Authorization: `Bearer ${agent.token}` } },
      );
      expect(response.status).toBe(200);
      const responseText = await response.text();
      const body = JSON.parse(responseText) as {
        items: Array<{
          id: string;
          sourceAnnotationId: string;
          source: { kind: string; body: string } | null;
          status: string;
        }>;
      };
      const byId = new Map(body.items.map((item) => [item.id, item]));
      const comment = byId.get(commentWorkItemId);
      const suggestion = byId.get(suggestionWorkItemId);

      expect(comment).toMatchObject({
        sourceAnnotationId: commentId,
        status: "completed",
        source: commentVisible ? { kind: "comment", body: commentBody } : null,
      });
      expect(suggestion).toMatchObject({
        sourceAnnotationId: suggestionId,
        status: "completed",
        source: suggestionVisible
          ? { kind: "suggestion", body: suggestionBody }
          : null,
      });
      expect(responseText.includes(commentBody)).toBe(commentVisible);
      expect(responseText.includes(suggestionBody)).toBe(suggestionVisible);
    },
  );

  it("requires work:read (contributor is 403, unknown id 404)", async () => {
    const contributor = await devLogin(h, "cass", "contributor");
    const forbidden = await h.app.request(
      `/v1/projects/${h.projectId}/work-items`,
      { headers: { Cookie: contributor } },
    );
    expect(forbidden.status).toBe(403);
    const missing = await h.app.request(
      `/v1/projects/${h.projectId}/work-items/01900000-0000-7000-8000-0000000fffff`,
      { headers: { Cookie: maintainer } },
    );
    expect(missing.status).toBe(404);
  });

  it("rejects an unknown status filter", async () => {
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/work-items?status=bogus`,
      { headers: { Cookie: maintainer } },
    );
    expect(res.status).toBe(400);
  });
});

describe("RULES_JSON boot validation", () => {
  it("boots with a valid custom rule and uses it", async () => {
    const rulesJson = JSON.stringify({
      easy_pass: {
        version: 2,
        when: { all: [{ metric: "approvals", operator: "gte", value: 1 }] },
        action: { type: "create_work_item", work_type: "revise_range" },
      },
    });
    const h = await makeHarness({ config: { rulesJson } });
    const author = await devLogin(h, "rick", "contributor");
    const id = await createOpenSuggestion(h, author);
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: author }),
    );
    const body = (await res.json()) as { decision: { ruleVersion: number; rule: string } | null };
    // A single approval crosses the custom threshold.
    expect(body.decision?.rule).toBe("easy_pass");
    expect(body.decision?.ruleVersion).toBe(2);
    h.close();
  });

  it("throws at boot on invalid RULES_JSON (never degrades to default)", async () => {
    await expect(makeHarness({ config: { rulesJson: "{ not json" } })).rejects.toThrow(/RULES_JSON/);
    await expect(
      makeHarness({
        config: {
          rulesJson: JSON.stringify({
            bad: { version: 1, when: { all: [] }, action: { type: "create_work_item", work_type: "revise_range" } },
          }),
        },
      }),
    ).rejects.toThrow(/RULES_JSON/);
  });
});
