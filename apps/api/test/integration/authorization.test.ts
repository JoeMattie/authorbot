/**
 * Authorization matrix (contract §7.2): every implemented endpoint ×
 * {anonymous, reader, contributor, maintainer, agent-with-scope,
 * agent-without-scope, revoked token, expired token} - enforced and audited -
 * against the real integration stack (git clone + better-sqlite3).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAPTER_1,
  cloneExampleBookRepo,
  devLogin,
  jsonRequest,
  makeIntegrationApp,
  mintToken,
  rangeSuggestionPayload,
  type BookRepoClone,
  type IntegrationApp,
} from "./helpers.js";

type Persona =
  | "anonymous"
  | "reader"
  | "contributor"
  | "maintainer"
  | "agentFull"
  | "agentReadOnly"
  | "revokedToken"
  | "expiredToken";

const PERSONAS: Persona[] = [
  "anonymous",
  "reader",
  "contributor",
  "maintainer",
  "agentFull",
  "agentReadOnly",
  "revokedToken",
  "expiredToken",
];

describe("authorization matrix", () => {
  let clone: BookRepoClone;
  let app: IntegrationApp;
  const headersOf: Partial<Record<Persona, Record<string, string>>> = { anonymous: {} };
  let operationId = "";

  beforeAll(async () => {
    clone = await cloneExampleBookRepo();
    // queue mode: the matrix exercises authorization, not git mirroring.
    app = await makeIntegrationApp({
      workTreePath: clone.workTreePath,
      config: { mirrorMode: "queue" },
    });

    headersOf.reader = { Cookie: await devLogin(app, "reba-reader", "reader") };
    headersOf.contributor = { Cookie: await devLogin(app, "carl-contrib", "contributor") };
    const maintainerCookie = await devLogin(app, "marta-maint", "maintainer");
    headersOf.maintainer = { Cookie: maintainerCookie };

    const agentFull = await mintToken(
      app,
      maintainerCookie,
      ["chapters:read", "annotations:read", "annotations:write"],
      "agent-full",
    );
    headersOf.agentFull = { Authorization: `Bearer ${agentFull.token}` };

    const agentReadOnly = await mintToken(app, maintainerCookie, ["chapters:read"], "agent-ro");
    headersOf.agentReadOnly = { Authorization: `Bearer ${agentReadOnly.token}` };

    const revoked = await mintToken(app, maintainerCookie, ["chapters:read"], "agent-revoked");
    const revokeResponse = await app.app.request(
      `/v1/projects/${app.projectId}/agent-tokens/${revoked.tokenId}`,
      jsonRequest("DELETE", undefined, { Cookie: maintainerCookie }),
    );
    if (revokeResponse.status !== 204) {
      throw new Error(`revoke failed: ${revokeResponse.status}`);
    }
    headersOf.revokedToken = { Authorization: `Bearer ${revoked.token}` };

    const expired = await mintToken(app, maintainerCookie, ["chapters:read"], "agent-expired");
    await app.db
      .prepare(`UPDATE agent_tokens SET expires_at = ? WHERE id = ?`)
      .bind("2020-01-01T00:00:00Z", expired.tokenId)
      .run();
    headersOf.expiredToken = { Authorization: `Bearer ${expired.token}` };

    // A real operation to read back (queued; queue mode does not drain).
    const accepted = (await (
      await app.app.request(
        `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), headersOf.contributor),
      )
    ).json()) as { operationId: string };
    operationId = accepted.operationId;
  });

  afterAll(async () => {
    app.close();
    await clone.cleanup();
  });

  const request = (
    persona: Persona,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> => {
    const headers = headersOf[persona] ?? {};
    return Promise.resolve(
      app.app.request(path, method === "GET" ? { headers } : jsonRequest(method, body, headers)),
    );
  };

  interface Case {
    name: string;
    method: string;
    path: () => string;
    body?: () => unknown;
    expected: Record<Persona, number>;
  }

  const p = (): string => `/v1/projects/hollow-creek-anomaly`;

  const cases: Case[] = [
    {
      name: "GET /v1/me",
      method: "GET",
      path: () => "/v1/me",
      expected: {
        anonymous: 401,
        reader: 200,
        contributor: 200,
        maintainer: 200,
        agentFull: 200,
        agentReadOnly: 200,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
    {
      name: "GET project",
      method: "GET",
      path: () => p(),
      expected: {
        anonymous: 401,
        reader: 200,
        contributor: 200,
        maintainer: 200,
        agentFull: 200,
        agentReadOnly: 200,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
    {
      name: "GET members",
      method: "GET",
      path: () => `${p()}/members`,
      expected: {
        anonymous: 401,
        reader: 200,
        contributor: 200,
        maintainer: 200,
        agentFull: 403,
        agentReadOnly: 403,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
    {
      name: "GET chapters",
      method: "GET",
      path: () => `${p()}/chapters`,
      expected: {
        anonymous: 401,
        reader: 200,
        contributor: 200,
        maintainer: 200,
        agentFull: 200,
        agentReadOnly: 200,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
    {
      name: "GET chapter",
      method: "GET",
      path: () => `${p()}/chapters/${CHAPTER_1.id}`,
      expected: {
        anonymous: 401,
        reader: 200,
        contributor: 200,
        maintainer: 200,
        agentFull: 200,
        agentReadOnly: 200,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
    {
      name: "GET annotations (annotations:read)",
      method: "GET",
      path: () => `${p()}/chapters/${CHAPTER_1.id}/annotations`,
      expected: {
        anonymous: 401,
        reader: 200,
        contributor: 200,
        maintainer: 200,
        agentFull: 200,
        agentReadOnly: 200,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
    {
      name: "POST annotations (annotations:write)",
      method: "POST",
      path: () => `${p()}/chapters/${CHAPTER_1.id}/annotations`,
      body: () => rangeSuggestionPayload(),
      expected: {
        anonymous: 401,
        reader: 403,
        contributor: 202,
        maintainer: 202,
        agentFull: 202,
        agentReadOnly: 403,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
    {
      name: "POST agent-tokens (tokens:manage)",
      method: "POST",
      path: () => `${p()}/agent-tokens`,
      body: () => ({ name: "matrix-token", scopes: ["chapters:read"] }),
      expected: {
        anonymous: 401,
        reader: 403,
        contributor: 403,
        maintainer: 201,
        agentFull: 403,
        agentReadOnly: 403,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
    {
      name: "DELETE agent-tokens/{id} (tokens:manage)",
      method: "DELETE",
      // Non-maintainers are rejected by the scope guard before lookup, so a
      // fixed UUID suffices; the maintainer case is covered separately below.
      path: () => `${p()}/agent-tokens/01900000-0000-7000-8000-00000000dead`,
      expected: {
        anonymous: 401,
        reader: 403,
        contributor: 403,
        maintainer: 404,
        agentFull: 403,
        agentReadOnly: 403,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
    {
      name: "GET operations/{id}",
      method: "GET",
      path: () => `${p()}/operations/${operationId}`,
      expected: {
        anonymous: 401,
        reader: 200,
        contributor: 200,
        maintainer: 200,
        agentFull: 200,
        agentReadOnly: 403,
        revokedToken: 401,
        expiredToken: 401,
      },
    },
  ];

  for (const testCase of cases) {
    for (const persona of PERSONAS) {
      it(`${testCase.name} as ${persona} → ${testCase.expected[persona]}`, async () => {
        const response = await request(
          persona,
          testCase.method,
          testCase.path(),
          testCase.body?.(),
        );
        expect(response.status).toBe(testCase.expected[persona]);
      });
    }
  }

  it("revoking a real token as maintainer returns 204 and the token stops working", async () => {
    const maintainer = headersOf.maintainer ?? {};
    const disposable = await mintToken(
      app,
      String(maintainer["Cookie"]),
      ["chapters:read"],
      "disposable",
    );
    const before = await app.app.request(`${p()}/chapters`, {
      headers: { Authorization: `Bearer ${disposable.token}` },
    });
    expect(before.status).toBe(200);
    const revoke = await app.app.request(
      `${p()}/agent-tokens/${disposable.tokenId}`,
      jsonRequest("DELETE", undefined, maintainer),
    );
    expect(revoke.status).toBe(204);
    const after = await app.app.request(`${p()}/chapters`, {
      headers: { Authorization: `Bearer ${disposable.token}` },
    });
    expect(after.status).toBe(401);
  });

  it("an agent token can never reach tokens:manage (scope ∩ editor bundle)", async () => {
    const maintainer = headersOf.maintainer ?? {};
    const sneaky = await mintToken(
      app,
      String(maintainer["Cookie"]),
      ["tokens:manage", "chapters:read"],
      "sneaky",
    );
    const mintAttempt = await app.app.request(
      `${p()}/agent-tokens`,
      jsonRequest(
        "POST",
        { name: "escalated", scopes: ["chapters:read"] },
        { Authorization: `Bearer ${sneaky.token}` },
      ),
    );
    expect(mintAttempt.status).toBe(403);
    const read = await app.app.request(`${p()}/chapters`, {
      headers: { Authorization: `Bearer ${sneaky.token}` },
    });
    expect(read.status).toBe(200);
  });

  it("mutations and logins are audited", async () => {
    const countOf = async (action: string): Promise<number> => {
      const rows = await app.db
        .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = ?`)
        .bind(action)
        .all();
      return Number(rows[0]?.["n"] ?? 0);
    };
    expect(await countOf("session.login")).toBeGreaterThanOrEqual(3);
    expect(await countOf("agent_token.mint")).toBeGreaterThanOrEqual(5);
    expect(await countOf("agent_token.revoke")).toBeGreaterThanOrEqual(2);
    expect(await countOf("annotation.create")).toBeGreaterThanOrEqual(4);
  });
});
