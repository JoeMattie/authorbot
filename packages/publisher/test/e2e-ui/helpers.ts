/**
 * Shared plumbing for the Phase 2b Playwright e2e (contract §5): a minimal
 * static file server, temp-git-repo creation, and typed access to the
 * environment handles that global-setup passes to the test workers.
 */
import { execFile } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { cp, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";

const execFileAsync = promisify(execFile);

// ---- env handles (set by global-setup, read by the workers) ----------------

export const ENV = {
  siteUrl: "AB_E2E_SITE_URL",
  apiUrl: "AB_E2E_API_URL",
  plainDir: "AB_E2E_PLAIN_DIR",
  repoDir: "AB_E2E_REPO_DIR",
  /** The served build directory — the Phase 4 flow rebuilds it in place. */
  siteDir: "AB_E2E_SITE_DIR",
  /**
   * The second, base-path deployment (ADR-0019 §6): its own origin, its own
   * API process mounted under `API_BASE_PATH`, its own book repo and database.
   * Kept entirely separate from the root deployment so neither test can
   * observe the other's commits.
   */
  baseSiteUrl: "AB_E2E_BASE_SITE_URL",
  baseRepoDir: "AB_E2E_BASE_REPO_DIR",
} as const;

/**
 * The base path the second deployment is published under. One segment is
 * enough to prove the pairing: the site's URLs, the emitted asset tree, and
 * the API prefix all have to agree, and they either all do or none do.
 */
export const BASE_PATH = "/my-book";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set — did global-setup run?`);
  }
  return value;
}

export const siteUrl = (): string => requireEnv(ENV.siteUrl);
export const apiUrl = (): string => requireEnv(ENV.apiUrl);
export const plainDir = (): string => requireEnv(ENV.plainDir);
export const repoDir = (): string => requireEnv(ENV.repoDir);

export const siteDir = (): string => requireEnv(ENV.siteDir);

/** Origin of the base-path deployment; the book itself lives under BASE_PATH. */
export const baseSiteUrl = (): string => requireEnv(ENV.baseSiteUrl);
export const baseRepoDir = (): string => requireEnv(ENV.baseRepoDir);

/** The base-path deployment's site root, e.g. `http://127.0.0.1:PORT/my-book`. */
export const basePathSiteUrl = (): string => `${baseSiteUrl()}${BASE_PATH}`;

export const chapterUrl = (slug = "baseline"): string => `${siteUrl()}/chapters/${slug}/`;

export const workUrl = (): string => `${siteUrl()}/work/`;

// ---- static file server ----------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve `root` (set lazily via the returned setter, so the server can start —
 * and its origin be known — before the site is built) on an ephemeral port,
 * **and reverse-proxy `/v1/*` to the collaboration API** (set lazily the same
 * way).
 *
 * The proxy is what makes this e2e model the only deployment shape Authorbot
 * supports (ADR-0019): site and API on ONE origin. Previously the site and the
 * API were served from two ports and paired with `ALLOWED_ORIGINS` — a
 * configuration that no longer exists. Cloudflare serves both planes from one
 * Worker; this node:http proxy is the local stand-in for that.
 *
 * Responses are piped rather than buffered, so the `/v1/projects/{p}/events`
 * SSE stream stays a stream, and the original `Host` header is forwarded so
 * the API's own origin — the one its CSRF and `return_to` checks compare
 * against — is the site's origin.
 */
