/**
 * Regression tests for the Phase 3 governance-race findings:
 *
 * - Finding 1: a maintainer force-create racing a rule crossing must not
 *   produce two work items (the create_work_item uniqueness domain now spans
 *   rule_version 0 and >= 1).
 * - Finding 2: a maintainer reject racing a rule crossing must never leave a
 *   self-contradictory state (a rejected suggestion with a live ready work
 *   item, or a maintainer reject silently clobbered) - status transitions are
 *   optimistic compare-and-swaps.
 * - Finding 4: the maintainer override reason is member-only and must not leak
 *   to anonymous readers on public books.
 *
 * Cross-isolate races are simulated with a SECOND `createApi` over the SAME
 * database (a distinct per-isolate serial-command Map), so the two commands
 * are serialized only by the DB, not by an in-process queue.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";
import type { AppDeps, AppEnv } from "../src/deps.js";
import { createDevIdentityProvider } from "../src/identity/provider.js";
import type { Hono } from "hono";
import {
  baseConfig,
  createOpenSuggestion,
  devLogin,
  jsonRequest,
  makeHarness,
  type TestHarness,
} from "./helpers.js";

const votePath = (h: TestHarness, id: string): string =>
  `/v1/projects/${h.projectId}/annotations/${id}/vote`;
const forcePath = (h: TestHarness, id: string): string =>
  `/v1/projects/${h.projectId}/annotations/${id}/force-create-work-item`;
const rejectPath = (h: TestHarness, id: string): string =>
  `/v1/projects/${h.projectId}/annotations/${id}/reject`;

async function castVote(
  h: TestHarness,
  cookie: string,
  id: string,
  value: "approve" | "reject" | "abstain",
): Promise<Response> {
  return h.app.request(votePath(h, id), jsonRequest("PUT", { value }, { Cookie: cookie }));
}

/** A second app (fresh serialize Map) over the same DB - a distinct isolate. */
function siblingApp(h: TestHarness): Hono<AppEnv> {
  const deps: AppDeps = {
    db: h.db,
    config: baseConfig(),
    identityProvider: createDevIdentityProvider(),
  };
  return createApi(deps).app;
}

/**
 * Two approvals in place, so a third crosses the default rule
 * (approvals >= 3, net >= 2, human_approvals >= 1, and - Phase 6 contract
 * §3.6 - human_maintainer_approvals >= 1). The maintainer casts one of the two
 * seeded approvals so the crossing vote itself can come from any contributor;
 * these tests are about the concurrency of the crossing, not about who is
 * allowed to cause it.
 */
async function seedTwoApprovals(h: TestHarness): Promise<{ id: string; third: string; maintainer: string }> {
  const author = await devLogin(h, "author", "contributor");
  const third = await devLogin(h, "cyril", "contributor");
  const maintainer = await devLogin(h, "maeve", "maintainer");
  const id = await createOpenSuggestion(h, author);
  await castVote(h, author, id, "approve");
  await castVote(h, maintainer, id, "approve");
  return { id, third, maintainer };
}

