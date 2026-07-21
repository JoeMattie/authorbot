/**
 * GitHub App creation via the manifest flow (Phase 6 contract §4).
 *
 * The point of this flow is that **the author never copies a client secret out
 * of a web page**. They click "Create GitHub App" once; GitHub hands back a
 * one-time code; the wizard exchanges it for the app id, private key, client
 * id/secret, and webhook secret, and pipes those straight into Worker secrets.
 * Nothing is written to disk, to the journal, or to the terminal.
 *
 * Four properties make it safe rather than merely convenient:
 *
 * - **Unpredictable callback path.** Another process on the machine cannot
 *   guess where to POST, so it cannot race the browser to the callback.
 * - **`state` verification.** A callback whose `state` does not match the one
 *   this run generated is refused, which is what stops a cross-site request
 *   from injecting a code from a *different* app into this flow.
 * - **A deadline.** The browser step can be abandoned; the wizard must not
 *   wait forever holding a server open.
 * - **Shutdown on every exit path.** Success, failure, timeout, or a thrown
 *   error all run through the same `finally`. A leaked loopback listener is a
 *   leaked callback endpoint.
 */
import { createPrivateKey } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { randomToken } from "../ids.js";
import { TimeoutError, WizardError } from "../errors.js";
import type {
  BrowserOpener,
  Clock,
  HttpClient,
  LoopbackServerFactory,
  RandomSource,
} from "../ports.js";

export interface ManifestFlowOptions {
  /** Shown on the GitHub App page; must be unique across GitHub. */
  readonly appName: string;
  /** The book's live site (ADR-0019: everything is on this one origin). */
  readonly siteUrl: string;
  /** OAuth callback, on the site's own origin. */
  readonly callbackUrl: string;
  /** Webhook receiver, on the site's own origin. */
  readonly webhookUrl: string;
  /** How long the author has to finish in the browser. */
  readonly timeoutMs: number;
  /** Called once the browser URL is known, so the caller can print it. */
  readonly onBrowserStep?: (url: string) => void;
}

export interface ManifestConversion {
  readonly appId: string;
  readonly slug: string;
  readonly htmlUrl: string;
  readonly clientId: string;
  /** Secret. */
  readonly clientSecret: string;
  /** Secret: always PKCS#8 PEM, converted on the way out if GitHub sent PKCS#1. */
  readonly pem: string;
  /** Secret. */
  readonly webhookSecret: string;
}

export interface ManifestFlowDeps {
  readonly loopback: LoopbackServerFactory;
  readonly browser: BrowserOpener;
  readonly http: HttpClient;
  readonly clock: Clock;
  readonly random: RandomSource;
  /** Overridable so tests point at an in-process fake GitHub. */
  readonly githubApiBase?: string;
  readonly githubWebBase?: string;
}

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_WEB_BASE = "https://github.com";

/**
 * Constant-time `state` comparison.
 *
 * `!==` short-circuits at the first differing byte, so the time it takes to
 * refuse a callback leaks how much of `state` the caller guessed. It is not
 * practically exploitable here — 32 CSPRNG bytes behind a 16-byte unguessable
 * callback path, over a single-shot loopback listener — but the fix costs one
 * function and removes the need for anyone to re-derive that argument. Lengths
 * are compared first because `timingSafeEqual` throws on a mismatch; a length
 * difference is not a secret.
 */
