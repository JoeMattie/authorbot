import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createNodeDevApi,
  discoverMigrationsDir,
  serveNodeDevApi,
  type NodeDevApi,
} from "@authorbot/api/local";
import { roleEditorialCapabilities } from "@authorbot/domain";
import { buildSite, startDevSite, type DevSite } from "@authorbot/publisher";
import { parse as parseYaml } from "yaml";
import { validateBookRepo } from "./validate/index.js";
import type { CliIo } from "./cli.js";
import { DEV_USAGE } from "./dev-usage.js";

interface BookIdentity {
  root: string;
  commonDir: string;
  id: string;
  slug: string;
  title: string;
  defaultBranch: string;
  repository: string;
}

interface DevManifest {
  schema: "authorbot.local/v1";
  bookId: string;
  bookSlug: string;
  repositoryCommonDir: string;
  originalRepo: string;
  baseBranch: string;
  baseSha: string;
  managedBranch: string;
  worktree: string;
  sourceIdentity: string;
  migrationChecksums: Record<string, string>;
  sandbox: boolean;
  promoteBook: boolean;
  pid: number | null;
  url: string | null;
  startedAt: string | null;
  projection: "ready" | "reconciling" | "error";
  projectionError: string | null;
  buildError: string | null;
}

interface DevPaths {
  root: string;
  manifest: string;
  database: string;
  secrets: string;
  bootstrap: string;
  agentEnv: string;
  lock: string;
  build: string;
  worktree: string;
}

interface BootstrapState {
  tokenHash: string;
  used: boolean;
  createdAt: string;
}