export async function startStaticServer(
  options: {
    /**
     * The path prefix proxied to the API. `/v1` is the origin-root deployment;
     * a base-path deployment (ADR-0019 §6) serves the same API under its own
     * prefix, e.g. `/my-book/v1`, which is exactly what the base-path e2e
     * exercises. The Worker's `API_BASE_PATH` and the site's
     * `publication.api_url` are the two halves of this pairing.
     */
    apiPrefix?: string;
  } = {},
): Promise<{
  server: Server;
  origin: string;
  setRoot: (dir: string) => void;
  setApiTarget: (target: { host: string; port: number }) => void;
}> {
  const apiPrefix = options.apiPrefix ?? "/v1";
  let root: string | null = null;
  let apiTarget: { host: string; port: number } | null = null;
  const server = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    if (
      rawUrl === apiPrefix ||
      rawUrl.startsWith(`${apiPrefix}/`) ||
      rawUrl.startsWith(`${apiPrefix}?`)
    ) {
      if (apiTarget === null) {
        res.statusCode = 503;
        res.end("api not started yet");
        return;
      }
      const upstream = httpRequest(
        {
          host: apiTarget.host,
          port: apiTarget.port,
          method: req.method,
          path: rawUrl,
          // `req.headers` still carries the browser's Host (this server's
          // origin); forwarding it verbatim keeps the API same-origin.
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.statusCode = 502;
        res.end("bad gateway");
      });
      req.pipe(upstream);
      return;
    }
    void (async () => {
      if (root === null) {
        res.statusCode = 503;
        res.end("site not built yet");
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith("/")) {
        pathname += "index.html";
      }
      let file = path.normalize(path.join(root, pathname));
      if (!file.startsWith(root + path.sep) && file !== root) {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      try {
        if ((await stat(file)).isDirectory()) {
          file = path.join(file, "index.html");
        }
        const body = await readFile(file);
        res.statusCode = 200;
        res.setHeader(
          "content-type",
          CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        );
        res.end(body);
      } catch {
        res.statusCode = 404;
        res.end("not found");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    setRoot: (dir: string) => {
      root = dir;
    },
    setApiTarget: (target: { host: string; port: number }) => {
      apiTarget = target;
    },
  };
}

/** An OS-assigned free port (bind to 0, close, reuse). */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// ---- temp book repo --------------------------------------------------------

/** Copy `sourceRepo` to `dest` and make it a committed git work tree. */
export async function createTempBookRepo(sourceRepo: string, dest: string): Promise<void> {
  await cp(sourceRepo, dest, { recursive: true });
  const git = async (...args: string[]): Promise<void> => {
    await execFileAsync("git", ["-C", dest, ...args]);
  };
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "e2e@authorbot.invalid");
  await git("config", "user.name", "Authorbot E2E");
  await git("config", "commit.gpgsign", "false");
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed: examples/book-repo");
}

/** Commit subjects + patch hits for `needle` in the temp repo's history. */
export async function gitLogContains(repo: string, needle: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    repo,
    "log",
    "--all",
    "-S",
    needle,
    "--oneline",
  ]);
  return stdout.trim().length > 0;
}

// ---- browser-side helpers --------------------------------------------------

/** Sign in through the islands' dev-login form (`data-dev-login` build). */
export async function devLogin(page: Page, login: string, role: string): Promise<void> {
  const form = page.locator(".ab-devlogin");
  await form.waitFor({ state: "visible" });
  await form.locator('input[name="login"]').fill(login);
  await form.locator("select").selectOption(role);
  await form.locator('button[type="submit"]').click();
  await page.locator(".ab-me", { hasText: `Signed in as ${login}` }).waitFor();
}

/**
 * Programmatically select a character range inside the chapter's first block
 * (Playwright's mouse-drag selection is flaky across font metrics; a real DOM
 * Range exercises the identical selectionchange → captureRange path).
 */
