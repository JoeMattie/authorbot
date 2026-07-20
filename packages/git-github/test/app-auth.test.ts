/**
 * Tests for the GitHub App auth layer (Phase 5 contract §2).
 *
 * The RSA key pair is generated with WebCrypto in `beforeAll` rather than
 * checked in: a committed private key — even a throwaway one — is the kind of
 * fixture that gets copied into a real deployment, and generating it here also
 * proves the PEM round trip (export PKCS#8 → wrap → parse → import → sign →
 * verify against the matching public key) end to end, which a fixture cannot.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  APP_JWT_SKEW_SECONDS,
  APP_JWT_TTL_SECONDS,
  createAppJwt,
  decodeJwtClaims,
  getGitHubAppAuth,
  GitHubAppAuth,
  GitHubAuthError,
  importAppPrivateKey,
  pkcs8PemToDer,
  readGitHubAppCredentialResult,
  readGitHubAppCredentials,
  resetGitHubAppAuthCache,
  scrubSecrets,
  TOKEN_REFRESH_MARGIN_MS,
  type GitHubAppCredentials,
  type SigningKey,
} from "../src/app-auth.js";
import { createFakeGitHub, type FakeGitHub } from "../src/testing/index.js";

const APP_ID = "1000001";
const INSTALLATION_ID = "12345678";

let privateKeyPem: string;
let publicKey: SigningKey;

function toPem(der: ArrayBuffer, label: string): string {
  let binary = "";
  for (const byte of new Uint8Array(der)) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as { privateKey: SigningKey; publicKey: SigningKey };
  privateKeyPem = toPem(await crypto.subtle.exportKey("pkcs8", pair.privateKey), "PRIVATE KEY");
  publicKey = pair.publicKey;
});

function credentials(): GitHubAppCredentials {
  return { appId: APP_ID, privateKeyPem, installationId: INSTALLATION_ID };
}

/** A clock the test moves by hand; no timers, no flakiness. */
function clock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const T0 = Date.parse("2026-07-20T09:00:00.000Z");

async function makeFake(options: Parameters<typeof createFakeGitHub>[0] = {}): Promise<FakeGitHub> {
  return createFakeGitHub({ appId: APP_ID, installationId: INSTALLATION_ID, ...options });
}

describe("credential configuration", () => {
  it("reports unconfigured when nothing is set — today's live behaviour", () => {
    const result = readGitHubAppCredentialResult({});
    expect(result.status).toBe("unconfigured");
    expect(readGitHubAppCredentials({})).toBeNull();
  });

  it("treats blank strings as absent", () => {
    const env = { GITHUB_APP_ID: "  ", GITHUB_APP_PRIVATE_KEY: "", GITHUB_INSTALLATION_ID: "\n" };
    expect(readGitHubAppCredentialResult(env).status).toBe("unconfigured");
    expect(readGitHubAppCredentials(env)).toBeNull();
  });

  it("distinguishes a partial configuration from an absent one", () => {
    const result = readGitHubAppCredentialResult({
      GITHUB_APP_ID: APP_ID,
      GITHUB_INSTALLATION_ID: INSTALLATION_ID,
    });
    expect(result.status).toBe("incomplete");
    expect(result.status === "incomplete" && result.missing).toEqual(["GITHUB_APP_PRIVATE_KEY"]);
    // Still no credentials: a half-configured app must not half-work.
    expect(
      readGitHubAppCredentials({ GITHUB_APP_ID: APP_ID, GITHUB_INSTALLATION_ID: INSTALLATION_ID }),
    ).toBeNull();
  });

  it("returns credentials when all three are present, trimming ids but not the key", () => {
    const result = readGitHubAppCredentials({
      GITHUB_APP_ID: ` ${APP_ID} `,
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      GITHUB_INSTALLATION_ID: ` ${INSTALLATION_ID}\n`,
    });
    expect(result).toEqual({
      appId: APP_ID,
      privateKeyPem,
      installationId: INSTALLATION_ID,
    });
  });
});

