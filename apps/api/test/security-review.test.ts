/**
 * Regression tests for the whole-system security review.
 *
 * Each `describe` below pins one finding. They live together rather than
 * scattered through the phase suites because what they have in common is not a
 * phase but a shape: every one of them is a place where two mechanisms that
 * were each individually correct disagreed about what they were protecting —
 * a role check standing in for a scope check, an escape predicate narrower than
 * the validator it feeds, a freeze that classified one route as "control" and
 * its twin as "collaboration". The tests are written to fail if the two drift
 * apart again, not merely if the specific reported request stops working.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AnnotationPolicy } from "@authorbot/domain";
import type { BookConfig } from "@authorbot/schemas";
import { hmacSha256Hex } from "../src/crypto.js";
import { uuidv7 } from "../src/ids.js";
import {
  PUBLICATION_DELIVERY_HEADER,
  PUBLICATION_SIGNATURE_HEADER,
  PUBLICATION_TIMESTAMP_HEADER,
  publicationSigningMaterial,
} from "../src/publications.js";
import {
  BLOCK_ID_1,
  CHAPTER_ID,
  WEBHOOK_SECRET,
  createOpenSuggestion,
  devLogin,
  jsonRequest,
  makeHarness,
  mintToken,
  validAnnotationPayload,
  type TestHarness,
} from "./helpers.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = any;
const json = async (response: Response): Promise<JsonBody> =>
  (await response.json()) as JsonBody;

let harness: TestHarness;

beforeEach(async () => {
  harness = await makeHarness();
});

const BOOK_ID = "01900000-0000-7000-8000-0000000000bb";

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
 * The configuration the review's finding 1 is about: an agent token granted the
 * maintainer ROLE — which the Phase 7 contract explicitly encourages, so a
 * `locked` book stays annotatable by the author's own agents — while its token
 * carries only the weak scopes it actually needs to annotate.
 */
async function agentMaintainer(
  maintainerCookie: string,
  scopes: string[] = ["chapters:read", "annotations:write"],
): Promise<{ token: string; actorId: string; headers: Record<string, string> }> {
  const { token, tokenId } = await mintToken(harness, maintainerCookie, scopes, `agent-${uuidv7()}`);
  const record = (await harness.repos.agentTokens.getById(tokenId))!;
  const promote = await harness.app.request(
    `/v1/projects/${harness.projectId}/collaborators/${record.actorId}`,
    jsonRequest("PATCH", { role: "maintainer" }, { Cookie: maintainerCookie }),
  );
  expect(promote.status, "promoting the agent to maintainer must itself work").toBe(200);
  return {
    token,
    actorId: record.actorId,
    headers: { Authorization: `Bearer ${token}` },
  };
}

const freeze = (headers: Record<string, string>, reason = "stopping to look") =>
  harness.app.request(
    `/v1/projects/${harness.projectId}/access/freeze`,
    jsonRequest("POST", { reason }, headers),
  );

// ---------------------------------------------------------------------------
// Finding 1 — the control plane is not owned by the maintainer ROLE alone
// ---------------------------------------------------------------------------

