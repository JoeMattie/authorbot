/**
 * The GitHub App manifest flow (Phase 6 contract §4 and §6).
 *
 * These run against a **real** loopback server on 127.0.0.1 with a fake
 * browser that fetches the start page, reads the manifest out of the form, and
 * calls the declared `redirect_url` — exactly as a browser would. That is what
 * makes the assertions about the unpredictable path, the `state` round trip,
 * and the redirect wiring mean something: they are observed from outside,
 * rather than read back out of the implementation.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  buildSubmitPage,
  convertManifestCode,
  runManifestFlow,
  withDeadline,
  type ManifestFlowDeps,
  type ManifestFlowOptions,
} from "../src/github/manifest-flow.js";
import { createAppJwt, waitForInstallation } from "../src/github/installation.js";
import { NodeLoopbackServerFactory } from "../src/runtime/node-ports.js";
import { TimeoutError, WizardError } from "../src/errors.js";
import type { LoopbackServer, LoopbackServerFactory } from "../src/ports.js";
import {
  FakeBrowser,
  FakeClock,
  FakeHttpClient,
  SeededRandom,
  fakeGitHub,
  manifestBrowser,
  testKeyPair,
} from "./fakes.js";

const OPTIONS: ManifestFlowOptions = {
  appName: "My Book",
  siteUrl: "https://my-book.workers.dev",
  callbackUrl: "https://my-book.workers.dev/v1/auth/github/callback",
  webhookUrl: "https://my-book.workers.dev/v1/webhooks/github",
  webhookSecret: "proposed-webhook-secret-value",
  timeoutMs: 60_000,
};

/**
 * Wraps the real factory so a test can assert the server was closed — the
 * contract requires shutdown on *every* exit path, and "we wrote a finally"
 * is not the same claim as "the listener is gone".
 */
class TrackingLoopback implements LoopbackServerFactory {
  readonly started: LoopbackServer[] = [];
  readonly closed: string[] = [];
  readonly #inner = new NodeLoopbackServerFactory();

  async start(
    handler: Parameters<LoopbackServerFactory["start"]>[0],
  ): Promise<LoopbackServer> {
    const server = await this.#inner.start(handler);
    const tracked: LoopbackServer = {
      origin: server.origin,
      close: async () => {
        this.closed.push(server.origin);
        await server.close();
      },
    };
    this.started.push(tracked);
    return tracked;
  }

  /** True when every server that was started has also been closed. */
  allClosed(): boolean {
    return this.started.every((server) => this.closed.includes(server.origin));
  }
}

let loopback: TrackingLoopback;

afterEach(async () => {
  // Belt and braces: if an assertion failed before shutdown, do not leak a
  // listener into the next test.
  for (const server of loopback?.started ?? []) {
    await server.close();
  }
});

function deps(github: ReturnType<typeof fakeGitHub>, browser: FakeBrowser): ManifestFlowDeps {
  loopback = new TrackingLoopback();
  return {
    loopback,
    browser,
    http: github.client,
    clock: new FakeClock(),
    random: new SeededRandom(),
    githubApiBase: github.apiBase,
    githubWebBase: github.webBase,
  };
}

describe("the manifest itself", () => {
  const manifest = buildManifest(OPTIONS, "http://127.0.0.1:5555/abc");

  it("asks for the narrowest permissions that do the job", () => {
    expect(manifest["default_permissions"]).toEqual({ contents: "write", metadata: "read" });
    expect(manifest["default_events"]).toEqual(["push"]);
  });

  it("requests OAuth on install, which is what replaces the separate OAuth App", () => {
    expect(manifest["request_oauth_on_install"]).toBe(true);
  });

  it("sends the creation code to the loopback and readers to the site", () => {
    // Confusing these two is the classic way to make this flow hang: the app
    // would be created and the code would go to production.
    expect(manifest["redirect_url"]).toBe("http://127.0.0.1:5555/abc");
    expect(manifest["callback_urls"]).toEqual([OPTIONS.callbackUrl]);
  });

  it("keeps everything on the book's own origin (ADR-0019)", () => {
    const origin = new URL(OPTIONS.siteUrl).origin;
    expect(String(manifest["url"]).startsWith(origin)).toBe(true);
    expect((manifest["hook_attributes"] as { url: string }).url.startsWith(origin)).toBe(true);
    expect(String((manifest["callback_urls"] as string[])[0]).startsWith(origin)).toBe(true);
  });
});

describe("the submit page", () => {
  it("posts to GitHub with the state in the query", () => {
    const page = buildSubmitPage({ name: "x" }, "st4te", "https://github.test");
    expect(page).toContain('method="post"');
    expect(page).toContain("https://github.test/settings/apps/new?state=st4te");
  });

  it("escapes the manifest so a title cannot break out of the attribute", () => {
    const page = buildSubmitPage({ name: '"><script>alert(1)</script>' }, "s", "https://github.test");
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&quot;");
  });

  it("works without JavaScript, via a focused submit button", () => {
    const page = buildSubmitPage({ name: "x" }, "s", "https://github.test");
    expect(page).toContain('<button type="submit" autofocus>');
  });
});