interface Secrets {
  sessionSecret: string;
  webhookSecret: string;
  bootstrapToken: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

const SOURCE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CLI_PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function exec(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              `${command} ${args[0] ?? ""} failed: ${stderr.trim() || stdout.trim() || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

function stateHome(): string {
  const configured = process.env["XDG_STATE_HOME"];
  return configured !== undefined && configured !== ""
    ? configured
    : path.join(homedir(), ".local", "state");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readBookIdentity(target: string): Promise<BookIdentity> {
  const root = await realpath(path.resolve(target));
  const top = await git(root, "rev-parse", "--show-toplevel");
  if (path.resolve(top) !== root) {
    throw new Error(`book path must be the repository root (found ${top})`);
  }
  const source = await readFile(path.join(root, "book.yml"), "utf8");
  const parsed = parseYaml(source) as {
    id?: unknown;
    slug?: unknown;
    title?: unknown;
    repository?: { default_branch?: unknown };
  };
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.slug !== "string" ||
    typeof parsed.title !== "string"
  ) {
    throw new Error("book.yml must define string id, slug, and title fields");
  }
  const defaultBranch =
    typeof parsed.repository?.default_branch === "string"
      ? parsed.repository.default_branch
      : "main";
  const commonRaw = await git(root, "rev-parse", "--git-common-dir");
  const commonDir = await realpath(path.resolve(root, commonRaw));
  let repository = `local/${parsed.slug}`;
  try {
    const remote = await git(root, "remote", "get-url", "origin");
    const match = remote.match(/(?:github\.com[:/])([^/]+\/[^/.]+)(?:\.git)?$/u);
    if (match?.[1] !== undefined) repository = match[1];
  } catch {
    // A local-only repository needs no remote until `dev pr`.
  }
  return {
    root,
    commonDir,
    id: parsed.id,
    slug: parsed.slug,
    title: parsed.title,
    defaultBranch,
    repository,
  };
}

function pathsFor(book: BookIdentity): DevPaths {
  const discriminator = hash(book.commonDir).slice(0, 12);
  const root = path.join(stateHome(), "authorbot", "books", `${book.id}-${discriminator}`);
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    database: path.join(root, "authorbot.sqlite"),
    secrets: path.join(root, "secrets.json"),
    bootstrap: path.join(root, "bootstrap.json"),
    agentEnv: path.join(root, "agent.env"),
    lock: path.join(root, "session.lock"),
    build: path.join(root, "production-build"),
    worktree: path.join(root, "worktree"),
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivate(file: string, value: string): Promise<void> {
  await writeFile(file, value, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

async function writeManifest(paths: DevPaths, manifest: DevManifest): Promise<void> {
  const temporary = `${paths.manifest}.${String(process.pid)}.${randomUUID()}.tmp`;
  await writePrivate(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporary, paths.manifest);
}

async function migrationChecksums(): Promise<Record<string, string>> {
  const dir = discoverMigrationsDir();
  const names = (await import("node:fs/promises")).readdir(dir);
  const result: Record<string, string> = {};
  for (const name of (await names).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    result[name] = hash(await readFile(path.join(dir, name), "utf8"));
  }
  return result;
}

async function sourceIdentity(sourcePath?: string): Promise<string> {
  const root = sourcePath ?? SOURCE_ROOT;
  try {
    const head = await git(root, "rev-parse", "HEAD");
    const dirty = (await git(root, "status", "--porcelain", "--untracked-files=normal")) !== "";
    return `git:${head}${dirty ? "+dirty" : ""}`;
  } catch {
    const pkg = JSON.parse(await readFile(path.join(CLI_PACKAGE_ROOT, "package.json"), "utf8")) as {
      version?: string;
    };
    return `npm:${pkg.version ?? "unknown"}`;
  }
}

async function ensureSession(
  book: BookIdentity,
  paths: DevPaths,
  options: { sourcePath?: string; sandbox: boolean; promoteBook: boolean; fresh: boolean },
): Promise<DevManifest> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  const identity = await sourceIdentity(options.sourcePath);
  const checksums = await migrationChecksums();
  const existing = await readJson<DevManifest>(paths.manifest);
  if (existing !== null) {
    if (
      existing.bookId !== book.id ||
      existing.repositoryCommonDir !== book.commonDir ||
      existing.originalRepo !== book.root
    ) {
      throw new Error("local state belongs to a different repository; refusing to reuse it");
    }
    const changedAppliedMigration = Object.entries(existing.migrationChecksums).some(
      ([name, checksum]) => checksums[name] !== checksum,
    );
    if (changedAppliedMigration) {
      const databaseExists = await stat(paths.database).then(() => true).catch(() => false);
      if (databaseExists && !options.fresh) {
        throw new Error(
          "an Authorbot migration already bound to this local database changed; run `authorbot dev reset --yes`",
        );
      }
    }
    // Newly added migrations are compatible and will be applied at startup.
    // A reset also intentionally permits rebinding the empty database.
    existing.migrationChecksums = checksums;
    if (existing.sourceIdentity !== identity) {
      existing.sourceIdentity = identity;
    }
    existing.promoteBook ||= options.promoteBook;
    await writeManifest(paths, existing);
    return existing;
  }

  const baseSha = await git(book.root, "rev-parse", `refs/heads/${book.defaultBranch}`);
  const managedBranch = `authorbot/local/${book.slug}-${hash(book.commonDir).slice(0, 8)}`;
  try {
    await stat(paths.worktree);
    throw new Error(`unmanaged path already exists at ${paths.worktree}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await exec(
    "git",
    ["worktree", "add", "-b", managedBranch, paths.worktree, book.defaultBranch],
    { cwd: book.root },
  );
  const manifest: DevManifest = {
    schema: "authorbot.local/v1",
    bookId: book.id,
    bookSlug: book.slug,
    repositoryCommonDir: book.commonDir,
    originalRepo: book.root,
    baseBranch: book.defaultBranch,
    baseSha,
    managedBranch,
    worktree: paths.worktree,
    sourceIdentity: identity,
    migrationChecksums: checksums,
    sandbox: options.sandbox,
    promoteBook: options.promoteBook,
    pid: null,
    url: null,
    startedAt: null,
    projection: "ready",
    projectionError: null,
    buildError: null,
  };
  await writeManifest(paths, manifest);
  return manifest;
}

function processIsAlive(pid: number | null): boolean {
  if (pid === null || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireLock(paths: DevPaths): Promise<() => Promise<void>> {
  const prior = await readJson<{ pid: number }>(paths.lock);
  if (prior !== null && processIsAlive(prior.pid)) {
    throw new Error(`local authoring is already running as PID ${String(prior.pid)}`);
  }
  if (prior !== null) await unlink(paths.lock);
  const handle = await open(paths.lock, "wx", 0o600);
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
  await handle.close();
  return async () => {
    const current = await readJson<{ pid: number }>(paths.lock);
    if (current?.pid === process.pid) await unlink(paths.lock).catch(() => undefined);
  };
}

async function ensureSecrets(paths: DevPaths): Promise<Secrets> {
  const existing = await readJson<Secrets>(paths.secrets);
  if (existing !== null) {
    const bootstrap = await readJson<BootstrapState>(paths.bootstrap);
    if (bootstrap !== null && !bootstrap.used) return existing;
    existing.bootstrapToken = randomBytes(32).toString("base64url");
    await writePrivate(paths.secrets, `${JSON.stringify(existing, null, 2)}\n`);
    await writePrivate(
      paths.bootstrap,
      `${JSON.stringify({
        tokenHash: hash(existing.bootstrapToken),
        used: false,
        createdAt: new Date().toISOString(),
      } satisfies BootstrapState, null, 2)}\n`,
    );
    return existing;
  }
  const secrets: Secrets = {
    sessionSecret: randomBytes(32).toString("base64url"),
    webhookSecret: randomBytes(32).toString("base64url"),
    bootstrapToken: randomBytes(32).toString("base64url"),
  };
  await writePrivate(paths.secrets, `${JSON.stringify(secrets, null, 2)}\n`);
  await writePrivate(
    paths.bootstrap,
    `${JSON.stringify({
      tokenHash: hash(secrets.bootstrapToken),
      used: false,
      createdAt: new Date().toISOString(),
    } satisfies BootstrapState, null, 2)}\n`,
  );
  return secrets;
}

async function isDirty(worktree: string): Promise<boolean> {
  return (await git(worktree, "status", "--porcelain", "--untracked-files=all")) !== "";
}

async function branchState(
  manifest: DevManifest,
): Promise<{ ok: boolean; branch: string; head: string }> {
  let branch = "(detached HEAD)";
  try {
    branch = await git(manifest.worktree, "symbolic-ref", "--short", "--quiet", "HEAD");
  } catch {
    // Report detached explicitly.
  }
  const head = await git(manifest.worktree, "rev-parse", "HEAD");
  return { ok: branch === manifest.managedBranch, branch, head };
}

async function internalLogin(
  devApi: NodeDevApi,
  login: string,
): Promise<string> {
  const response = await devApi.api.app.fetch(
    new Request("http://localhost/v1/dev/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ login, role: "maintainer" }),
    }),
  );
  if (!response.ok) {
    throw new Error(`local maintainer login failed (${String(response.status)}): ${await response.text()}`);
  }
  const cookie = response.headers.getSetCookie()[0];
  if (cookie === undefined) throw new Error("local maintainer login returned no session cookie");
  return cookie.split(";", 1)[0] ?? cookie;
}

async function ensureStarterToken(
  devApi: NodeDevApi,
  book: BookIdentity,
  paths: DevPaths,
  login: string,
  publicUrl: string,
): Promise<void> {
  const existing = await readFile(paths.agentEnv, "utf8").catch(() => null);
  const existingToken = existing?.match(/^export AUTHORBOT_TOKEN='([^']+)'$/mu)?.[1];
  if (existing !== null && existingToken !== undefined) {
    const check = await devApi.api.app.fetch(
      new Request("http://localhost/v1/me", {
        headers: { authorization: `Bearer ${existingToken}` },
      }),
    );
    if (check.ok) {
      await writePrivate(
        paths.agentEnv,
        existing.replace(
          /^export AUTHORBOT_API='[^']*'$/mu,
          `export AUTHORBOT_API='${publicUrl}'`,
        ),
      );
      return;
    }
  }