describe("PKCS#8 PEM parsing", () => {
  it("parses a well-formed PKCS#8 PEM", () => {
    expect(pkcs8PemToDer(privateKeyPem).length).toBeGreaterThan(100);
  });

  it("accepts a PEM whose newlines were escaped by a secret store", () => {
    const escaped = privateKeyPem.replace(/\n/g, "\\n");
    expect(pkcs8PemToDer(escaped)).toEqual(pkcs8PemToDer(privateKeyPem));
  });

  it("names the fix for a PKCS#1 key rather than failing opaquely", () => {
    const pkcs1 = privateKeyPem
      .replace("BEGIN PRIVATE KEY", "BEGIN RSA PRIVATE KEY")
      .replace("END PRIVATE KEY", "END RSA PRIVATE KEY");
    try {
      pkcs8PemToDer(pkcs1);
      expect.unreachable("expected a GitHubAuthError");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubAuthError);
      const authError = error as GitHubAuthError;
      expect(authError.code).toBe("invalid-private-key");
      expect(authError.message).toContain("openssl pkcs8 -topk8");
      // The key body must not travel with the advice.
      expect(authError.message).not.toContain(pkcs1.split("\n")[1]);
    }
  });

  it("rejects text that is not a PEM at all", () => {
    expect(() => pkcs8PemToDer("not a key")).toThrowError(GitHubAuthError);
  });

  it("never echoes key material in the error", () => {
    const body = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    try {
      pkcs8PemToDer(`-----BEGIN PRIVATE KEY-----\n${body}!!!\n-----END PRIVATE KEY-----`);
    } catch (error) {
      expect((error as Error).message).not.toContain(body);
    }
  });

  it("rejects a key WebCrypto cannot import", async () => {
    const fake = `-----BEGIN PRIVATE KEY-----\nAAECAwQFBgcICQoLDA0ODw==\n-----END PRIVATE KEY-----`;
    await expect(importAppPrivateKey(fake)).rejects.toThrowError(GitHubAuthError);
  });
});