export async function selectInFirstBlock(page: Page, start: number, end: number): Promise<void> {
  await page.evaluate(
    ([from, to]) => {
      const block = document.querySelector('main .prose [id^="b-"]');
      if (block === null) {
        throw new Error("no block found");
      }
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      if (text === null || (text.textContent ?? "").length < (to ?? 0)) {
        throw new Error("first text node too short");
      }
      const range = document.createRange();
      range.setStart(text, from ?? 0);
      range.setEnd(text, to ?? 0);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    [start, end],
  );
}

export const PROJECT = "hollow-creek-anomaly";

/** Dev-login straight against the API; returns the session cookie for reuse. */
export async function loginCookie(login: string, role = "contributor"): Promise<string> {
  const loginResponse = await fetch(`${apiUrl()}/v1/dev/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: siteUrl() },
    body: JSON.stringify({ login, role }),
  });
  if (!loginResponse.ok) {
    throw new Error(`dev login failed: ${loginResponse.status}`);
  }
  return (loginResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

/**
 * Create an annotation directly against the API (dev login + cookie + CSRF
 * Origin header) — for tests that need existing data without driving the UI.
 * Returns the created annotation id and the chapter coordinates it used.
 */
export async function seedAnnotationViaApi(options: {
  login: string;
  body: string;
  chapterSlug?: string;
  kind?: "comment" | "suggestion";
  role?: string;
}): Promise<{ annotationId: string; chapterId: string; blockId: string; revision: number }> {
  const api = apiUrl();
  const origin = siteUrl();
  const cookie = await loginCookie(options.login, options.role ?? "contributor");

  // Read chapter id/revision and a real block id straight from the built page
  // so the seed matches the served site exactly.
  const html = await (await fetch(chapterUrl(options.chapterSlug ?? "baseline"))).text();
  const mount = /<authorbot-collab[^>]*>/.exec(html)?.[0] ?? "";
  const chapterId = /data-chapter-id="([^"]+)"/.exec(mount)?.[1];
  const revision = Number(/data-chapter-revision="([^"]+)"/.exec(mount)?.[1]);
  const blockId = /id="b-([0-9a-f-]{36})"/.exec(html)?.[1];
  if (chapterId === undefined || blockId === undefined || !Number.isInteger(revision)) {
    throw new Error("could not extract chapter data from the built page");
  }

  const create = await fetch(`${api}/v1/projects/${PROJECT}/chapters/${chapterId}/annotations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      cookie,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      kind: options.kind ?? "comment",
      scope: "block",
      chapterRevision: revision,
      target: { blockId },
      body: options.body,
    }),
  });
  if (create.status !== 202) {
    throw new Error(`seed annotation failed: ${create.status} ${await create.text()}`);
  }
  const accepted = (await create.json()) as { annotationId?: string };
  if (typeof accepted.annotationId !== "string") {
    throw new Error("seed annotation response had no annotationId");
  }
  return { annotationId: accepted.annotationId, chapterId, blockId, revision };
}

/** Cast a vote on a suggestion via the API using a saved session cookie. */
export async function voteViaApi(
  cookie: string,
  annotationId: string,
  value: "approve" | "reject" | "abstain",
): Promise<void> {
  const response = await fetch(
    `${apiUrl()}/v1/projects/${PROJECT}/annotations/${annotationId}/vote`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: siteUrl(),
        cookie,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ value }),
    },
  );
  if (response.status !== 200) {
    throw new Error(`vote failed: ${response.status} ${await response.text()}`);
  }
}

// ---- Phase 4 helpers (leases, work items, rebuild) -------------------------

/** Chapter id, revision and the first block's id/text, read from the built page. */
export async function chapterFacts(chapterSlug = "baseline"): Promise<{
  chapterId: string;
  revision: number;
  blockId: string;
  blockText: string;
}> {
  const html = await (await fetch(chapterUrl(chapterSlug))).text();
  const mount = /<authorbot-collab[^>]*>/.exec(html)?.[0] ?? "";
  const chapterId = /data-chapter-id="([^"]+)"/.exec(mount)?.[1];
  const revision = Number(/data-chapter-revision="([^"]+)"/.exec(mount)?.[1]);
  const block = /id="b-([0-9a-f-]{36})"[^>]*>([^<]*)</.exec(html);
  if (chapterId === undefined || block?.[1] === undefined || !Number.isInteger(revision)) {
    throw new Error("could not extract chapter data from the built page");
  }
  return { chapterId, revision, blockId: block[1], blockText: block[2] ?? "" };
}

/**
 * Seed a **range**-scoped suggestion over `exact` inside the chapter's first
 * block — the shape that votes into a `revise_range` work item, which is the
 * work-item type both the human (Playwright) and agent (script) paths must
 * complete end to end (contract §7 / §27.5).
 */