  const cookie = await internalLogin(devApi, login);
  const response = await devApi.api.app.fetch(
    new Request(`http://localhost/v1/projects/${encodeURIComponent(book.slug)}/agent-tokens`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "http://localhost",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify({
        name: "Local collaborator",
        capabilities: roleEditorialCapabilities("editor"),
        expiresInDays: 90,
      }),
    }),
  );
  if (!response.ok) {
    throw new Error(`starter token creation failed (${String(response.status)}): ${await response.text()}`);
  }
  const payload = await response.json() as { token?: unknown };
  if (typeof payload.token !== "string") {
    throw new Error("starter token creation returned no plaintext token");
  }
  await writePrivate(
    paths.agentEnv,
    [
      "# Generated by Authorbot. Keep this file private and outside the book checkout.",
      `export AUTHORBOT_API='${publicUrl}'`,
      `export AUTHORBOT_PROJECT='${book.slug}'`,
      `export AUTHORBOT_TOKEN='${payload.token}'`,
      "",
    ].join("\n"),
  );
}

async function resetOperationalState(paths: DevPaths): Promise<void> {
  for (const file of [paths.database, `${paths.database}-shm`, `${paths.database}-wal`, paths.secrets, paths.bootstrap, paths.agentEnv]) {
    await rm(file, { force: true });
  }
}

