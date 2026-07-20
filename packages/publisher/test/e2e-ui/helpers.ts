/**
 * Shared plumbing for the Phase 2b Playwright e2e (contract §5): a minimal
 * static file server, temp-git-repo creation, and typed access to the
 * environment handles that global-setup passes to the test workers.
 */
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
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
} as const;

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

export const chapterUrl = (slug = "baseline"): string => `${siteUrl()}/chapters/${slug}/`;

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
 * and its origin be known — before the site is built) on an ephemeral port.
 */
export async function startStaticServer(): Promise<{
  server: Server;
  origin: string;
  setRoot: (dir: string) => void;
}> {
  let root: string | null = null;
  const server = createServer((req, res) => {
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

/**
 * Create an annotation directly against the API (dev login + cookie + CSRF
 * Origin header) — for tests that need existing data without driving the UI.
 */
export async function seedAnnotationViaApi(options: {
  login: string;
  body: string;
  chapterSlug?: string;
}): Promise<void> {
  const api = apiUrl();
  const origin = siteUrl();
  const loginResponse = await fetch(`${api}/v1/dev/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ login: options.login, role: "contributor" }),
  });
  if (!loginResponse.ok) {
    throw new Error(`dev login failed: ${loginResponse.status}`);
  }
  const cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

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

  const create = await fetch(
    `${api}/v1/projects/hollow-creek-anomaly/chapters/${chapterId}/annotations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        cookie,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        kind: "comment",
        scope: "block",
        chapterRevision: revision,
        target: { blockId },
        body: options.body,
      }),
    },
  );
  if (create.status !== 202) {
    throw new Error(`seed annotation failed: ${create.status} ${await create.text()}`);
  }
}
