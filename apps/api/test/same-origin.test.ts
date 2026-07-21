/**
 * ADR-0019 (same-origin only), superseding the cross-origin provisions of
 * Phase 2b contract §3:
 *
 *  - no `Access-Control-*` header is emitted under ANY configuration, on any
 *    request shape including preflight-shaped ones (§1);
 *  - the session cookie is always `HttpOnly; Secure; SameSite=Lax` (§2);
 *  - CSRF origin matching on cookie-authenticated mutations STAYS (§3);
 *  - `return_to` accepts only URLs within the API's own origin (§4);
 *  - `API_BASE_PATH` mounts the whole API under a prefix (§6).
 *
 * This file replaces `cors-csrf.test.ts`. Every test that asserted CORS
 * headers, the `ALLOWED_ORIGINS` allow-list, or the `SameSite=None` cookie is
 * deleted rather than adapted: the behaviour it covered no longer exists, and
 * the deletions are re-covered here by their inverse (no header, no allow-list,
 * never `None`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, openSqliteDatabase } from "@authorbot/database";
import { createApi, type AuthorbotApi } from "../src/app.js";
import { configFromBindings, type WorkerBindings } from "../src/worker.js";
import { normalizeBasePath } from "../src/base-path.js";
import { isValidReturnTo, csrfOriginAllowed } from "../src/origins.js";
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

/** Every `Access-Control-*` header present on a response. */
function corsHeaders(res: Response): string[] {
  const found: string[] = [];
  res.headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith("access-control-")) {
      found.push(name.toLowerCase());
    }
  });
  return found;
}

describe("no CORS surface (ADR-0019 §1)", () => {
  let h: TestHarness;
  afterEach(() => h.close());

  const annotationsPath = (): string =>
    `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`;

  it("emits no Access-Control-* header on an authenticated read", async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "cors-user", "reader");
    for (const origin of [SITE, FOREIGN, API_ORIGIN]) {
      const res = await h.app.request("/v1/me", { headers: { Cookie: cookie, Origin: origin } });
      expect(res.status).toBe(200);
      expect(corsHeaders(res)).toEqual([]);
    }
  });

  it("emits no Access-Control-* header on a mutation", async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "cors-user", "contributor");
    const res = await h.app.request(
      annotationsPath(),
      jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie, Origin: API_ORIGIN }),
    );
    expect(res.status).toBe(202);
    expect(corsHeaders(res)).toEqual([]);
  });

  it("does not intercept a preflight-shaped OPTIONS request", async () => {
    h = await makeHarness();
    for (const origin of [SITE, API_ORIGIN]) {
      const res = await h.app.request(annotationsPath(), {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,idempotency-key",
        },
      });
      // No preflight handler exists; the route has no OPTIONS method.
      expect(res.status).toBe(404);
      expect(corsHeaders(res)).toEqual([]);
    }
  });

  it("emits no Access-Control-* header on unauthenticated or error responses", async () => {
    h = await makeHarness();
    const unauthorized = await h.app.request("/v1/me", { headers: { Origin: FOREIGN } });
    expect(unauthorized.status).toBe(401);
    expect(corsHeaders(unauthorized)).toEqual([]);
    const notFound = await h.app.request("/v1/nope", { headers: { Origin: FOREIGN } });
    expect(notFound.status).toBe(404);
    expect(corsHeaders(notFound)).toEqual([]);
  });

  it("has no ALLOWED_ORIGINS binding: an unknown var cannot re-enable CORS", async () => {
    const bindings = {
      DB: null,
      AUTH_MODE: "dev",
      DEV_LOGIN_ENABLED: "true",
      SESSION_SECRET: "s",
      WEBHOOK_SECRET: "w",
      PROJECT_SLUG: "p",
      PROJECT_REPO: "o/r",
      INITIAL_MAINTAINER: "github:o",
      // Deliberately still set in the environment, as a lingering deployment
      // variable would be: it must be inert, not honoured.
      ALLOWED_ORIGINS: SITE,
    } as unknown as WorkerBindings;
    const config = configFromBindings(bindings);
    expect(Object.keys(config)).not.toContain("allowedOrigins");

    h = await makeHarness({ config });
    const cookie = await devLogin(h, "cors-user", "reader");
    const res = await h.app.request("/v1/me", { headers: { Cookie: cookie, Origin: SITE } });
    expect(corsHeaders(res)).toEqual([]);
  });
});

