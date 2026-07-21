import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_ORIGIN,
  devLogin,
  jsonRequest,
  makeHarness,
  mintToken,
  validAnnotationPayload,
  type TestHarness,
} from "./helpers.js";

describe("authentication and authorization", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it("rejects anonymous requests with 401 problem+json", async () => {
    const res = await h.app.request("/v1/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("unauthorized");
    expect(res.headers.get("x-correlation-id")).toBeTruthy();
  });

  it("serves /v1/me for a session and echoes effective scopes", async () => {
    const cookie = await devLogin(h, "alice", "contributor");
    const res = await h.app.request("/v1/me", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      actor: { externalIdentity: string };
      scopes: string[];
      authKind: string;
    };
    expect(body.actor.externalIdentity).toBe("github:alice");
    // Phase 3: the contributor bundle gains votes:write (contract §2).
    expect(body.scopes).toEqual([
      "chapters:read",
      "annotations:read",
      "annotations:write",
      "votes:write",
    ]);
    expect(body.authKind).toBe("session");
  });

  it("rejects a garbage cookie and a tampered signature", async () => {
    const cookie = await devLogin(h, "alice", "reader");
    const tampered = cookie.replace(/.$/, (ch) => (ch === "a" ? "b" : "a"));
    for (const value of ["authorbot_session=nonsense", tampered]) {
      const res = await h.app.request("/v1/me", { headers: { Cookie: value } });
      expect(res.status).toBe(401);
    }
  });

  it("404s when {projectId} does not match the configured project", async () => {
    const cookie = await devLogin(h, "alice", "maintainer");
    const res = await h.app.request("/v1/projects/some-other-project/chapters", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });

  it("accepts both the project UUID and the slug in {projectId}", async () => {
    const cookie = await devLogin(h, "alice", "reader");
    for (const id of [h.projectId, "hollow-creek-anomaly"]) {
      const res = await h.app.request(`/v1/projects/${id}`, { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
    }
  });

  it("enforces the scope matrix on writes: reader 403, contributor 202", async () => {
    const reader = await devLogin(h, "ro", "reader");
    const contributor = await devLogin(h, "rw", "contributor");
    const path = `/v1/projects/${h.projectId}/chapters/01900000-0000-7000-8000-000000000001/annotations`;

    const denied = await h.app.request(
      path,
      jsonRequest("POST", validAnnotationPayload(), { Cookie: reader }),
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { code: string }).code).toBe("forbidden");

    const accepted = await h.app.request(
      path,
      jsonRequest("POST", validAnnotationPayload(), { Cookie: contributor }),
    );
    expect(accepted.status).toBe(202);
  });

  it("restricts token minting to maintainers", async () => {
    const contributor = await devLogin(h, "carol", "contributor");
    const res = await h.app.request(`/v1/projects/${h.projectId}/agent-tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "k-mint-denied",
        Origin: API_ORIGIN,
        Cookie: contributor,
      },
      body: JSON.stringify({ name: "nope", scopes: ["chapters:read"] }),
    });
    expect(res.status).toBe(403);
  });

  describe("agent tokens", () => {
    let maintainerCookie: string;

    beforeEach(async () => {
      maintainerCookie = await devLogin(h, "boss", "maintainer");
    });

    it("authenticates a valid bearer token with intersected scopes", async () => {
      const { token } = await mintToken(h, maintainerCookie, [
        "chapters:read",
        "annotations:write",
      ]);
      const res = await h.app.request("/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scopes: string[]; authKind: string };
      expect(body.authKind).toBe("token");
      expect(body.scopes).toEqual(["chapters:read", "annotations:write"]);
    });

    it("caps agent scopes at the editor bundle (tokens:manage never effective)", async () => {
      const { token } = await mintToken(h, maintainerCookie, [
        "chapters:read",
        "tokens:manage",
      ]);
      const me = await h.app.request("/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await me.json()) as { scopes: string[] };
      expect(body.scopes).toEqual(["chapters:read"]);

      const mint = await h.app.request(`/v1/projects/${h.projectId}/agent-tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "k-agent-mint",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: "sneaky", scopes: ["chapters:read"] }),
      });
      expect(mint.status).toBe(403);
    });

    it("rejects malformed, unknown, revoked, and expired tokens", async () => {
      const { token, tokenId } = await mintToken(h, maintainerCookie, ["chapters:read"]);

      // malformed
      for (const bad of ["Bearer nope", "Bearer authorbot_short", `Basic ${token}`]) {
        const res = await h.app.request("/v1/me", { headers: { Authorization: bad } });
        expect(res.status).toBe(401);
      }

      // unknown (valid shape, never minted)
      const unknown = `authorbot_${"A".repeat(43)}`;
      const unknownRes = await h.app.request("/v1/me", {
        headers: { Authorization: `Bearer ${unknown}` },
      });
      expect(unknownRes.status).toBe(401);

      // expired: age the row in the database
      await h.db
        .prepare(`UPDATE agent_tokens SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?`)
        .bind(tokenId)
        .run();
      const expired = await h.app.request("/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(expired.status).toBe(401);

      // un-expire, then revoke via the API
      await h.db
        .prepare(`UPDATE agent_tokens SET expires_at = '2099-01-01T00:00:00Z' WHERE id = ?`)
        .bind(tokenId)
        .run();
      const del = await h.app.request(
        `/v1/projects/${h.projectId}/agent-tokens/${tokenId}`,
        {
          method: "DELETE",
          headers: { Cookie: maintainerCookie, "Idempotency-Key": "k-revoke-1", Origin: API_ORIGIN },
        },
      );
      expect(del.status).toBe(204);
      const revoked = await h.app.request("/v1/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(revoked.status).toBe(401);
    });

    it("denies an actor whose membership was revoked", async () => {
      const cookie = await devLogin(h, "victim", "contributor");
      await h.db
        .prepare(
          `UPDATE project_memberships SET revoked_at = '2026-01-01T00:00:00Z'
           WHERE actor_id = (SELECT id FROM actors WHERE external_identity = 'github:victim')`,
        )
        .run();
      const res = await h.app.request(`/v1/projects/${h.projectId}/chapters`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(403);
    });
  });

  it("audits every mutation", async () => {
    const cookie = await devLogin(h, "auditee", "contributor");
    const path = `/v1/projects/${h.projectId}/chapters/01900000-0000-7000-8000-000000000001/annotations`;
    await h.app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "k-audit-1",
        Origin: API_ORIGIN,
        Cookie: cookie,
      },
      body: JSON.stringify(validAnnotationPayload()),
    });
    const events = await h.repos.auditEvents.listByProject(h.projectId);
    const actions = events.map((event) => event.action);
    expect(actions).toContain("annotation.create");
    expect(actions).toContain("session.login");
  });
});

