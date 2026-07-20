import { afterEach, describe, expect, it } from "vitest";
import { devLogin, makeHarness, type TestHarness } from "./helpers.js";

describe("dev identity provider gating (contract §3, ADR 0015)", () => {
  let h: TestHarness;
  afterEach(() => h.close());

  it("mounts /v1/dev/login in dev mode and issues a working session", async () => {
    h = await makeHarness();
    const res = await h.app.request("/v1/dev/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "dave", role: "editor" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    const body = (await res.json()) as { membership: { role: string }; scopes: string[] };
    expect(body.membership.role).toBe("editor");
    expect(body.scopes).toContain("work:claim");
  });

  it("does NOT mount /v1/dev/login when AUTH_MODE=github (404 by construction)", async () => {
    h = await makeHarness({ githubMode: true });
    const res = await h.app.request("/v1/dev/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "dave", role: "maintainer" }),
    });
    expect(res.status).toBe(404);
  });

  it("github mode mounts the OAuth start route instead", async () => {
    h = await makeHarness({ githubMode: true });
    const res = await h.app.request("/v1/auth/github");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client");
    expect(res.headers.get("set-cookie")).toContain("authorbot_oauth_state");
  });

  it("dev mode does not mount the OAuth routes", async () => {
    h = await makeHarness();
    const res = await h.app.request("/v1/auth/github");
    expect(res.status).toBe(404);
  });

  it("re-login with a different role replaces the membership", async () => {
    h = await makeHarness();
    await devLogin(h, "flip", "reader");
    const cookie = await devLogin(h, "flip", "maintainer");
    const me = await h.app.request("/v1/me", { headers: { Cookie: cookie } });
    const body = (await me.json()) as { memberships: { role: string }[] };
    expect(body.memberships[0]?.role).toBe("maintainer");
  });

  it("validates the login shape", async () => {
    h = await makeHarness();
    const res = await h.app.request("/v1/dev/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "bad login!", role: "reader" }),
    });
    expect(res.status).toBe(400);
  });
});