describe("CSRF origin check on cookie-authed mutations (ADR-0019 §3)", () => {
  let h: TestHarness;
  afterEach(() => h.close());

  const annotationsPath = (): string =>
    `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`;

  const postAnnotation = async (headers: Record<string, string>): Promise<Response> =>
    h.app.request(annotationsPath(), jsonRequest("POST", validAnnotationPayload(), headers));

  const csrfCode = async (res: Response): Promise<string> =>
    ((await res.json()) as { code: string }).code;

  it("accepts the API's own origin", async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const res = await postAnnotation({ Cookie: cookie, Origin: API_ORIGIN });
    expect(res.status).toBe(202);
  });

  it("rejects a foreign Origin with 403 csrf-origin-mismatch", async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const res = await postAnnotation({ Cookie: cookie, Origin: FOREIGN });
    expect(res.status).toBe(403);
    expect(await csrfCode(res)).toBe("csrf-origin-mismatch");
  });

  it("rejects what used to be a configured cross-origin site", async () => {
    // The whole point of ADR-0019: there is no configuration that makes this
    // succeed any more.
    h = await makeHarness();
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const res = await postAnnotation({ Cookie: cookie, Origin: SITE });
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
    h = await makeHarness();
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const ok = await h.app.request(annotationsPath(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "csrf-referer-1",
        Cookie: cookie,
        Referer: `${API_ORIGIN}/chapters/baseline`,
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

  it("does not let a foreign Origin fall back to an acceptable Referer", async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "csrf-user", "contributor");
    const res = await postAnnotation({
      Cookie: cookie,
      Origin: FOREIGN,
      Referer: `${API_ORIGIN}/chapters/baseline`,
    });
    expect(res.status).toBe(403);
  });

  it("exempts bearer-token mutations (no ambient credential)", async () => {
    h = await makeHarness();
    const cookie = await devLogin(h, "csrf-boss", "maintainer");
    const { token } = await mintToken(h, cookie, ["annotations:read", "annotations:write"]);
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

  it("rejects a foreign Origin on dev login (the session-minting route)", async () => {
    h = await makeHarness();
    const res = await h.app.request("/v1/dev/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: FOREIGN },
      body: JSON.stringify({ login: "csrf-login", role: "reader" }),
    });
    expect(res.status).toBe(403);
    expect(await csrfCode(res)).toBe("csrf-origin-mismatch");
  });

  it("csrfOriginAllowed unit matrix: only the API's own origin", () => {
    expect(csrfOriginAllowed(API_ORIGIN, undefined, API_ORIGIN)).toBe(true);
    expect(csrfOriginAllowed(SITE, undefined, API_ORIGIN)).toBe(false);
    expect(csrfOriginAllowed(undefined, `${API_ORIGIN}/x`, API_ORIGIN)).toBe(true);
    expect(csrfOriginAllowed(undefined, `${FOREIGN}/x`, API_ORIGIN)).toBe(false);
    expect(csrfOriginAllowed(undefined, undefined, API_ORIGIN)).toBe(false);
    expect(csrfOriginAllowed("null", undefined, API_ORIGIN)).toBe(false);
  });
});

describe("session cookie attributes are fixed (ADR-0019 §2)", () => {
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

  it("is always HttpOnly; Secure; SameSite=Lax", async () => {
    h = await makeHarness();
    const cookie = await loginSetCookie();
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
  });

  it("stays SameSite=Lax under a base path", async () => {
    h = await makeHarness({ config: { basePath: "/my-book" } });
    const res = await h.app.request("/my-book/v1/dev/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: API_ORIGIN },
      body: JSON.stringify({ login: "cookie-user", role: "reader" }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });
});

describe("base path (ADR-0019 §6)", () => {
  describe("normalizeBasePath", () => {
    it.each([
      [undefined, ""],
      ["", ""],
      ["/", ""],
      ["  ", ""],
      ["/my-book", "/my-book"],
      ["/my-book/", "/my-book"],
      ["/my-book///", "/my-book"],
      ["/books/hollow-creek", "/books/hollow-creek"],
      [" /my-book ", "/my-book"],
    ])("normalizes %s → %s", (input, expected) => {
      expect(normalizeBasePath(input)).toBe(expected);
    });

    it.each([
      "https://api.example/my-book",
      "http://api.example",
      "my-book",
      "/my book",
      "/my-book?x=1",
      "/my-book#frag",
      "/../etc",
      "/my-book/../..",
      "//evil.example",
      "/my//book",
      "/-leading-dash",
    ])("rejects %s at boot", (value) => {
      expect(() => normalizeBasePath(value)).toThrow();
    });

    it("configFromBindings validates API_BASE_PATH at boot", () => {
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
      expect(configFromBindings(bindings).basePath).toBe("");
      expect(
        configFromBindings({ ...bindings, API_BASE_PATH: "/my-book/" }).basePath,
      ).toBe("/my-book");
      expect(() =>
        configFromBindings({ ...bindings, API_BASE_PATH: "https://api.example" }),
      ).toThrow(/API_BASE_PATH/);
    });
  });

  describe("routing", () => {
    let h: TestHarness;
    afterEach(() => h.close());

    it("serves every route under the prefix and nothing at the root", async () => {
      h = await makeHarness({ config: { basePath: "/my-book" } });
      const unauth = await h.app.request("/my-book/v1/me");
      expect(unauth.status).toBe(401);
      // The un-prefixed path is simply not routed.
      expect((await h.app.request("/v1/me")).status).toBe(404);
    });

    it("runs the full authenticated request pipeline under the prefix", async () => {
      h = await makeHarness({ config: { basePath: "/my-book" } });
      const login = await h.app.request("/my-book/v1/dev/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: API_ORIGIN },
        body: JSON.stringify({ login: "base-path-user", role: "contributor" }),
      });
      expect(login.status).toBe(200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;

      const me = await h.app.request("/my-book/v1/me", { headers: { Cookie: cookie } });
      expect(me.status).toBe(200);
      expect(me.headers.get("x-correlation-id")).not.toBeNull();

      const created = await h.app.request(
        `/my-book/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
        jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie, Origin: API_ORIGIN }),
      );
      expect(created.status).toBe(202);
      expect(corsHeaders(created)).toEqual([]);
    });

    it("still enforces CSRF under the prefix", async () => {
      h = await makeHarness({ config: { basePath: "/my-book" } });
      const login = await h.app.request("/my-book/v1/dev/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: API_ORIGIN },
        body: JSON.stringify({ login: "base-path-csrf", role: "contributor" }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const res = await h.app.request(
        `/my-book/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
        jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie, Origin: FOREIGN }),
      );
      expect(res.status).toBe(403);
    });

    it("supports a multi-segment prefix", async () => {
      h = await makeHarness({ config: { basePath: "/books/hollow-creek" } });
      expect((await h.app.request("/books/hollow-creek/v1/me")).status).toBe(401);
      expect((await h.app.request("/books/v1/me")).status).toBe(404);
    });

    it('treats "/" as no prefix', async () => {
      h = await makeHarness({ config: { basePath: "/" } });
      expect((await h.app.request("/v1/me")).status).toBe(401);
    });
  });
});

describe("OAuth return_to (github mode, ADR-0019 §4)", () => {
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

  async function makeGithubHarness(basePath?: string): Promise<GithubHarness> {
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, MIGRATIONS_DIR);
    const api = createApi({
      db,
      config: baseConfig({
        authMode: "github",
        ...(basePath !== undefined ? { basePath } : {}),
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
    prefix = "",
  ): Promise<{ response: Response; stateCookie: string | null; state: string | null }> {
    const query = returnTo !== undefined ? `?return_to=${encodeURIComponent(returnTo)}` : "";
    const response = await g.api.app.request(`${prefix}/v1/auth/github${query}`);
    const setCookie = response.headers.get("set-cookie");
    const stateCookie =
      setCookie !== null && setCookie.includes("authorbot_oauth_state=")
        ? (setCookie.split(";")[0] as string)
        : null;
    const location = response.headers.get("location");
    const state = location !== null ? new URL(location).searchParams.get("state") : null;
    return { response, stateCookie, state };
  }

  it("propagates a same-origin return_to through the signed state cookie", async () => {
    const g = await makeGithubHarness();
    try {
      // Hono#request builds requests against http://localhost - the API's own
      // origin, which under ADR-0019 is also the site's.
      const target = `${API_ORIGIN}/chapters/baseline#annotate`;
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
      const sessionCookie = callback.headers.get("set-cookie") ?? "";
      expect(sessionCookie).toContain("authorbot_session=");
      expect(sessionCookie).toContain("SameSite=Lax");
      expect(sessionCookie).not.toContain("SameSite=None");
    } finally {
      g.close();
    }
  });

  it("redirects to / when no return_to was given", async () => {
    const g = await makeGithubHarness();
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
    ["a formerly-allowed cross-origin site", `${SITE}/chapters/baseline`],
    ["subdomain-suffix open redirect", "http://localhost.evil.com/phish"],
    ["userinfo open redirect", "http://localhost@evil.com/phish"],
    ["backslash authority trick", "http://localhost\\@evil.com/phish"],
    ["scheme-relative URL", "//evil.example/phish"],
    ["relative path", "/chapters/baseline"],
    ["own origin without boundary", "http://localhostzz"],
  ])("rejects %s with 400 validation-failed", async (_name, attempt) => {
    const g = await makeGithubHarness();
    try {
      const { response } = await startOauth(g, attempt);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("validation-failed");
    } finally {
      g.close();
    }
  });

  it("runs the whole OAuth flow under a base path", async () => {
    const g = await makeGithubHarness("/my-book");
    try {
      const target = `${API_ORIGIN}/my-book/chapters/baseline/`;
      const { response, stateCookie, state } = await startOauth(g, target, "/my-book");
      expect(response.status).toBe(302);
      const callback = await g.api.app.request(
        `/my-book/v1/auth/github/callback?code=fake-code&state=${encodeURIComponent(state as string)}`,
        { headers: { Cookie: stateCookie as string } },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(target);
    } finally {
      g.close();
    }
  });

  it("still rejects a state mismatch", async () => {
    const g = await makeGithubHarness();
    try {
      const { stateCookie } = await startOauth(g, `${API_ORIGIN}/x`);
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
    const g = await makeGithubHarness();
    try {
      const { stateCookie, state } = await startOauth(g, `${API_ORIGIN}/x`);
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
  it.each([
    [`${API}`, true],
    [`${API}/`, true],
    [`${API}/chapters/one?x=1#frag`, true],
    [`${API}/my-book/chapters/one`, true],
    [`${API}zz/path`, false],
    [`${SITE}/`, false],
    [`${FOREIGN}/`, false],
    ["http://localhost:4321/ch/2", false],
    ["javascript:alert(1)", false],
    ["HTTP://API.EXAMPLE/path", false], // not a literal origin prefix - conservative
  ])("%s → %s", (value, expected) => {
    expect(isValidReturnTo(value, API)).toBe(expected);
  });
});