describe("finding 1: an agent token cannot take over the control plane by role alone", () => {
  /**
   * Every mutating control-plane route, exercised with a credential that holds
   * the maintainer role and nothing else.
   *
   * Enumerated as a table rather than as separate tests so that the assertion
   * is "the control plane", not "these seven URLs I happened to think of": a
   * new route added to the list is one line, and a new route NOT added to the
   * list is the thing the companion test below catches.
   */
  const controlRoutes = (h: TestHarness): { name: string; run(hdrs: Record<string, string>): Response | Promise<Response> }[] => [
    {
      name: "freeze",
      run: (hdrs) =>
        h.app.request(
          `/v1/projects/${h.projectId}/access/freeze`,
          jsonRequest("POST", { reason: "mine now" }, hdrs),
        ),
    },
    {
      name: "unfreeze",
      run: (hdrs) =>
        h.app.request(
          `/v1/projects/${h.projectId}/access/unfreeze`,
          jsonRequest("POST", {}, hdrs),
        ),
    },
    {
      name: "pause-agents",
      run: (hdrs) =>
        h.app.request(
          `/v1/projects/${h.projectId}/access/pause-agents`,
          jsonRequest("POST", { reason: "mine now" }, hdrs),
        ),
    },
    {
      name: "resume-agents",
      run: (hdrs) =>
        h.app.request(
          `/v1/projects/${h.projectId}/access/resume-agents`,
          jsonRequest("POST", {}, hdrs),
        ),
    },
    {
      name: "revoke every token",
      run: (hdrs) =>
        h.app.request(
          `/v1/projects/${h.projectId}/agent-tokens/revoke-all`,
          jsonRequest("POST", { reason: "mine now" }, hdrs),
        ),
    },
    {
      name: "reopen the annotation policy",
      run: (hdrs) =>
        h.app.request(
          `/v1/projects/${h.projectId}/settings`,
          jsonRequest("PATCH", { settings: { "collaboration.annotation_policy": "open" } }, hdrs),
        ),
    },
  ];

  it("refuses every control-plane change from a maintainer-role agent with weak scopes", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const agent = await agentMaintainer(maintainer);

    for (const route of controlRoutes(harness)) {
      const response = await route.run(agent.headers);
      const body = await json(response);
      expect(response.status, `${route.name} must be refused: ${JSON.stringify(body)}`).toBe(403);
      expect(body.code, route.name).toBe("forbidden");
      // The refusal names a scope, not a role — the whole point of the fix is
      // that the token∩role intersection is what decides.
      expect(String(body.detail), route.name).toMatch(/scope/);
    }
  });

  it("refuses to let such an agent delete the human author's membership", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const humanActor = (await harness.repos.actors.getByExternalIdentity(
      "github:initial-maintainer",
    ))!;
    const agent = await agentMaintainer(maintainer);

    const removal = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${humanActor.id}`,
      jsonRequest("DELETE", {}, agent.headers),
    );
    expect(removal.status).toBe(403);

    const demotion = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${humanActor.id}`,
      jsonRequest("PATCH", { role: "reader" }, agent.headers),
    );
    expect(demotion.status).toBe(403);

    // And the author is still standing.
    const membership = await harness.repos.projectMemberships.getByProjectAndActor(
      harness.projectId,
      humanActor.id,
    );
    expect(membership!.revokedAt).toBeNull();
    expect(membership!.role).toBe("maintainer");
  });

  /**
   * The other half of the fix: this must remain a SCOPE gate, not a blanket
   * "agents may not administer". The contract supports an author delegating the
   * control plane to their own agent — it just has to be delegated on purpose,
   * by minting the token with the scope AND raising the role, rather than
   * arriving free with the role.
   */
  it("admits an agent whose token was deliberately minted with the managing scope", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const agent = await agentMaintainer(maintainer, [
      "chapters:read",
      "annotations:write",
      "members:manage",
      "tokens:manage",
    ]);
    expect((await freeze(agent.headers)).status).toBe(200);
    const paused = await harness.app.request(
      `/v1/projects/${harness.projectId}/access/pause-agents`,
      jsonRequest("POST", { reason: "deliberate" }, agent.headers),
    );
    expect(paused.status).toBe(200);
  });

  /**
   * The grant the contract actually intends must survive the fix untouched: a
   * maintainer-role agent exists so a `locked` book stays workable.
   */
  it("leaves the contract's grant intact: the same agent still annotates a locked book", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const agent = await agentMaintainer(maintainer);
    await setPolicy("locked");

    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", validAnnotationPayload(), agent.headers),
    );
    expect(response.status, await response.text()).toBe(202);
  });

  it("refuses to remove or demote the last HUMAN maintainer, not merely the last maintainer", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const humanActor = (await harness.repos.actors.getByExternalIdentity(
      "github:initial-maintainer",
    ))!;
    // An agent maintainer exists, so the naive "is anyone left?" count is
    // satisfied — and used to be the only thing standing between an author and
    // a book administered exclusively by a machine.
    await agentMaintainer(maintainer);

    const removal = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${humanActor.id}`,
      jsonRequest("DELETE", {}, { Cookie: maintainer }),
    );
    expect(removal.status).toBe(422);
    expect(String((await json(removal)).detail)).toMatch(/last human maintainer/);

    const demotion = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${humanActor.id}`,
      jsonRequest("PATCH", { role: "editor" }, { Cookie: maintainer }),
    );
    expect(demotion.status).toBe(422);
    expect(String((await json(demotion)).detail)).toMatch(/last human maintainer/);
  });

  it("still allows the handover once a second human maintainer exists", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const humanActor = (await harness.repos.actors.getByExternalIdentity(
      "github:initial-maintainer",
    ))!;
    await devLogin(harness, "second-human", "maintainer");

    const demotion = await harness.app.request(
      `/v1/projects/${harness.projectId}/collaborators/${humanActor.id}`,
      jsonRequest("PATCH", { role: "editor" }, { Cookie: maintainer }),
    );
    expect(demotion.status, await demotion.text()).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Finding 4 — freeze must stop operation retry
// ---------------------------------------------------------------------------

describe("finding 4: a freeze stops operations/:id/retry", () => {
  /** Drive one annotation to a `failed` git operation with a live outbox row. */
  async function failedOperation(cookie: string): Promise<string> {
    const created = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie }),
    );
    expect(created.status).toBe(202);
    const operationId = (await json(created)).operationId as string;
    await harness.repos.gitOperations.updateState(operationId, {
      state: "failed",
      updatedAt: "2026-07-19T18:00:00Z",
      error: "upstream rejected the push",
    });
    await harness.repos.outbox.markFailed(
      (await harness.repos.outbox.getByGitOperationId(operationId))!.id,
      "2026-07-19T18:00:00Z",
    );
    return operationId;
  }

  const retry = (operationId: string, headers: Record<string, string>) =>
    harness.app.request(
      `/v1/projects/${harness.projectId}/operations/${operationId}/retry`,
      jsonRequest("POST", {}, headers),
    );

  it("refuses a retry while the book is frozen, and leaves the operation failed", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const operationId = await failedOperation(maintainer);
    expect((await freeze({ Cookie: maintainer })).status).toBe(200);

    const response = await retry(operationId, { Cookie: maintainer });
    expect(response.status).toBe(423);
    expect((await json(response)).code).toBe("book-frozen");

    // Nothing was requeued: a retry accepted under a freeze would have the
    // mirror committing while the author was still looking.
    expect((await harness.repos.gitOperations.getById(operationId))!.state).toBe("failed");
    expect((await harness.repos.outbox.getByGitOperationId(operationId))!.status).not.toBe(
      "pending",
    );
  });

  it("accepts the same retry once the freeze lifts (nothing is lost, only deferred)", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const operationId = await failedOperation(maintainer);
    await freeze({ Cookie: maintainer });
    await harness.app.request(
      `/v1/projects/${harness.projectId}/access/unfreeze`,
      jsonRequest("POST", {}, { Cookie: maintainer }),
    );

    const response = await retry(operationId, { Cookie: maintainer });
    expect(response.status, await response.text()).toBe(202);
    expect((await harness.repos.gitOperations.getById(operationId))!.state).toBe("queued");
    expect((await harness.repos.outbox.getByGitOperationId(operationId))!.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Finding 5 — freeze must not block credential rotation
// ---------------------------------------------------------------------------

describe("finding 5: a frozen book can still rotate one credential", () => {
  it("lets a maintainer revoke a single token and mint its replacement under a freeze", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { tokenId } = await mintToken(harness, maintainer, ["annotations:write"], "leaked-agent");
    expect((await freeze({ Cookie: maintainer }, "a token leaked")).status).toBe(200);

    const revoked = await harness.app.request(
      `/v1/projects/${harness.projectId}/agent-tokens/${tokenId}`,
      jsonRequest("DELETE", undefined, { Cookie: maintainer }),
    );
    expect(revoked.status, await revoked.text()).toBe(204);
    expect((await harness.repos.agentTokens.getById(tokenId))!.revokedAt).not.toBeNull();

    const minted = await harness.app.request(
      `/v1/projects/${harness.projectId}/agent-tokens`,
      jsonRequest("POST", { name: "replacement", scopes: ["annotations:write"] }, {
        Cookie: maintainer,
      }),
    );
    expect(minted.status, await minted.text()).toBe(201);
  });

  it("keeps the freeze meaningful: the replacement token still cannot write", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await freeze({ Cookie: maintainer }, "a token leaked");
    const minted = await harness.app.request(
      `/v1/projects/${harness.projectId}/agent-tokens`,
      jsonRequest("POST", { name: "replacement", scopes: ["annotations:write"] }, {
        Cookie: maintainer,
      }),
    );
    const token = (await json(minted)).token as string;

    const write = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", validAnnotationPayload(), { Authorization: `Bearer ${token}` }),
    );
    expect(write.status).toBe(423);
    expect((await json(write)).code).toBe("book-frozen");
  });
});

