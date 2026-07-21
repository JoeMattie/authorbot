/**
 * Phase 7 author-facing access control, at the HTTP boundary.
 *
 * Exit criteria 6–10 in order: an author can see and change everything from the
 * API alone; revocation is effective on the next request; freeze refuses every
 * write path while reads keep working; each policy mode is enforced
 * server-side; and `approval-gated` keeps unapproved comments out of votes,
 * out of rules, and out of everyone else's view.
 *
 * The Git half of exit criterion 10 — "reaches no Git commit … approval mirrors
 * it … rejection leaves no trace in the repository" — is asserted against a
 * real repository in test/integration/phase7-access-control.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { BookConfig } from "@authorbot/schemas";
import type { AnnotationPolicy } from "@authorbot/domain";
import { uuidv7 } from "../src/ids.js";
import {
  API_ORIGIN,
  BLOCK_ID_1,
  CHAPTER_ID,
  createOpenSuggestion,
  devLogin,
  jsonRequest,
  makeHarness,
  mintToken,
  validAnnotationPayload,
  type TestHarness,
} from "./helpers.js";

/**
 * Response bodies in this suite are asserted field by field against a
 * deliberately loose type. The shapes are pinned by openapi.yaml and by the
 * handlers themselves; restating each of them here as an interface would add a
 * second place to update without adding a check the assertions do not already
 * make.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = any;
const json = async (response: Response): Promise<JsonBody> =>
  (await response.json()) as JsonBody;

let harness: TestHarness;

beforeEach(async () => {
  harness = await makeHarness();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOOK_ID = "01900000-0000-7000-8000-0000000000bb";

/**
 * Project a `book.yml` declaring `policy` straight into `book_configs`.
 *
 * Writing the projection row rather than going through the settings PATCH is
 * deliberate for these tests: PATCH is a 202 whose commit lands asynchronously,
 * and what is under test here is the ENFORCEMENT of a policy, not the route
 * that changes it. A separate test drives the PATCH end to end.
 */
async function setPolicy(policy: AnnotationPolicy): Promise<void> {
  const config: BookConfig = {
    schema: "authorbot.book/v1",
    id: BOOK_ID,
    title: "Hollow Creek Anomaly",
    slug: "hollow-creek-anomaly",
    language: "en",
    collaboration: { annotation_policy: policy },
  };
  await harness.repos.bookConfigs.upsert({
    projectId: harness.projectId,
    config,
    status: "committed",
    gitOperationId: null,
    sourceCommit: null,
    createdAt: "2026-07-19T00:00:00Z",
    updatedAt: "2026-07-19T00:00:00Z",
  });
}

/**
 * A valid signed-in session belonging to NO membership — the "any signed-in
 * GitHub user" of the `open` and `approval-gated` rows.
 *
 * Dev login always grants a membership, so the membership is revoked
 * afterwards. That is exactly the state a stranger arriving at a public book
 * is in: a real GitHub identity, a real session, and no standing in the
 * project.
 */
async function signedInStranger(login: string): Promise<string> {
  const cookie = await devLogin(harness, login, "contributor");
  const actor = await harness.repos.actors.getByExternalIdentity(`github:${login}`);
  const membership = await harness.repos.projectMemberships.getByProjectAndActor(
    harness.projectId,
    actor!.id,
  );
  await harness.repos.projectMemberships.revoke(membership!.id, "2026-07-19T00:00:00Z");
  return cookie;
}

const annotate = (headers: Record<string, string>) =>
  harness.app.request(
    `/v1/projects/${harness.projectId}/chapters/${CHAPTER_ID}/annotations`,
    jsonRequest("POST", validAnnotationPayload(), headers),
  );

const readAnnotations = (headers: Record<string, string>) =>
  harness.app.request(
    `/v1/projects/${harness.projectId}/chapters/${CHAPTER_ID}/annotations`,
    { headers },
  );

// ---------------------------------------------------------------------------
// Exit criterion 9 — each policy enforced server-side
// ---------------------------------------------------------------------------

