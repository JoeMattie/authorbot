/**
 * Phase 3 contract §4/§5: work-queue reads (GET work-items with status
 * filter + cursor, GET work-items/{id}) and RULES_JSON boot validation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenSuggestion,
  devLogin,
  jsonRequest,
  makeHarness,
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