describe("signing out", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it("ends the session so the same cookie stops working", async () => {
    const cookie = await devLogin(h, "alice", "contributor");

    // The cookie works before.
    expect((await h.app.request("/v1/me", { headers: { cookie } })).status).toBe(200);

    const out = await h.app.request("/v1/auth/logout", { method: "POST" , headers: { cookie } });
    expect(out.status).toBe(204);

    // And is dead after — revoked server-side, not merely forgotten by the
    // browser. Replaying the exact same value must fail.
    expect((await h.app.request("/v1/me", { headers: { cookie } })).status).toBe(401);
  });

  it("clears the cookie with attributes that actually replace it", async () => {
    const cookie = await devLogin(h, "alice", "contributor");
    const out = await h.app.request("/v1/auth/logout", { method: "POST", headers: { cookie } });

    // A browser only replaces a cookie when Path, Secure, HttpOnly and
    // SameSite match the one it holds; a clear that differs in any of them
    // leaves the original in place and the reader still signed in.
    const setCookie = out.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("authorbot_session=;");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("succeeds for a caller with no session at all", async () => {
    // "Sign me out" is satisfied either way, and the response must not reveal
    // whether the cookie was real.
    const out = await h.app.request("/v1/auth/logout", { method: "POST" });
    expect(out.status).toBe(204);
  });
});