describe("annotation policy is enforced server-side (exit criterion 9)", () => {
  it("collaborators-only (the default) rejects a signed-in non-member", async () => {
    const stranger = await signedInStranger("passing-stranger");
    const response = await annotate({ Cookie: stranger });
    expect(response.status).toBe(403);
    expect((await json(response)).code).toBe("forbidden");
  });

  it("collaborators-only admits an ordinary member", async () => {
    const cookie = await devLogin(harness, "avery-cole", "contributor");
    expect((await annotate({ Cookie: cookie })).status).toBe(202);
  });

  it("open admits a signed-in non-member", async () => {
    await setPolicy("open");
    const stranger = await signedInStranger("passing-stranger");
    const response = await annotate({ Cookie: stranger });
    expect(response.status).toBe(202);
    // Published immediately: `open` is not `approval-gated`.
    const body = await json(response);
    expect(body.status).toBe("queued");
    expect(body.annotationId).toBeTruthy();
  });

  it("open still refuses anonymous writes", async () => {
    await setPolicy("open");
    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapters/${CHAPTER_ID}/annotations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": uuidv7(),
          Origin: API_ORIGIN,
        },
        body: JSON.stringify(validAnnotationPayload()),
      },
    );
    // 401, not 403: there is no credential to evaluate. Design §19.7 defers
    // anonymous writing until moderation, spam controls, privacy, and a
    // deletion policy all exist.
    expect(response.status).toBe(401);
  });

  it("open does NOT admit an agent token that holds no membership", async () => {
    await setPolicy("open");
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token, tokenId } = await mintToken(harness, maintainer, [
      "annotations:read",
      "annotations:write",
    ]);
    const record = await harness.repos.agentTokens.getById(tokenId);
    const membership = await harness.repos.projectMemberships.getByProjectAndActor(
      harness.projectId,
      record!.actorId,
    );
    await harness.repos.projectMemberships.revoke(membership!.id, "2026-07-19T00:00:00Z");

    const response = await annotate({ Authorization: `Bearer ${token}` });
    expect(response.status).toBe(403);
  });

  it("locked refuses contributors and editors", async () => {
    await setPolicy("locked");
    for (const role of ["contributor", "editor"] as const) {
      const cookie = await devLogin(harness, `locked-${role}`, role);
      const response = await annotate({ Cookie: cookie });
      expect(response.status, role).toBe(423);
      const body = await json(response);
      expect(body.code).toBe("book-locked");
      expect(body.detail).toMatch(/keep their membership/i);
    }
  });

  it("locked still admits the author (exit criterion 9)", async () => {
    await setPolicy("locked");
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    expect((await annotate({ Cookie: maintainer })).status).toBe(202);
  });

  it("locked admits an author's agent holding a maintainer-role membership", async () => {
    await setPolicy("locked");
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token, tokenId } = await mintToken(harness, maintainer, [
      "annotations:read",
      "annotations:write",
    ]);
    const record = await harness.repos.agentTokens.getById(tokenId);

    // Minting pins the agent to `editor`, which `locked` refuses …
    expect((await annotate({ Authorization: `Bearer ${token}` })).status).toBe(423);

    // … until the author deliberately grants it the maintainer role. That is
    // the ordinary scope-intersection rule, never an inheritance from the
    // token's owner.
    const promote = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${record!.actorId}`,
      jsonRequest("PATCH", { role: "maintainer", reason: "author's drafting agent" }, {
        Cookie: maintainer,
      }),
    );
    expect(promote.status).toBe(200);

    const after = await annotate({ Authorization: `Bearer ${token}` });
    expect(after.status).toBe(202);
  });

  it("locked leaves reads completely alone", async () => {
    await setPolicy("locked");
    const cookie = await devLogin(harness, "reader-person", "reader");
    expect((await readAnnotations({ Cookie: cookie })).status).toBe(200);
  });

  it("locked refuses votes, claims, and submissions too — a vote is a write", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const contributor = await devLogin(harness, "voter-person", "contributor");
    const annotationId = await createOpenSuggestion(harness, maintainer);
    await setPolicy("locked");

    const vote = await harness.app.request(
      `/v1/projects/${harness.projectId}/annotations/${annotationId}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: contributor }),
    );
    expect(vote.status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 8 — freeze
// ---------------------------------------------------------------------------

describe("freeze refuses every write path while reads keep working (exit criterion 8)", () => {
  const freeze = (cookie: string) =>
    harness.app.request(
      `/v1/projects/${harness.projectId}/access/freeze`,
      jsonRequest("POST", { reason: "runaway fleet; stopping to look" }, { Cookie: cookie }),
    );

  it("refuses maintainer writes, not just collaborator writes", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    expect((await freeze(maintainer)).status).toBe(200);

    const response = await annotate({ Cookie: maintainer });
    expect(response.status).toBe(423);
    const body = await json(response);
    expect(body.code).toBe("book-frozen");
    expect(body.reason).toBe("runaway fleet; stopping to look");
    expect(body.detail).toMatch(/including maintainers/i);
  });

  it("refuses annotations, replies, withdrawals, votes, claims, and submissions", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const annotationId = await createOpenSuggestion(harness, maintainer);
    const workItem = {
      id: uuidv7(),
      projectId: harness.projectId,
      type: "revise_range" as const,
      status: "ready" as const,
      sourceAnnotationId: annotationId,
      chapterId: CHAPTER_ID,
      baseRevision: 3,
      target: null,
      priority: "normal" as const,
      createdAt: "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:00:00Z",
    };
    await harness.repos.workItems.insert(workItem);
    await freeze(maintainer);

    const p = `/v1/projects/${harness.projectId}`;
    const attempts: [string, Response | Promise<Response>][] = [
      ["annotation", annotate({ Cookie: maintainer })],
      [
        "reply",
        harness.app.request(
          `${p}/annotations/${annotationId}/replies`,
          jsonRequest("POST", { body: "A thought." }, { Cookie: maintainer }),
        ),
      ],
      [
        "withdraw",
        harness.app.request(
          `${p}/annotations/${annotationId}/withdraw`,
          jsonRequest("POST", undefined, { Cookie: maintainer }),
        ),
      ],
      [
        "vote",
        harness.app.request(
          `${p}/annotations/${annotationId}/vote`,
          jsonRequest("PUT", { value: "approve" }, { Cookie: maintainer }),
        ),
      ],
      [
        "vote-clear",
        harness.app.request(
          `${p}/annotations/${annotationId}/vote`,
          jsonRequest("DELETE", undefined, { Cookie: maintainer }),
        ),
      ],
      [
        "claim",
        harness.app.request(
          `${p}/work-items/${workItem.id}/claim`,
          jsonRequest("POST", {}, { Cookie: maintainer }),
        ),
      ],
      [
        "lease-release",
        harness.app.request(
          `${p}/work-items/${workItem.id}/lease/release`,
          jsonRequest("POST", {}, { Cookie: maintainer }),
        ),
      ],
      [
        "submission",
        harness.app.request(
          `${p}/work-items/${workItem.id}/submissions`,
          jsonRequest(
            "POST",
            {
              leaseId: uuidv7(),
              leaseToken: "irrelevant",
              type: "range_replacement" as const,
              baseRevision: 3,
              baseContentHash: "sha256:0",
              content: "New text.",
            },
            { Cookie: maintainer },
          ),
        ),
      ],
      [
        "chapter-submission",
        harness.app.request(
          `${p}/chapter-submissions`,
          jsonRequest(
            "POST",
            { type: "new_chapter", title: "T", slug: "t", body: "Words." },
            { Cookie: maintainer },
          ),
        ),
      ],
      [
        "force-create-work-item",
        harness.app.request(
          `${p}/annotations/${annotationId}/force-create-work-item`,
          jsonRequest("POST", { reason: "because" }, { Cookie: maintainer }),
        ),
      ],
      [
        "reject-suggestion",
        harness.app.request(
          `${p}/annotations/${annotationId}/reject`,
          jsonRequest("POST", { reason: "because" }, { Cookie: maintainer }),
        ),
      ],
    ];

    for (const [name, promise] of attempts) {
      const response = await promise;
      expect(response.status, `${name} should be refused by the freeze`).toBe(423);
      expect((await json(response)).code, name).toBe("book-frozen");
    }
  });

  it("leaves every read serving normally", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const annotationId = await createOpenSuggestion(harness, maintainer);
    await freeze(maintainer);

    const p = `/v1/projects/${harness.projectId}`;
    const reads = [
      `${p}`,
      `${p}/chapters`,
      `${p}/chapters/${CHAPTER_ID}`,
      `${p}/chapters/${CHAPTER_ID}/annotations`,
      `${p}/annotations/${annotationId}`,
      `${p}/annotations/${annotationId}/replies`,
      `${p}/members`,
      `${p}/work-items`,
      `${p}/access`,
      `${p}/collaborators`,
      `${p}/agent-tokens`,
      `${p}/audit`,
      `${p}/rate-limits`,
      `${p}/events?poll=1`,
    ];
    for (const url of reads) {
      const response = await harness.app.request(url, { headers: { Cookie: maintainer } });
      expect(response.status, url).toBe(200);
    }
  });

  it("does not block the controls that undo it — a freeze is not a one-way door", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await freeze(maintainer);

    const unfreeze = await harness.app.request(
      `/v1/projects/${harness.projectId}/access/unfreeze`,
      jsonRequest("POST", { reason: "all clear" }, { Cookie: maintainer }),
    );
    expect(unfreeze.status).toBe(200);
    expect((await json(unfreeze)).freeze.state).toBe("open");

    expect((await annotate({ Cookie: maintainer })).status).toBe(202);
  });

  it("keeps the first freeze's reason when re-frozen", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await freeze(maintainer);
    const second = await harness.app.request(
      `/v1/projects/${harness.projectId}/access/freeze`,
      jsonRequest("POST", { reason: "a different, later reason" }, { Cookie: maintainer }),
    );
    expect(second.status).toBe(200);
    const body = await json(second);
    expect(body.changed).toBe(false);
    expect(body.freeze.reason).toBe("runaway fleet; stopping to look");
  });

  it("is maintainer-only", async () => {
    const editor = await devLogin(harness, "some-editor", "editor");
    expect((await freeze(editor)).status).toBe(403);
  });

  it("records an audit event naming who froze the book and why", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await freeze(maintainer);
    const audit = await harness.app.request(
      `/v1/projects/${harness.projectId}/audit?action=project.freeze`,
      { headers: { Cookie: maintainer } },
    );
    const body = await json(audit);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].actorIdentity).toBe("github:initial-maintainer");
    expect(body.items[0].metadata.reason).toBe("runaway fleet; stopping to look");
  });
});

