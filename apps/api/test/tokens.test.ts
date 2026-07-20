import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_ORIGIN, devLogin, makeHarness, mintToken, type TestHarness } from "./helpers.js";

describe("agent token storage and lifecycle", () => {
  let h: TestHarness;
  let maintainer: string;

  beforeEach(async () => {
    h = await makeHarness();
    maintainer = await devLogin(h, "boss", "maintainer");
  });
  afterEach(() => h.close());

  it("stores only the hash: no plaintext anywhere in the database", async () => {
    const { token } = await mintToken(h, maintainer, ["chapters:read"]);
    const secret = token.slice("authorbot_".length);

    // scan every text cell of every table
    const tables = await h.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all<{ name: string }>();
    for (const { name } of tables) {
      const rows = await h.db.prepare(`SELECT * FROM "${name}"`).all();
      const dump = JSON.stringify(rows);
      expect(dump.includes(token), `plaintext token found in table ${name}`).toBe(false);
      expect(dump.includes(secret), `token secret found in table ${name}`).toBe(false);
    }
  });

  it("session ids are stored hashed only", async () => {
    const cookie = await devLogin(h, "hasher", "reader");
    const sessionId = (cookie.split("=")[1] as string).split(".")[0] as string;
    const rows = await h.db.prepare(`SELECT * FROM human_sessions`).all();
    expect(JSON.stringify(rows).includes(sessionId)).toBe(false);
  });

  it("mint validates scopes and expiry bounds", async () => {
    const bad = await h.app.request(`/v1/projects/${h.projectId}/agent-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: maintainer,
        "Idempotency-Key": "k-bad-scope",
        Origin: API_ORIGIN,
      },
      body: JSON.stringify({ name: "x", scopes: ["not-a-scope"] }),
    });
    expect(bad.status).toBe(400);

    const tooLong = await h.app.request(`/v1/projects/${h.projectId}/agent-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: maintainer,
        "Idempotency-Key": "k-bad-ttl",
        Origin: API_ORIGIN,
      },
      body: JSON.stringify({ name: "x", scopes: ["chapters:read"], expiresInDays: 91 }),
    });
    expect(tooLong.status).toBe(400);
  });

  it("mint response carries metadata + plaintext; the record ties agent to minter", async () => {
    const res = await h.app.request(`/v1/projects/${h.projectId}/agent-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: maintainer,
        "Idempotency-Key": "k-meta",
        Origin: API_ORIGIN,
      },
      body: JSON.stringify({ name: "meta-agent", scopes: ["chapters:read"], expiresInDays: 10 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      scopes: string[];
      actorId: string;
      expiresAt: string;
      token: string;
    };
    expect(body.name).toBe("meta-agent");
    expect(body.scopes).toEqual(["chapters:read"]);

    const record = await h.repos.agentTokens.getById(body.id);
    expect(record).not.toBeNull();
    const agentActor = await h.repos.actors.getById(body.actorId);
    expect(agentActor?.type).toBe("agent");
    const minter = await h.repos.actors.getByExternalIdentity("github:boss");
    expect(agentActor?.ownerActorId).toBe(minter?.id);
    expect(record?.createdBy).toBe(minter?.id);

    const membership = await h.repos.projectMemberships.getByProjectAndActor(
      h.projectId,
      body.actorId,
    );
    expect(membership?.role).toBe("editor");
  });

  it("DELETE 404s on an unknown token id", async () => {
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/agent-tokens/01900000-0000-7000-8000-00000000f00d`,
      {
        method: "DELETE",
        headers: { Cookie: maintainer, "Idempotency-Key": "k-del-404", Origin: API_ORIGIN },
      },
    );
    expect(res.status).toBe(404);
  });

  it("updates last_used_at at most once per minute", async () => {
    const { token, tokenId } = await mintToken(h, maintainer, ["chapters:read"]);
    await h.app.request("/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    const first = (await h.repos.agentTokens.getById(tokenId))?.lastUsedAt;
    expect(first).toBeTruthy();
    await h.app.request("/v1/me", { headers: { Authorization: `Bearer ${token}` } });
    const second = (await h.repos.agentTokens.getById(tokenId))?.lastUsedAt;
    expect(second).toBe(first); // throttled: not updated again within a minute
  });
});