describe("Finding 1: force-create vs rule crossing → one work item", () => {
  it("sequential: force-create then a crossing vote never creates a second work item", async () => {
    const h = await makeHarness();
    try {
      const { id, third, maintainer } = await seedTwoApprovals(h);
      const forced = await h.app.request(
        forcePath(h, id),
        jsonRequest("POST", { reason: "editorial call" }, { Cookie: maintainer }),
      );
      expect(forced.status).toBe(201);
      // The third approval now "crosses" the rule, but a work item already
      // exists → no second one, no error.
      const vote = await castVote(h, third, id, "approve");
      expect(vote.status).toBe(200);
      expect(await h.repos.workItems.listBySourceAnnotation(id)).toHaveLength(1);
      const creates = (await h.repos.decisions.listByAnnotation(id)).filter(
        (d) => d.actionType === "create_work_item",
      );
      expect(creates).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("sequential: a crossing then a force-create is a 409 (work item already exists)", async () => {
    const h = await makeHarness();
    try {
      const { id, third, maintainer } = await seedTwoApprovals(h);
      const vote = await castVote(h, third, id, "approve");
      expect(vote.status).toBe(200);
      const forced = await h.app.request(
        forcePath(h, id),
        jsonRequest("POST", { reason: "editorial call" }, { Cookie: maintainer }),
      );
      expect(forced.status).toBe(409);
      expect(await h.repos.workItems.listBySourceAnnotation(id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("cross-isolate race: force-create ‖ crossing vote → exactly one work item", async () => {
    for (let iter = 0; iter < 12; iter += 1) {
      const h = await makeHarness();
      try {
        const { id, third, maintainer } = await seedTwoApprovals(h);
        const appB = siblingApp(h);
        const [forced, voted] = await Promise.all([
          h.app.request(
            forcePath(h, id),
            jsonRequest("POST", { reason: "editorial call" }, { Cookie: maintainer }),
          ),
          appB.request(votePath(h, id), jsonRequest("PUT", { value: "approve" }, { Cookie: third })),
        ]);
        expect(forced.status, `force status iter ${iter}`).not.toBe(500);
        expect(voted.status, `vote status iter ${iter}`).not.toBe(500);
        const workItems = await h.repos.workItems.listBySourceAnnotation(id);
        expect(workItems.length, `work items iter ${iter}`).toBe(1);
        const creates = (await h.repos.decisions.listByAnnotation(id)).filter(
          (d) => d.actionType === "create_work_item",
        );
        expect(creates.length, `create decisions iter ${iter}`).toBe(1);
      } finally {
        h.close();
      }
    }
  });
});

describe("Finding 2: reject vs rule crossing → never self-contradictory", () => {
  it("sequential: reject then a crossing vote - no work item, stays rejected", async () => {
    const h = await makeHarness();
    try {
      const { id, third, maintainer } = await seedTwoApprovals(h);
      const rej = await h.app.request(
        rejectPath(h, id),
        jsonRequest("POST", { reason: "off-canon" }, { Cookie: maintainer }),
      );
      expect(rej.status).toBe(200);
      // A vote can no longer cross - the suggestion is rejected (not votable).
      const vote = await castVote(h, third, id, "approve");
      expect(vote.status).toBe(409);
      expect((await h.repos.annotations.getById(id))?.status).toBe("rejected");
      expect(await h.repos.workItems.listBySourceAnnotation(id)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("sequential: a crossing then a reject is a 409 - work item stays ready", async () => {
    const h = await makeHarness();
    try {
      const { id, third, maintainer } = await seedTwoApprovals(h);
      const vote = await castVote(h, third, id, "approve");
      expect(vote.status).toBe(200);
      const rej = await h.app.request(
        rejectPath(h, id),
        jsonRequest("POST", { reason: "too late" }, { Cookie: maintainer }),
      );
      expect(rej.status).toBe(409);
      expect((await h.repos.annotations.getById(id))?.status).toBe("work_item_created");
      const items = await h.repos.workItems.listBySourceAnnotation(id);
      expect(items).toHaveLength(1);
      expect(items[0]?.status).toBe("ready");
    } finally {
      h.close();
    }
  });

  it("cross-isolate race: reject ‖ crossing vote → consistent terminal state", async () => {
    for (let iter = 0; iter < 12; iter += 1) {
      const h = await makeHarness();
      try {
        const { id, third, maintainer } = await seedTwoApprovals(h);
        const appB = siblingApp(h);
        const [rej, voted] = await Promise.all([
          h.app.request(
            rejectPath(h, id),
            jsonRequest("POST", { reason: "off-canon" }, { Cookie: maintainer }),
          ),
          appB.request(votePath(h, id), jsonRequest("PUT", { value: "approve" }, { Cookie: third })),
        ]);
        expect(rej.status, `reject status iter ${iter}`).not.toBe(500);
        expect(voted.status, `vote status iter ${iter}`).not.toBe(500);

        const annotation = await h.repos.annotations.getById(id);
        const readyItems = (await h.repos.workItems.listBySourceAnnotation(id)).filter(
          (w) => w.status === "ready",
        );
        // The invariant: a rejected suggestion NEVER carries a live ready work
        // item, and a work_item_created suggestion has exactly one ready item.
        if (annotation?.status === "rejected") {
          expect(readyItems.length, `rejected must have no ready item iter ${iter}`).toBe(0);
        } else {
          expect(annotation?.status, `iter ${iter}`).toBe("work_item_created");
          expect(readyItems.length, `iter ${iter}`).toBe(1);
        }
        // Never both a reject decision AND a ready work item.
        const hasReject = (await h.repos.decisions.listByAnnotation(id)).some(
          (d) => d.actionType === "reject_suggestion" && d.result === "rejected",
        );
        expect(
          hasReject && readyItems.length > 0,
          `no reject-with-live-work-item iter ${iter}`,
        ).toBe(false);
      } finally {
        h.close();
      }
    }
  });
});

describe("Finding 4: override reason is member-only on public books", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeHarness({ config: { publicAnnotations: true } });
  });
  afterEach(() => h.close());

  it("hides overrideReason from anonymous readers, keeps it for members", async () => {
    const maintainer = await devLogin(h, "maeve", "maintainer");
    const author = await devLogin(h, "author", "contributor");
    const id = await createOpenSuggestion(h, author);
    const forced = await h.app.request(
      forcePath(h, id),
      jsonRequest("POST", { reason: "bypassing rule per private moderation thread" }, { Cookie: maintainer }),
    );
    expect(forced.status).toBe(201);

    // Anonymous public read: decision badge present, but NO override reason.
    const anon = await h.app.request(`/v1/projects/${h.projectId}/annotations/${id}`);
    expect(anon.status).toBe(200);
    const anonBody = (await anon.json()) as { decision: Record<string, unknown> | null };
    expect(anonBody.decision).not.toBeNull();
    expect(anonBody.decision).not.toHaveProperty("overrideReason");
    expect(JSON.stringify(anonBody)).not.toContain("private moderation thread");

    // Member read: override reason visible.
    const member = await h.app.request(`/v1/projects/${h.projectId}/annotations/${id}`, {
      headers: { Cookie: maintainer },
    });
    const memberBody = (await member.json()) as { decision: { overrideReason?: string } | null };
    expect(memberBody.decision?.overrideReason).toBe("bypassing rule per private moderation thread");
  });
});
