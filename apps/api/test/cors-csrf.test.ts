/**
 * Phase 2b contract §3: CORS (exact-origin allow-list, credentialed,
 * preflight), CSRF (Origin/Referer check on cookie-authed mutations, bearer
 * exempt), session cookie attribute matrix, and OAuth `return_to` validation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, openSqliteDatabase } from "@authorbot/database";
import { createApi, type AuthorbotApi } from "../src/app.js";
import { configFromBindings, type WorkerBindings } from "../src/worker.js";
import { parseAllowedOrigins, isValidReturnTo } from "../src/origins.js";
import type { GitHubIdentityProvider } from "../src/identity/provider.js";
import {
  API_ORIGIN,
  CHAPTER_ID,
  MIGRATIONS_DIR,
  baseConfig,
  devLogin,
  jsonRequest,
  makeHarness,
  mintToken,
  validAnnotationPayload,
  type TestHarness,
} from "./helpers.js";

const SITE = "https://site.example";
const FOREIGN = "https://evil.example";

describe("ALLOWED_ORIGINS boot parsing", () => {
  it("parses a comma-separated exact-origin list", () => {
    expect(parseAllowedOrigins("https://site.example, http://localhost:4321")).toEqual([
      "https://site.example",
      "http://localhost:4321",
    ]);
  });

  it("returns [] for absent/blank input", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("   ")).toEqual([]);
  });

  it("dedupes and tolerates trailing commas", () => {
    expect(parseAllowedOrigins("https://a.example,https://a.example,")).toEqual([
      "https://a.example",
    ]);
  });

  it.each([
    "*",
    "https://site.example/",
    "https://site.example/path",
    "site.example",
    "https://user:pw@site.example",
    "https://site.example?q=1",
    "ftp://site.example",
    "javascript:alert(1)",
  ])("rejects %s at boot", (value) => {
    expect(() => parseAllowedOrigins(value)).toThrow();
  });

  it("configFromBindings validates ALLOWED_ORIGINS at boot", () => {
    const bindings = {
      DB: null,
      AUTH_MODE: "dev",
      DEV_LOGIN_ENABLED: "true",
      SESSION_SECRET: "s",
      WEBHOOK_SECRET: "w",
      PROJECT_SLUG: "p",
      PROJECT_REPO: "o/r",
      INITIAL_MAINTAINER: "github:o",
    } as unknown as WorkerBindings;
    expect(
      configFromBindings({ ...bindings, ALLOWED_ORIGINS: `${SITE},http://localhost:4321` })
        .allowedOrigins,
    ).toEqual([SITE, "http://localhost:4321"]);
    expect(() =>
      configFromBindings({ ...bindings, ALLOWED_ORIGINS: "https://site.example/app" }),
    ).toThrow(/ALLOWED_ORIGINS/);
    expect(configFromBindings(bindings).allowedOrigins).toEqual([]);
  });
});

describe("CORS", () => {
  let h: TestHarness;
  afterEach(() => h.close());

  const annotationsPath = (): string =>
    `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`;

  it("answers preflight for an allowed origin with credentials and headers", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const res = await h.app.request(annotationsPath(), {
      method: "OPTIONS",
      headers: {
        Origin: SITE,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,idempotency-key",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    const allowHeaders = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowHeaders).toContain("Idempotency-Key");
    expect(allowHeaders).toContain("Content-Type");
    expect(allowHeaders).toContain("Authorization");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("gives a foreign-origin preflight no CORS headers", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const res = await h.app.request(annotationsPath(), {
      method: "OPTIONS",
      headers: { Origin: FOREIGN, "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("decorates actual responses for an allowed origin and exposes X-Correlation-Id", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const cookie = await devLogin(h, "cors-user", "reader");
    const res = await h.app.request("/v1/me", { headers: { Cookie: cookie, Origin: SITE } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-expose-headers")).toContain("X-Correlation-Id");
    expect(res.headers.get("x-correlation-id")).not.toBeNull();
  });

  it("adds no CORS headers for a foreign or absent Origin", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const cookie = await devLogin(h, "cors-user", "reader");
    const foreign = await h.app.request("/v1/me", {
      headers: { Cookie: cookie, Origin: FOREIGN },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const absent = await h.app.request("/v1/me", { headers: { Cookie: cookie } });
    expect(absent.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("is fully inert when ALLOWED_ORIGINS is not configured", async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "cors-user", "reader");
    const res = await h.app.request("/v1/me", { headers: { Cookie: cookie, Origin: SITE } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await h.app.request(annotationsPath(), {
      method: "OPTIONS",
      headers: { Origin: SITE, "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.status).toBe(404); // no preflight interception either
  });
});

describe("CSRF origin check on cookie-authed mutations", () => {
  let h: TestHarness;
  afterEach(() => h.close());

  const annotationsPath = (): string =>
    `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`;

  const postAnnotation = async (headers: Record<string, string>): Promise<Response> =>
    h.app.request(annotationsPath(), jsonRequest("POST", validAnnotationPayload(), headers));

  const csrfCode = async (res: Response): Promise<string> =>
    ((await res.json()) as { code: string }).code;

  it("accepts a configured cross-origin site's Origin", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const res = await postAnnotation({ Cookie: cookie, Origin: SITE });
    expect(res.status).toBe(202);
  });

  it("accepts the API's own origin", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const res = await postAnnotation({ Cookie: cookie, Origin: API_ORIGIN });
    expect(res.status).toBe(202);
  });

  it("rejects a foreign Origin with 403 csrf-origin-mismatch", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const res = await postAnnotation({ Cookie: cookie, Origin: FOREIGN });
    expect(res.status).toBe(403);
    expect(await csrfCode(res)).toBe("csrf-origin-mismatch");
  });

  it("rejects a missing Origin/Referer (fails closed)", async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const response = await h.app.request(annotationsPath(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "csrf-missing-1",
        Cookie: cookie,
      },
      body: JSON.stringify(validAnnotationPayload()),
    });
    expect(response.status).toBe(403);
    expect(await csrfCode(response)).toBe("csrf-origin-mismatch");
  });

  it('rejects an opaque "null" Origin', async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const res = await postAnnotation({ Cookie: cookie, Origin: "null" });
    expect(res.status).toBe(403);
    expect(await csrfCode(res)).toBe("csrf-origin-mismatch");
  });

  it("falls back to the Referer origin when Origin is absent", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const ok = await h.app.request(annotationsPath(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "csrf-referer-1",
        Cookie: cookie,
        Referer: `${SITE}/chapters/baseline`,
      },
      body: JSON.stringify(validAnnotationPayload()),
    });
    expect(ok.status).toBe(202);
    const bad = await h.app.request(annotationsPath(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "csrf-referer-2",
        Cookie: cookie,
        Referer: `${FOREIGN}/attack`,
      },
      body: JSON.stringify(validAnnotationPayload()),
    });
    expect(bad.status).toBe(403);
  });

  it("does not let a foreign Origin fall back to an allowed Referer", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const res = await postAnnotation({
      Cookie: cookie,
      Origin: FOREIGN,
      Referer: `${SITE}/chapters/baseline`,
    });
    expect(res.status).toBe(403);
  });

  it("exempts bearer-token mutations (no ambient credential)", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const cookie = await devLogin(h, "csrf-boss", "maintainer");
    const { token } = await mintToken(h, cookie, ["annotations:read", "annotations:write"]);
    // No Origin at all:
    const noOrigin = await h.app.request(annotationsPath(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "csrf-bearer-1",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(validAnnotationPayload()),
    });
    expect(noOrigin.status).toBe(202);
    // Foreign Origin:
    const foreignOrigin = await h.app.request(annotationsPath(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "csrf-bearer-2",
        Authorization: `Bearer ${token}`,
        Origin: FOREIGN,
      },
      body: JSON.stringify(validAnnotationPayload()),
    });
    expect(foreignOrigin.status).toBe(202);
  });

  it("leaves cookie-authed reads unaffected", async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "csrf-user", "reader");
    const res = await h.app.request("/v1/me", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
  });

  it("runs after authentication: an anonymous mutation is still 401", async () => {
    h = await makeHarness();
    const res = await h.app.request(annotationsPath(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "csrf-anon-1" },
      body: JSON.stringify(validAnnotationPayload()),
    });
    expect(res.status).toBe(401);
  });
});

describe("session cookie attribute matrix", () => {
  let h: TestHarness;
  afterEach(() => h.close());

  const loginSetCookie = async (): Promise<string> => {
    const res = await h.app.request("/v1/dev/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: API_ORIGIN },
      body: JSON.stringify({ login: "cookie-user", role: "reader" }),
    });
    expect(res.status).toBe(200);
    return res.headers.get("set-cookie") ?? "";
  };

  it("SameSite=Lax (Secure, HttpOnly) when no cross-origin site is configured", async () => {
    h = await makeHarness();
    const cookie = await loginSetCookie();
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });

  it("SameSite=None (Secure, HttpOnly) when ALLOWED_ORIGINS is configured", async () => {
    h = await makeHarness({ config: { allowedOrigins: [SITE] } });
    const cookie = await loginSetCookie();
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });
});

describe("OAuth return_to (github mode)", () => {
  const stubProvider: GitHubIdentityProvider = {
    mode: "github",
    authorizeUrl: (state: string) =>
      `https://github.com/login/oauth/authorize?client_id=test-client&state=${encodeURIComponent(state)}`,
    resolveCallback: async () => ({
      externalIdentity: "github:cb-user",
      displayName: "Callback User",
    }),
  };

  interface GithubHarness {
    api: AuthorbotApi;
    close(): void;
  }

  async function makeGithubHarness(allowedOrigins: string[]): Promise<GithubHarness> {
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, MIGRATIONS_DIR);
    const api = createApi({
      db,
      config: baseConfig({
        authMode: "github",
        allowedOrigins,
        github: {
          clientId: "test-client",
          clientSecret: "test-oauth-secret",
          redirectUri: "https://example.test/v1/auth/github/callback",
        },
      }),
      identityProvider: stubProvider,
    });
    await api.bootstrap();
    return { api, close: () => db.close() };
  }

  /** Run the start route; return the state cookie value and redirect state. */
  async function startOauth(
    g: GithubHarness,
    returnTo?: string,
  ): Promise<{ response: Response; stateCookie: string | null; state: string | null }> {
    const query = returnTo !== undefined ? `?return_to=${encodeURIComponent(returnTo)}` : "";
    const response = await g.api.app.request(`/v1/auth/github${query}`);
    const setCookie = response.headers.get("set-cookie");
    const stateCookie =
      setCookie !== null && setCookie.includes("authorbot_oauth_state=")
        ? (setCookie.split(";")[0] as string)
        : null;
    const location = response.headers.get("location");
    const state =
      location !== null ? new URL(location).searchParams.get("state") : null;
    return { response, stateCookie, state };
  }

  it("propagates a valid return_to through the signed state cookie to the callback redirect", async () => {
    const g = await makeGithubHarness([SITE]);
    try {
      const target = `${SITE}/chapters/baseline#annotate`;
      const { response, stateCookie, state } = await startOauth(g, target);
      expect(response.status).toBe(302);
      expect(stateCookie).not.toBeNull();
      expect(state).not.toBeNull();
      // return_to is never leaked to GitHub via the authorize URL:
      expect(response.headers.get("location")).not.toContain("return_to");

      const callback = await g.api.app.request(
        `/v1/auth/github/callback?code=fake-code&state=${encodeURIComponent(state as string)}`,
        { headers: { Cookie: stateCookie as string } },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(target);
      // Session established with SameSite=None (cross-origin configured):
      const sessionCookie = callback.headers.get("set-cookie") ?? "";
      expect(sessionCookie).toContain("authorbot_session=");
      expect(sessionCookie).toContain("SameSite=None");
    } finally {
      g.close();
    }
  });

  it("redirects to / when no return_to was given", async () => {
    const g = await makeGithubHarness([SITE]);
    try {
      const { stateCookie, state } = await startOauth(g);
      const callback = await g.api.app.request(
        `/v1/auth/github/callback?code=fake-code&state=${encodeURIComponent(state as string)}`,
        { headers: { Cookie: stateCookie as string } },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("/");
    } finally {
      g.close();
    }
  });

  it.each([
    ["javascript: URL", "javascript:alert(1)"],
    ["data: URL", "data:text/html,<script>alert(1)</script>"],
    ["foreign origin", `${FOREIGN}/phish`],
    ["subdomain-suffix open redirect", "https://site.example.evil.com/phish"],
    ["userinfo open redirect", "https://site.example@evil.com/phish"],
    ["backslash authority trick", "https://site.example\\@evil.com/phish"],
    ["scheme-relative URL", "//evil.example/phish"],
    ["relative path", "/chapters/baseline"],
    ["allowed origin without boundary", "https://site.examplezz"],
  ])("rejects %s with 400 validation-failed", async (_name, attempt) => {
    const g = await makeGithubHarness([SITE]);
    try {
      const { response } = await startOauth(g, attempt);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("validation-failed");
    } finally {
      g.close();
    }
  });

  it("rejects a foreign return_to when no origins are configured", async () => {
    const g = await makeGithubHarness([]);
    try {
      const { response } = await startOauth(g, `${SITE}/chapters/baseline`);
      expect(response.status).toBe(400);
    } finally {
      g.close();
    }
  });

  it("accepts a same-origin return_to when no origins are configured (contract §2.4 same-origin deployment)", async () => {
    // Hono#request builds requests against http://localhost — the API's own
    // origin. The recommended production deployment (ALLOWED_ORIGINS unset,
    // site + API on one host) must allow the sign-in flow to start.
    const g = await makeGithubHarness([]);
    try {
      const target = "http://localhost/chapters/baseline/";
      const { response, stateCookie, state } = await startOauth(g, target);
      expect(response.status).toBe(302);
      const callback = await g.api.app.request(
        `/v1/auth/github/callback?code=fake-code&state=${encodeURIComponent(state as string)}`,
        { headers: { Cookie: stateCookie as string } },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(target);
    } finally {
      g.close();
    }
  });

  it("still rejects a state mismatch", async () => {
    const g = await makeGithubHarness([SITE]);
    try {
      const { stateCookie } = await startOauth(g, `${SITE}/x`);
      const callback = await g.api.app.request(
        "/v1/auth/github/callback?code=fake-code&state=wrong-state",
        { headers: { Cookie: stateCookie as string } },
      );
      expect(callback.status).toBe(401);
    } finally {
      g.close();
    }
  });

  it("rejects a tampered state cookie", async () => {
    const g = await makeGithubHarness([SITE]);
    try {
      const { stateCookie, state } = await startOauth(g, `${SITE}/x`);
      const tampered = `${(stateCookie as string).slice(0, -2)}xx`;
      const callback = await g.api.app.request(
        `/v1/auth/github/callback?code=fake-code&state=${encodeURIComponent(state as string)}`,
        { headers: { Cookie: tampered } },
      );
      expect(callback.status).toBe(401);
    } finally {
      g.close();
    }
  });
});

describe("isValidReturnTo unit matrix", () => {
  const API = "http://api.example";
  const allowed = [SITE, "http://localhost:4321"];
  it.each([
    [`${SITE}`, true],
    [`${SITE}/`, true],
    [`${SITE}/chapters/one?x=1#frag`, true],
    ["http://localhost:4321/ch/2", true],
    // The API's own origin is always acceptable (same-origin deployment,
    // mirroring csrfOriginAllowed) — even with an empty allow-list.
    [`${API}/chapters/one`, true],
    [`${SITE}zz/path`, false],
    [`${FOREIGN}/`, false],
    ["javascript:alert(1)", false],
    ["HTTPS://SITE.EXAMPLE/path", false], // not a literal origin prefix — conservative
  ])("%s → %s", (value, expected) => {
    expect(isValidReturnTo(value, API, allowed)).toBe(expected);
  });

  it("accepts the API's own origin when no origins are configured (same-origin deployment)", () => {
    expect(isValidReturnTo(`${API}/chapters/baseline/`, API, [])).toBe(true);
    expect(isValidReturnTo(`${FOREIGN}/phish`, API, [])).toBe(false);
  });
});