// ---------------------------------------------------------------------------
// Finding 6 — incident reasons must not leak through the anonymous feed
// ---------------------------------------------------------------------------

describe("finding 6: the event feed does not publish freeze/pause reasons", () => {
  const SECRET_REASON = "rotating leaked token tok_9f13 used by contractor evelyn";

  beforeEach(async () => {
    harness.close();
    harness = await makeHarness({ config: { publicAnnotations: true } });
  });

  const anonymousEvents = async (): Promise<JsonBody> =>
    json(await harness.app.request(`/v1/projects/${harness.projectId}/events?poll=1&after=0`));

  it("omits the reason from project_frozen and agents_paused for an anonymous reader", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await freeze({ Cookie: maintainer }, SECRET_REASON);
    await harness.app.request(
      `/v1/projects/${harness.projectId}/access/pause-agents`,
      jsonRequest("POST", { reason: SECRET_REASON }, { Cookie: maintainer }),
    );

    const feed = await anonymousEvents();
    const types = feed.items.map((e: { type: string }) => e.type);
    // The FACT is still published — a listening client must learn the book
    // froze; it is the prose that is withheld.
    expect(types).toContain("project_frozen");
    expect(types).toContain("agents_paused");
    expect(JSON.stringify(feed)).not.toContain("tok_9f13");
    expect(JSON.stringify(feed)).not.toContain("evelyn");
    for (const event of feed.items) {
      expect(event.payload?.reason, event.type).toBeUndefined();
    }
  });

  it("keeps the reason where the author put it: /access and the audit log", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await freeze({ Cookie: maintainer }, SECRET_REASON);

    const access = await json(
      await harness.app.request(`/v1/projects/${harness.projectId}/access`, {
        headers: { Cookie: maintainer },
      }),
    );
    expect(access.freeze.reason).toBe(SECRET_REASON);

    const audit = await json(
      await harness.app.request(
        `/v1/projects/${harness.projectId}/audit?action=project.freeze`,
        { headers: { Cookie: maintainer } },
      ),
    );
    expect(audit.items[0].metadata.reason).toBe(SECRET_REASON);
  });

  it("still 401s the anonymous caller on /access, which is the intent the feed must match", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await freeze({ Cookie: maintainer }, SECRET_REASON);
    const anonymous = await harness.app.request(`/v1/projects/${harness.projectId}/access`);
    expect(anonymous.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Finding 7 — SSE is bounded in time and in count
// ---------------------------------------------------------------------------

describe("finding 7: event streams are bounded", () => {
  /** Drain a stream to completion, or give up after `ms`. */
  async function drain(response: Response, ms: number): Promise<{ ended: boolean; text: string }> {
    const reader = response.body?.getReader();
    if (reader === undefined) return { ended: true, text: "" };
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + ms;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { ended: false, text };
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: false; value: undefined; timeout: true }>((resolve) =>
            setTimeout(() => resolve({ done: false, value: undefined, timeout: true }), remaining),
          ),
        ]);
        if ("timeout" in chunk) return { ended: false, text };
        if (chunk.done) return { ended: true, text };
        if (chunk.value !== undefined) text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  it("closes a stream at its lifetime cap rather than holding it open forever", async () => {
    harness.close();
    harness = await makeHarness({
      config: { ssePollMs: 10, sseHeartbeatMs: 10_000, sseMaxLifetimeMs: 120 },
    });
    const cookie = await devLogin(harness, "listener", "contributor");
    const response = await harness.app.request(`/v1/projects/${harness.projectId}/events`, {
      headers: { Cookie: cookie },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const { ended, text } = await drain(response, 3_000);
    expect(ended, "the server must close the stream on its own").toBe(true);
    // It still sent the reconnection hint, which is what makes the close
    // invisible to a client: it comes straight back with Last-Event-ID.
    expect(text).toContain("retry:");
  });

  it("caps concurrent streams per client and releases the slot when one closes", async () => {
    harness.close();
    harness = await makeHarness({
      config: { ssePollMs: 10, sseHeartbeatMs: 10_000, sseMaxStreamsPerClient: 2 },
    });
    const cookie = await devLogin(harness, "listener", "contributor");
    const open = (): Response | Promise<Response> =>
      harness.app.request(`/v1/projects/${harness.projectId}/events`, {
        headers: { Cookie: cookie, "CF-Connecting-IP": "203.0.113.7" },
      });

    const first = await open();
    const second = await open();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const third = await open();
    expect(third.status).toBe(429);
    expect((await json(third)).code).toBe("rate-limited");
    expect(third.headers.get("Retry-After")).not.toBeNull();

    // A different address is unaffected — the cap is per client, not global.
    const other = await harness.app.request(`/v1/projects/${harness.projectId}/events`, {
      headers: { Cookie: cookie, "CF-Connecting-IP": "198.51.100.4" },
    });
    expect(other.status).toBe(200);
    await other.body?.cancel();

    // Closing one frees exactly one slot.
    await first.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fourth = await open();
    expect(fourth.status).toBe(200);
    await fourth.body?.cancel();
    await second.body?.cancel();
  });
});

// ---------------------------------------------------------------------------
// Finding 8 — the per-actor limit is per PERSON, not per token
// ---------------------------------------------------------------------------

describe("finding 8: a fleet does not scale by minting more tokens", () => {
  /**
   * A frozen clock, because the limiter uses FIXED windows: a test that spends
   * sixty-odd requests near a minute boundary would see its counters reset
   * mid-run and fail for a reason that has nothing to do with the property
   * under test. Pinning the clock pins the window.
   */
  beforeEach(async () => {
    harness.close();
    harness = await makeHarness({ clock: { now: () => new Date("2026-07-19T18:00:20Z") } });
  });

  it("charges every agent's mutations to the human who minted it", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    // Three tokens, each staying well under its own per-token ceiling of 30.
    // Their combined traffic must still be stopped by the owner's per-actor
    // ceiling of 60 for the annotation class — otherwise "the actor limit
    // bounds what one identity can do however many credentials it holds" is
    // false, and a fleet buys throughput by minting.
    const tokens: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      tokens.push((await mintToken(harness, maintainer, ["annotations:write"], `fleet-${i}`)).token);
    }

    // Requests are refused on their merits (unknown chapter) but still counted:
    // the limiter runs in the guard, before the handler.
    const unknownChapter = uuidv7();
    let limited: Response | null = null;
    let accepted = 0;
    outer: for (const token of tokens) {
      for (let i = 0; i < 21; i += 1) {
        const response = await harness.app.request(
          `/v1/projects/${harness.projectId}/chapters/${unknownChapter}/annotations`,
          jsonRequest("POST", validAnnotationPayload(), { Authorization: `Bearer ${token}` }),
        );
        if (response.status === 429) {
          limited = response;
          break outer;
        }
        expect(response.status).toBe(404);
        accepted += 1;
      }
    }

    expect(limited, "63 requests across three tokens must trip the owner's ceiling").not.toBeNull();
    const body = await json(limited!);
    // Attributed to the ACTOR ceiling, not the token's — no single token got
    // anywhere near 30.
    expect(body.scope).toBe("actor");
    expect(body.limitClass).toBe("annotation");
    expect(accepted).toBe(60);
  });

  it("leaves a single token's own ceiling in force (one credential cannot outrun its owner)", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const { token } = await mintToken(harness, maintainer, ["annotations:write"], "solo");
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
    }
    expect((await json(limited!)).scope).toBe("token");
  });
});