export async function seedRangeSuggestion(options: {
  login: string;
  body: string;
  exact: string;
  chapterSlug?: string;
}): Promise<{ annotationId: string; chapterId: string; blockId: string; cookie: string }> {
  const cookie = await loginCookie(options.login, "contributor");
  const facts = await chapterFacts(options.chapterSlug ?? "baseline");
  const start = facts.blockText.indexOf(options.exact);
  if (start === -1) {
    throw new Error(`"${options.exact}" is not in the first block of the built chapter`);
  }
  const end = start + options.exact.length;
  const response = await fetch(
    `${apiUrl()}/v1/projects/${PROJECT}/chapters/${facts.chapterId}/annotations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: siteUrl(),
        cookie,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        kind: "suggestion",
        scope: "range",
        chapterRevision: facts.revision,
        target: {
          blockId: facts.blockId,
          textPosition: { start, end },
          textQuote: {
            exact: options.exact,
            prefix: facts.blockText.slice(Math.max(0, start - 32), start),
            suffix: facts.blockText.slice(end, end + 32),
          },
        },
        body: options.body,
      }),
    },
  );
  if (response.status !== 202) {
    throw new Error(`seed range suggestion failed: ${response.status} ${await response.text()}`);
  }
  const accepted = (await response.json()) as { annotationId?: string };
  if (typeof accepted.annotationId !== "string") {
    throw new Error("seed range suggestion response had no annotationId");
  }
  await waitForAnnotationOpen(accepted.annotationId, cookie);
  return {
    annotationId: accepted.annotationId,
    chapterId: facts.chapterId,
    blockId: facts.blockId,
    cookie,
  };
}

/**
 * Approve a suggestion until it crosses the default rule: design §25
 * (approvals ≥ 3, net ≥ 2, human_approvals ≥ 1) **plus** the Phase 6 contract
 * §3.6 amendment `human_maintainer_approvals >= 1`.
 *
 * So the third approver is the book's human maintainer. Without them the
 * numbers are met and nothing becomes work, which is the whole point of the
 * amendment — an author's book does not acquire work items without the author
 * agreeing to it.
 */
export async function voteToThreshold(annotationId: string, prefix: string): Promise<void> {
  for (const [name, role] of [
    ["a", "contributor"],
    ["b", "contributor"],
    ["c", "maintainer"],
  ] as const) {
    const cookie = await loginCookie(`${prefix}-${name}`, role);
    await voteViaApi(cookie, annotationId, "approve");
  }
}

interface WorkItemJson {
  id: string;
  type: string;
  status: string;
  sourceAnnotationId: string;
  baseRevision: number;
}

/** Poll `/work-items` until the item created from `annotationId` shows up. */
export async function waitForWorkItem(
  cookie: string,
  annotationId: string,
  status = "ready",
): Promise<WorkItemJson> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const response = await fetch(
      `${apiUrl()}/v1/projects/${PROJECT}/work-items?status=${status}&limit=50`,
      { headers: { cookie } },
    );
    if (response.ok) {
      const body = (await response.json()) as { items: WorkItemJson[] };
      const found = body.items.find((item) => item.sourceAnnotationId === annotationId);
      if (found !== undefined) {
        return found;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no ${status} work item appeared for annotation ${annotationId} within 20s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The chapter file's current text, straight from the temp repo's work tree. */
export async function chapterFileText(fileName: string): Promise<string> {
  return readFile(path.join(repoDir(), "chapters", fileName), "utf8");
}

/**
 * Rebuild the served site from the (now committed) book repo — the publish
 * step a real deployment runs after Authorbot commits an accepted edit.
 */
export async function rebuildSite(): Promise<void> {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "build-sites.mjs");
  await execFileAsync(
    process.execPath,
    [
      script,
      JSON.stringify({
        repoDir: repoDir(),
        siteDir: siteDir(),
        plainDir: plainDir(),
        // Same-origin only (ADR-0019 §5): the site is served from the origin
        // that also answers /v1/*, so the API base is simply the root.
        apiUrl: "/",
      }),
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

/**
 * Poll the annotation read until its git operation lands and it becomes
 * `open` — a freshly seeded annotation is `pending_git` and cannot be voted
 * on until the inline mirror commits it.
 */
export async function waitForAnnotationOpen(annotationId: string, cookie: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fetch(
      `${apiUrl()}/v1/projects/${PROJECT}/annotations/${annotationId}`,
      { headers: { cookie } },
    );
    if (response.ok) {
      const body = (await response.json()) as { status?: string };
      if (body.status === "open") {
        return;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`annotation ${annotationId} did not reach "open" within 15s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
