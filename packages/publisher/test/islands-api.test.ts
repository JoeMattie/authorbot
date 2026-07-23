import { afterEach, describe, expect, it, vi } from "vitest";
import { CollabApi, type VoteTally } from "../site/src/islands/api.js";

const API = "https://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER = "chapter-1";
const ANNOTATION = "annotation-1";

const api = (): CollabApi => new CollabApi(API, PROJECT);

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const keyFrom = (call: readonly unknown[]): string | null => {
  const init = call[1] as RequestInit | undefined;
  return new Headers(init?.headers).get("idempotency-key");
};

const correlationFrom = (call: readonly unknown[]): string | null => {
  const init = call[1] as RequestInit | undefined;
  return new Headers(init?.headers).get("x-correlation-id");
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CollabApi completed Work reads", () => {
  it("requests one bounded page and preserves the opaque cursor", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json({ items: [{ id: "work-complete-1" }], nextCursor: "next-completed" }, 200),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api().completedWorkItems("older than this", 20);

    expect(result).toEqual({
      ok: true,
      value: { items: [{ id: "work-complete-1" }], nextCursor: "next-completed" },
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${API}/v1/projects/${PROJECT}/work-items/completed?limit=20&cursor=older+than+this`,
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).credentials).toBe("include");
  });
});

describe("CollabApi mutation transport", () => {
  it("reuses an exact caller-supplied idempotency key across retries", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json(
        {
          operationId: "operation-1",
          annotationId: ANNOTATION,
          correlationId: "correlation-1",
          status: "queued",
        },
        202,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const command = {
      kind: "comment" as const,
      scope: "chapter" as const,
      chapterRevision: 4,
      body: "Check this transition.",
    };
    const options = {
      idempotencyKey: "store-command-019fabcd",
      correlationId: "store-correlation-019fabcd",
    };
    const first = await api().createAnnotation(CHAPTER, command, options);
    const second = await api().createAnnotation(CHAPTER, command, options);

    expect(first).toEqual({
      ok: true,
      value: {
        outcome: "queued_git",
        operationId: "operation-1",
        annotationId: ANNOTATION,
        correlationId: "correlation-1",
        status: "queued",
      },
    });
    expect(second).toEqual(first);
    expect(fetchMock.mock.calls.map((call) => keyFrom(call))).toEqual([
      "store-command-019fabcd",
      "store-command-019fabcd",
    ]);
    expect(fetchMock.mock.calls.map((call) => correlationFrom(call))).toEqual([
      "store-correlation-019fabcd",
      "store-correlation-019fabcd",
    ]);
  });

  it("keeps fresh UUID idempotency keys as the compatibility default", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      json(
        {
          operationId: "operation-reply",
          replyId: "reply-1",
          correlationId: "correlation-reply",
          status: "queued",
        },
        202,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api().createReply(ANNOTATION, "First reply");
    await api().createReply(ANNOTATION, "Second reply");

    const keys = fetchMock.mock.calls.map((call) => keyFrom(call));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("parses an approval-gated annotation as pending review without an operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            pendingId: "pending-1",
            annotationId: null,
            status: "pending_review",
            moderation: {
              state: "pending",
              message: "This book reviews contributions before they appear.",
            },
            correlationId: "correlation-pending",
          },
          202,
        ),
      ),
    );

    const result = await api().createAnnotation(CHAPTER, {
      kind: "suggestion",
      scope: "chapter",
      chapterRevision: 4,
      body: "Consider a quieter ending.",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        outcome: "pending_review",
        pendingId: "pending-1",
        annotationId: null,
        correlationId: "correlation-pending",
        status: "pending_review",
        moderation: {
          state: "pending",
          message: "This book reviews contributions before they appear.",
        },
      },
    });
    if (result.ok) {
      expect("operationId" in result.value).toBe(false);
    }
  });

  it.each([
    ["empty", ""],
    ["malformed", "{"],
  ])("marks an %s successful mutation response as ambiguous", async (_label, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(body, {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await api().withdraw(ANNOTATION, {
      idempotencyKey: "withdraw-command-1",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 202,
      ambiguous: true,
    });
  });

  it("retains vote, release, reply, and operation response fields", async () => {
    const votes: VoteTally = {
      approvals: 2,
      rejections: 1,
      abstentions: 0,
      netScore: 1,
      distinctVoters: 3,
      humanApprovals: 2,
      agentApprovals: 0,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/annotations/${ANNOTATION}/vote`)) {
        return json(
          {
            annotationId: ANNOTATION,
            value: "approve",
            votes,
            ruleSatisfied: true,
            decision: null,
            correlationId: "correlation-vote",
          },
          200,
        );
      }
      if (url.endsWith("/work-items/work-1/lease/release")) {
        return json(
          {
            workItemId: "work-1",
            leaseId: "lease-1",
            status: "ready",
            expired: false,
            correlationId: "correlation-release",
          },
          200,
        );
      }
      if (url.endsWith(`/annotations/${ANNOTATION}/replies`)) {
        return json(
          {
            operationId: "operation-reply",
            replyId: "reply-1",
            correlationId: "correlation-reply",
            status: "queued",
          },
          202,
        );
      }
      return json(
        {
          id: "operation-1",
          projectId: PROJECT,
          correlationId: "correlation-operation",
          state: "committed",
          attempts: 2,
          commitSha: "abc123",
          error: null,
          createdAt: "2026-07-22T18:00:00.000Z",
          updatedAt: "2026-07-22T18:01:00.000Z",
        },
        200,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const vote = await api().castVote(ANNOTATION, "approve", {
      idempotencyKey: "vote-command-1",
    });
    const release = await api().releaseLease("work-1", "lease-1", {
      idempotencyKey: "release-command-1",
    });
    const reply = await api().createReply(ANNOTATION, "Following up.", undefined, {
      idempotencyKey: "reply-command-1",
    });
    const operation = await api().operationResult("operation-1");

    expect(vote).toEqual({
      ok: true,
      value: {
        annotationId: ANNOTATION,
        value: "approve",
        votes,
        ruleSatisfied: true,
        decision: null,
        correlationId: "correlation-vote",
      },
    });
    expect(release).toMatchObject({
      ok: true,
      value: {
        workItemId: "work-1",
        leaseId: "lease-1",
        expired: false,
        correlationId: "correlation-release",
      },
    });
    expect(reply).toMatchObject({
      ok: true,
      value: {
        operationId: "operation-reply",
        replyId: "reply-1",
        correlationId: "correlation-reply",
      },
    });
    expect(operation).toMatchObject({
      ok: true,
      value: {
        projectId: PROJECT,
        correlationId: "correlation-operation",
        attempts: 2,
        commitSha: "abc123",
        createdAt: "2026-07-22T18:00:00.000Z",
        updatedAt: "2026-07-22T18:01:00.000Z",
      },
    });
    expect(fetchMock.mock.calls.slice(0, 3).map((call) => keyFrom(call))).toEqual([
      "vote-command-1",
      "release-command-1",
      "reply-command-1",
    ]);
  });
});