describe("app JWT", () => {
  it("is RS256, backdated 60s, and expires in 9 minutes", async () => {
    const key = await importAppPrivateKey(privateKeyPem);
    const jwt = await createAppJwt(key, APP_ID, T0);
    const [encodedHeader] = jwt.split(".");
    const header = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob((encodedHeader as string).replace(/-/g, "+").replace(/_/g, "/")), (c) =>
          c.charCodeAt(0),
        ),
      ),
    ) as { alg: string; typ: string };
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const claims = decodeJwtClaims(jwt);
    const seconds = Math.floor(T0 / 1000);
    expect(claims.iss).toBe(APP_ID);
    expect(claims.iat).toBe(seconds - APP_JWT_SKEW_SECONDS);
    expect(claims.exp).toBe(seconds + APP_JWT_TTL_SECONDS);
    // GitHub rejects a JWT expiring more than 10 minutes from *its* clock.
    // The backdated `iat` widens the token's nominal span to exactly 600s, so
    // the limit that matters is measured from now, not from `iat`.
    expect(claims.exp - seconds).toBeLessThan(600);
  });

  it("carries a signature the matching public key verifies", async () => {
    const key = await importAppPrivateKey(privateKeyPem);
    const jwt = await createAppJwt(key, APP_ID, T0);
    const [header, payload, signature] = jwt.split(".");
    const signed = new TextEncoder().encode(`${header}.${payload}`);
    const bytes = Uint8Array.from(
      atob((signature as string).replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    await expect(
      crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, bytes, signed),
    ).resolves.toBe(true);
  });

  it("is base64url with no padding", async () => {
    const key = await importAppPrivateKey(privateKeyPem);
    const jwt = await createAppJwt(key, APP_ID, T0);
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("installation tokens", () => {
  it("mints one token and caches it across calls", async () => {
    const fake = await makeFake();
    const time = clock(T0);
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch, now: time.now });

    const first = await auth.installationToken();
    const second = await auth.installationToken();

    expect(second).toBe(first);
    expect(fake.issuedTokenCount()).toBe(1);
    expect(auth.tokenCacheInfo().fresh).toBe(true);
  });

  it("presents an app JWT — not an installation token — to the token endpoint", async () => {
    // The fake enforces `requireAppJwt` by default; a non-JWT bearer 401s.
    const fake = await makeFake();
    const auth = new GitHubAppAuth(credentials(), {
      fetchImpl: fake.fetch,
      now: clock(T0).now,
    });
    await expect(auth.installationToken()).resolves.toMatch(/^ghs_/);
  });

  it("refreshes 5 minutes before expiry, not at expiry", async () => {
    const time = clock(T0);
    // The fake stamps `expires_at` from its own clock, so it must share ours.
    const fake = await makeFake({ tokenTtlSeconds: 3600, now: time.now });
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch, now: time.now });

    const first = await auth.installationToken();
    // One second before the margin opens: still cached.
    time.advance(3600_000 - TOKEN_REFRESH_MARGIN_MS - 1000);
    expect(await auth.installationToken()).toBe(first);
    expect(fake.issuedTokenCount()).toBe(1);

    // Crossing into the margin mints a new one, while the old is still valid.
    time.advance(2000);
    const second = await auth.installationToken();
    expect(second).not.toBe(first);
    expect(fake.issuedTokenCount()).toBe(2);
  });

  it("mints once when many callers race a cold cache", async () => {
    const fake = await makeFake();
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch, now: clock(T0).now });

    const tokens = await Promise.all(Array.from({ length: 8 }, () => auth.installationToken()));

    expect(new Set(tokens).size).toBe(1);
    expect(fake.issuedTokenCount()).toBe(1);
  });

  it("mints again after forceRefresh", async () => {
    const fake = await makeFake();
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch, now: clock(T0).now });
    const first = await auth.installationToken();
    const second = await auth.installationToken({ forceRefresh: true });
    expect(second).not.toBe(first);
    expect(fake.issuedTokenCount()).toBe(2);
  });

  it("exposes the writer's token seam under getInstallationToken", async () => {
    const fake = await makeFake();
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch, now: clock(T0).now });
    const { getInstallationToken } = auth; // bound, so destructuring is safe
    await expect(getInstallationToken()).resolves.toMatch(/^ghs_/);
    await expect(getInstallationToken({ forceRefresh: true })).resolves.toMatch(/^ghs_/);
    expect(fake.issuedTokenCount()).toBe(2);
  });

  it("surfaces a token-endpoint failure without leaking anything", async () => {
    const fake = await makeFake({
      faults: { installationTokenFailure: { status: 401, message: "Bad credentials" } },
    });
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch, now: clock(T0).now });

    await expect(auth.installationToken()).rejects.toMatchObject({
      name: "GitHubAuthError",
      code: "token-request-failed",
      status: 401,
    });
    expect(auth.tokenCacheInfo().cached).toBe(false);
    fake.assertAllFaultsFired();
  });

  it("rejects a malformed token response instead of caching junk", async () => {
    const auth = new GitHubAppAuth(credentials(), {
      now: clock(T0).now,
      fetchImpl: async () =>
        new Response(JSON.stringify({ token: "ghs_whatever0000" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(auth.installationToken()).rejects.toMatchObject({
      code: "malformed-token-response",
    });
    expect(auth.tokenCacheInfo().cached).toBe(false);
  });

  it("keeps rejecting a bad key with the same typed error, never a stale promise", async () => {
    const fake = await makeFake();
    const auth = new GitHubAppAuth(
      {
        appId: APP_ID,
        installationId: INSTALLATION_ID,
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nAAECAwQ=\n-----END PRIVATE KEY-----",
      },
      { fetchImpl: fake.fetch, now: clock(T0).now },
    );

    // A cached *rejected* promise would make every later call reuse a settled
    // rejection — the same symptom, but unrecoverable and impossible to
    // instrument. Both calls must go through the import path afresh.
    await expect(auth.appJwt()).rejects.toMatchObject({ code: "invalid-private-key" });
    await expect(auth.appJwt()).rejects.toMatchObject({ code: "invalid-private-key" });
    expect(fake.issuedTokenCount()).toBe(0);

    // A corrected secret produces a new isolate/instance, which works.
    const fixed = new GitHubAppAuth(credentials(), {
      fetchImpl: fake.fetch,
      now: clock(T0).now,
    });
    await expect(fixed.installationToken()).resolves.toMatch(/^ghs_/);
  });
});

describe("authorizedFetch", () => {
  it("attaches the token and GitHub's required headers", async () => {
    const seen: Headers[] = [];
    const fake = await makeFake();
    const auth = new GitHubAppAuth(credentials(), {
      now: clock(T0).now,
      fetchImpl: async (input, init) => {
        seen.push(new Headers(init?.headers));
        return fake.fetch(input, init);
      },
    });

    const response = await auth.authorizedFetch(
      `https://api.github.com/repos/${fake.fullName}`,
    );

    expect(response.status).toBe(200);
    const headers = seen.at(-1) as Headers;
    expect(headers.get("authorization")).toMatch(/^Bearer ghs_/);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("authorbot/0.1");
  });

  it("overrides a caller-supplied Authorization header", async () => {
    const seen: Headers[] = [];
    const fake = await makeFake();
    const auth = new GitHubAppAuth(credentials(), {
      now: clock(T0).now,
      fetchImpl: async (input, init) => {
        seen.push(new Headers(init?.headers));
        return fake.fetch(input, init);
      },
    });

    await auth.authorizedFetch(`https://api.github.com/repos/${fake.fullName}`, {
      headers: { authorization: "Bearer stale-token" },
    });

    expect((seen.at(-1) as Headers).get("authorization")).not.toContain("stale-token");
  });

  it("refreshes once on 401 and retries the request", async () => {
    const fake = await makeFake();
    const auth = new GitHubAppAuth(credentials(), { fetchImpl: fake.fetch, now: clock(T0).now });

    // Warm the cache, then invalidate server-side as a rotation would.
    await auth.installationToken();
    fake.revokeAllTokens();

    const response = await auth.authorizedFetch(`https://api.github.com/repos/${fake.fullName}`);

    expect(response.status).toBe(200);
    expect(fake.issuedTokenCount()).toBe(2);
  });

  it("retries only once — a persistent 401 is returned, not looped", async () => {
    let calls = 0;
    const fake = await makeFake();
    const auth = new GitHubAppAuth(credentials(), {
      now: clock(T0).now,
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/repos/")) {
          calls += 1;
          return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
        }
        return fake.fetch(input, init);
      },
    });

    const response = await auth.authorizedFetch(`https://api.github.com/repos/${fake.fullName}`);

    expect(response.status).toBe(401);
    expect(calls).toBe(2);
  });

  it("does not retry when the body cannot be replayed", async () => {
    let calls = 0;
    const auth = new GitHubAppAuth(credentials(), {
      now: clock(T0).now,
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("access_tokens")) {
          return new Response(
            JSON.stringify({ token: "ghs_fake0001", expires_at: new Date(T0 + 3600_000).toISOString() }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        calls += 1;
        return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      },
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const response = await auth.authorizedFetch("https://api.github.com/repos/a/b/git/blobs", {
      method: "POST",
      // `duplex` is required by undici for a stream body; it is not in the
      // lib types this package compiles against, hence the widening.
      ...({ body: stream, duplex: "half" } as unknown as RequestInit),
    });

    // Replaying a consumed stream would send an empty body — a wrong commit
    // is worse than a surfaced 401.
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
  });

  it("keeps a string body replayable across the retry", async () => {
    const bodies: (string | undefined)[] = [];
    const fake = await makeFake();
    const auth = new GitHubAppAuth(credentials(), {
      now: clock(T0).now,
      fetchImpl: async (input, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : undefined);
        return fake.fetch(input, init);
      },
    });
    await auth.installationToken();
    fake.revokeAllTokens();

    const response = await auth.authorizedFetch(
      `https://api.github.com/repos/${fake.fullName}/git/blobs`,
      { method: "POST", body: JSON.stringify({ content: "hi", encoding: "utf-8" }) },
    );

    expect(response.status).toBe(201);
    const sent = bodies.filter((body) => body !== undefined);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
  });
});

describe("secret hygiene", () => {
  it("scrubs tokens and key blocks from text", () => {
    expect(scrubSecrets("token ghs_abcdefgh12345678 leaked")).toBe(
      "token [redacted-token] leaked",
    );
    expect(scrubSecrets("pat github_pat_abcdefgh1234")).toBe("pat [redacted-token]");
    expect(scrubSecrets(privateKeyPem.trim())).toBe("[redacted-private-key]");
  });

  it("never lets a token reach a thrown error", async () => {
    // The token endpoint echoes the minted token back in an error body — a
    // hostile proxy or a future GitHub change could do this.
    const auth = new GitHubAppAuth(credentials(), {
      now: clock(T0).now,
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: "rejected token ghs_secret123456789" }), {
          status: 403,
        }),
    });

    await expect(auth.installationToken()).rejects.toSatisfy(
      (error: Error) =>
        !error.message.includes("ghs_secret123456789") &&
        error.message.includes("[redacted-token]"),
    );
  });

  it("contains no console call in the auth module", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../src/app-auth.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/console\./);
  });
});

