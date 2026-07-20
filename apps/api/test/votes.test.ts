/**
 * Phase 3 contract §2–§4: vote endpoints, the serialized vote command
 * pipeline (record vote + event, tally, rule eval, one-batch decision/work
 * item creation), and sticky `support_changed` semantics.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenSuggestion,
  devLogin,
  jsonRequest,
  makeHarness,
  CHAPTER_ID,
  type TestHarness,
} from "./helpers.js";
import { uuidv7 } from "../src/ids.js";

const votePath = (h: TestHarness, id: string): string =>
  `/v1/projects/${h.projectId}/annotations/${id}/vote`;

async function castVote(
  h: TestHarness,
  cookie: string,
  annotationId: string,
  value: "approve" | "reject" | "abstain",
): Promise<Response> {
  return h.app.request(votePath(h, annotationId), jsonRequest("PUT", { value }, { Cookie: cookie }));
}

describe("vote endpoints and pipeline", () => {
  let h: TestHarness;
  let author: string;

  beforeEach(async () => {
    // No inline mirror by default here — the Phase 3 outbox renderers live in
    // repo-coordinator; these tests assert DB + API state.
    h = await makeHarness();
    author = await devLogin(h, "author", "contributor");
  });
  afterEach(() => h.close());

  it("PUT records a vote, a vote_event, and returns the tally", async () => {
    const id = await createOpenSuggestion(h, author);
    const res = await castVote(h, author, id, "approve");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { votes: { approvals: number; netScore: number } };
    expect(body.votes.approvals).toBe(1);
    expect(body.votes.netScore).toBe(1);

    const current = await h.repos.votes.getCurrent(id, (await voterId(h, "author")) ?? "");
    expect(current?.value).toBe("approve");
    const events = await h.repos.voteEvents.listByAnnotation(id);
    expect(events).toHaveLength(1);
    expect(events[0]?.value).toBe("approve");
    expect(events[0]?.previousValue).toBeNull();
  });

  it("re-voting updates in place and appends a vote_event", async () => {
    const id = await createOpenSuggestion(h, author);
    await castVote(h, author, id, "approve");
    const res = await castVote(h, author, id, "reject");
    expect(res.status).toBe(200);
    const votes = await h.repos.votes.listByAnnotation(id);
    expect(votes).toHaveLength(1);
    expect(votes[0]?.value).toBe("reject");
    const events = await h.repos.voteEvents.listByAnnotation(id);
    expect(events).toHaveLength(2);
    expect(events[1]?.previousValue).toBe("approve");
    expect(events[1]?.value).toBe("reject");
  });

  it("DELETE clears the vote and records a cleared vote_event", async () => {
    const id = await createOpenSuggestion(h, author);
    await castVote(h, author, id, "approve");
    const res = await h.app.request(votePath(h, id), jsonRequest("DELETE", undefined, { Cookie: author }));
    expect(res.status).toBe(200);
    expect(await h.repos.votes.getCurrent(id, (await voterId(h, "author")) ?? "")).toBeNull();
    const events = await h.repos.voteEvents.listByAnnotation(id);
    expect(events.at(-1)?.value).toBeNull();
    expect(events.at(-1)?.previousValue).toBe("approve");
  });

  it("votes on a comment are 422 (suggestion-only)", async () => {
    const id = await createOpenSuggestion(h, author, { kind: "comment" });
    const res = await castVote(h, author, id, "approve");
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("domain-rule-failed");
  });

  it("requires votes:write (a reader is 403)", async () => {
    const id = await createOpenSuggestion(h, author);
    const reader = await devLogin(h, "reed", "reader");
    const res = await castVote(h, reader, id, "approve");
    expect(res.status).toBe(403);
  });

  it("needs a credential (anonymous is 401)", async () => {
    const id = await createOpenSuggestion(h, author);
    const res = await h.app.request(votePath(h, id), jsonRequest("PUT", { value: "approve" }));
    expect(res.status).toBe(401);
  });

  it("crossing the threshold creates exactly one decision + work item and transitions the annotation", async () => {
    const id = await createOpenSuggestion(h, author);
    const c1 = author;
    // Phase 6 §3.6: the default rule now also requires
    // `human_maintainer_approvals >= 1`, so a crossing needs the book's
    // (human) maintainer among the approvers.
    const c2 = await devLogin(h, "bella", "maintainer");
    const c3 = await devLogin(h, "cyril", "contributor");

    await castVote(h, c1, id, "approve");
    await castVote(h, c2, id, "approve");
    const crossing = await castVote(h, c3, id, "approve");
    expect(crossing.status).toBe(200);
    const body = (await crossing.json()) as {
      ruleSatisfied: boolean;
      decision: { id: string; result: string; workItemId: string } | null;
    };
    expect(body.ruleSatisfied).toBe(true);
    expect(body.decision?.result).toBe("create_work_item");

    const decisions = await h.repos.decisions.listByAnnotation(id);
    expect(decisions).toHaveLength(1);
    const workItems = await h.repos.workItems.listBySourceAnnotation(id);
    expect(workItems).toHaveLength(1);
    expect(workItems[0]?.status).toBe("ready");
    expect(workItems[0]?.type).toBe("revise_range");
    const annotation = await h.repos.annotations.getById(id);
    expect(annotation?.status).toBe("work_item_created");

    // Feed events: vote_aggregate per vote, plus decision_created + work_item_created.
    const events = await h.repos.events.listAfter(h.projectId, 0, 100);
    const types = events.map((e) => e.type);
    expect(types).toContain("decision_created");
    expect(types).toContain("work_item_created");
    expect(types.filter((t) => t === "vote_aggregate").length).toBe(3);
  });

  it("further votes never create a second work item and mark support_changed when support drops", async () => {
    const id = await createOpenSuggestion(h, author);
    const c1 = author;
    // Phase 6 §3.6: the default rule now also requires
    // `human_maintainer_approvals >= 1`, so a crossing needs the book's
    // (human) maintainer among the approvers.
    const c2 = await devLogin(h, "bella", "maintainer");
    const c3 = await devLogin(h, "cyril", "contributor");
    await castVote(h, c1, id, "approve");
    await castVote(h, c2, id, "approve");
    await castVote(h, c3, id, "approve");

    // c3 flips to reject: approvals 2, net 0 → rule no longer satisfied.
    const drop = await castVote(h, c3, id, "reject");
    const dropBody = (await drop.json()) as { decision: { supportChanged: boolean } | null };
    expect(dropBody.decision?.supportChanged).toBe(true);

    // Still exactly one decision + one work item, still ready.
    expect(await h.repos.decisions.listByAnnotation(id)).toHaveLength(1);
    const workItems = await h.repos.workItems.listBySourceAnnotation(id);
    expect(workItems).toHaveLength(1);
    expect(workItems[0]?.status).toBe("ready");

    const events = await h.repos.events.listAfter(h.projectId, 0, 200);
    expect(events.some((e) => e.type === "decision_support_changed")).toBe(true);

    // c3 back to approve: support returns → flag cleared, event emitted again.
    const restore = await castVote(h, c3, id, "approve");
    const restoreBody = (await restore.json()) as { decision: { supportChanged: boolean } | null };
    expect(restoreBody.decision?.supportChanged).toBe(false);
    const decision = (await h.repos.decisions.listByAnnotation(id))[0];
    expect(decision?.supportChanged).toBe(false);
  });

  it("concurrent qualifying votes yield exactly one decision and one work item", async () => {
    const id = await createOpenSuggestion(h, author);
    const c1 = author;
    // Phase 6 §3.6: the default rule now also requires
    // `human_maintainer_approvals >= 1`, so a crossing needs the book's
    // (human) maintainer among the approvers.
    const c2 = await devLogin(h, "bella", "maintainer");
    const c3 = await devLogin(h, "cyril", "contributor");
    await castVote(h, c1, id, "approve");
    await castVote(h, c2, id, "approve");
    // Fire many crossing attempts at once (same serialized queue + unique key).
    await Promise.all([
      castVote(h, c3, id, "approve"),
      castVote(h, c3, id, "approve"),
      castVote(h, c3, id, "approve"),
    ]);
    expect(await h.repos.decisions.listByAnnotation(id)).toHaveLength(1);
    expect(await h.repos.workItems.listBySourceAnnotation(id)).toHaveLength(1);
  });

  it("human vs agent approval split is tracked", async () => {
    const id = await createOpenSuggestion(h, author);
    // Mint an agent token with votes:write and vote with it.
    const maintainer = await devLogin(h, "mint", "maintainer");
    const mintRes = await h.app.request(
      `/v1/projects/${h.projectId}/agent-tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: maintainer,
          Origin: "http://localhost",
          "Idempotency-Key": uuidv7(),
        },
        body: JSON.stringify({ name: "voter-bot", scopes: ["annotations:read", "votes:write"] }),
      },
    );
    expect(mintRes.status).toBe(201);
    const { token } = (await mintRes.json()) as { token: string };

    await castVote(h, author, id, "approve");
    const agentRes = await h.app.request(votePath(h, id), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": uuidv7() },
      body: JSON.stringify({ value: "approve" }),
    });
    expect(agentRes.status).toBe(200);
    const tally = await h.repos.votes.tally(id);
    expect(tally.approvals).toBe(2);
    expect(tally.humanApprovals).toBe(1);
    expect(tally.agentApprovals).toBe(1);
  });

  it("embeds tallies (public: counts only) and myVote for members in annotation reads", async () => {
    const id = await createOpenSuggestion(h, author);
    await castVote(h, author, id, "approve");

    // Member sees own vote.
    const memberRes = await h.app.request(
      `/v1/projects/${h.projectId}/annotations/${id}`,
      { headers: { Cookie: author } },
    );
    const memberBody = (await memberRes.json()) as { votes: { approvals: number }; myVote: string | null };
    expect(memberBody.votes.approvals).toBe(1);
    expect(memberBody.myVote).toBe("approve");

    // Public reader sees counts, no myVote.
    const pub = await makeHarness({ config: { publicAnnotations: true } });
    const pubAuthor = await devLogin(pub, "author", "contributor");
    const pubId = await createOpenSuggestion(pub, pubAuthor);
    await castVote(pub, pubAuthor, pubId, "approve");
    const anonRes = await pub.app.request(
      `/v1/projects/${pub.projectId}/chapters/${CHAPTER_ID}/annotations`,
    );
    const anonBody = (await anonRes.json()) as { items: { votes: { approvals: number }; myVote?: unknown }[] };
    const entry = anonBody.items.find((a) => (a as { id: string } & typeof a).votes.approvals === 1);
    expect(entry?.votes.approvals).toBe(1);
    expect(entry && "myVote" in entry).toBe(false);
    pub.close();
  });
});

async function voterId(h: TestHarness, login: string): Promise<string | null> {
  const actor = await h.repos.actors.getByExternalIdentity(`github:${login}`);
  return actor?.id ?? null;
}