export function statesMatch(returned: string | null, expected: string): boolean {
  if (returned === null) {
    return false;
  }
  const a = Buffer.from(returned, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The manifest GitHub is asked to create an app from.
 *
 * Permissions are the minimum the API actually uses: `contents: write` to
 * commit prose, `metadata: read` because GitHub requires it alongside any
 * repository permission. `request_oauth_on_install` is what lets this one app
 * both authenticate readers and write to the repository, replacing the
 * separate OAuth App.
 */
export function buildManifest(
  options: ManifestFlowOptions,
  loopbackRedirectUrl: string,
): Record<string, unknown> {
  return {
    name: options.appName,
    url: options.siteUrl,
    hook_attributes: {
      url: options.webhookUrl,
      active: true,
      // NO `secret` HERE. It is not a permitted manifest key, and GitHub
      // rejects the entire manifest for its presence — "Error \"secret\" is
      // not a permitted key" — before the app is ever created. GitHub
      // generates the webhook secret itself and hands it back from the
      // conversion, which is the value the caller uses, so proposing one was
      // never anything but a way to fail.
    },
    // `redirect_url` is where GitHub sends the *one-time creation code*, so it
    // is the loopback server — not the site. `callback_urls` is a different
    // thing entirely: where GitHub sends readers after they sign in, which is
    // on the book's own origin (ADR-0019). Conflating the two is the classic
    // way to make this flow hang forever waiting for a callback that went to
    // production.
    redirect_url: loopbackRedirectUrl,
    callback_urls: [options.callbackUrl],
    setup_url: options.siteUrl,
    description:
      "Lets this book's site sign readers in with GitHub and commit approved changes back to the repository.",
    public: false,
    default_events: ["push"],
    default_permissions: {
      contents: "write",
      metadata: "read",
    },
    request_oauth_on_install: true,
    setup_on_update: false,
  };
}

/**
 * The page the browser is opened to. It exists only to turn a GET (all a
 * browser can be handed) into the POST that GitHub's manifest endpoint
 * requires, and it submits itself immediately.
 *
 * `autofocus` on the button is the fallback for a browser with JavaScript
 * disabled: the flow still works, it just needs one click.
 */
export function buildSubmitPage(
  manifest: Record<string, unknown>,
  state: string,
  webBase: string,
): string {
  const action = `${webBase}/settings/apps/new?state=${encodeURIComponent(state)}`;
  const payload = escapeHtml(JSON.stringify(manifest));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setting up your book's GitHub App</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
  button { font: inherit; padding: 0.6rem 1.2rem; }
</style>
</head>
<body>
<h1>Creating your book's GitHub App</h1>
<p>You are being sent to GitHub to approve an app for your book. It can sign
readers in and commit approved changes to your repository, and nothing else.</p>
<form id="manifest-form" method="post" action="${escapeHtml(action)}">
  <input type="hidden" name="manifest" value="${payload}">
  <button type="submit" autofocus>Continue to GitHub</button>
</form>
<script>document.getElementById("manifest-form").submit();</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DONE_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>All set</title>
<style>body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }</style>
</head>
<body><h1>All set.</h1><p>Your app was created. You can close this tab and go back to your terminal.</p></body>
</html>
`;

/**
 * Runs the whole browser round-trip and returns the converted credentials.
 *
 * The returned object contains three secrets. The caller must register them
 * with the vault before doing anything else with them.
 */
export async function runManifestFlow(
  deps: ManifestFlowDeps,
  options: ManifestFlowOptions,
): Promise<ManifestConversion> {
  const apiBase = deps.githubApiBase ?? GITHUB_API_BASE;
  const webBase = deps.githubWebBase ?? GITHUB_WEB_BASE;

  const state = randomToken(deps.random, 32);
  const startPath = `/${randomToken(deps.random, 16)}`;
  const callbackPath = `/${randomToken(deps.random, 16)}`;

  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The callback can arrive (and be refused) before anything awaits this — the
  // browser may be quicker than the next line of this function. Attaching an
  // inert handler now marks the rejection as observed, so Node does not report
  // an unhandled rejection for a failure the caller is about to be told about
  // properly. The real handling still happens at the `await` below.
  codePromise.catch(() => {});

  // Assigned as soon as the server has a port; the handler cannot run before
  // `start` resolves, so it is always set by the time the page is rendered.
  let redirectUrl = "";

  const server = await deps.loopback.start(async (request) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === startPath) {
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: buildSubmitPage(buildManifest(options, redirectUrl), state, webBase),
      };
    }
    if (url.pathname === callbackPath) {
      const returnedState = url.searchParams.get("state");
      if (!statesMatch(returnedState, state)) {
        // Refused, and the flow fails rather than continuing with a code whose
        // provenance is unknown. Reporting "mismatch" back to the browser is
        // safe; the value itself is not echoed.
        const error = new WizardError(
          "GitHub came back with a security token that does not match the one this run created, so the app was not accepted.",
          "This usually means an old browser tab finished the flow. Close every GitHub tab and run `create-authorbot collaborate` again.",
        );
        rejectCode(error);
        return {
          status: 400,
          contentType: "text/plain; charset=utf-8",
          body: "This setup link is not the one your terminal is waiting for. Return to your terminal and start again.",
        };
      }
      const code = url.searchParams.get("code");
      if (code === null || code.length === 0) {
        rejectCode(
          new WizardError(
            "GitHub redirected back without the one-time code needed to finish creating the app.",
            "Run `create-authorbot collaborate` again and approve the app when the browser asks.",
          ),
        );
        return {
          status: 400,
          contentType: "text/plain; charset=utf-8",
          body: "Something was missing from GitHub's response. Return to your terminal.",
        };
      }
      resolveCode(code);
      return { status: 200, contentType: "text/html; charset=utf-8", body: DONE_PAGE };
    }
    return {
      status: 404,
      contentType: "text/plain; charset=utf-8",
      body: "Not found.",
    };
  });

  redirectUrl = `${server.origin}${callbackPath}`;

  // One `finally` for every exit path (contract §4.6): success, refusal,
  // timeout, and any unexpected throw all shut the listener down.
  try {
    const startUrl = `${server.origin}${startPath}`;
    options.onBrowserStep?.(startUrl);
    await deps.browser.open(startUrl);

    const code = await withDeadline(
      deps.clock,
      codePromise,
      options.timeoutMs,
      () =>
        new TimeoutError(
          "your approval in the browser",
          `Open ${startUrl} and approve the app, then run \`create-authorbot collaborate\` again. Nothing has been created yet.`,
        ),
    );

    return await convertManifestCode(deps.http, apiBase, code);
  } finally {
    await server.close();
  }
}