describe("per-isolate cache", () => {
  beforeEach(() => {
    resetGitHubAppAuthCache();
  });

  it("returns the same instance for the same credentials", async () => {
    const fake = await makeFake();
    const options = { fetchImpl: fake.fetch, now: clock(T0).now };
    const first = getGitHubAppAuth(credentials(), options);
    const second = getGitHubAppAuth(credentials(), options);

    expect(second).toBe(first);
    // The point of sharing: one token for the whole isolate.
    await Promise.all([first.installationToken(), second.installationToken()]);
    expect(fake.issuedTokenCount()).toBe(1);
  });

  it("separates different installations", async () => {
    const fake = await makeFake();
    const options = { fetchImpl: fake.fetch, now: clock(T0).now };
    const first = getGitHubAppAuth(credentials(), options);
    const other = getGitHubAppAuth({ ...credentials(), installationId: "99" }, options);
    expect(other).not.toBe(first);
  });

  it("is cleared by resetGitHubAppAuthCache", async () => {
    const fake = await makeFake();
    const options = { fetchImpl: fake.fetch, now: clock(T0).now };
    const first = getGitHubAppAuth(credentials(), options);
    resetGitHubAppAuthCache();
    expect(getGitHubAppAuth(credentials(), options)).not.toBe(first);
  });
});
