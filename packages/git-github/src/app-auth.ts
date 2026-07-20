/**
 * GitHub App authentication (Phase 5 contract §2, design §14.1).
 *
 * Worker-compatible throughout: the app JWT is signed with **WebCrypto**
 * (`crypto.subtle.importKey` on a PKCS#8 key + `RSASSA-PKCS1-v1_5`/SHA-256),
 * never `node:crypto`, and every request goes through an injectable `fetch`.
 * The clock is injectable too, so expiry, refresh margins and skew backdating
 * are tested deterministically rather than with timers.
 *
 * Credential rule (design §19.5, §20.6), enforced by tests:
 * **installation tokens and the app private key are never logged, never
 * persisted, and never appear in a thrown error, a response, or a task
 * bundle.** This module contains no `console` call at all, and every error it
 * raises is scrubbed of anything that looks like a token or key material
 * before it escapes.
 *
 * Absent credentials are not an error: `readGitHubAppCredentials` returns
 * `null` and the caller leaves Git integration disabled, which is what the
 * live deployment does today.
 */
import {
  GITHUB_ACCEPT,
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from "./constants.js";

/**
 * A WebCrypto key handle, named without relying on a DOM/Node global of that
 * name being in scope.
 * `lib: ES2022` has no DOM, and the Node and Workers type packages disagree
 * about whether the global exists, so the type is derived from the API that
 * produces it and stays correct in every one of them.
 */
export type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** App JWT lifetime. GitHub rejects anything over 10 minutes; §2 says 9. */
export const APP_JWT_TTL_SECONDS = 9 * 60;

/** `iat` is backdated this far to tolerate clock skew (§2). */
export const APP_JWT_SKEW_SECONDS = 60;

/** A cached installation token is replaced this long before it expires (§2). */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * A `fetch`-shaped function that has already attached credentials. The reader
 * and the writer take one of these rather than credentials, so neither ever
 * handles a token.
 */
export type AuthorizedFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The `fetch` implementation to talk to GitHub with (injectable for tests). */
export type FetchLike = (input: Request | string, init?: RequestInit) => Promise<Response>;

export interface GitHubAppCredentials {
  /** Numeric app id, as `GITHUB_APP_ID`. */
  appId: string;
  /** PKCS#8 PEM private key, as `GITHUB_APP_PRIVATE_KEY` (a secret). */
  privateKeyPem: string;
  /** Numeric installation id, as `GITHUB_INSTALLATION_ID`. */
  installationId: string;
}

export interface GitHubAppAuthOptions {
  /** Injected `fetch`; defaults to the global. */
  fetchImpl?: FetchLike;
  /** Injected clock in ms since epoch; defaults to `Date.now`. */
  now?: () => number;
  /** API origin; defaults to `https://api.github.com`. */
  apiOrigin?: string;
  /** `User-Agent` sent on every request. */
  userAgent?: string;
}

/** Names of the environment variables this module reads. */
export const GITHUB_APP_ENV_KEYS = {
  appId: "GITHUB_APP_ID",
  privateKeyPem: "GITHUB_APP_PRIVATE_KEY",
  installationId: "GITHUB_INSTALLATION_ID",
} as const;

export type GitHubCredentialStatus =
  | "configured"
  | "unconfigured"
  | "incomplete"
  | "invalid";

export type GitHubAppCredentialResult =
  | { status: "configured"; credentials: GitHubAppCredentials }
  /** None of the three variables is set — Git integration is simply off. */
  | { status: "unconfigured"; missing: readonly string[] }
  /** Some but not all are set — a misconfiguration worth surfacing. */
  | { status: "incomplete"; missing: readonly string[] }
  /**
   * All three are present but at least one cannot possibly work — a PKCS#1
   * private key, a non-numeric app or installation id. Distinct from
   * `incomplete` because the operator's mistake is different and the fix is
   * different.
   */
  | { status: "invalid"; problems: readonly CredentialProblem[] };

/** One thing wrong with a present credential. Never quotes the value. */
export interface CredentialProblem {
  /** The environment variable at fault. */
  variable: string;
  /** What is wrong, and how to fix it. Contains no credential material. */
  detail: string;
}

// --------------------------------------------------------------------- errors

export type GitHubAuthErrorCode =
  /** The PEM could not be parsed or imported. */
  | "invalid-private-key"
  /** GitHub refused to mint an installation token. */
  | "token-request-failed"
  /** GitHub's token response was not shaped as documented. */
  | "malformed-token-response";

/**
 * An authentication failure, safe to surface. The message is scrubbed: see
 * {@link scrubSecrets}. Nothing here carries the key or the token.
 */
export class GitHubAuthError extends Error {
  override readonly name = "GitHubAuthError";
  readonly code: GitHubAuthErrorCode;
  /** HTTP status GitHub answered with, when there was one. */
  readonly status: number | undefined;

  constructor(code: GitHubAuthErrorCode, message: string, status?: number) {
    super(scrubSecrets(message));
    this.code = code;
    this.status = status;
  }
}

/**
 * Remove anything that looks like GitHub credential material from text that
 * is about to escape this module. Defence in depth: GitHub's own error bodies
 * do not echo our token, but a future code path (or a proxy) might, and a
 * leaked token in a log line is unrecoverable.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(?:ghs|ghu|gho|ghp|ghr)_[A-Za-z0-9]{8,}/g, "[redacted-token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "[redacted-token]")
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[redacted-private-key]",
    );
}

// ------------------------------------------------------------- configuration

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Read app credentials from an environment-like record. All three variables
 * are required together; any other combination yields no credentials, so the
 * caller keeps today's behaviour exactly (§2: absent ⇒ integration disabled).
 */
export function readGitHubAppCredentialResult(
  env: Readonly<Record<string, unknown>>,
): GitHubAppCredentialResult {
  const appId = trimmed(env[GITHUB_APP_ENV_KEYS.appId]);
  // The PEM keeps its internal newlines; only surrounding whitespace goes.
  const rawKey = env[GITHUB_APP_ENV_KEYS.privateKeyPem];
  const privateKeyPem = typeof rawKey === "string" && rawKey.trim() !== "" ? rawKey : null;
  const installationId = trimmed(env[GITHUB_APP_ENV_KEYS.installationId]);

  const missing: string[] = [];
  if (appId === null) missing.push(GITHUB_APP_ENV_KEYS.appId);
  if (privateKeyPem === null) missing.push(GITHUB_APP_ENV_KEYS.privateKeyPem);
  if (installationId === null) missing.push(GITHUB_APP_ENV_KEYS.installationId);

  if (missing.length > 0) {
    return { status: missing.length === 3 ? "unconfigured" : "incomplete", missing };
  }

  // Presence is not configuration. `configured` is the operator guide's
  // pre-flight gate before flipping MIRROR_MODE to durable on a live
  // deployment, and a presence-only check reported green for a PKCS#1 key, an
  // App ID pasted into the Installation ID slot, or any other typo — with the
  // failure then surfacing only as git_operations rows going to conflict
  // inside the Durable Object, where nothing logs the reason. These checks are
  // structural and synchronous (no key import, no network), so they cost
  // nothing and still catch every mistake the guide warns about.
  const problems: CredentialProblem[] = [];
  if (!/^[0-9]+$/.test(appId as string)) {
    problems.push({
      variable: GITHUB_APP_ENV_KEYS.appId,
      detail: "must be the GitHub App's numeric App ID (digits only)",
    });
  }
  if (!/^[0-9]+$/.test(installationId as string)) {
    problems.push({
      variable: GITHUB_APP_ENV_KEYS.installationId,
      detail:
        "must be the numeric installation id (digits only) — it is NOT the App ID; " +
        "find it in the installation's settings URL",
    });
  }
  const keyProblem = privateKeyProblem(privateKeyPem as string);
  if (keyProblem !== null) {
    problems.push({ variable: GITHUB_APP_ENV_KEYS.privateKeyPem, detail: keyProblem });
  }
  if (problems.length > 0) {
    return { status: "invalid", problems };
  }

  return {
    status: "configured",
    credentials: {
      appId: appId as string,
      privateKeyPem: privateKeyPem as string,
      installationId: installationId as string,
    },
  };
}

/**
 * What is structurally wrong with the private key, or `null` when it is a
 * plausible PKCS#8 PEM.
 *
 * Deliberately not an `importKey` call: this runs synchronously from
 * `configFromBindings` at boot. The PKCS#1 case is the one this exists for —
 * GitHub's download button hands you `BEGIN RSA PRIVATE KEY`, WebCrypto cannot
 * read it, and the old presence-only check reported such a key as
 * `configured`. Never echoes any part of the key.
 */
function privateKeyProblem(pem: string): string | null {
  const normalized = pem.replace(/\\r/g, "").replace(/\\n/g, "\n").trim();
  if (normalized.includes(PKCS1_BEGIN)) {
    return (
      "is a PKCS#1 key ('BEGIN RSA PRIVATE KEY'), which WebCrypto cannot import. " +
      "Convert it once with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt " +
      "-in github-app.private-key.pem -out github-app.pkcs8.pem"
    );
  }
  const begin = normalized.indexOf(PKCS8_BEGIN);
  const end = normalized.indexOf(PKCS8_END);
  if (begin === -1 || end === -1 || end < begin) {
    return "is not a PKCS#8 PEM (expected a '-----BEGIN PRIVATE KEY-----' block)";
  }
  if (normalized.slice(begin + PKCS8_BEGIN.length, end).replace(/\s+/g, "") === "") {
    return "contains an empty PKCS#8 body";
  }
  return null;
}

/** Credentials, or `null` when they are absent or incomplete. */
export function readGitHubAppCredentials(
  env: Readonly<Record<string, unknown>>,
): GitHubAppCredentials | null {
  const result = readGitHubAppCredentialResult(env);
  return result.status === "configured" ? result.credentials : null;
}

// ------------------------------------------------------------------- the PEM

const PKCS8_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PKCS8_END = "-----END PRIVATE KEY-----";
const PKCS1_BEGIN = "-----BEGIN RSA PRIVATE KEY-----";

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * PKCS#8 PEM → DER bytes.
 *
 * Two real-world hazards are handled deliberately:
 *
 * 1. **PKCS#1.** GitHub's download button hands you `BEGIN RSA PRIVATE KEY`,
 *    which `crypto.subtle.importKey` cannot read. Rather than fail with an
 *    opaque `DataError`, say so and give the conversion command — this is the
 *    single most likely setup mistake an operator will make.
 * 2. **Escaped newlines.** Pasting a PEM into a secret store frequently
 *    stores the two characters `\` `n` instead of a newline. Base64 ignores
 *    whitespace, so accepting both costs nothing and saves a confusing
 *    outage.
 */
export function pkcs8PemToDer(pem: string): Uint8Array {
  const normalized = pem.replace(/\\r/g, "").replace(/\\n/g, "\n").trim();
  if (normalized.includes(PKCS1_BEGIN)) {
    throw new GitHubAuthError(
      "invalid-private-key",
      "GITHUB_APP_PRIVATE_KEY is a PKCS#1 key ('BEGIN RSA PRIVATE KEY'), which WebCrypto " +
        "cannot import. Convert it once with: openssl pkcs8 -topk8 -inform PEM -outform PEM " +
        "-nocrypt -in github-app.private-key.pem -out github-app.pkcs8.pem",
    );
  }
  const begin = normalized.indexOf(PKCS8_BEGIN);
  const end = normalized.indexOf(PKCS8_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new GitHubAuthError(
      "invalid-private-key",
      "GITHUB_APP_PRIVATE_KEY is not a PKCS#8 PEM (expected a '-----BEGIN PRIVATE KEY-----' block)",
    );
  }
  const body = normalized.slice(begin + PKCS8_BEGIN.length, end);
  try {
    const der = decodeBase64ToBytes(body);
    if (der.length === 0) {
      throw new Error("empty key body");
    }
    return der;
  } catch {
    // Never echo the body: it is key material.
    throw new GitHubAuthError(
      "invalid-private-key",
      "GITHUB_APP_PRIVATE_KEY contains an unreadable PKCS#8 body",
    );
  }
}

/** Import a PKCS#8 PEM as an RS256 signing key. */
export async function importAppPrivateKey(pem: string): Promise<SigningKey> {
  const der = pkcs8PemToDer(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der as unknown as ArrayBufferView,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, // not extractable: the key cannot be read back out of the isolate
      ["sign"],
    );
  } catch {
    throw new GitHubAuthError(
      "invalid-private-key",
      "GITHUB_APP_PRIVATE_KEY could not be imported as an RSA signing key",
    );
  }
}

// ---------------------------------------------------------------------- JWT

const textEncoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(textEncoder.encode(JSON.stringify(value)));
}

export interface AppJwtClaims {
  /** Issued-at, seconds. Backdated by {@link APP_JWT_SKEW_SECONDS}. */
  iat: number;
  /** Expiry, seconds. */
  exp: number;
  /** The app id. */
  iss: string;
}

/**
 * Sign an app JWT (RS256). `nowMs` is the caller's clock so the 60s backdated
 * `iat` and 9-minute `exp` are assertable without waiting.
 */
export async function createAppJwt(
  key: SigningKey,
  appId: string,
  nowMs: number,
): Promise<string> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const claims: AppJwtClaims = {
    iat: nowSeconds - APP_JWT_SKEW_SECONDS,
    exp: nowSeconds + APP_JWT_TTL_SECONDS,
    iss: appId,
  };
  const signingInput = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    textEncoder.encode(signingInput) as unknown as ArrayBufferView,
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** Decode a JWT's claims without verifying — for tests and diagnostics only. */
export function decodeJwtClaims(jwt: string): AppJwtClaims {
  const segment = jwt.split(".")[1];
  if (segment === undefined) throw new Error("not a JWT");
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(new TextDecoder().decode(decodeBase64ToBytes(padded))) as AppJwtClaims;
}

// -------------------------------------------------------- installation token

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Non-secret facts about the cached token, safe to expose to tests/metrics. */
export interface TokenCacheInfo {
  cached: boolean;
  expiresAtMs: number | null;
  /** True when the cached token is still outside the 5-minute refresh margin. */
  fresh: boolean;
}

/**
 * Body of a `POST /app/installations/{id}/access_tokens` response. Only the
 * two fields we use are modelled; `token` never leaves this module.
 */
interface AccessTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

/**
 * A request body is replayable if we can send the identical bytes again. Only
 * then may we retry after a 401 — silently re-sending a consumed stream would
 * commit an empty or truncated payload, which for the writer means a wrong
 * commit. Strings (what this package sends) always qualify.
 */
function isReplayable(init: RequestInit | undefined): boolean {
  const body = init?.body;
  return body === undefined || body === null || typeof body === "string";
}

/** Discard an unused response body so the connection is not held open. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled is not worth failing the request over.
  }
}

/**
 * Mints and caches installation tokens, and lends out an {@link AuthorizedFetch}.
 *
 * Caching is per instance; hold one instance per isolate (see
 * {@link getGitHubAppAuth}) and the 5-minute refresh margin does its job.
 * Concurrent callers share a single in-flight mint — without that, the
 * reader's eight parallel blob fetches would each trigger their own token
 * request on a cold isolate.
 */
export class GitHubAppAuth {
  readonly appId: string;
  readonly installationId: string;
  readonly apiOrigin: string;

  readonly #privateKeyPem: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #userAgent: string;

  #key: Promise<SigningKey> | null = null;
  #cached: CachedToken | null = null;
  #inFlight: Promise<string> | null = null;

  constructor(credentials: GitHubAppCredentials, options: GitHubAppAuthOptions = {}) {
    this.appId = credentials.appId;
    this.installationId = credentials.installationId;
    this.apiOrigin = options.apiOrigin ?? GITHUB_API_ORIGIN;
    this.#privateKeyPem = credentials.privateKeyPem;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input as string, init));
    this.#now = options.now ?? (() => Date.now());
    this.#userAgent = options.userAgent ?? GITHUB_USER_AGENT;
  }

  /** Sign a fresh app JWT. The key is imported once and reused. */
  async appJwt(): Promise<string> {
    this.#key ??= importAppPrivateKey(this.#privateKeyPem);
    let key: SigningKey;
    try {
      key = await this.#key;
    } catch (error) {
      // Do not cache a rejected import: a corrected secret should recover
      // without recreating the instance.
      this.#key = null;
      throw error;
    }
    return createAppJwt(key, this.appId, this.#now());
  }

  /** Non-secret view of the cache, for assertions and diagnostics. */
  tokenCacheInfo(): TokenCacheInfo {
    if (this.#cached === null) return { cached: false, expiresAtMs: null, fresh: false };
    return {
      cached: true,
      expiresAtMs: this.#cached.expiresAtMs,
      fresh: this.#isFresh(this.#cached),
    };
  }

  /** Drop the cached token (used after a 401, and by tests). */
  clearCachedToken(): void {
    this.#cached = null;
  }

  #isFresh(token: CachedToken): boolean {
    return token.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > this.#now();
  }

  /**
   * A valid installation token, minted if the cache is empty or inside the
   * refresh margin. **Never log or persist the return value.**
   */
  async installationToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (options.forceRefresh === true) {
      this.#cached = null;
    } else if (this.#cached !== null && this.#isFresh(this.#cached)) {
      return this.#cached.token;
    }
    // Collapse concurrent mints onto one request.
    this.#inFlight ??= this.#mintToken().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #mintToken(): Promise<string> {
    const jwt = await this.appJwt();
    const url = `${this.apiOrigin}/app/installations/${encodeURIComponent(this.installationId)}/access_tokens`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: GITHUB_ACCEPT,
        "x-github-api-version": GITHUB_API_VERSION,
        "user-agent": this.#userAgent,
      },
    });
    if (!response.ok) {
      const detail = await readErrorMessage(response);
      throw new GitHubAuthError(
        "token-request-failed",
        `installation token request failed (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
    let body: AccessTokenResponse;
    try {
      body = (await response.json()) as AccessTokenResponse;
    } catch {
      throw new GitHubAuthError(
        "malformed-token-response",
        "installation token response was not JSON",
        response.status,
      );
    }
    const token = typeof body.token === "string" ? body.token : null;
    const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    if (token === null || token === "" || !Number.isFinite(expiresAt)) {
      // Deliberately does not include the body: it may contain the token.
      throw new GitHubAuthError(
        "malformed-token-response",
        "installation token response lacked a usable token/expires_at pair",
        response.status,
      );
    }
    this.#cached = { token, expiresAtMs: expiresAt };
    return token;
  }

  /**
   * Alias of {@link installationToken} under the name the writer's token seam
   * (`InstallationTokenSource.getInstallationToken`) looks for, so a
   * `GitHubAppAuth` is passed straight to `GitHubBookRepoWriter` as `tokens`
   * with no adapter. Bound, so it survives being destructured.
   */
  readonly getInstallationToken = (
    request: { forceRefresh?: boolean } = {},
  ): Promise<string> => this.installationToken(request);

  #headers(init: RequestInit | undefined, token: string): Headers {
    const headers = new Headers(init?.headers);
    // Ours always wins: a caller must not be able to send a stale credential.
    headers.set("authorization", `Bearer ${token}`);
    if (!headers.has("accept")) headers.set("accept", GITHUB_ACCEPT);
    headers.set("x-github-api-version", GITHUB_API_VERSION);
    headers.set("user-agent", this.#userAgent);
    return headers;
  }

  /**
   * `fetch` with a live installation token attached. On a 401 the token is
   * dropped and the request is retried **once** with a freshly minted one
   * (§2) — but only when the body can be replayed byte-for-byte.
   *
   * Bound as a property so it can be handed straight to the reader/writer.
   */
  readonly authorizedFetch: AuthorizedFetch = async (url, init) => {
    const token = await this.installationToken();
    const response = await this.#fetch(url, { ...init, headers: this.#headers(init, token) });
    if (response.status !== 401 || !isReplayable(init)) {
      return response;
    }
    await discard(response);
    // Only invalidate the token we actually used; a parallel request may have
    // already installed a newer one.
    if (this.#cached?.token === token) this.clearCachedToken();
    const refreshed = await this.installationToken();
    return this.#fetch(url, { ...init, headers: this.#headers(init, refreshed) });
  };
}

/** GitHub's `{ message }` error field, scrubbed. Never throws. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text === "") return "";
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") return scrubSecrets(parsed.message);
    } catch {
      // Not JSON; fall through to the raw text.
    }
    return scrubSecrets(text.slice(0, 200));
  } catch {
    return "";
  }
}

// --------------------------------------------------------- per-isolate cache

const isolateAuth = new Map<string, GitHubAppAuth>();

function isolateKey(credentials: GitHubAppCredentials, apiOrigin: string): string {
  return `${apiOrigin}|${credentials.appId}|${credentials.installationId}`;
}

/**
 * The per-isolate {@link GitHubAppAuth} for these credentials, created on
 * first use. This is what makes "cached in memory per isolate until 5 minutes
 * before expiry" true across requests: a Worker handler that builds a reader
 * per request still shares one token.
 *
 * The private key is not part of the cache key (it is a secret and it does not
 * vary independently of the app id), so rotating the key requires
 * {@link resetGitHubAppAuthCache} or a new isolate — which is what a secret
 * update produces anyway.
 */
export function getGitHubAppAuth(
  credentials: GitHubAppCredentials,
  options: GitHubAppAuthOptions = {},
): GitHubAppAuth {
  const key = isolateKey(credentials, options.apiOrigin ?? GITHUB_API_ORIGIN);
  const existing = isolateAuth.get(key);
  if (existing !== undefined) return existing;
  const created = new GitHubAppAuth(credentials, options);
  isolateAuth.set(key, created);
  return created;
}

/** Forget every per-isolate instance. For tests and key rotation. */
export function resetGitHubAppAuthCache(): void {
  isolateAuth.clear();
}