/**
 * Exchanges the one-time code for credentials
 * (`POST /app-manifests/{code}/conversions`). The code is valid for one hour
 * and single-use, so a failure here means starting the flow again rather than
 * retrying the exchange.
 */
export async function convertManifestCode(
  http: HttpClient,
  apiBase: string,
  code: string,
): Promise<ManifestConversion> {
  const response = await http.request(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "create-authorbot",
    },
    timeoutMs: 30_000,
  });

  if (response.status === 404 || response.status === 422) {
    throw new WizardError(
      "GitHub would not exchange the setup code — it has already been used, or it expired.",
      "Run `create-authorbot collaborate` again; the browser step has to be finished within an hour of starting it.",
    );
  }
  if (response.status >= 500) {
    throw new WizardError(
      `GitHub returned an error (${String(response.status)}) while creating the app.`,
      "Check https://www.githubstatus.com and try again once it is green; nothing has been created yet.",
    );
  }
  if (response.status !== 201 && response.status !== 200) {
    throw new WizardError(
      `GitHub refused to create the app (${String(response.status)}).`,
      "Run `create-authorbot collaborate` again. If it keeps failing, check https://www.githubstatus.com.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new WizardError(
      "GitHub's reply while creating the app could not be understood.",
      "Run `create-authorbot collaborate` again; if it keeps happening, please report it.",
    );
  }
  const record = parsed as Record<string, unknown>;
  const appId = record["id"];
  const pem = record["pem"];
  const clientId = record["client_id"];
  const clientSecret = record["client_secret"];
  const webhookSecret = record["webhook_secret"];
  const slug = record["slug"];
  const htmlUrl = record["html_url"];

  if (
    (typeof appId !== "number" && typeof appId !== "string") ||
    typeof pem !== "string" ||
    typeof clientId !== "string" ||
    typeof clientSecret !== "string" ||
    typeof webhookSecret !== "string" ||
    typeof slug !== "string" ||
    typeof htmlUrl !== "string"
  ) {
    // Named without values: saying which field was missing is diagnostic;
    // printing the body would print the credentials that did arrive.
    throw new WizardError(
      "GitHub created the app but its reply was missing something the wizard needs.",
      "Delete the app it just made (github.com/settings/apps) and run `create-authorbot collaborate` again.",
    );
  }

  return {
    appId: String(appId),
    slug,
    htmlUrl,
    clientId,
    clientSecret,
    pem: toPkcs8(pem),
    webhookSecret,
  };
}

/**
 * Races a promise against a deadline. The loser is not cancellable (the
 * loopback handler may still fire), which is exactly why the caller closes the
 * server in a `finally` rather than relying on this returning.
 */
export async function withDeadline<T>(
  clock: Clock,
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timedOut = false;
  const timeout = clock.sleep(timeoutMs).then(() => {
    timedOut = true;
  });
  const result = await Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout.then(() => ({ ok: false as const, value: undefined })),
  ]);
  if (result.ok) {
    return result.value;
  }
  if (timedOut) {
    throw onTimeout();
  }
  // The timeout resolved without the flag being set, which cannot happen; fall
  // back to awaiting the real promise rather than inventing a failure.
  return await promise;
}

/**
 * GitHub's PEM, in the one format the Worker can actually use.
 *
 * The manifest conversion returns a PKCS#1 key — `BEGIN RSA PRIVATE KEY` —
 * and WebCrypto, which is all a Cloudflare Worker has, cannot import one. The
 * wizard stored it verbatim, so every book it set up reported
 * `gitIntegration: "invalid"` and did no Git work at all: chapters could not
 * be saved, the projection never ran, and nothing said why.
 *
 * `createPrivateKey` parses either format and re-exports as PKCS#8, so this is
 * a re-encoding rather than a conversion in any meaningful sense — the key
 * material is untouched.
 *
 * A key that cannot be parsed is passed through unchanged: the Worker's own
 * credential check will refuse it and name the problem, which is a better
 * error than one thrown from inside the setup wizard about a format the
 * author never chose.
 */
export function toPkcs8(pem: string): string {
  try {
    return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    return pem;
  }
}
