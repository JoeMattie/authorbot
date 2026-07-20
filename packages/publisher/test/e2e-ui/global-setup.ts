/**
 * Global setup for the Phase 2b e2e (contract §5). In order:
 *
 *   1. temp book repo — copy examples/book-repo, `git init` + commit, so the
 *      dev API's LocalGitAdapter mirror has a real work tree to commit into;
 *   2. static server first (ephemeral port) — its origin must be known before
 *      the API starts (ALLOWED_ORIGINS) and before the site is built;
 *   3. Phase 2 Node dev API (apps/api dist/dev-server.js as a child process):
 *      dev auth, temp SQLite file, inline mirror, ALLOWED_ORIGINS = the
 *      static origin;
 *   4. `buildSite` twice via a child Node process (Playwright's module loader
 *      breaks Astro's second in-process build): collab-enabled (apiUrl +
 *      devLogin) into the served dir, plus an api-url-less build for the
 *      script-free regression;
 *   5. hand the URLs/dirs to the workers via process.env.
 *
 * Everything lives under one mkdtemp dir removed in teardown; ports are
 * ephemeral, so consecutive runs never collide (repeatability).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createTempBookRepo, ENV, freePort, startStaticServer } from "./helpers.js";

const execFileAsync = promisify(execFile);

const exampleRepo = fileURLToPath(new URL("../../../../examples/book-repo/", import.meta.url));
const devServerJs = fileURLToPath(
  new URL("../../../../apps/api/dist/dev-server.js", import.meta.url),
);
const buildSitesJs = fileURLToPath(new URL("./build-sites.mjs", import.meta.url));
const publisherDist = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

async function waitForApi(origin: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(`${origin}/v1/me`);
      return; // any HTTP response (401 included) means the server is up
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`dev API at ${origin} did not come up within 30s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const [file, hint] of [
    [devServerJs, "pnpm --filter @authorbot/api build"],
    [publisherDist, "pnpm --filter @authorbot/publisher build"],
  ] as const) {
    await stat(file).catch(() => {
      throw new Error(`missing ${file} — run \`${hint}\` first (or the root: pnpm test:e2e)`);
    });
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "authorbot-e2e-ui-"));
  const repoDir = path.join(tmp, "book-repo");
  const siteDir = path.join(tmp, "site");
  const plainDir = path.join(tmp, "site-plain");
  let site: Awaited<ReturnType<typeof startStaticServer>> | null = null;
  let apiProcess: ChildProcess | null = null;

  const teardown = async (): Promise<void> => {
    if (site !== null) {
      const { server } = site;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await new Promise<void>((resolve) => {
      if (apiProcess === null || apiProcess.exitCode !== null) {
        resolve();
        return;
      }
      apiProcess.once("exit", () => resolve());
      apiProcess.kill("SIGTERM");
      const child = apiProcess;
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000).unref();
    });
    await rm(tmp, { recursive: true, force: true });
  };

  try {
    return await setUp();
  } catch (error) {
    // Setup died partway: release the servers and the temp tree it leaked.
    await teardown();
    throw error;
  }

  async function setUp(): Promise<() => Promise<void>> {
  // 1. temp git book repo
  await createTempBookRepo(exampleRepo, repoDir);

  // 2. static origin first (root is attached after the build)
  site = await startStaticServer();

  // 3. Phase 2 Node dev API as a child process
  const apiPort = await freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  apiProcess = spawn(process.execPath, [devServerJs], {
    env: {
      ...process.env,
      BOOK_REPO_PATH: repoDir,
      AUTH_MODE: "dev",
      DEV_LOGIN_ENABLED: "true",
      SESSION_SECRET: "e2e-session-secret",
      WEBHOOK_SECRET: "e2e-webhook-secret",
      PROJECT_SLUG: "hollow-creek-anomaly",
      PROJECT_REPO: "JoeMattie/causal-projector",
      INITIAL_MAINTAINER: "github:JoeMattie",
      SQLITE_PATH: path.join(tmp, "e2e.sqlite"),
      MIRROR_MODE: "inline",
      // Phase 4 short-lease test config (contract §7): a 5m10s lease sits
      // just above the PT5M renewal-prompt threshold, so the prompt appears
      // ~10 seconds after a claim and the e2e can watch it happen for real
      // instead of mocking the clock.
      LEASE_DURATION: "PT5M10S",
      LEASE_RENEWAL_DURATION: "PT30M",
      LEASE_MAX_TOTAL_DURATION: "PT4H",
      ALLOWED_ORIGINS: site.origin,
      // Mirror of examples/book-repo book.yml `show_public_annotations: true`
      // (contract §2.1): signed-out readers get read-only annotation lists.
      PUBLIC_ANNOTATIONS: "true",
      PORT: String(apiPort),
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForApi(apiOrigin);

  // 4. build the site: collab-enabled (served) + api-url-less (regression)
  await execFileAsync(
    process.execPath,
    [buildSitesJs, JSON.stringify({ repoDir, siteDir, plainDir, apiUrl: apiOrigin })],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  site.setRoot(siteDir);

  // 5. hand the handles to the workers
  process.env[ENV.siteUrl] = site.origin;
  process.env[ENV.apiUrl] = apiOrigin;
  process.env[ENV.plainDir] = plainDir;
  process.env[ENV.repoDir] = repoDir;
  process.env[ENV.siteDir] = siteDir;

  return teardown;
  }
}