describe("CollabApi revision review transport", () => {
  it("uses the bounded list/detail routes and the exact approve/reject contracts", async () => {
    const proposalId = "proposal-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/revision-proposals?")) {
        return json({ items: [], nextCursor: null }, 200);
      }
      if (url.endsWith("/diff")) {
        return json(
          {
            proposal: { id: proposalId, currentRevision: 4 },
            author: null,
            baseContent: "Before",
            proposedContent: "After",
            unifiedDiff: null,
            computationLimited: true,
          },
          200,
        );
      }
      if ((init?.method ?? "GET") === "GET") {
        return json({ id: proposalId, baseContent: "Before", proposedContent: "After" }, 200);
      }
      if (url.endsWith("/approve")) {
        return json(
          {
            proposalId,
            status: "applying",
            correlationId: "correlation-approve",
            operationId: "operation-approve",
          },
          202,
        );
      }
      return json(
        { proposalId, status: "rejected", correlationId: "correlation-reject" },
        200,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = api();

    await client.revisionProposals("next page");
    await client.revisionProposal(proposalId);
    const approved = await client.reviewRevisionProposal(
      proposalId,
      "approve",
      undefined,
      { idempotencyKey: "approve-key" },
    );
    const rejected = await client.reviewRevisionProposal(
      proposalId,
      "reject",
      "  Keep the current ending.  ",
      { idempotencyKey: "reject-key" },
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${API}/v1/projects/${PROJECT}/revision-proposals?status=pending_review&limit=50&cursor=next+page`,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `${API}/v1/projects/${PROJECT}/revision-proposals/${proposalId}`,
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      `${API}/v1/projects/${PROJECT}/revision-proposals/${proposalId}/diff`,
    );
    expect(fetchMock.mock.calls.slice(3).map((call) => String(call[0]))).toEqual([
      `${API}/v1/projects/${PROJECT}/revision-proposals/${proposalId}/approve`,
      `${API}/v1/projects/${PROJECT}/revision-proposals/${proposalId}/reject`,
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body))).toEqual({});
    expect(JSON.parse(String((fetchMock.mock.calls[4]?.[1] as RequestInit).body))).toEqual({
      reason: "Keep the current ending.",
    });
    expect(fetchMock.mock.calls.slice(3).map((call) => keyFrom(call))).toEqual([
      "approve-key",
      "reject-key",
    ]);
    expect(approved).toMatchObject({
      ok: true,
      value: { status: "applying", operationId: "operation-approve" },
    });
    expect(rejected).toMatchObject({ ok: true, value: { status: "rejected" } });
  });
});