// ---------------------------------------------------------------------------
// Finding 9 — the Phase 3 override routes carry real scopes
// ---------------------------------------------------------------------------

describe("finding 9: override routes require a real scope", () => {
  it("refuses force-create-work-item from a maintainer-role agent with no work scope", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const agent = await agentMaintainer(maintainer);
    const annotationId = await createOpenSuggestion(harness, maintainer);

    const forced = await harness.app.request(
      `/v1/projects/${harness.projectId}/annotations/${annotationId}/force-create-work-item`,
      jsonRequest("POST", { reason: "manufacturing work with no vote" }, agent.headers),
    );
    expect(forced.status).toBe(403);
    expect(String((await json(forced)).detail)).toContain("work:claim");

    // No work item was created — the point of the finding is the whole chain
    // (create a suggestion, then force work on it) being available for free.
    const decision = await harness.repos.decisions.getWorkItemCreation(annotationId);
    expect(decision).toBeNull();
  });

  it("refuses reject/reopen from the same credential", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const agent = await agentMaintainer(maintainer, ["chapters:read"]);
    const annotationId = await createOpenSuggestion(harness, maintainer);

    for (const action of ["reject", "reopen"]) {
      const response = await harness.app.request(
        `/v1/projects/${harness.projectId}/annotations/${annotationId}/${action}`,
        jsonRequest("POST", { reason: "not mine to make" }, agent.headers),
      );
      expect(response.status, action).toBe(403);
      expect(String((await json(response)).detail), action).toContain("annotations:write");
    }
  });

  it("refuses work-item cancel from the same credential", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const agent = await agentMaintainer(maintainer);
    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/work-items/${uuidv7()}/cancel`,
      jsonRequest("POST", { reason: "not mine to make" }, agent.headers),
    );
    // 403 for the scope, NOT 404 for the unknown work item: the guard runs
    // first, which is what makes the check unskippable.
    expect(response.status).toBe(403);
    expect(String((await json(response)).detail)).toContain("work:claim");
  });

  it("still admits a human maintainer, whose role bundle contains those scopes", async () => {
    const maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    const annotationId = await createOpenSuggestion(harness, maintainer);
    const rejected = await harness.app.request(
      `/v1/projects/${harness.projectId}/annotations/${annotationId}/reject`,
      jsonRequest("POST", { reason: "does not fit the arc" }, { Cookie: maintainer }),
    );
    expect(rejected.status, await rejected.text()).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Finding 10 — one secret per trust domain
// ---------------------------------------------------------------------------

describe("finding 10: the publication callback has its own secret", () => {
  const PUBLICATION_SECRET = "publication-secret-in-the-book-repo";

  const publish = async (secret: string): Promise<Response> => {
    const body = JSON.stringify({ integratedCommit: "a".repeat(40), buildStatus: "succeeded" });
    const deliveryId = uuidv7();
    const timestamp = new Date().toISOString();
    return harness.app.request("/v1/publications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [PUBLICATION_DELIVERY_HEADER]: deliveryId,
        [PUBLICATION_TIMESTAMP_HEADER]: timestamp,
        [PUBLICATION_SIGNATURE_HEADER]: `sha256=${await hmacSha256Hex(
          secret,
          publicationSigningMaterial(deliveryId, timestamp, body),
        )}`,
      },
      body,
    });
  };

  const pushWebhook = async (secret: string): Promise<Response> => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    return harness.app.request("/v1/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": uuidv7(),
        "X-Hub-Signature-256": `sha256=${await hmacSha256Hex(secret, body)}`,
      },
      body,
    });
  };

  it("refuses a publication callback signed with the GitHub webhook secret", async () => {
    harness.close();
    harness = await makeHarness({ config: { publicationSecret: PUBLICATION_SECRET } });
    // Whoever holds GitHub's webhook secret must not be able to forge a
    // deployment report, and vice versa: two protocols, two trust domains.
    const forged = await publish(WEBHOOK_SECRET);
    expect(forged.status).toBe(401);
    expect((await json(forged)).code).toBe("signature-invalid");
  });

  it("refuses a push webhook signed with the publication secret", async () => {
    harness.close();
    harness = await makeHarness({ config: { publicationSecret: PUBLICATION_SECRET } });
    const forged = await pushWebhook(PUBLICATION_SECRET);
    expect(forged.status).toBe(401);
  });

  it("accepts each protocol under its own key", async () => {
    harness.close();
    harness = await makeHarness({ config: { publicationSecret: PUBLICATION_SECRET } });
    expect((await publish(PUBLICATION_SECRET)).status).toBeLessThan(400);
    expect((await pushWebhook(WEBHOOK_SECRET)).status).toBeLessThan(400);
  });

  it("falls back to WEBHOOK_SECRET when no publication secret is configured", async () => {
    // Compatibility: an existing deployment keeps reporting through the
    // rotation rather than losing its publication callbacks on upgrade.
    expect((await publish(WEBHOOK_SECRET)).status).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------
// Finding 13 — approval re-checks the anchor the create path enforces
// ---------------------------------------------------------------------------

describe("finding 13: moderation approval re-validates revision and block", () => {
  let maintainer: string;
  let stranger: string;
  let pendingId: string;

  beforeEach(async () => {
    maintainer = await devLogin(harness, "initial-maintainer", "maintainer");
    await setPolicy("approval-gated");
    // A maintainer's own comments bypass the queue by design, so the queued
    // rows under test have to come from someone else.
    stranger = await devLogin(harness, "passing-stranger", "contributor");
    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", validAnnotationPayload(), { Cookie: stranger }),
    );
    expect(response.status).toBe(202);
    // `approval-gated` queues a non-maintainer's comment: the response names
    // the queue row, and `annotationId` is deliberately null until approval.
    pendingId = (await json(response)).pendingId as string;
  });

  /** Move the chapter on underneath the queued comment, as a real book does. */
  async function advanceChapter(changes: { revision?: number; blockIds?: string[] }): Promise<void> {
    const chapter = (await harness.repos.chapters.getById(CHAPTER_ID))!;
    await harness.repos.chapters.upsert({
      ...chapter,
      ...(changes.revision !== undefined ? { revision: changes.revision } : {}),
      ...(changes.blockIds !== undefined ? { blockIds: changes.blockIds } : {}),
    });
  }

  const approve = () =>
    harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/${pendingId}/approve`,
      jsonRequest("POST", {}, { Cookie: maintainer }),
    );

  it("refuses to commit a comment whose chapter has moved on", async () => {
    await advanceChapter({ revision: 7 });
    const response = await approve();
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.code).toBe("revision-conflict");
    expect(body.projectedRevision).toBe(7);

    // Nothing was committed and nothing was resolved: the queue row is still
    // pending, so the author can re-anchor rather than losing the comment.
    expect(await harness.repos.annotations.getById(pendingId)).toBeNull();
    expect((await harness.repos.pendingAnnotations.getById(pendingId))!.status).toBe("pending");
  });

  it("refuses to commit a comment anchored to a block that no longer exists", async () => {
    await advanceChapter({ blockIds: ["01900000-0000-7000-8000-0000000009ff"] });
    const response = await approve();
    expect(response.status).toBe(422);
    expect((await json(response)).code).toBe("unknown-block");
    expect(await harness.repos.annotations.getById(pendingId)).toBeNull();
  });

  it("reports stale-anchor per item in bulk, without failing the rest of the batch", async () => {
    // A second comment that stays valid, so the batch has both outcomes in it.
    const other = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest(
        "POST",
        { ...validAnnotationPayload(), scope: "chapter", target: undefined },
        { Cookie: stranger },
      ),
    );
    const otherBody = await json(other);
    expect(other.status, JSON.stringify(otherBody)).toBe(202);
    const otherId = otherBody.pendingId as string;
    await advanceChapter({ blockIds: ["01900000-0000-7000-8000-0000000009ff"] });

    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/moderation/bulk`,
      jsonRequest("POST", { action: "approve", ids: [pendingId, otherId] }, { Cookie: maintainer }),
    );
    const body = await json(response);
    expect(response.status, JSON.stringify(body)).toBe(200);
    const outcome = (id: string): string =>
      body.results.find((r: { pendingId: string }) => r.pendingId === id).outcome;
    expect(outcome(pendingId)).toBe("stale-anchor");
    expect(outcome(otherId)).toBe("approved");
    expect(body.approved).toBe(1);
  });

  it("approves normally when the anchor is still good", async () => {
    const response = await approve();
    expect(response.status, await response.text()).toBe(202);
    const annotation = await harness.repos.annotations.getById(pendingId);
    expect(annotation).not.toBeNull();
    expect(annotation!.chapterRevision).toBe(3);
    expect((annotation!.target as { blockId: string }).blockId).toBe(BLOCK_ID_1);
  });
});
