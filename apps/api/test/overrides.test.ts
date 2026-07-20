/**
 * Phase 3 contract §4: maintainer overrides — reject, reopen, force-create,
 * cancel. Maintainer-only, reason-required, audited; force-create respects
 * the `(source_annotation_id, action_type, rule_version 0)` uniqueness key.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenSuggestion,
  devLogin,
  jsonRequest,
  makeHarness,
  type TestHarness,
} from "./helpers.js";

describe("maintainer overrides", () => {
  let h: TestHarness;
  let maintainer: string;
  let contributor: string;

  beforeEach(async () => {
    h = await makeHarness();
    maintainer = await devLogin(h, "maeve", "maintainer");
    contributor = await devLogin(h, "connor", "contributor");
  });
  afterEach(() => h.close());

  const reject = async (
    h: TestHarness,
    cookie: string,
    id: string,
    reason: string,
  ): Promise<Response> =>
    h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/reject`,
      jsonRequest("POST", { reason }, { Cookie: cookie }),
    );

  it("rejects an open suggestion, records an override decision, and audits it", async () => {
    const id = await createOpenSuggestion(h, contributor);
    const res = await reject(h, maintainer, id, "off-canon");
    expect(res.status).toBe(200);
    expect((await h.repos.annotations.getById(id))?.status).toBe("rejected");
    const decisions = await h.repos.decisions.listByAnnotation(id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.overrideReason).toBe("off-canon");
    expect(decisions[0]?.result).toBe("rejected");
    const audits = await h.repos.auditEvents.listByProject(h.projectId);
    expect(audits.some((a) => a.action === "annotation.reject")).toBe(true);
  });

  it("is maintainer-only (contributor is 403) and reason is required", async () => {
    const id = await createOpenSuggestion(h, contributor);
    const forbidden = await reject(h, contributor, id, "not your call");
    expect(forbidden.status).toBe(403);
    const noReason = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/reject`,
      jsonRequest("POST", {}, { Cookie: maintainer }),
    );
    expect(noReason.status).toBe(400);
  });

  it("reopens a rejected suggestion back to open", async () => {
    const id = await createOpenSuggestion(h, contributor);
    await reject(h, maintainer, id, "premature");
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/reopen`,
      jsonRequest("POST", { reason: "reconsidered" }, { Cookie: maintainer }),
    );
    expect(res.status).toBe(200);
    expect((await h.repos.annotations.getById(id))?.status).toBe("open");
  });

  it("force-creates a work item bypassing the rule (rule_version 0)", async () => {
    const id = await createOpenSuggestion(h, contributor);
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/force-create-work-item`,
      jsonRequest("POST", { reason: "editorial call" }, { Cookie: maintainer }),
    );
    expect(res.status).toBe(201);
    const decision = await h.repos.decisions.getByKey(id, "create_work_item", 0);
    expect(decision?.ruleVersion).toBe(0);
    expect(decision?.overrideReason).toBe("editorial call");
    const workItems = await h.repos.workItems.listBySourceAnnotation(id);
    expect(workItems).toHaveLength(1);
    expect((await h.repos.annotations.getById(id))?.status).toBe("work_item_created");
  });

  it("force-create is idempotent on the uniqueness key (second call 409s)", async () => {
    const id = await createOpenSuggestion(h, contributor);
    const first = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/force-create-work-item`,
      jsonRequest("POST", { reason: "once" }, { Cookie: maintainer }),
    );
    expect(first.status).toBe(201);
    const second = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/force-create-work-item`,
      jsonRequest("POST", { reason: "again" }, { Cookie: maintainer }),
    );
    expect(second.status).toBe(409);
    expect(await h.repos.workItems.listBySourceAnnotation(id)).toHaveLength(1);
  });

  it("cancels a ready work item before integration", async () => {
    const id = await createOpenSuggestion(h, contributor);
    await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/force-create-work-item`,
      jsonRequest("POST", { reason: "seed" }, { Cookie: maintainer }),
    );
    const workItem = (await h.repos.workItems.listBySourceAnnotation(id))[0];
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/work-items/${workItem?.id}/cancel`,
      jsonRequest("POST", { reason: "superseded by rewrite" }, { Cookie: maintainer }),
    );
    expect(res.status).toBe(200);
    expect((await h.repos.workItems.getById(workItem?.id ?? ""))?.status).toBe("cancelled");
    const cancelDecision = await h.repos.decisions.getByKey(id, "cancel_work_item", 0);
    expect(cancelDecision?.overrideReason).toBe("superseded by rewrite");
  });

  it("cancel is maintainer-only", async () => {
    const id = await createOpenSuggestion(h, contributor);
    await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}/force-create-work-item`,
      jsonRequest("POST", { reason: "seed" }, { Cookie: maintainer }),
    );
    const workItem = (await h.repos.workItems.listBySourceAnnotation(id))[0];
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/work-items/${workItem?.id}/cancel`,
      jsonRequest("POST", { reason: "not allowed" }, { Cookie: contributor }),
    );
    expect(res.status).toBe(403);
  });

  it("rejecting a non-open suggestion is a state conflict", async () => {
    const id = await createOpenSuggestion(h, contributor);
    await reject(h, maintainer, id, "first");
    const again = await reject(h, maintainer, id, "second");
    expect(again.status).toBe(409);
  });
});