describe("runManifestFlow", () => {
  it("completes the round trip and returns the credentials", async () => {
    const github = fakeGitHub();
    const browser = manifestBrowser({ code: "one-time-code" });
    const flowDeps = deps(github, browser);

    const result = await runManifestFlow(flowDeps, OPTIONS);

    expect(result.appId).toBe("424242");
    expect(result.clientId).toBe("Iv1.fake_client_id");
    expect(result.clientSecret).toBe(github.secrets.clientSecret);
    expect(result.pem).toBe(github.secrets.pem);
    expect(result.webhookSecret).toBe(github.secrets.webhookSecret);
    expect(loopback.allClosed()).toBe(true);
  });

  it("binds to loopback only, on an unguessable path", async () => {
    const github = fakeGitHub();
    const browser = manifestBrowser({ code: "c" });
    const flowDeps = deps(github, browser);
    let startUrl = "";

    await runManifestFlow(flowDeps, { ...OPTIONS, onBrowserStep: (url) => (startUrl = url) });

    const url = new URL(startUrl);
    expect(url.hostname).toBe("127.0.0.1");
    // Long enough that another local process cannot guess where to POST.
    expect(url.pathname.length).toBeGreaterThan(20);
    expect(url.pathname).toMatch(/^\/[A-Za-z0-9_-]+$/);
  });

  it("uses a different state and different paths on every run", async () => {
    const seen = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const github = fakeGitHub();
      const browser = manifestBrowser({ code: "c" });
      const flowDeps: ManifestFlowDeps = {
        ...deps(github, browser),
        // A fresh generator each run; the values must still differ, because
        // they come from separate draws rather than a fixed constant.
        random: new SeededRandom(BigInt(index + 1) * 0x1234567n),
      };
      let startUrl = "";
      await runManifestFlow(flowDeps, { ...OPTIONS, onBrowserStep: (url) => (startUrl = url) });
      seen.add(new URL(startUrl).pathname);
    }
    expect(seen.size).toBe(3);
  });

  it("refuses a callback whose state does not match, and shuts down", async () => {
    const github = fakeGitHub();
    const browser = manifestBrowser({ code: "c", stateOverride: "not-the-right-state" });
    const flowDeps = deps(github, browser);

    await expect(runManifestFlow(flowDeps, OPTIONS)).rejects.toThrow(
      /security token that does not match/i,
    );
    expect(loopback.allClosed()).toBe(true);
    // Nothing was exchanged: a code of unknown provenance is never spent.
    expect(github.client.requests.filter((r) => r.url.includes("conversions"))).toHaveLength(0);
  });

  it("times out with an actionable message, and shuts down", async () => {
    const github = fakeGitHub();
    const browser = manifestBrowser({ code: "c", neverCallBack: true });
    const flowDeps = deps(github, browser);

    const error = await runManifestFlow(flowDeps, { ...OPTIONS, timeoutMs: 5_000 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).nextAction).toMatch(/approve the app/i);
    expect((error as TimeoutError).nextAction).toMatch(/Nothing has been created yet/i);
    expect(loopback.allClosed()).toBe(true);
  });

  it("shuts down even when the exchange itself fails", async () => {
    const github = fakeGitHub({ conversionStatus: 503 });
    const browser = manifestBrowser({ code: "c" });
    const flowDeps = deps(github, browser);

    await expect(runManifestFlow(flowDeps, OPTIONS)).rejects.toThrow(WizardError);
    expect(loopback.allClosed()).toBe(true);
  });

  it("serves 404 on any path other than the two it owns", async () => {
    const github = fakeGitHub();
    const browser = new FakeBrowser();
    let probe = 404;
    browser.onOpen(async (url) => {
      const origin = new URL(url).origin;
      probe = (await fetch(`${origin}/some-other-path`)).status;
      // Then complete the flow so the test does not hang until the deadline.
      const page = await fetch(url);
      const html = await page.text();
      const manifest = JSON.parse(
        (/name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "{}").replace(/&quot;/g, '"'),
      ) as { redirect_url: string };
      const state = new URL(
        (/action="([^"]+)"/.exec(html)?.[1] ?? "").replace(/&amp;/g, "&"),
      ).searchParams.get("state");
      await fetch(`${manifest.redirect_url}?code=c&state=${String(state)}`);
    });

    await runManifestFlow(deps(github, browser), OPTIONS);
    expect(probe).toBe(404);
  });
});