async function startLocal(
  book: BookIdentity,
  paths: DevPaths,
  manifest: DevManifest,
  options: { port: number; open: boolean; fresh: boolean },
  io: CliIo,
  releaseLock: () => Promise<void>,
): Promise<number> {
  let apiServer: ReturnType<typeof serveNodeDevApi> | null = null;
  let devApi: NodeDevApi | null = null;
  let site: DevSite | null = null;
  try {
    if (options.fresh) await resetOperationalState(paths);
    const branch = await branchState(manifest);
    if (!branch.ok) {
      throw new Error(
        `managed worktree is on ${branch.branch}, expected ${manifest.managedBranch}; refusing to reset it`,
      );
    }
    const secrets = await ensureSecrets(paths);
    const maintainerLogin = `owner-${hash(book.commonDir).slice(0, 12)}`;
    const displayName =
      (await git(book.root, "config", "--get", "user.name").catch(() => "")) || "Local maintainer";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BOOK_REPO_PATH: manifest.worktree,
      AUTH_MODE: "dev",
      DEV_LOGIN_ENABLED: "true",
      SESSION_SECRET: secrets.sessionSecret,
      WEBHOOK_SECRET: secrets.webhookSecret,
      PROJECT_SLUG: book.slug,
      PROJECT_REPO: book.repository,
      INITIAL_MAINTAINER: `local:${maintainerLogin}`,
      INITIAL_MAINTAINER_DISPLAY_NAME: displayName,
      LOCAL_ACTOR_NAMESPACE: "local",
      DEFAULT_BRANCH: manifest.managedBranch,
      SQLITE_PATH: paths.database,
      MIRROR_MODE: "inline",
    };
    const activeDevApi = await createNodeDevApi(env);
    devApi = activeDevApi;
    await chmod(paths.database, 0o600);
    let lastHead = branch.head;
    let projectionError: string | null = null;
    const bootstrapPath = `/__authorbot/bootstrap/${secrets.bootstrapToken}`;
    const cookieName = `authorbot_session_${hash(book.commonDir).slice(0, 12)}`;

    const beforeRequest = async (request: Request): Promise<Response | null> => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/dev/login") {
        return new Response("not found", { status: 404 });
      }
      if (url.pathname.startsWith("/__authorbot/bootstrap/")) {
        const supplied = url.pathname.slice("/__authorbot/bootstrap/".length);
        const state = await readJson<BootstrapState>(paths.bootstrap);
        if (
          state === null ||
          state.used ||
          hash(supplied) !== state.tokenHash
        ) {
          return new Response("bootstrap link is invalid or has already been used", { status: 410 });
        }
        state.used = true;
        await writePrivate(paths.bootstrap, `${JSON.stringify(state, null, 2)}\n`);
        const cookie = await internalLogin(activeDevApi, maintainerLogin);
        return new Response(null, {
          status: 303,
          headers: { location: "/", "set-cookie": `${cookie}; Path=/; HttpOnly; SameSite=Lax` },
        });
      }
      if (MUTATING_METHODS.has(request.method) && url.pathname !== "/v1/auth/logout") {
        const current = await branchState(manifest);
        if (!current.ok) {
          return Response.json(
            {
              type: "about:blank",
              title: "Local worktree branch changed",
              detail: `expected ${manifest.managedBranch}, found ${current.branch}`,
              code: "local-wrong-branch",
            },
            { status: 409 },
          );
        }
        if (projectionError !== null || await isDirty(manifest.worktree)) {
          return Response.json(
            {
              type: "about:blank",
              title: "Local Git state needs attention",
              detail:
                projectionError ??
                "API writes are paused while the managed worktree has uncommitted editor changes. Commit them explicitly to continue.",
              code: "local-git-state",
            },
            { status: 409 },
          );
        }
      }
      return null;
    };

    apiServer = serveNodeDevApi(activeDevApi, {
      port: 0,
      allowedHosts: [
        `localhost:${String(options.port)}`,
        `127.0.0.1:${String(options.port)}`,
      ],
      sessionCookieName: cookieName,
      beforeRequest,
    });
    await once(apiServer, "listening");
    const address = apiServer.address();
    if (typeof address !== "object" || address === null) throw new Error("local API did not bind");
    const apiTarget = `http://127.0.0.1:${String(address.port)}`;

    const status = async (): Promise<Record<string, unknown>> => {
      const current = await branchState(manifest);
      const dirty = await isDirty(manifest.worktree);
      return {
        url: manifest.url,
        pid: process.pid,
        branch: current.branch,
        worktree: manifest.worktree,
        source: manifest.sourceIdentity,
        dirty,
        projection: projectionError === null ? "ready" : "error",
        projectionError,
        buildError: manifest.buildError,
        statePath: paths.root,
        agentEnv: paths.agentEnv,
      };
    };
    site = await startDevSite({
      repoPath: manifest.worktree,
      port: options.port,
      apiTarget,
      bootstrapPath,
      status,
      onWarning: (message: string) => {
        io.err(`authorbot dev: ${message}`);
      },
      onBuildState: (error) => {
        manifest.buildError = error;
        void writeManifest(paths, manifest);
      },
    });
    manifest.pid = process.pid;
    manifest.url = site.url;
    manifest.startedAt = new Date().toISOString();
    manifest.projection = "ready";
    manifest.projectionError = null;
    await writeManifest(paths, manifest);
    await ensureStarterToken(activeDevApi, book, paths, maintainerLogin, site.url);

    const timer = setInterval(() => {
      void (async () => {
        const current = await branchState(manifest);
        if (!current.ok || await isDirty(manifest.worktree) || current.head === lastHead) return;
        const forward = await exec(
          "git",
          ["merge-base", "--is-ancestor", lastHead, current.head],
          { cwd: manifest.worktree },
        ).then(() => true).catch(() => false);
        if (!forward) {
          projectionError = `branch moved backwards or was reset (${lastHead.slice(0, 8)} to ${current.head.slice(0, 8)}); local mode will not reconcile it`;
          manifest.projection = "error";
          manifest.projectionError = projectionError;
          await writeManifest(paths, manifest);
          return;
        }
        manifest.projection = "reconciling";
        await writeManifest(paths, manifest);
        try {
          await activeDevApi.api.reconcile({ acceptRepository: true });
          lastHead = current.head;
          projectionError = null;
          manifest.projection = "ready";
          manifest.projectionError = null;
        } catch (error) {
          projectionError = error instanceof Error ? error.message : String(error);
          manifest.projection = "error";
          manifest.projectionError = projectionError;
        }
        await writeManifest(paths, manifest);
      })();
    }, 500);
    timer.unref();

    io.out(`Authorbot local authoring: ${site.url}`);
    io.out(`Branch: ${manifest.managedBranch}`);
    io.out(`Worktree: ${manifest.worktree}`);
    io.out(`One-use maintainer sign-in: ${site.url}${bootstrapPath}`);
    io.out(`Agent environment: authorbot dev agent-env ${book.root}`);

    if (options.open) {
      const child = spawn("xdg-open", [`${site.url}${bootstrapPath}`], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }

    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    clearInterval(timer);
    return 0;
  } finally {
    manifest.pid = null;
    manifest.startedAt = null;
    await writeManifest(paths, manifest).catch(() => undefined);
    if (site !== null) {
      await Promise.race([
        site.stop().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    if (apiServer !== null) {
      const server = apiServer;
      await Promise.race([
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    devApi?.close();
    await releaseLock();
  }
}

async function statusCommand(
  book: BookIdentity,
  paths: DevPaths,
  json: boolean,
  io: CliIo,
): Promise<number> {
  const manifest = await readJson<DevManifest>(paths.manifest);
  if (manifest === null) {
    io.err("authorbot: no local authoring session exists for this book");
    return 1;
  }
  const current = await branchState(manifest);
  const result = {
    running: processIsAlive(manifest.pid),
    url: manifest.url,
    pid: manifest.pid,
    branch: current.branch,
    expectedBranch: manifest.managedBranch,
    head: current.head,
    worktree: manifest.worktree,
    source: manifest.sourceIdentity,
    dirty: await isDirty(manifest.worktree),
    projection: manifest.projection,
    projectionError: manifest.projectionError,
    buildError: manifest.buildError,
    localState: paths.root,
    agentEnv: paths.agentEnv,
    sandbox: manifest.sandbox,
  };
  if (json) {
    io.out(JSON.stringify(result, null, 2));
  } else {
    for (const [key, value] of Object.entries(result)) {
      io.out(`${key}: ${value === null ? "-" : String(value)}`);
    }
  }
  return result.running ? 0 : 1;
}

async function resetCommand(paths: DevPaths, confirmed: boolean, io: CliIo): Promise<number> {
  const manifest = await readJson<DevManifest>(paths.manifest);
  if (manifest === null) {
    io.err("authorbot: no local authoring session exists for this book");
    return 1;
  }
  if (processIsAlive(manifest.pid)) {
    io.err(`authorbot: stop PID ${String(manifest.pid)} before resetting local state`);
    return 1;
  }
  if (!confirmed) {
    io.err(
      `authorbot: reset deletes only ${paths.database}, local sessions, and local tokens. ` +
        "Git is untouched. Re-run with --yes to confirm.",
    );
    return 2;
  }
  const before = await git(manifest.worktree, "status", "--porcelain=v2", "--branch");
  await resetOperationalState(paths);
  const after = await git(manifest.worktree, "status", "--porcelain=v2", "--branch");
  if (before !== after) throw new Error("reset changed Git state; refusing to report success");
  io.out("Local SQLite, sessions, secrets, and tokens were reset. Git was unchanged.");
  return 0;
}

async function prCommand(
  book: BookIdentity,
  paths: DevPaths,
  io: CliIo,
): Promise<number> {
  const manifest = await readJson<DevManifest>(paths.manifest);
  if (manifest === null) throw new Error("no local authoring session exists for this book");
  if (processIsAlive(manifest.pid)) throw new Error("stop local authoring before opening a PR");
  if (manifest.sandbox && !manifest.promoteBook) {
    throw new Error(
      "this source-dogfood book is a sandbox; restart once with --promote-book before `dev pr`",
    );
  }
  const branch = await branchState(manifest);
  if (!branch.ok) throw new Error(`managed worktree is on ${branch.branch}, expected ${manifest.managedBranch}`);
  if (await isDirty(manifest.worktree)) throw new Error("managed worktree is dirty; commit author edits first");
  const report = await validateBookRepo(manifest.worktree);
  if (!report.valid) {
    throw new Error(`book validation failed with ${String(report.errors.length)} error(s)`);
  }
  await rm(paths.build, { recursive: true, force: true });
  await buildSite({ repoPath: manifest.worktree, outDir: paths.build, logLevel: "warn" });
  await exec("git", ["push", "origin", manifest.managedBranch], { cwd: manifest.worktree });
  const existing = await exec(
    "gh",
    ["pr", "list", "--head", manifest.managedBranch, "--state", "open", "--json", "url", "--limit", "1"],
    { cwd: manifest.worktree },
  );
  const rows = JSON.parse(existing.stdout) as Array<{ url?: string }>;
  if (rows[0]?.url !== undefined) {
    io.out(rows[0].url);
    return 0;
  }
  const created = await exec(
    "gh",
    [
      "pr",
      "create",
      "--draft",
      "--base",
      manifest.baseBranch,
      "--head",
      manifest.managedBranch,
      "--title",
      `Authorbot local changes for ${book.title}`,
      "--body",
      "Prepared and production-built by `authorbot dev pr`.",
    ],
    { cwd: manifest.worktree },
  );
  io.out(created.stdout.trim());
  return 0;
}

async function cleanCommand(paths: DevPaths, io: CliIo): Promise<number> {
  const manifest = await readJson<DevManifest>(paths.manifest);
  if (manifest === null) {
    io.out("Nothing to clean.");
    return 0;
  }
  if (processIsAlive(manifest.pid)) throw new Error("stop local authoring before cleaning it");
  let merged = await exec(
    "git",
    ["merge-base", "--is-ancestor", manifest.managedBranch, manifest.baseBranch],
    { cwd: manifest.originalRepo },
  ).then(() => true).catch(() => false);
  if (!merged) {
    merged = await exec(
      "gh",
      [
        "pr",
        "list",
        "--head",
        manifest.managedBranch,
        "--state",
        "merged",
        "--json",
        "mergedAt",
        "--limit",
        "1",
      ],
      { cwd: manifest.originalRepo },
    ).then((result) => {
      const rows = JSON.parse(result.stdout) as Array<{ mergedAt?: string | null }>;
      return typeof rows[0]?.mergedAt === "string";
    }).catch(() => false);
  }
  if (!merged) {
    throw new Error(
      `managed branch ${manifest.managedBranch} is not merged into ${manifest.baseBranch}; cleanup refused`,
    );
  }
  await exec("git", ["worktree", "remove", manifest.worktree], { cwd: manifest.originalRepo });
  await exec("git", ["branch", "-d", manifest.managedBranch], { cwd: manifest.originalRepo });
  await rm(paths.root, { recursive: true });
  io.out(`Removed merged worktree and branch ${manifest.managedBranch}.`);
  return 0;
}

function parsePort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer in 1..65535");
  }
  return port;
}

export async function runDev(args: string[], io: CliIo): Promise<number> {
  type DevSubcommand = "start" | "status" | "agent-env" | "reset" | "pr" | "clean";
  const first = args[0];
  let subcommand: DevSubcommand;
  if (
    first === "status" ||
    first === "agent-env" ||
    first === "reset" ||
    first === "pr" ||
    first === "clean"
  ) {
    subcommand = first;
    args.shift();
  } else {
    subcommand = "start";
  }
  let target = ".";
  let port = 4321;
  let openBrowser = false;
  let fresh = false;
  let json = false;
  let confirmed = false;
  let sourcePath: string | undefined;
  let promoteBook = false;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      continue;
    } else if (arg === "-h" || arg === "--help") {
      io.out(DEV_USAGE);
      return 0;
    }
    if (arg === "--port") {
      port = parsePort(args[++index]);
    } else if (arg === "--open") {
      openBrowser = true;
    } else if (arg === "--fresh") {
      fresh = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--yes") {
      confirmed = true;
    } else if (arg === "--promote-book") {
      promoteBook = true;
    } else if (arg === "--authorbot-source") {
      const value = args[++index];
      if (value === undefined) throw new Error("--authorbot-source requires a checkout path");
      sourcePath = await realpath(path.resolve(value));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) throw new Error("authorbot dev accepts at most one book path");
  if (positionals[0] !== undefined) target = positionals[0];

  if (sourcePath !== undefined && sourcePath !== await realpath(SOURCE_ROOT)) {
    const forwarded = [
      "--dir",
      sourcePath,
      "dev:book",
      "--",
      path.resolve(target),
      "--port",
      String(port),
      ...(openBrowser ? ["--open"] : []),
      ...(fresh ? ["--fresh"] : []),
      ...(promoteBook ? ["--promote-book"] : []),
    ];
    const child = spawn("pnpm", forwarded, {
      stdio: "inherit",
      env: {
        ...process.env,
        AUTHORBOT_SOURCE_DOGFOOD: "1",
        ...(promoteBook ? { AUTHORBOT_PROMOTE_BOOK: "1" } : {}),
      },
    });
    const [code] = await once(child, "exit") as [number | null];
    return code ?? 1;
  }

  const book = await readBookIdentity(target);
  const paths = pathsFor(book);
  if (subcommand === "status") return statusCommand(book, paths, json, io);
  if (subcommand === "agent-env") {
    const source = await readFile(paths.agentEnv, "utf8").catch(() => null);
    if (source === null) {
      io.err("authorbot: no starter agent environment exists; start local authoring first");
      return 1;
    }
    io.out(source.trimEnd());
    return 0;
  }
  if (subcommand === "reset") return resetCommand(paths, confirmed, io);
  if (subcommand === "pr") return prCommand(book, paths, io);
  if (subcommand === "clean") return cleanCommand(paths, io);

  const sandbox =
    process.env["AUTHORBOT_SOURCE_DOGFOOD"] === "1" || sourcePath !== undefined;
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireLock(paths);
  let handedOff = false;
  try {
    const manifest = await ensureSession(book, paths, {
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      sandbox,
      promoteBook: promoteBook || process.env["AUTHORBOT_PROMOTE_BOOK"] === "1",
      fresh,
    });
    handedOff = true;
    return await startLocal(book, paths, manifest, {
      port,
      open: openBrowser,
      fresh,
    }, io, releaseLock);
  } finally {
    if (!handedOff) await releaseLock();
  }
}
