/**
 * Global setup for the Phase 2b e2e (contract §5). In order:
 *
 *   1. temp book repo - copy examples/book-repo, `git init` + commit, so the
 *      dev API's LocalGitAdapter mirror has a real work tree to commit into;
 *   2. static server first (ephemeral port) - its origin must be known before
 *      the site is built, and it is the ONE origin everything is served from:
 *      it reverse-proxies `/v1/*` to the API (ADR-0019, same-origin only);
 *   3. Phase 2 Node dev API (apps/api dist/dev-server.js as a child process):
 *      dev auth, temp SQLite file, inline mirror, reachable only through the
 *      static server's proxy;
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
import { BASE_PATH, createTempBookRepo, ENV, freePort, startStaticServer } from "./helpers.js";

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
      throw new Error(`missing ${file} - run \`${hint}\` first (or the root: pnpm test:e2e)`);
    });
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "authorbot-e2e-ui-"));
  const repoDir = path.join(tmp, "book-repo");
  const siteDir = path.join(tmp, "site");
  const plainDir = path.join(tmp, "site-plain");
  // The base-path deployment (ADR-0019 §6) gets its own repo, database and
  // output tree so the two deployments cannot observe each other's commits.
  const baseRepoDir = path.join(tmp, "base-book-repo");
  const baseSiteDir = path.join(tmp, "base-site");
  const servers: Awaited<ReturnType<typeof startStaticServer>>[] = [];
  const apiProcesses: ChildProcess[] = [];

  /** Spawn the Node dev API against `repo`, optionally under a base path. */
  const startApi = async (options: {
    repo: string;
    sqlite: string;
    port: number;
    allowedHosts: readonly string[];
    basePath?: string;
  }): Promise<ChildProcess> => {
    const child = spawn(process.execPath, [devServerJs], {
      env: {
        ...process.env,
        BOOK_REPO_PATH: options.repo,
        AUTH_MODE: "dev",
        DEV_LOGIN_ENABLED: "true",
        SESSION_SECRET: "e2e-session-secret",
        WEBHOOK_SECRET: "e2e-webhook-secret",
        PROJECT_SLUG: "hollow-creek-anomaly",
        PROJECT_REPO: "JoeMattie/causal-projector",
        INITIAL_MAINTAINER: "github:JoeMattie",
        SQLITE_PATH: options.sqlite,
        MIRROR_MODE: "inline",
        // Phase 4 short-lease test config (contract §7): a 5m10s lease sits
        // just above the PT5M renewal-prompt threshold, so the prompt appears
        // ~10 seconds after a claim and the e2e can watch it happen for real
        // instead of mocking the clock.
        LEASE_DURATION: "PT5M10S",
        LEASE_RENEWAL_DURATION: "PT30M",
        LEASE_MAX_TOTAL_DURATION: "PT4H",
        // Mirror of examples/book-repo book.yml `show_public_annotations: true`
        // (contract §2.1): signed-out readers get read-only annotation lists.
        PUBLIC_ANNOTATIONS: "true",
        PORT: String(options.port),
        ALLOWED_HOSTS: options.allowedHosts.join(","),
        ...(options.basePath === undefined ? {} : { API_BASE_PATH: options.basePath }),
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    apiProcesses.push(child);
    return child;
  };

  const teardown = async (): Promise<void> => {
    for (const { server } of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const apiProcess of apiProcesses) {
      await new Promise<void>((resolve) => {
        if (apiProcess.exitCode !== null) {
          resolve();
          return;
        }
        apiProcess.once("exit", () => resolve());
        apiProcess.kill("SIGTERM");
        setTimeout(() => {
          apiProcess.kill("SIGKILL");
          resolve();
        }, 3_000).unref();
      });
    }
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
  // 1. temp git book repos (one per deployment)
  await createTempBookRepo(exampleRepo, repoDir);
  await createTempBookRepo(exampleRepo, baseRepoDir);

  // 2. static origins first (roots are attached after the builds)
  const site = await startStaticServer();
  servers.push(site);
  const baseSite = await startStaticServer({ apiPrefix: `${BASE_PATH}/v1` });
  servers.push(baseSite);

  // 3. Phase 2 Node dev API per deployment, as child processes
  const apiPort = await freePort();
  await startApi({
    repo: repoDir,
    sqlite: path.join(tmp, "e2e.sqlite"),
    port: apiPort,
    allowedHosts: [
      `127.0.0.1:${String(apiPort)}`,
      `localhost:${String(apiPort)}`,
      new URL(site.origin).host,
    ],
  });
  await waitForApi(`http://127.0.0.1:${apiPort}`);
  // The site origin now answers /v1/* too - one origin, as deployed.
  site.setApiTarget({ host: "127.0.0.1", port: apiPort });
  await waitForApi(site.origin);

  // The base-path API mounts every route under API_BASE_PATH, the mirror
  // image of the site's `publication.api_url` (ADR-0019 §6).
  const baseApiPort = await freePort();
  await startApi({
    repo: baseRepoDir,
    sqlite: path.join(tmp, "e2e-base.sqlite"),
    port: baseApiPort,
    allowedHosts: [
      `127.0.0.1:${String(baseApiPort)}`,
      `localhost:${String(baseApiPort)}`,
      new URL(baseSite.origin).host,
    ],
    basePath: BASE_PATH,
  });
  await waitForApi(`http://127.0.0.1:${baseApiPort}${BASE_PATH}`);
  baseSite.setApiTarget({ host: "127.0.0.1", port: baseApiPort });
  await waitForApi(`${baseSite.origin}${BASE_PATH}`);

  // 4. build the sites: collab-enabled (served) + api-url-less (regression),
  // then the base-path deployment. `api_url: "/"` is the only accepted shape
  // at the origin root; a base path uses its own prefix (ADR-0019 §5-§6).
  await execFileAsync(
    process.execPath,
    [buildSitesJs, JSON.stringify({ repoDir, siteDir, plainDir, apiUrl: "/" })],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  site.setRoot(siteDir);

  await execFileAsync(
    process.execPath,
    [
      buildSitesJs,
      JSON.stringify({
        repoDir: baseRepoDir,
        siteDir: baseSiteDir,
        apiUrl: BASE_PATH,
        baseUrl: `${baseSite.origin}${BASE_PATH}`,
      }),
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  // buildSite nests a base-path tree under the prefix (so files match the
  // URLs they are linked by), which is exactly what the served root expects:
  // point the server at the un-nested outDir and `/my-book/` resolves.
  baseSite.setRoot(baseSiteDir);

  // 5. hand the handles to the workers. The API url IS the site url: the
  //    helpers' direct `fetch` calls go through the same origin the browser
  //    uses, so their Origin headers satisfy the CSRF check for real.
  process.env[ENV.siteUrl] = site.origin;
  process.env[ENV.apiUrl] = site.origin;
  process.env[ENV.plainDir] = plainDir;
  process.env[ENV.repoDir] = repoDir;
  process.env[ENV.siteDir] = siteDir;
  process.env[ENV.baseSiteUrl] = baseSite.origin;
  process.env[ENV.baseRepoDir] = baseRepoDir;

  return teardown;
  }
}