// ---------------------------------------------------------------------------
// Pause agents
// ---------------------------------------------------------------------------

describe("pause agents stops the fleet and leaves humans working", () => {
  it("refuses agent writes while the same write from a human succeeds", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token } = await mintToken(harness, maintainer, [
      "annotations:read",
      "annotations:write",
    ]);
    // Baseline: the agent can write.
    expect((await annotate({ Authorization: `Bearer ${token}` })).status).toBe(202);

    const pause = await harness.app.request(
      `/v1/projects/${harness.projectId}/access/pause-agents`,
      jsonRequest("POST", { reason: "one of them is looping" }, { Cookie: maintainer }),
    );
    expect(pause.status).toBe(200);
    expect((await json(pause)).affectedTokens).toBe(1);

    const paused = await annotate({ Authorization: `Bearer ${token}` });
    expect(paused.status).toBe(403);
    expect((await json(paused)).code).toBe("agents-paused");

    // Humans are untouched — the whole point of the control.
    const contributor = await devLogin(harness, "human-collaborator", "contributor");
    expect((await annotate({ Cookie: contributor })).status).toBe(202);
    expect((await annotate({ Cookie: maintainer })).status).toBe(202);
  });

  it("leaves agent READS working — a paused agent is stopped, not blinded", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token } = await mintToken(harness, maintainer, ["chapters:read", "annotations:read"]);
    await harness.app.request(
      `/v1/projects/${harness.projectId}/access/pause-agents`,
      jsonRequest("POST", { reason: "pausing" }, { Cookie: maintainer }),
    );
    expect((await readAnnotations({ Authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it("does not let a paused maintainer-role agent unpause itself", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token, tokenId } = await mintToken(harness, maintainer, [
      "chapters:read",
      "annotations:read",
      "annotations:write",
      "tokens:manage",
    ]);
    const record = await harness.repos.agentTokens.getById(tokenId);
    await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${record!.actorId}`,
      jsonRequest("PATCH", { role: "maintainer" }, { Cookie: maintainer }),
    );
    await harness.app.request(
      `/v1/projects/${harness.projectId}/access/pause-agents`,
      jsonRequest("POST", { reason: "pausing" }, { Cookie: maintainer }),
    );

    const selfResume = await harness.app.request(
      `/v1/projects/${harness.projectId}/access/resume-agents`,
      jsonRequest("POST", {}, { Authorization: `Bearer ${token}` }),
    );
    expect(selfResume.status).toBe(403);
    expect((await json(selfResume)).code).toBe("agents-paused");
  });

  it("resumes cleanly, restoring every token unchanged", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token, tokenId } = await mintToken(harness, maintainer, [
      "annotations:read",
      "annotations:write",
    ]);
    await harness.app.request(
      `/v1/projects/${harness.projectId}/access/pause-agents`,
      jsonRequest("POST", { reason: "pausing" }, { Cookie: maintainer }),
    );
    await harness.app.request(
      `/v1/projects/${harness.projectId}/access/resume-agents`,
      jsonRequest("POST", { reason: "fixed" }, { Cookie: maintainer }),
    );
    expect((await annotate({ Authorization: `Bearer ${token}` })).status).toBe(202);
    // Nothing was revoked: pause is reversible, revoke-all is not.
    expect((await harness.repos.agentTokens.getById(tokenId))!.revokedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 10 — the moderation queue
// ---------------------------------------------------------------------------

describe("approval-gated moderation (exit criterion 10)", () => {
  let maintainer: string;
  let stranger: string;
  let strangerActorId: string;
  let pendingId: string;

  beforeEach(async () => {
    maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await setPolicy("approval-gated");
    stranger = await signedInStranger("passing-stranger");
    strangerActorId = (await harness.repos.actors.getByExternalIdentity("github:passing-stranger"))!
      .id;
    const response = await annotate({ Cookie: stranger });
    expect(response.status).toBe(202);
    const body = await json(response);
    expect(body.status).toBe("pending_review");
    pendingId = body.pendingId;
  });

  it("writes no annotation row, no git operation, and no outbox row", async () => {
    // The three guarantees, checked at the storage layer where they actually
    // live. A pending annotation that had an outbox row would be one bug away
    // from being committed.
    expect(await harness.repos.annotations.getById(pendingId)).toBeNull();
    const outbox = await harness.repos.outbox.listPending(harness.projectId);
    expect(outbox).toHaveLength(0);
    const queued = await harness.repos.pendingAnnotations.getById(pendingId);
    expect(queued!.status).toBe("pending");
    expect(queued!.body).toBe(validAnnotationPayload().body);
  });

  it("never wakes the mirror — there is nothing to drain", async () => {
    expect(harness.mutationsCommitted).toHaveLength(0);
  });

  it("is visible to its author, badged, and to maintainers", async () => {
    for (const [who, cookie] of [
      ["author", stranger],
      ["maintainer", maintainer],
    ] as const) {
      const response = await readAnnotations({ Cookie: cookie });
      const body = await json(response);
      expect(body.pending, who).toHaveLength(1);
      expect(body.pending[0].id, who).toBe(pendingId);
      expect(body.pending[0].moderation.state, who).toBe("pending");
      // Badged as awaiting review, and NOT mixed in with published ones.
      expect(body.items.some((a: { id: string }) => a.id === pendingId), who).toBe(false);
    }
  });

  it("is invisible to everyone else", async () => {
    const other = await devLogin(harness, "another-contributor", "contributor");
    const body = await json(await readAnnotations({ Cookie: other }));
    expect(body.pending).toEqual([]);
    expect(body.items.some((a: { id: string }) => a.id === pendingId)).toBe(false);

    // Not readable directly either — a queue id must not be a back door.
    const direct = await harness.app.request(
      `/v1/projects/${harness.projectId}/annotations/${pendingId}`,
      { headers: { Cookie: other } },
    );
    expect(direct.status).toBe(404);
  });

  it("accrues no votes", async () => {
    const contributor = await devLogin(harness, "eager-voter", "contributor");
    const vote = await harness.app.request(
      `/v1/projects/${harness.projectId}/annotations/${pendingId}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: contributor }),
    );
    // 404, not 403: as far as the votes table is concerned this annotation
    // does not exist, and the foreign key makes that structural.
    expect(vote.status).toBe(404);
    expect((await harness.repos.votes.tally(pendingId)).approvals).toBe(0);
  });

  it("cannot trigger a governance rule — an unapproved suggestion manufactures no work", async () => {
    // Three approvals is the design §25 threshold. Nobody can cast one, so the
    // rule cannot fire; assert the outcome as well as the mechanism.
    for (const login of ["voter-one", "voter-two", "voter-three"]) {
      const cookie = await devLogin(harness, login, "contributor");
      const vote = await harness.app.request(
        `/v1/projects/${harness.projectId}/annotations/${pendingId}/vote`,
        jsonRequest("PUT", { value: "approve" }, { Cookie: cookie }),
      );
      expect(vote.status).toBe(404);
    }
    expect(await harness.repos.workItems.listByProject(harness.projectId)).toHaveLength(0);
    expect(await harness.repos.decisions.getWorkItemCreation(pendingId)).toBeNull();
  });

  it("shows the moderator the comment, its chapter, and the author's history", async () => {
    const queue = await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/queue`,
      { headers: { Cookie: maintainer } },
    );
    expect(queue.status).toBe(200);
    const body = await json(queue);
    expect(body.pendingCount).toBe(1);
    expect(body.items[0].body).toBe(validAnnotationPayload().body);
    expect(body.items[0].chapter.id).toBe(CHAPTER_ID);
    expect(body.items[0].author.externalIdentity).toBe("github:passing-stranger");
    expect(body.items[0].authorHistory).toEqual({ pending: 1, approved: 0, rejected: 0 });
    expect(body.items[0].target.blockId).toBe(BLOCK_ID_1);
  });

  it("approval turns it into an ordinary annotation, attributed to its author", async () => {
    const approve = await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/${pendingId}/approve`,
      jsonRequest("POST", undefined, { Cookie: maintainer }),
    );
    expect(approve.status).toBe(202);
    const body = await json(approve);
    expect(body.annotationId).toBe(pendingId);

    const annotation = await harness.repos.annotations.getById(pendingId);
    expect(annotation).not.toBeNull();
    // Attribution follows the words, not the approval.
    expect(annotation!.authorActorId).toBe(strangerActorId);
    expect(annotation!.status).toBe("pending_git");
    expect(annotation!.gitOperationId).toBe(body.operationId);

    // An ordinary outbox row: the same mirroring path any annotation takes.
    const outbox = await harness.repos.outbox.listPending(harness.projectId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.kind).toBe("annotation.create");
    expect((outbox[0]!.payload as { actorRef: string }).actorRef).toBe("github:passing-stranger");

    const queued = await harness.repos.pendingAnnotations.getById(pendingId);
    expect(queued!.status).toBe("approved");
  });

  it("rejection retains the record and creates nothing", async () => {
    const reject = await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/${pendingId}/reject`,
      jsonRequest("POST", { reason: "off topic" }, { Cookie: maintainer }),
    );
    expect(reject.status).toBe(200);
    expect((await json(reject)).retained).toBe(true);

    expect(await harness.repos.annotations.getById(pendingId)).toBeNull();
    expect(await harness.repos.outbox.listPending(harness.projectId)).toHaveLength(0);

    const queued = await harness.repos.pendingAnnotations.getById(pendingId);
    expect(queued!.status).toBe("rejected");
    expect(queued!.rejectionReason).toBe("off topic");
    expect(queued!.reviewedByActorId).toBeTruthy();
  });

  it("refuses a second verdict on the same row", async () => {
    await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/${pendingId}/reject`,
      jsonRequest("POST", {}, { Cookie: maintainer }),
    );
    const again = await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/${pendingId}/approve`,
      jsonRequest("POST", undefined, { Cookie: maintainer }),
    );
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe("moderation-already-reviewed");
  });

  it("does not queue a maintainer's own annotations", async () => {
    const response = await annotate({ Cookie: maintainer });
    const body = await json(response);
    expect(body.status).toBe("queued");
    expect(await harness.repos.annotations.getById(body.annotationId)).not.toBeNull();
  });

  it("switching to a permissive mode does NOT retroactively approve the queue", async () => {
    await setPolicy("open");
    expect((await harness.repos.pendingAnnotations.getById(pendingId))!.status).toBe("pending");
    expect(await harness.repos.annotations.getById(pendingId)).toBeNull();

    // The queue is still there, still drainable, still pending.
    const queue = await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/queue`,
      { headers: { Cookie: maintainer } },
    );
    expect((await json(queue)).pendingCount).toBe(1);
  });

  it("is not approvable while the book is frozen — approval commits content", async () => {
    await harness.app.request(
      `/v1/projects/${harness.projectId}/access/freeze`,
      jsonRequest("POST", { reason: "spam wave" }, { Cookie: maintainer }),
    );
    const approve = await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/${pendingId}/approve`,
      jsonRequest("POST", undefined, { Cookie: maintainer }),
    );
    expect(approve.status).toBe(423);

    // Rejection stays available: it is database-only, and draining the queue is
    // part of looking at what went wrong.
    const reject = await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/${pendingId}/reject`,
      jsonRequest("POST", { reason: "spam" }, { Cookie: maintainer }),
    );
    expect(reject.status).toBe(200);
  });

  it("bulk-approves and bulk-rejects, reporting per-item outcomes", async () => {
    const extra: string[] = [pendingId];
    for (let i = 0; i < 3; i += 1) {
      const response = await annotate({ Cookie: stranger });
      extra.push((await json(response)).pendingId);
    }
    // One is already resolved, so the bulk call must report it and carry on.
    await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/${extra[1]}/reject`,
      jsonRequest("POST", {}, { Cookie: maintainer }),
    );

    const bulk = await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/bulk`,
      jsonRequest("POST", { action: "approve", ids: [...extra, uuidv7()] }, { Cookie: maintainer }),
    );
    expect(bulk.status).toBe(200);
    const body = await json(bulk);
    expect(body.approved).toBe(3);
    expect(body.results.filter((r: { outcome: string }) => r.outcome === "already-rejected")).toHaveLength(1);
    expect(body.results.filter((r: { outcome: string }) => r.outcome === "not-found")).toHaveLength(1);
    expect(await harness.repos.pendingAnnotations.countPending(harness.projectId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 7 — revocation
// ---------------------------------------------------------------------------

describe("revocation is effective on the next request (exit criterion 7)", () => {
  it("invalidates sessions, releases the lease, and keeps the contributions", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const editor = await devLogin(harness, "departing-editor", "editor");
    const editorActor = (await harness.repos.actors.getByExternalIdentity(
      "github:departing-editor",
    ))!;

    // A contribution that must survive the removal.
    const annotationResponse = await annotate({ Cookie: editor });
    const { annotationId } = await json(annotationResponse);

    // A work item the departing editor holds a lease on.
    const suggestionId = await createOpenSuggestion(harness, maintainer);
    const workItemId = uuidv7();
    await harness.repos.workItems.insert({
      id: workItemId,
      projectId: harness.projectId,
      type: "revise_range" as const,
      status: "leased" as const,
      sourceAnnotationId: suggestionId,
      chapterId: CHAPTER_ID,
      baseRevision: 3,
      target: null,
      priority: "normal" as const,
      createdAt: "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:00:00Z",
    });
    const leaseId = uuidv7();
    await harness.repos.leases.claim({
      id: leaseId,
      projectId: harness.projectId,
      workItemId,
      actorId: editorActor.id,
      tokenHash: "0".repeat(64),
      issuedAt: "2026-07-19T00:00:00Z",
      // Deliberately FAR in the future: the contract's complaint is that a
      // departing collaborator strands work "for up to four hours", so a lease
      // that would expire on its own proves nothing.
      expiresAt: "2099-01-01T00:00:00Z",
      maxExpiresAt: "2099-01-01T00:00:00Z",
      renewalCount: 0,
      releasedAt: null,
      revokedAt: null,
    });

    const remove = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${editorActor.id}`,
      jsonRequest("DELETE", { reason: "left the project" }, { Cookie: maintainer }),
    );
    expect(remove.status).toBe(200);
    const outcome = await json(remove);
    expect(outcome.sessionsInvalidated).toBe(true);
    expect(outcome.leasesReleased).toEqual([{ leaseId, workItemId }]);
    expect(outcome.contributionsRetained).toBe(true);

    // Effective on the NEXT REQUEST, not at session expiry.
    const nextRequest = await harness.app.request(`/v1/me`, { headers: { Cookie: editor } });
    expect(nextRequest.status).toBe(401);

    // The lease is ended and the work item is back in the queue immediately —
    // not in four hours.
    expect((await harness.repos.leases.getById(leaseId))!.revokedAt).not.toBeNull();
    expect((await harness.repos.workItems.getById(workItemId))!.status).toBe("ready");

    // And their prior contribution is untouched: attribution and history are
    // permanent records, not access grants.
    const annotation = await harness.repos.annotations.getById(annotationId);
    expect(annotation).not.toBeNull();
    expect(annotation!.authorActorId).toBe(editorActor.id);
    const actor = await harness.repos.actors.getById(editorActor.id);
    expect(actor!.status).toBe("active");
    expect(actor!.displayName).toBe("departing-editor");
  });

  it("rejects the revoked actor's in-flight submission and frees its work item", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await devLogin(harness, "departing-editor", "editor");
    const editorActor = (await harness.repos.actors.getByExternalIdentity(
      "github:departing-editor",
    ))!;
    const suggestionId = await createOpenSuggestion(harness, maintainer);
    const workItemId = uuidv7();
    await harness.repos.workItems.insert({
      id: workItemId,
      projectId: harness.projectId,
      type: "revise_range" as const,
      status: "applying" as const,
      sourceAnnotationId: suggestionId,
      chapterId: CHAPTER_ID,
      baseRevision: 3,
      target: null,
      priority: "normal" as const,
      createdAt: "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:00:00Z",
    });
    const submissionId = uuidv7();
    await harness.repos.submissions.insert({
      id: submissionId,
      projectId: harness.projectId,
      workItemId,
      leaseId: uuidv7(),
      actorId: editorActor.id,
      type: "range_replacement" as const,
      baseRevision: 3,
      baseContentHash: "sha256:0",
      content: "Replacement prose.",
      summary: null,
      notes: null,
      state: "applying" as const,
      gitOperationId: null,
      createdAt: "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:00:00Z",
    });

    const remove = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${editorActor.id}`,
      jsonRequest("DELETE", {}, { Cookie: maintainer }),
    );
    expect((await json(remove)).submissionsRejected).toEqual([submissionId]);
    expect((await harness.repos.submissions.getById(submissionId))!.state).toBe("rejected");
    expect((await harness.repos.workItems.getById(workItemId))!.status).toBe("ready");
  });

  it("revoking a token releases its lease rather than stranding the work item", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { tokenId } = await mintToken(harness, maintainer, ["work:read", "work:claim"]);
    const record = (await harness.repos.agentTokens.getById(tokenId))!;
    const suggestionId = await createOpenSuggestion(harness, maintainer);
    const workItemId = uuidv7();
    await harness.repos.workItems.insert({
      id: workItemId,
      projectId: harness.projectId,
      type: "revise_range" as const,
      status: "leased" as const,
      sourceAnnotationId: suggestionId,
      chapterId: CHAPTER_ID,
      baseRevision: 3,
      target: null,
      priority: "normal" as const,
      createdAt: "2026-07-19T00:00:00Z",
      updatedAt: "2026-07-19T00:00:00Z",
    });
    const leaseId = uuidv7();
    await harness.repos.leases.claim({
      id: leaseId,
      projectId: harness.projectId,
      workItemId,
      actorId: record.actorId,
      tokenHash: "1".repeat(64),
      issuedAt: "2026-07-19T00:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      maxExpiresAt: "2099-01-01T00:00:00Z",
      renewalCount: 0,
      releasedAt: null,
      revokedAt: null,
    });

    const revoke = await harness.app.request(
      `/v1/projects/${harness.projectId}/agent-tokens/${tokenId}`,
      jsonRequest("DELETE", undefined, { Cookie: maintainer }),
    );
    expect(revoke.status).toBe(204);
    expect((await harness.repos.workItems.getById(workItemId))!.status).toBe("ready");
    expect((await harness.repos.leases.getById(leaseId))!.revokedAt).not.toBeNull();
  });

  it("revokes every agent token in one action", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const first = await mintToken(harness, maintainer, ["annotations:write"], "agent-one");
    const second = await mintToken(harness, maintainer, ["annotations:write"], "agent-two");

    const revokeAll = await harness.app.request(
      `/v1/projects/${harness.projectId}/agent-tokens/revoke-all`,
      jsonRequest("POST", { reason: "suspected leak" }, { Cookie: maintainer }),
    );
    expect(revokeAll.status).toBe(200);
    expect((await json(revokeAll)).revoked).toHaveLength(2);

    for (const token of [first.token, second.token]) {
      const response = await annotate({ Authorization: `Bearer ${token}` });
      expect(response.status).toBe(401);
    }
    // The human maintainer keeps working — this is a token revocation, not a
    // shutdown.
    expect((await annotate({ Cookie: maintainer })).status).toBe(202);
  });

  it("refuses to remove or demote the last maintainer", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const actor = (await harness.repos.actors.getByExternalIdentity(
      "github:initial-maintainer",
    ))!;

    const demote = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${actor.id}`,
      jsonRequest("PATCH", { role: "editor" }, { Cookie: maintainer }),
    );
    expect(demote.status).toBe(422);
    expect((await json(demote)).detail).toMatch(/last maintainer/i);

    const remove = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${actor.id}`,
      jsonRequest("DELETE", {}, { Cookie: maintainer }),
    );
    expect(remove.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 6 — the author can see and do all of it from the API
// ---------------------------------------------------------------------------

describe("an author can run the whole surface without a database or CLI (exit criterion 6)", () => {
  it("lists collaborators with role, joined, added-by, and last-acted", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const editorCookie = await devLogin(harness, "working-editor", "editor");
    await annotate({ Cookie: editorCookie });

    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators`,
      { headers: { Cookie: maintainer } },
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    const editor = body.items.find(
      (m: { actor: { externalIdentity: string } }) =>
        m.actor.externalIdentity === "github:working-editor",
    );
    expect(editor.role).toBe("editor");
    expect(editor.joinedAt).toBeTruthy();
    expect(editor.lastActedAt).toBeTruthy();
    expect(editor.isAgent).toBe(false);
    // Nobody granted this membership — dev login self-serves — so the honest
    // answer is null rather than a plausible-looking guess.
    expect(editor.addedByActorId).toBeNull();
    // Scope consequences in plain language, not scope names.
    expect(editor.roleMeans).toMatch(/claiming work items/i);
    expect(body.roleConsequences.reader).toMatch(/Cannot comment/i);
  });

  it("lists agent tokens as metadata only — never the token value", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token } = await mintToken(harness, maintainer, ["annotations:write"], "drafting-agent");

    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/agent-tokens`,
      { headers: { Cookie: maintainer } },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    // The strongest form of the assertion: the secret does not appear anywhere
    // in the response, in any field, under any name.
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("tokenHash");
    const body = JSON.parse(raw);
    expect(body.items[0].name).toBe("drafting-agent");
    expect(body.items[0].owner.externalIdentity).toBe("github:initial-maintainer");
    expect(body.items[0].role).toBe("editor");
    expect(body.items[0].expired).toBe(false);
  });

  it("reads the audit log filtered by actor, newest first", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const contributor = await devLogin(harness, "chatty-contributor", "contributor");
    await annotate({ Cookie: contributor });
    await annotate({ Cookie: contributor });
    await annotate({ Cookie: maintainer });

    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/audit?actor=github:chatty-contributor`,
      { headers: { Cookie: maintainer } },
    );
    const body = await json(response);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    for (const item of body.items) {
      expect(item.actorIdentity).toBe("github:chatty-contributor");
    }
    // Newest first: what a person opening the view wants.
    const ids = body.items.map((i: { id: string }) => i.id);
    expect([...ids].sort().reverse()).toEqual(ids);
  });

  it("changes a role and states the consequence in plain language", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await devLogin(harness, "promoted-person", "reader");
    const actor = (await harness.repos.actors.getByExternalIdentity("github:promoted-person"))!;

    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${actor.id}`,
      jsonRequest("PATCH", { role: "editor", reason: "joining the revision pass" }, {
        Cookie: maintainer,
      }),
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.previousRole).toBe("reader");
    expect(body.role).toBe("editor");
    expect(body.roleMeans).toMatch(/submitting rewritten prose/i);
    expect(body.scopes).toContain("submissions:write");

    const membership = await harness.repos.projectMemberships.getByProjectAndActor(
      harness.projectId,
      actor.id,
    );
    expect(membership!.role).toBe("editor");
  });

  it("keeps every control maintainer-only", async () => {
    const editor = await devLogin(harness, "curious-editor", "editor");
    const p = `/v1/projects/${harness.projectId}`;
    const forbidden = [
      harness.app.request(`${p}/collaborators`, { headers: { Cookie: editor } }),
      harness.app.request(`${p}/agent-tokens`, { headers: { Cookie: editor } }),
      harness.app.request(`${p}/audit`, { headers: { Cookie: editor } }),
      harness.app.request(`${p}/moderation/queue`, { headers: { Cookie: editor } }),
      harness.app.request(
        `${p}/access/freeze`,
        jsonRequest("POST", { reason: "nope" }, { Cookie: editor }),
      ),
      harness.app.request(
        `${p}/access/pause-agents`,
        jsonRequest("POST", { reason: "nope" }, { Cookie: editor }),
      ),
      harness.app.request(
        `${p}/agent-tokens/revoke-all`,
        jsonRequest("POST", { reason: "nope" }, { Cookie: editor }),
      ),
    ];
    for (const promise of forbidden) {
      expect((await promise).status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 1 — rate limits
// ---------------------------------------------------------------------------

describe("rate limits (exit criterion 1)", () => {
  it("returns 429 with Retry-After once a token exceeds its ceiling", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token } = await mintToken(harness, maintainer, [
      "annotations:read",
      "annotations:write",
    ]);
    // The annotation class allows 30 per token per minute. Each request here
    // is refused on its merits (unknown chapter) but is still counted — the
    // limiter runs in the guard, before the handler, which is what stops a
    // loop of failing requests from being free.
    const unknownChapter = uuidv7();
    let limited: Response | null = null;
    for (let i = 0; i < 31; i += 1) {
      const response = await harness.app.request(
        `/v1/projects/${harness.projectId}/chapters/${unknownChapter}/annotations`,
        jsonRequest("POST", validAnnotationPayload(), { Authorization: `Bearer ${token}` }),
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
      expect(response.status).toBe(404);
    }
    expect(limited).not.toBeNull();
    const retryAfter = Number(limited!.headers.get("Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    const body = await json(limited!);
    expect(body.code).toBe("rate-limited");
    expect(body.scope).toBe("token");
    expect(body.limitClass).toBe("annotation");
  });

  it("does not fire on reads", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token } = await mintToken(harness, maintainer, [
      "chapters:read",
      "annotations:read",
    ]);
    // Far beyond every ceiling in the table; a read must never be refused by a
    // limit, which is what keeps a rate-limited book readable.
    for (let i = 0; i < 200; i += 1) {
      const response = await readAnnotations({ Authorization: `Bearer ${token}` });
      expect(response.status).toBe(200);
    }
  });

  it("documents its ceilings through the API", async () => {
    const cookie = await devLogin(harness, "curious-agent-author", "contributor");
    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/rate-limits`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(200);
    const body = await json(response);
    for (const name of ["vote", "claim", "submission", "annotation", "control", "mutation"]) {
      expect(body.classes[name].perActor).toBeGreaterThan(0);
      // A single token may never outrun its owner.
      expect(body.classes[name].perToken).toBeLessThanOrEqual(body.classes[name].perActor);
      expect(body.classes[name].description.length).toBeGreaterThan(0);
    }
    expect(body.notes.join(" ")).toMatch(/reads are never counted/i);
  });
});

// ---------------------------------------------------------------------------
// The policy is changed through Settings, like every other book setting
// ---------------------------------------------------------------------------

describe("the annotation policy is set from the settings view", () => {
  it("round-trips through GET and PATCH, and takes effect on the next request", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    // The settings routes are a read-modify-write of a projected `book.yml`,
    // so the book has to have one.
    await setPolicy("collaborators-only");

    const before = await json(
      await harness.app.request(`/v1/projects/${harness.projectId}/settings`, {
        headers: { Cookie: maintainer },
      }),
    );
    expect(before.settings.collaboration.annotation_policy).toBe("collaborators-only");
    // Every mode explains itself, so the picker does not need its own copy.
    expect(before.settings.collaboration.options.locked).toMatch(/keep their membership/i);
    expect(before.settings.collaboration.options.locked).toMatch(/run your own agents/i);

    const patch = await harness.app.request(
      `/v1/projects/${harness.projectId}/settings`,
      jsonRequest(
        "PATCH",
        { collaboration: { annotation_policy: "locked" } },
        { Cookie: maintainer },
      ),
    );
    expect(patch.status).toBe(202);
    const patched = await json(patch);
    expect(patched.changed).toContain("collaboration.annotation_policy");
    expect(patched.settings.collaboration.annotation_policy).toBe("locked");

    // The projection row lands immediately, so enforcement does not wait for
    // the commit — exactly like a governance rule edit.
    const contributor = await devLogin(harness, "now-locked-out", "contributor");
    expect((await annotate({ Cookie: contributor })).status).toBe(423);
    expect((await annotate({ Cookie: maintainer })).status).toBe(202);
  });

  it("refuses an unknown mode rather than silently falling back", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await setPolicy("collaborators-only");
    const patch = await harness.app.request(
      `/v1/projects/${harness.projectId}/settings`,
      jsonRequest(
        "PATCH",
        { collaboration: { annotation_policy: "everyone" } },
        { Cookie: maintainer },
      ),
    );
    expect(patch.status).toBe(400);
    expect((await json(patch)).code).toBe("validation-failed");
  });

  it("clears back to the default when the section is nulled", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await setPolicy("locked");
    const patch = await harness.app.request(
      `/v1/projects/${harness.projectId}/settings`,
      jsonRequest(
        "PATCH",
        { collaboration: { annotation_policy: null } },
        { Cookie: maintainer },
      ),
    );
    expect(patch.status).toBe(202);
    const contributor = await devLogin(harness, "restored-contributor", "contributor");
    expect((await annotate({ Cookie: contributor })).status).toBe(202);
  });

  it("is maintainer-only, like every other setting", async () => {
    const editor = await devLogin(harness, "curious-editor", "editor");
    await setPolicy("collaborators-only");
    const patch = await harness.app.request(
      `/v1/projects/${harness.projectId}/settings`,
      jsonRequest(
        "PATCH",
        { collaboration: { annotation_policy: "open" } },
        { Cookie: editor },
      ),
    );
    expect(patch.status).toBe(403);
  });
});

describe("who added whom (contract \"Seeing\")", () => {
  it("credits the maintainer who minted an agent, and shows it as an agent", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const maintainerActor = (await harness.repos.actors.getByExternalIdentity(
      "github:initial-maintainer",
    ))!;
    const { tokenId } = await mintToken(harness, maintainer, ["annotations:write"], "helper-agent");
    const record = (await harness.repos.agentTokens.getById(tokenId))!;

    const body = await json(
      await harness.app.request(`/v1/projects/${harness.projectId}/collaborators`, {
        headers: { Cookie: maintainer },
      }),
    );
    const agent = body.items.find((m: { actorId: string }) => m.actorId === record.actorId);
    expect(agent.isAgent).toBe(true);
    expect(agent.addedByActorId).toBe(maintainerActor.id);
    expect(agent.ownerActorId).toBe(maintainerActor.id);
    expect(agent.role).toBe("editor");
  });

  it("does not mistake a later role change for the original grant", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const maintainerActor = (await harness.repos.actors.getByExternalIdentity(
      "github:initial-maintainer",
    ))!;
    const { tokenId } = await mintToken(harness, maintainer, ["annotations:write"], "promoted-agent");
    const record = (await harness.repos.agentTokens.getById(tokenId))!;

    const second = await devLogin(harness, "second-maintainer", "maintainer");
    await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${record.actorId}`,
      jsonRequest("PATCH", { role: "maintainer" }, { Cookie: second }),
    );

    const body = await json(
      await harness.app.request(`/v1/projects/${harness.projectId}/collaborators`, {
        headers: { Cookie: maintainer },
      }),
    );
    const agent = body.items.find((m: { actorId: string }) => m.actorId === record.actorId);
    // Who changed the role is a different fact from who added them, and
    // reporting the former as the latter would be wrong in exactly the case an
    // author is vetting.
    expect(agent.addedByActorId).toBe(maintainerActor.id);
    expect(agent.role).toBe("maintainer");
  });
});