describe("convertManifestCode", () => {
  it("explains an expired or reused code rather than retrying it", async () => {
    const github = fakeGitHub({ acceptCode: (code) => code === "good" });
    const error = await convertManifestCode(github.client, github.apiBase, "stale").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(WizardError);
    expect((error as WizardError).message).toMatch(/already been used, or it expired/i);
  });

  it("points at the status page on a 5xx", async () => {
    const github = fakeGitHub({ conversionStatus: 502 });
    const error = await convertManifestCode(github.client, github.apiBase, "c").catch(
      (e: unknown) => e,
    );
    expect((error as WizardError).nextAction).toMatch(/githubstatus/i);
  });

  it("never puts the response body into an error when a field is missing", async () => {
    const client = new FakeHttpClient().route(/conversions/, () => ({
      status: 201,
      headers: {},
      // Everything present except `id` — the body still carries real secrets.
      body: JSON.stringify({
        slug: "s",
        html_url: "https://github.test/apps/s",
        client_id: "Iv1.x",
        client_secret: "SUPER-SECRET-CLIENT-SECRET",
        webhook_secret: "SUPER-SECRET-WEBHOOK",
        pem: "SUPER-SECRET-PEM",
      }),
    }));
    const error = await convertManifestCode(client, "https://api.github.test", "c").catch(
      (e: unknown) => e,
    );
    const text = `${(error as WizardError).message}\n${(error as WizardError).nextAction}`;
    expect(text).not.toContain("SUPER-SECRET-CLIENT-SECRET");
    expect(text).not.toContain("SUPER-SECRET-PEM");
    expect(text).not.toContain("SUPER-SECRET-WEBHOOK");
  });
});

describe("withDeadline", () => {
  it("returns the value when it arrives in time", async () => {
    const clock = new FakeClock();
    await expect(
      withDeadline(clock, Promise.resolve("ok"), 1_000, () => new Error("late")),
    ).resolves.toBe("ok");
  });

  it("throws the caller's error when it does not", async () => {
    const clock = new FakeClock();
    await expect(
      withDeadline(clock, new Promise<string>(() => {}), 10, () => new Error("late")),
    ).rejects.toThrow("late");
  });
});

describe("createAppJwt", () => {
  it("produces three base64url segments GitHub can read", () => {
    const { privateKey } = testKeyPair();
    const jwt = createAppJwt("424242", privateKey, 1_800_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString()) as {
      alg: string;
    };
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString()) as {
      iat: number;
      exp: number;
      iss: string;
    };
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe("424242");
    // Backdated, because a laptop clock running fast makes GitHub reject it.
    expect(payload.iat).toBeLessThan(1_800_000_000);
    // Inside GitHub's ten-minute ceiling.
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
  });

  it("never quotes the key material in the error from an unusable key", () => {
    const error = (() => {
      try {
        createAppJwt("1", "-----BEGIN PRIVATE KEY-----\nNOT-A-KEY-BUT-SECRET\n-----END PRIVATE KEY-----", 1);
        return null;
      } catch (e) {
        return e as WizardError;
      }
    })();
    expect(error).toBeInstanceOf(WizardError);
    expect(`${error?.message}${error?.nextAction}`).not.toContain("NOT-A-KEY-BUT-SECRET");
  });
});

describe("waitForInstallation", () => {
  it("polls until the app appears on the repository", async () => {
    const github = fakeGitHub({ installAfterAttempts: 3 });
    const clock = new FakeClock();
    const id = await waitForInstallation(github.client, clock, {
      appId: "424242",
      pem: testKeyPair().privateKey,
      repo: "novelist/my-book",
      apiBase: github.apiBase,
      timeoutMs: 60_000,
      intervalMs: 100,
      installUrl: "https://github.test/apps/x/installations/new",
    });
    expect(id).toBe("777777");
    expect(github.installationAttempts()).toBe(4);
  });

  it("re-mints the JWT on every attempt, so a long wait cannot expire it", async () => {
    const github = fakeGitHub({ installAfterAttempts: 2 });
    // Poll slowly enough that the second hand moves between attempts: the
    // JWT's `iat` has second resolution, so a faster poll would re-mint an
    // identical token and the assertion would prove nothing.
    const clock = new FakeClock();
    await waitForInstallation(github.client, clock, {
      appId: "424242",
      pem: testKeyPair().privateKey,
      repo: "novelist/my-book",
      apiBase: github.apiBase,
      timeoutMs: 60_000,
      intervalMs: 1_500,
      installUrl: "https://github.test/x",
    });
    const auths = github.client.requests
      .filter((request) => request.url.includes("/installation"))
      .map((request) => request.init.headers?.["authorization"]);
    expect(auths).toHaveLength(3);
    expect(new Set(auths).size).toBeGreaterThan(1);
  });

  it("times out naming the install page", async () => {
    const github = fakeGitHub({ installAfterAttempts: 1_000_000 });
    const clock = new FakeClock();
    const error = await waitForInstallation(github.client, clock, {
      appId: "424242",
      pem: testKeyPair().privateKey,
      repo: "novelist/my-book",
      apiBase: github.apiBase,
      timeoutMs: 1_000,
      intervalMs: 100,
      installUrl: "https://github.test/apps/x/installations/new",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).nextAction).toContain("installations/new");
  });

  it("refuses a repository name that is not owner/repo", async () => {
    const github = fakeGitHub();
    await expect(
      waitForInstallation(github.client, new FakeClock(), {
        appId: "1",
        pem: testKeyPair().privateKey,
        repo: "not-a-full-name",
        apiBase: github.apiBase,
        timeoutMs: 1_000,
        installUrl: "https://github.test/x",
      }),
    ).rejects.toThrow(/owner\/repository/);
  });
});
