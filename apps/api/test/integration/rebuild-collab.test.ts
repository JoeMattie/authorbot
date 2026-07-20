/**
 * Phase 3 exit criterion §7.5 (integration): a fresh DB + projection rebuild
 * restores decisions and work items from `.authorbot/` with statuses intact.
 * Covers both the fixtures the example repo ships and a decision/work-item
 * produced by a live threshold crossing, committed to Git, then rebuilt into a
 * brand-new database.
 */
import { openSqliteDatabase } from "@authorbot/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cloneExampleBookRepo,
  devLogin,
  jsonRequest,
  makeIntegrationApp,
  rangeSuggestionPayload,
  type BookRepoClone,
  type IntegrationApp,
} from "./helpers.js";

const CHAPTER_1_ID = "019cadfd-8900-7140-98fb-ceff64cada33";
// The decision + work-item fixtures the example repo commits under .authorbot.
const FIXTURE_DECISION_ID = "019f4102-5620-7732-b502-6bc0729392fa";
const FIXTURE_WORK_ITEM_ID = "019f4102-5a08-7a60-967d-d1ebfea5a188";
const FIXTURE_SOURCE_ANNOTATION_ID = "019f32b1-7b00-7896-92ab-30424bda2cd7";

describe("Phase 3 rebuild restores decisions and work items (§7.5)", () => {
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

  it("restores the example repo's committed decision + work-item fixtures on boot rebuild", async () => {
    // `app` was just built on a fresh in-memory DB with a reader → bootstrap
    // rebuilt the projection from the work tree.
    const decision = await app.repos.decisions.getById(FIXTURE_DECISION_ID);
    expect(decision, "committed decision fixture restored").not.toBeNull();
    expect(decision?.sourceAnnotationId).toBe(FIXTURE_SOURCE_ANNOTATION_ID);
    expect(decision?.result).toBe("create_work_item");
    expect(decision?.workItemId).toBe(FIXTURE_WORK_ITEM_ID);

    const workItem = await app.repos.workItems.getById(FIXTURE_WORK_ITEM_ID);
    expect(workItem, "committed work-item fixture restored").not.toBeNull();
    expect(workItem?.status).toBe("ready");
    expect(workItem?.sourceAnnotationId).toBe(FIXTURE_SOURCE_ANNOTATION_ID);

    // Served through the read API to a maintainer.
    const maintainer = await devLogin(app, "restorer", "maintainer");
    const listed = await app.app.request(
      `/v1/projects/${app.projectId}/work-items?status=ready`,
      { headers: { Cookie: maintainer } },
    );
    const body = (await listed.json()) as { items: { id: string }[] };
    expect(body.items.map((w) => w.id)).toContain(FIXTURE_WORK_ITEM_ID);
  });

  it("restores a live-crossing decision + work item into a brand-new database", async () => {
    // Produce a fresh decision + ready work item via a threshold crossing.
    const c1 = await devLogin(app, "nora", "contributor");
    // Phase 6 §3.6: the default rule requires a human maintainer's approval.
    const c2 = await devLogin(app, "omar", "maintainer");
    const c3 = await devLogin(app, "priya", "contributor");
    const created = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1_ID}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: c1 }),
    );
    const { annotationId } = (await created.json()) as { annotationId: string };
    await app.mirror.drain(app.projectId);

    const vote = async (cookie: string): Promise<Response> =>
      app.app.request(
        `/v1/projects/${app.projectId}/annotations/${annotationId}/vote`,
        jsonRequest("PUT", { value: "approve" }, { Cookie: cookie }),
      );
    await vote(c1);
    await vote(c2);
    await vote(c3);
    await app.mirror.drain(app.projectId);

    // Contract §5 event set: creation emits annotation_created; the mirror
    // finalize emits operation_completed (Finding 7).
    const feed = await app.repos.events.listAfter(app.projectId, 0, 200);
    const feedTypes = feed.map((e) => e.type);
    expect(feedTypes).toContain("annotation_created");
    expect(feedTypes).toContain("operation_completed");

    const [decision] = await app.repos.decisions.listByAnnotation(annotationId);
    const [workItem] = await app.repos.workItems.listBySourceAnnotation(annotationId);
    expect(decision).toBeDefined();
    expect(workItem).toBeDefined();
    const decisionId = decision?.id ?? "";
    const workItemId = workItem?.id ?? "";
    const ruleVersion = decision?.ruleVersion ?? 0;

    // ---- FRESH DB, projection rebuilt from the committed artifacts ----------
    const fresh = await makeIntegrationApp({
      db: openSqliteDatabase(":memory:"),
      workTreePath: repo.workTreePath,
    });
    try {
      const rebuiltDecision = await fresh.repos.decisions.getById(decisionId);
      expect(rebuiltDecision, "decision restored into fresh DB").not.toBeNull();
      expect(rebuiltDecision?.sourceAnnotationId).toBe(annotationId);
      expect(rebuiltDecision?.result).toBe("create_work_item");
      expect(rebuiltDecision?.ruleVersion).toBe(ruleVersion);
      expect(rebuiltDecision?.workItemId).toBe(workItemId);
      // The uniqueness key is intact so a post-rebuild re-evaluation is a no-op.
      const byKey = await fresh.repos.decisions.getByKey(
        annotationId,
        "create_work_item",
        ruleVersion,
      );
      expect(byKey?.id).toBe(decisionId);

      const rebuiltWorkItem = await fresh.repos.workItems.getById(workItemId);
      expect(rebuiltWorkItem, "work item restored into fresh DB").not.toBeNull();
      expect(rebuiltWorkItem?.status).toBe("ready");
      expect(rebuiltWorkItem?.type).toBe("revise_range");
      expect(rebuiltWorkItem?.sourceAnnotationId).toBe(annotationId);

      const maintainer = await devLogin(fresh, "restorer", "maintainer");
      const listed = await fresh.app.request(
        `/v1/projects/${fresh.projectId}/work-items?status=ready`,
        { headers: { Cookie: maintainer } },
      );
      const body = (await listed.json()) as { items: { id: string }[] };
      expect(body.items.map((w) => w.id)).toContain(workItemId);
    } finally {
      fresh.close();
    }
  });

  it("rebuilds a force-create-then-cancel history without an idempotency collision (Finding 3)", async () => {
    // A maintainer force-creates a work item (create_work_item, rule_version 0)
    // then cancels the SAME work item (cancel_work_item, rule_version 0). Both
    // are committed to Git; a fresh-DB rebuild must derive distinct
    // action_types for them (not collapse both to cancel_work_item and violate
    // the idempotency index), so the whole projection rebuilds cleanly.
    const maintainer = await devLogin(app, "maple", "maintainer");
    const c1 = await devLogin(app, "quinn", "contributor");
    const created = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1_ID}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: c1 }),
    );
    const { annotationId } = (await created.json()) as { annotationId: string };
    await app.mirror.drain(app.projectId);

    const forced = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${annotationId}/force-create-work-item`,
      jsonRequest("POST", { reason: "editorial call" }, { Cookie: maintainer }),
    );
    expect(forced.status).toBe(201);
    const { decisionId: forceDecisionId, workItemId } = (await forced.json()) as {
      decisionId: string;
      workItemId: string;
    };
    await app.mirror.drain(app.projectId);

    const cancelled = await app.app.request(
      `/v1/projects/${app.projectId}/work-items/${workItemId}/cancel`,
      jsonRequest("POST", { reason: "superseded by a rewrite" }, { Cookie: maintainer }),
    );
    expect(cancelled.status).toBe(200);
    const { decisionId: cancelDecisionId } = (await cancelled.json()) as { decisionId: string };
    await app.mirror.drain(app.projectId);

    // ---- FRESH DB, projection rebuilt from the committed artifacts ----------
    const fresh = await makeIntegrationApp({
      db: openSqliteDatabase(":memory:"),
      workTreePath: repo.workTreePath,
    });
    try {
      const forceDecision = await fresh.repos.decisions.getById(forceDecisionId);
      expect(forceDecision, "force-create decision restored").not.toBeNull();
      expect(forceDecision?.actionType).toBe("create_work_item");
      expect(forceDecision?.result).toBe("create_work_item");
      expect(forceDecision?.ruleVersion).toBe(0);

      const cancelDecision = await fresh.repos.decisions.getById(cancelDecisionId);
      expect(cancelDecision, "cancel decision restored").not.toBeNull();
      expect(cancelDecision?.actionType).toBe("cancel_work_item");
      expect(cancelDecision?.result).toBe("overridden");

      // Both idempotency keys are intact and distinct.
      expect((await fresh.repos.decisions.getByKey(annotationId, "create_work_item", 0))?.id).toBe(
        forceDecisionId,
      );
      expect((await fresh.repos.decisions.getByKey(annotationId, "cancel_work_item", 0))?.id).toBe(
        cancelDecisionId,
      );

      const rebuiltWorkItem = await fresh.repos.workItems.getById(workItemId);
      expect(rebuiltWorkItem?.status).toBe("cancelled");
    } finally {
      fresh.close();
    }
  });
});
