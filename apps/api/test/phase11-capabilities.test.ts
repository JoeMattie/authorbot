import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { LEGACY_AGENT_SCOPES, translateLegacyScopes } from "@authorbot/domain";
import { createApi } from "../src/app.js";
import type { AppDeps, AppEnv } from "../src/deps.js";
import { createDevIdentityProvider } from "../src/identity/provider.js";
import {
  API_ORIGIN,
  baseConfig,
  devLogin,
  jsonRequest,
  makeHarness,
  mintToken,
  type TestHarness,
} from "./helpers.js";

/** A distinct in-process stand-in for another Worker isolate over the same D1. */
function siblingApp(h: TestHarness): Hono<AppEnv> {
  const deps: AppDeps = {
    db: h.db,
    config: baseConfig(),
    identityProvider: createDevIdentityProvider(),
  };
  return createApi(deps).app;
}

interface CanonicalMintBody {
  id: string;
  actorId: string;
  token: string;
  scopes: string[];
  capabilityMode: string;
  grantedCapabilities: string[];
  roleCapabilityCeiling: string[];
  effectiveCapabilities: string[];
  legacyEffectiveActions: unknown[];
}

describe("Phase 11 agent-token capabilities", () => {
  let h: TestHarness;
  let maintainer: string;

  beforeEach(async () => {
    h = await makeHarness();
    maintainer = await devLogin(h, "phase11-maintainer", "maintainer");
  });

  afterEach(() => h.close());

  const mintCanonical = async (
    capabilities: string[],
    key = "phase11-canonical-mint",
  ): Promise<CanonicalMintBody> => {
    const response = await h.app.request(
      `/v1/projects/${h.projectId}/agent-tokens`,
      jsonRequest(
        "POST",
        { name: "canonical-agent", capabilities },
        { Cookie: maintainer, "Idempotency-Key": key },
      ),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as CanonicalMintBody;
  };

  it("mints canonical rows with a conservative shadow and projects the role ceiling", async () => {
    const body = await mintCanonical([
      "chapters:publish",
      "suggestions:write",
      "chapters:read",
      "suggestions:read",
    ]);

    expect(body.capabilityMode).toBe("canonical");
    expect(body.grantedCapabilities).toEqual([
      "chapters:read",
      "suggestions:read",
      "suggestions:write",
      "chapters:publish",
    ]);
    expect(body.scopes).toEqual(["chapters:read"]);
    expect(body.effectiveCapabilities).toEqual([
      "chapters:read",
      "suggestions:read",
      "suggestions:write",
    ]);
    expect(body.roleCapabilityCeiling).toContain("work:submit");
    expect(body.roleCapabilityCeiling).not.toContain("chapters:publish");
    expect(body.legacyEffectiveActions).toEqual([]);

    const stored = await h.repos.agentTokens.getById(body.id);
    expect(stored).toMatchObject({
      capabilityMode: "canonical",
      capabilitiesV2: body.grantedCapabilities,
      scopes: ["chapters:read"],
    });

    const me = await h.app.request("/v1/me", {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      authKind: "token",
      capabilityMode: "canonical",
      grantedCapabilities: body.grantedCapabilities,
      effectiveCapabilities: body.effectiveCapabilities,
      scopes: ["chapters:read"],
      legacyEffectiveActions: [],
    });
  });

  it("intersects an exact grant with the current role on every request", async () => {
    const body = await mintCanonical(["chapters:read", "chapters:publish"]);
    expect(body.effectiveCapabilities).not.toContain("chapters:publish");

    await h.db
      .prepare(`UPDATE project_memberships SET role = 'maintainer' WHERE actor_id = ?`)
      .bind(body.actorId)
      .run();
    const elevated = await h.app.request("/v1/me", {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(elevated.status).toBe(200);
    const projection = (await elevated.json()) as {
      grantedCapabilities: string[];
      roleCapabilityCeiling: string[];
      effectiveCapabilities: string[];
    };
    expect(projection.grantedCapabilities).toEqual(["chapters:read", "chapters:publish"]);
    expect(projection.roleCapabilityCeiling).toContain("chapters:publish");
    expect(projection.effectiveCapabilities).toEqual([
      "chapters:read",
      "chapters:publish",
    ]);
  });

  it("dual-writes the canonical projection for every legacy mint scope", async () => {
    const scopes = [...LEGACY_AGENT_SCOPES];
    const { tokenId } = await mintToken(h, maintainer, scopes);
    const stored = await h.repos.agentTokens.getById(tokenId);

    expect(stored).toMatchObject({
      capabilityMode: "legacy",
      scopes,
      capabilitiesV2: translateLegacyScopes(scopes),
    });
    expect(stored?.capabilitiesV2).not.toContain("members:manage");
    expect(stored?.capabilitiesV2).not.toContain("tokens:manage");
  });

  it("dual-reads legacy rows and identifies preserved actions by source", async () => {
    const { token, tokenId } = await mintToken(h, maintainer, [
      "annotations:write",
      "work:claim",
    ]);
    const record = await h.repos.agentTokens.getById(tokenId);
    if (record === null) throw new Error("minted token record is missing");
    await h.db
      .prepare(`UPDATE project_memberships SET role = 'maintainer' WHERE actor_id = ?`)
      .bind(record.actorId)
      .run();

    // Model a token created before the dual-write gate. Legacy scopes remain
    // authoritative until 3C, so the deployed reader must behave identically
    // before and after the later 3B backfill populates this projection.
    await h.db
      .prepare(`UPDATE agent_tokens SET capabilities_v2 = NULL WHERE id = ?`)
      .bind(tokenId)
      .run();

    const me = await h.app.request("/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const beforeBackfill = (await me.json()) as Record<string, unknown>;
    expect(beforeBackfill).toMatchObject({
      capabilityMode: "legacy",
      grantedCapabilities: [
        "comments:write",
        "suggestions:write",
        "replies:write",
        "feedback:withdraw-own",
        "work:claim",
      ],
      legacyEffectiveActions: [
        {
          action: "feedback:moderate",
          source: "legacy-scope",
          sourceScope: "annotations:write",
        },
        {
          action: "work:promote",
          source: "legacy-scope",
          sourceScope: "work:claim",
        },
        {
          action: "work:cancel",
          source: "legacy-scope",
          sourceScope: "work:claim",
        },
      ],
    });

    // The v0.1.36 Slice 3B migration populates this projection but deliberately
    // leaves mode=legacy. The already-deployed v0.1.35 dual-reader and writer
    // must keep legacy scopes authoritative before, during, and after it.
    await h.db
      .prepare(`UPDATE agent_tokens SET capabilities_v2 = ? WHERE id = ?`)
      .bind(
        JSON.stringify([
          "comments:write",
          "suggestions:write",
          "replies:write",
          "feedback:withdraw-own",
          "work:claim",
        ]),
        tokenId,
      )
      .run();
    const afterBackfill = await h.app.request("/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(afterBackfill.status).toBe(200);
    expect(await afterBackfill.json()).toEqual(beforeBackfill);
  });

  it("fails closed for unknown and malformed canonical grant sets", async () => {
    const { token, tokenId } = await mintToken(h, maintainer, ["chapters:read"]);
    await h.db
      .prepare(
        `UPDATE agent_tokens
            SET capability_mode = 'canonical',
                capabilities_v2 = '["future:unknown"]',
                scopes = '["chapters:read"]'
          WHERE id = ?`,
      )
      .bind(tokenId)
      .run();

    const unknown = await h.app.request("/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({
      capabilityMode: "canonical",
      grantedCapabilities: [],
      effectiveCapabilities: [],
      scopes: [],
    });

    await h.db
      .prepare(`UPDATE agent_tokens SET capabilities_v2 = '{not-json' WHERE id = ?`)
      .bind(tokenId)
      .run();
    const malformed = await h.app.request("/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(malformed.status).toBe(401);
  });

  it("replaces the complete set idempotently without rotating or returning the secret", async () => {
    const { tokenId } = await mintToken(h, maintainer, ["annotations:write"]);
    const before = await h.repos.agentTokens.getById(tokenId);
    expect(before).not.toBeNull();
    const path = `/v1/projects/${h.projectId}/agent-tokens/${tokenId}/capabilities`;
    const key = "phase11-capabilities-replace";
    const request = () =>
      h.app.request(
        path,
        jsonRequest(
          "PUT",
          { capabilities: ["comments:read", "chapters:read"] },
          { Cookie: maintainer, "Idempotency-Key": key },
        ),
      );

    const first = await request();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      id: tokenId,
      capabilityMode: "canonical",
      scopes: ["chapters:read"],
      grantedCapabilities: ["chapters:read", "comments:read"],
      effectiveCapabilities: ["chapters:read", "comments:read"],
      legacyEffectiveActions: [],
    });
    expect(firstBody).not.toHaveProperty("token");
    expect(firstBody).not.toHaveProperty("tokenHash");

    const replay = await request();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const stored = await h.repos.agentTokens.getById(tokenId);
    expect(stored?.tokenHash).toBe(before?.tokenHash);
    expect(stored).toMatchObject({
      capabilityMode: "canonical",
      scopes: ["chapters:read"],
      capabilitiesV2: ["chapters:read", "comments:read"],
    });
    const audit = await h.db
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'agent_token.capabilities.update' AND target_id = ?`,
      )
      .bind(tokenId)
      .first<{ count: number }>();
    expect(audit?.count).toBe(1);

    const cleared = await h.app.request(
      path,
      jsonRequest(
        "PUT",
        { capabilities: [] },
        { Cookie: maintainer, "Idempotency-Key": "phase11-capabilities-clear" },
      ),
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      capabilityMode: "canonical",
      scopes: [],
      grantedCapabilities: [],
      effectiveCapabilities: [],
    });
  });

  it("serializes locally and compare-and-swaps cross-isolate capability replacements", async () => {
    const { tokenId } = await mintToken(h, maintainer, ["chapters:read"]);
    const path = `/v1/projects/${h.projectId}/agent-tokens/${tokenId}/capabilities`;
    const other = siblingApp(h);
    const [comments, suggestions] = await Promise.all([
      h.app.request(
        path,
        jsonRequest(
          "PUT",
          { capabilities: ["chapters:read", "comments:read"] },
          { Cookie: maintainer, "Idempotency-Key": "phase11-race-comments" },
        ),
      ),
      other.request(
        path,
        jsonRequest(
          "PUT",
          { capabilities: ["chapters:read", "suggestions:read"] },
          { Cookie: maintainer, "Idempotency-Key": "phase11-race-suggestions" },
        ),
      ),
    ]);

    expect([comments.status, suggestions.status]).toContain(200);
    expect([200, 409]).toContain(comments.status);
    expect([200, 409]).toContain(suggestions.status);
    const rows = await h.db
      .prepare(
        `SELECT metadata FROM audit_events
          WHERE action = 'agent_token.capabilities.update' AND target_id = ?
          ORDER BY rowid`,
      )
      .bind(tokenId)
      .all<{ metadata: string }>();
    expect(rows).toHaveLength(
      [comments.status, suggestions.status].filter((status) => status === 200).length,
    );
    if (rows.length === 2) {
      const first = JSON.parse(rows[0]?.metadata ?? "{}") as {
        after?: Record<string, unknown>;
      };
      const second = JSON.parse(rows[1]?.metadata ?? "{}") as {
        before?: Record<string, unknown>;
      };
      expect(second.before).toEqual(first.after);
    }
  });

  it("never applies a capability replacement after a racing revocation", async () => {
    const { tokenId } = await mintToken(h, maintainer, ["chapters:read"]);
    const other = siblingApp(h);
    const [replacement, revocation] = await Promise.all([
      h.app.request(
        `/v1/projects/${h.projectId}/agent-tokens/${tokenId}/capabilities`,
        jsonRequest(
          "PUT",
          { capabilities: ["chapters:read", "comments:read"] },
          { Cookie: maintainer, "Idempotency-Key": "phase11-race-replace" },
        ),
      ),
      other.request(`/v1/projects/${h.projectId}/agent-tokens/${tokenId}`, {
        method: "DELETE",
        headers: {
          Cookie: maintainer,
          Origin: API_ORIGIN,
          "Idempotency-Key": "phase11-race-revoke",
        },
      }),
    ]);

    expect(revocation.status).toBe(204);
    expect([200, 409]).toContain(replacement.status);
    expect((await h.repos.agentTokens.getById(tokenId))?.revokedAt).not.toBeNull();
    const updates = await h.db
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'agent_token.capabilities.update' AND target_id = ?`,
      )
      .bind(tokenId)
      .first<{ count: number }>();
    expect(updates?.count).toBe(replacement.status === 200 ? 1 : 0);
  });

  it("projects capabilities in the session-only token list", async () => {
    const minted = await mintCanonical(["chapters:read", "comments:read"]);
    const list = await h.app.request(`/v1/projects/${h.projectId}/agent-tokens`, {
      headers: { Cookie: maintainer },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<Record<string, unknown>> };
    const item = body.items.find(({ id }) => id === minted.id);
    expect(item).toMatchObject({
      id: minted.id,
      capabilityMode: "canonical",
      grantedCapabilities: ["chapters:read", "comments:read"],
      effectiveCapabilities: ["chapters:read", "comments:read"],
      legacyEffectiveActions: [],
    });
    expect(item).not.toHaveProperty("token");
    expect(item).not.toHaveProperty("tokenHash");
  });

  it("rejects bearer credentials on every token-management route before scope checks", async () => {
    const { token, tokenId } = await mintToken(h, maintainer, [
      "chapters:read",
      "tokens:manage",
      "members:manage",
    ]);
    const record = await h.repos.agentTokens.getById(tokenId);
    if (record === null) throw new Error("minted token record is missing");
    await h.db
      .prepare(`UPDATE project_memberships SET role = 'maintainer' WHERE actor_id = ?`)
      .bind(record.actorId)
      .run();

    const authorization = { Authorization: `Bearer ${token}` };
    const attempts = [
      h.app.request(`/v1/projects/${h.projectId}/agent-tokens`, {
        headers: authorization,
      }),
      h.app.request(
        `/v1/projects/${h.projectId}/agent-tokens`,
        jsonRequest(
          "POST",
          { name: "forbidden", capabilities: [] },
          { ...authorization, "Idempotency-Key": "phase11-token-post" },
        ),
      ),
      h.app.request(
        `/v1/projects/${h.projectId}/agent-tokens/${tokenId}/capabilities`,
        jsonRequest(
          "PUT",
          { capabilities: [] },
          { ...authorization, "Idempotency-Key": "phase11-token-put" },
        ),
      ),
      h.app.request(`/v1/projects/${h.projectId}/agent-tokens/${tokenId}`, {
        method: "DELETE",
        headers: {
          ...authorization,
          "Idempotency-Key": "phase11-token-delete",
        },
      }),
      h.app.request(
        `/v1/projects/${h.projectId}/agent-tokens/revoke-all`,
        jsonRequest(
          "POST",
          { reason: "must require a human session" },
          { ...authorization, "Idempotency-Key": "phase11-token-revoke-all" },
        ),
      ),
    ];

    for (const response of await Promise.all(attempts)) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "forbidden",
        detail: "agent-token credentials cannot manage agent tokens",
      });
    }
    expect((await h.repos.agentTokens.getById(tokenId))?.revokedAt).toBeNull();
  });
});
