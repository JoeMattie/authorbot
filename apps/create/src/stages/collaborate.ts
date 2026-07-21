/**
 * `collaborate` — the API (Phase 6 contract §3.4 and §4).
 *
 * This is the stage where an author gets sign-in, comments, votes, the work
 * queue, and — the thing that makes the whole wizard's promise true — the
 * "New chapter" button.
 *
 * Two orderings in here are load-bearing rather than incidental:
 *
 * 1. **Migrations run before the deploy** (ADR-0021 §4). The Worker serving
 *    readers keeps serving throughout, so for a few seconds the old code talks
 *    to the new schema. A migration can be written to tolerate that; a Worker
 *    cannot be written to tolerate columns that do not exist yet.
 * 2. **`publication.api_url` is set only after the health checks pass**
 *    (§3.4). That flag is what makes sign-in buttons and annotation gutters
 *    appear on the site. Setting it before the API is known good produces a
 *    published book covered in controls that lead nowhere, which is strictly
 *    worse than a book with none.
 */
import path from "node:path";
import { AbortedError, WizardError } from "../errors.js";
import type { Stage, StageOutcome, WizardContext } from "../context.js";
import { nowIso } from "../context.js";
import { randomToken } from "../ids.js";
import { renderWrangler, type CollaborationSettings } from "../scaffold/wrangler.js";
import { TOOLCHAIN_VERSION } from "../scaffold/render.js";
import { checkGh, ghLogin, requireTool } from "../tools.js";
import { runAuthorbot, runWrangler } from "../toolchain.js";
import {
  GITHUB_API_BASE,
  GITHUB_WEB_BASE,
  runManifestFlow,
  type ManifestConversion,
} from "../github/manifest-flow.js";
import { waitForInstallation } from "../github/installation.js";
import { looksLikeFlag, validateD1Name, validateWorkerName } from "../slug.js";
import {
  readBookIdentity,
  requireBookDirectory,
  resolveSiteUrl,
  setApiUrl,
} from "./shared.js";

/** How long the author has for each browser step before the wizard gives up. */
const BROWSER_STEP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A journal-supplied name, or the fallback — never an unchecked value.
 *
 * Every one of these ends up in an argv slot where the receiving tool would
 * read a leading `-` as the start of an option rather than as a name.
 */
function usableName(
  ctx: WizardContext,
  candidate: string | undefined,
  validate: (value: string) => string | null,
  fallback: string,
  what: string,
): string {
  if (candidate === undefined) {
    return fallback;
  }
  if (validate(candidate) === null && !looksLikeFlag(candidate)) {
    return candidate;
  }
  ctx.reporter.warn(
    `The setup journal records a ${what} that is not a usable name, so "${fallback}" is being used instead.`,
  );
  return fallback;
}

/**
 * The GitHub App's name: `authorbot-<slug>`.
 *
 * GitHub caps this at 34 characters and slugifies it into the app's public
 * handle, which cannot be changed from the wizard and appears on every
 * authorization screen the book's readers see.
 *
 * It used to be `${title} (${slug})`, which GitHub then slugified — so "The
 * Causal Projector (causal-projector)" became the handle
 * `the-causal-causal-projector`: the same words twice, one of them truncated.
 * The title earns nothing here. The slug already identifies the book, is
 * already URL-shaped, and survives slugification unchanged.
 */
export function gitHubAppName(_title: string, slug: string): string {
  const LIMIT = 34;
  const PREFIX = "authorbot-";
  const room = LIMIT - PREFIX.length;
  if (slug.length <= room) {
    return `${PREFIX}${slug}`;
  }
  // Slugs may be up to 64 characters, so this one still needs cutting — at a
  // hyphen, the slug's own word separator, rather than mid-word. Two books
  // whose slugs agree this far collide, and GitHub rejects a duplicate app
  // name outright, which is a better failure than a quietly confusing one.
  const cut = slug.slice(0, room);
  const lastHyphen = cut.lastIndexOf("-");
  return `${PREFIX}${lastHyphen >= 4 ? cut.slice(0, lastHyphen) : cut}`;
}

export const collaborateStage: Stage = async (ctx: WizardContext): Promise<StageOutcome> => {
  ctx.reporter.heading("Turning on collaboration");
  ctx.reporter.explain(
    "This adds sign-in, comments, votes, the work queue, and the New chapter button to your site. It needs a Cloudflare account (the free tier is enough) and one click in your browser to approve an app on your repository. You never type or see a secret.",
  );
  ctx.reporter.explain(
    "Concretely, it adds: a database to remember who commented and what was agreed, a way for readers to sign in with their GitHub account, and permission for your site to commit approved changes back to your book.",
  );

  await requireBookDirectory(ctx);
  const book = await readBookIdentity(ctx);

  // §3.4: "Only offered after `publish` succeeds." A site that is not live has
  // no origin to put the callback URL on, and same-origin is the only shape.
  // Corroborated against the Worker name rather than taken from the journal on
  // trust: this value receives sign-in codes, webhooks, and a maintainer token.
  const siteUrl = await resolveSiteUrl(ctx, ctx.journal.data.publish?.workerName);
  if (siteUrl === undefined) {
    throw new WizardError(
      "Your reading site is not published yet, and collaboration lives on the same address as the site.",
      "Run `create-authorbot publish` first, then run this again.",
    );
  }
  const repo = book.repo;
  if (repo === null) {
    throw new WizardError(
      "This book is not connected to a GitHub repository, and collaboration commits changes to one.",
      "Run `create-authorbot book` to create the repository, then run this again.",
    );
  }
  const gh = await checkGh(ctx.actions);
  requireTool(gh, "collaborate");
  const login = await ghLogin(ctx.actions);
  if (login === null) {
    throw new WizardError(
      "Could not read your GitHub username, and it is needed to make you the first maintainer of your own book.",
      "Run `gh auth login`, then run `create-authorbot collaborate` again.",
    );
  }

  const proceed = await ctx.prompter.confirm({
    id: "collaborate.proceed",
    message: `Set up collaboration for ${book.title} at ${siteUrl}?`,
    hint: "It creates a database and a GitHub App, both of which are listed at the end with how to delete them.",
    defaultValue: true,
  });
  if (!proceed) {
    throw new AbortedError("collaboration was not set up");
  }

  const apiBase = ctx.env.env["AUTHORBOT_GITHUB_API"] ?? GITHUB_API_BASE;
  const webBase = ctx.env.env["AUTHORBOT_GITHUB_WEB"] ?? GITHUB_WEB_BASE;
  // Same reasoning as the database name: this reaches
  // `wrangler secret put NAME --name <workerName>` from the journal without
  // ever passing the prompt's validator, so it is checked here instead.
  const workerName = usableName(
    ctx,
    ctx.journal.data.publish?.workerName,
    validateWorkerName,
    book.slug,
    "Worker name",
  );

  // ---- the Worker code that serves the API --------------------------------

  await installApiPackage(ctx);

  // ---- the database -------------------------------------------------------

  const database = await ensureDatabase(ctx, book.slug);

  // ---- the GitHub App -----------------------------------------------------

  const credentials = await ensureGitHubApp(ctx, {
    appName: gitHubAppName(book.title, book.slug),
    siteUrl,
    repo,
    apiBase,
    webBase,
    workerName,
  });

  // ---- configuration ------------------------------------------------------

  const collaboration: CollaborationSettings = {
    d1Name: database.name,
    d1Id: database.id,
    projectSlug: book.slug,
    projectRepo: repo,
    maintainerLogin: login,
    defaultBranch: book.defaultBranch,
    githubClientId: credentials.clientId,
    redirectUri: `${siteUrl.replace(/\/$/, "")}/v1/auth/github/callback`,
    installationId: credentials.installationId,
    appId: credentials.appId,
    publicAnnotations: book.showPublicAnnotations,
  };

  // The Worker treats its three GitHub App credentials as all-or-nothing, and
  // reports `gitIntegration: "incomplete"` for a partial set — then does no Git
  // work while every read-only route keeps answering perfectly. That is exactly
  // how a dropped app id shipped: the wizard's health check asked /v1/me for a
  // 401, got one, and reported success over an integration that could not
  // commit, project, or read the book's own book.yml.
  //
  // So assert the set is whole here, at the seam where it is assembled, rather
  // than trusting a later check that cannot see it.
  for (const [name, value] of [
    ["app id", collaboration.appId],
    ["installation id", collaboration.installationId],
    ["client id", collaboration.githubClientId],
  ] as const) {
    if (value.trim() === "") {
      throw new WizardError(
        `The GitHub App's ${name} is missing, so the Worker would be deployed with an incomplete credential.`,
        "Nothing was deployed. This is a bug in the wizard rather than something you did — please report it. Deleting the app at https://github.com/settings/apps and running `create-authorbot collaborate` again creates a fresh one.",
      );
    }
  }

  ctx.reporter.step("Updating your Worker configuration");
  await ctx.actions.writeFile({
    filePath: path.join(ctx.directory, "wrangler.jsonc"),
    contents: renderWrangler({
      workerName,
      ...(ctx.journal.data.publish?.customDomain === undefined
        ? {}
        : { customDomain: ctx.journal.data.publish.customDomain }),
      collaboration,
    }),
    purpose: "tells Cloudflare to serve the API from the same address as your site",
  });

  // ---- migrations, then deploy (in that order) ----------------------------

  ctx.reporter.step("Preparing the database");
  const migrate = await runWrangler(
    ctx,
    ["d1", "migrations", "apply", database.name, "--remote"],
    {
      purpose: "create the tables the collaboration features need",
      mutates: true,
      timeoutMs: 300_000,
    },
  );
  if (migrate !== null && migrate.code !== 0) {
    throw new WizardError(
      `Setting up the database failed:\n${(migrate.stderr || migrate.stdout).trim().split("\n").slice(-8).join("\n")}`,
      `Run \`npx wrangler d1 migrations apply ${database.name} --remote\` in ${ctx.directory} to see the full output, then run \`create-authorbot collaborate\` again.`,
    );
  }
  ctx.reporter.ok("Database ready.");

  ctx.reporter.step("Deploying the upgraded site");
  const deploy = await runWrangler(ctx, ["deploy"], {
    purpose: "put the site and its API live on one address",
    mutates: true,
    timeoutMs: 300_000,
  });
  if (deploy !== null && deploy.code !== 0) {
    throw new WizardError(
      `The deploy failed:\n${(deploy.stderr || deploy.stdout).trim().split("\n").slice(-10).join("\n")}`,
      "Your site is still serving the previous version, so readers are unaffected. Fix the problem above and run `create-authorbot collaborate` again.",
    );
  }

  // ---- health checks (before anything on the site points at the API) ------

  if (ctx.actions.dryRun) {
    ctx.actions.note(
      `check: ${siteUrl}/v1/me returns 401, ${siteUrl}/v1/auth/github redirects to GitHub, and the project is seeded with you as maintainer`,
      "Only after all three pass is publication.api_url set and the site rebuilt.",
    );
    ctx.actions.note(
      "edit: book.yml publication.api_url = /",
      "Switches on the sign-in link, annotation gutter, and New chapter button.",
    );
    // In memory only (the journal is read-only in a dry run), so the `agent`
    // stage can plan against the API this would have switched on.
    await ctx.journal.update((data) => {
      data.collaborate = {
        ...data.collaborate,
        d1Name: database.name,
        d1Id: database.id,
        apiVerified: true,
      };
    }, nowIso(ctx));
    return { continue: true, note: "planned only" };
  }

  ctx.reporter.step("Checking the API is really working before switching it on");
  await verifyHealth(ctx, siteUrl, database.name, book.slug, login);
  ctx.reporter.ok("The API answers correctly and knows you are the book's maintainer.");

  await ctx.journal.update((data) => {
    data.collaborate = {
      ...data.collaborate,
      d1Name: database.name,
      d1Id: database.id,
      installationId: credentials.installationId,
      apiVerified: true,
    };
  }, nowIso(ctx));

  // ---- switch the site's controls on --------------------------------------

  ctx.reporter.step("Switching on the collaboration controls");
  const updated = await setApiUrl(ctx, "/");
  await ctx.actions.writeFile({
    filePath: path.join(ctx.directory, "book.yml"),
    contents: updated,
    purpose: "tells your site that the API is live at the same address",
  });

  const rebuild = await runAuthorbot(ctx, ["build", ".", "--out", "_site"], {
    purpose: "rebuild the site with sign-in and the New chapter button",
    mutates: true,
    required: true,
  });
  if (rebuild === null) {
    throw new WizardError(
      "The Authorbot toolchain is not installed, so the site could not be rebuilt.",
      `Run \`npm install\` in ${ctx.directory}, then run \`create-authorbot collaborate\` again.`,
    );
  }
  const redeploy = await runWrangler(ctx, ["deploy"], {
    purpose: "publish the site with its collaboration controls",
    mutates: true,
    timeoutMs: 300_000,
  });
  if (redeploy !== null && redeploy.code !== 0) {
    throw new WizardError(
      `The final deploy failed:\n${(redeploy.stderr || redeploy.stdout).trim().split("\n").slice(-10).join("\n")}`,
      "The API is healthy; only the rebuilt site did not publish. Run `create-authorbot collaborate` again to finish.",
    );
  }

  ctx.reporter.blank();
  ctx.reporter.ok("Collaboration is on.");
  ctx.reporter.info(
    `Go to ${siteUrl}, sign in with GitHub, and press New chapter. You get a plain title-and-prose box — Authorbot writes the frontmatter and the ids for you.`,
  );
  ctx.reporter.info("Commit and push the changed book.yml and wrangler.jsonc when you are ready.");

  return { continue: true, note: "collaboration enabled and verified" };
};

/** Adds `@authorbot/api` to the book, pinned to the same version as the CLI. */
async function installApiPackage(ctx: WizardContext): Promise<void> {
  const marker = path.join(ctx.directory, "node_modules", "@authorbot", "api", "dist", "worker.js");
  if (await ctx.fs.exists(marker)) {
    return;
  }
  ctx.reporter.step("Installing the API your Worker will run");
  ctx.reporter.info(
    "Nothing is compiled: this downloads a prebuilt Worker and the database migrations that shipped with the same version, so your schema and your code can never be different releases.",
  );
  const result = await ctx.actions.run({
    purpose: "install the prebuilt collaboration API",
    command: "npm",
    args: ["install", "--save-dev", `@authorbot/api@${TOOLCHAIN_VERSION}`, "--no-audit", "--no-fund"],
    cwd: ctx.directory,
    mutates: true,
    timeoutMs: 600_000,
  });
  if (result.code !== 0) {
    throw new WizardError(
      `Installing @authorbot/api failed:\n${(result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n")}`,
      `Run \`npm install --save-dev @authorbot/api@${TOOLCHAIN_VERSION}\` in ${ctx.directory} yourself, then run this again.`,
    );
  }
}

interface DatabaseRef {
  readonly name: string;
  readonly id: string;
}

/**
 * Creates the D1 database, or finds the existing one.
 *
 * Idempotency here is not a nicety: a re-run after an interrupted setup must
 * not leave an author paying for two databases, one of which holds their
 * comments and one of which does not.
 */
async function ensureDatabase(ctx: WizardContext, slug: string): Promise<DatabaseRef> {
  const recorded = ctx.journal.data.collaborate;
  // The resume path gets the same check as the prompt, not a weaker one. This
  // name becomes a *positional* argument to `wrangler d1 migrations apply` and
  // `wrangler d1 execute`, where a value like `--config=/tmp/evil.jsonc` is
  // read as a flag rather than a name — wrangler would load someone else's
  // configuration and act on the author's live Cloudflare account. Validating
  // only what was typed left the far more likely path (a journal on disk)
  // unguarded.
  if (recorded?.d1Name !== undefined && recorded.d1Id !== undefined) {
    if (validateD1Name(recorded.d1Name) === null && !looksLikeFlag(recorded.d1Name)) {
      ctx.reporter.info(`Reusing the database created earlier (${recorded.d1Name}).`);
      return { name: recorded.d1Name, id: recorded.d1Id };
    }
    ctx.reporter.warn(
      "The setup journal records a database name that is not a usable name, so it is being ignored.",
    );
  }

  const name = await ctx.prompter.text({
    id: "collaborate.d1Name",
    message: "What should the database be called?",
    hint: "It remembers who commented, what was voted on, and what was agreed. The name is only ever seen by you.",
    defaultValue: `${slug}-authorbot`,
    validate: validateD1Name,
  });

  ctx.reporter.step("Creating the database");
  const created = await runWrangler(ctx, ["d1", "create", name], {
    purpose: "create a database to remember who commented and what was agreed",
    mutates: true,
    timeoutMs: 120_000,
    dryRunStdout: '{ "uuid": "00000000-0000-0000-0000-000000000000" }',
  });
  if (created === null) {
    throw new WizardError(
      "wrangler is not available, so the database cannot be created.",
      `Run \`npm install\` in ${ctx.directory}, then run \`create-authorbot collaborate\` again.`,
    );
  }

  let id = extractDatabaseId(created.stdout + created.stderr);
  if (created.code !== 0) {
    if (!/already exists/i.test(created.stderr + created.stdout)) {
      throw new WizardError(
        `Creating the database failed:\n${(created.stderr || created.stdout).trim().split("\n").slice(-8).join("\n")}`,
        `Run \`npx wrangler d1 create ${name}\` in ${ctx.directory} to see the full output, then run this again.`,
      );
    }
    // Already there: adopt it rather than making a second one. This is the
    // interrupted-run case, and adopting is what makes the stage re-entrant.
    ctx.reporter.info(`A database called ${name} already exists; using it.`);
    id = await lookupDatabaseId(ctx, name);
  }

  if (id === null) {
    throw new WizardError(
      `The database ${name} was created but its id could not be read from wrangler's output.`,
      `Run \`npx wrangler d1 list\` to find its id, add it to wrangler.jsonc yourself, then run \`create-authorbot collaborate\` again.`,
    );
  }

  await ctx.actions.resource({
    kind: "d1-database",
    name,
    description: "The database holding comments, votes, sessions, and the work queue.",
    deleteWith: `wrangler d1 delete ${name}`,
  });
  await ctx.journal.update((data) => {
    data.collaborate = { ...data.collaborate, d1Name: name, d1Id: id };
  }, nowIso(ctx));

  return { name, id };
}

/**
 * Pulls the database id out of `wrangler d1 create` output, which has changed
 * shape across wrangler versions (a JSON block, a TOML snippet, or a bare
 * line). All three are matched rather than pinning to one.
 */
export function extractDatabaseId(output: string): string | null {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const labelled =
    /(?:database_id|"uuid"|uuid)\s*[:=]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/i.exec(
      output,
    );
  if (labelled?.[1] !== undefined) {
    return labelled[1];
  }
  const bare = uuid.exec(output);
  return bare === null ? null : bare[0];
}

async function lookupDatabaseId(ctx: WizardContext, name: string): Promise<string | null> {
  const list = await runWrangler(ctx, ["d1", "list", "--json"], {
    purpose: "find the existing database's id",
    mutates: false,
    timeoutMs: 60_000,
  });
  if (list === null || list.code !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(list.stdout) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry === "object" && entry !== null) {
          const record = entry as Record<string, unknown>;
          if (record["name"] === name) {
            const id = record["uuid"] ?? record["database_id"];
            if (typeof id === "string") {
              return id;
            }
          }
        }
      }
    }
  } catch {
    // Fall through to the regex, which copes with a non-JSON build of wrangler.
  }
  return extractDatabaseId(list.stdout);
}

interface AppCredentials {
  readonly clientId: string;
  readonly installationId: string;
  /**
   * GitHub App id. Read from the manifest conversion, and — until this was
   * fixed — used only to poll for the installation and then dropped, so the
   * Worker never received it and did no Git work at all.
   */
  readonly appId: string;
}

/**
 * The manifest flow, the secret plumbing, and the installation wait.
 *
 * Every secret in here has the same lifetime: it exists as a local variable,
 * goes onto a `wrangler secret put` process's stdin, and is never seen again.
 * They are registered with the vault the instant they arrive, so even an
 * unexpected error message cannot carry one out.
 */
async function ensureGitHubApp(
  ctx: WizardContext,
  options: {
    appName: string;
    siteUrl: string;
    repo: string;
    apiBase: string;
    webBase: string;
    workerName: string;
  },
): Promise<AppCredentials> {
  const already = ctx.journal.data.collaborate;
  if (already?.installationId !== undefined && ctx.journal.hasSecret("GITHUB_APP_PRIVATE_KEY")) {
    // The credentials themselves are gone — they only ever lived in memory —
    // but the client id is public and lives in wrangler.jsonc, so a resumed
    // run reads it back rather than creating a second app.
    const clientId = await readClientIdFromWrangler(ctx);
    if (clientId !== null && already.appId !== undefined) {
      ctx.reporter.info("Reusing the GitHub App created earlier.");
      return { clientId, installationId: already.installationId, appId: already.appId };
    }
  }

  const base = options.siteUrl.replace(/\/$/, "");

  ctx.reporter.blank();
  ctx.reporter.step("Creating a GitHub App for your book");
  ctx.reporter.info(
    "Your browser is about to open. GitHub will show you exactly what the app can do — read your repository's metadata, and write to its contents — and you approve it with one click. The credentials come straight back here and go straight into Cloudflare; they are never displayed or saved to a file.",
  );

  if (ctx.actions.dryRun) {
    ctx.actions.note(
      "browser: create a GitHub App from a manifest, then install it on the repository",
      "The app id, private key, client secret, and webhook secret would be exchanged over a loopback callback and piped into wrangler secrets.",
    );
    for (const name of [
      "GITHUB_CLIENT_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "WEBHOOK_SECRET",
      "SESSION_SECRET",
    ]) {
      await ctx.actions.secretSet(name, `the ${options.workerName} Worker`);
    }
    await ctx.actions.resource({
      kind: "github-app",
      name: options.appName,
      description: "The GitHub App that signs readers in and commits approved changes.",
      deleteWith: "Delete it at https://github.com/settings/apps (Advanced > Delete GitHub App).",
    });
    return {
      clientId: "<created during the real run>",
      installationId: "<created during the real run>",
      appId: "<created during the real run>",
    };
  }

  const conversion: ManifestConversion = await runManifestFlow(
    {
      loopback: ctx.loopback,
      browser: ctx.browser,
      http: ctx.http,
      clock: ctx.clock,
      random: ctx.random,
      githubApiBase: options.apiBase,
      githubWebBase: options.webBase,
    },
    {
      appName: options.appName,
      siteUrl: base,
      callbackUrl: `${base}/v1/auth/github/callback`,
      webhookUrl: `${base}/v1/webhooks/github`,
      timeoutMs: BROWSER_STEP_TIMEOUT_MS,
      onBrowserStep: (url) => {
        ctx.reporter.info("If your browser did not open, go to:");
        ctx.reporter.literal(url);
      },
    },
  );

  // Registered before anything else touches them, including any error path.
  const clientSecret = ctx.vault.register("GITHUB_CLIENT_SECRET", conversion.clientSecret);
  const privateKey = ctx.vault.register("GITHUB_APP_PRIVATE_KEY", conversion.pem);
  const effectiveWebhookSecret = ctx.vault.register("WEBHOOK_SECRET", conversion.webhookSecret);
  const sessionSecret = ctx.vault.register("SESSION_SECRET", randomToken(ctx.random, 48));

  ctx.reporter.ok(`Created the GitHub App "${conversion.slug}".`);
  await ctx.actions.resource({
    kind: "github-app",
    name: conversion.slug,
    description: "The GitHub App that signs readers in and commits approved changes.",
    deleteWith: `Delete it at ${conversion.htmlUrl} (Advanced > Delete GitHub App).`,
  });

  ctx.reporter.step("Storing the credentials in Cloudflare (they are never shown or saved)");
  await putSecret(ctx, options.workerName, "GITHUB_CLIENT_SECRET", clientSecret);
  await putSecret(ctx, options.workerName, "GITHUB_APP_PRIVATE_KEY", privateKey);
  await putSecret(ctx, options.workerName, "WEBHOOK_SECRET", effectiveWebhookSecret);
  await putSecret(ctx, options.workerName, "SESSION_SECRET", sessionSecret);
  await ctx.journal.update((data) => {
    data.collaborate = { ...data.collaborate, appSlug: conversion.slug };
  }, nowIso(ctx));

  // ---- installation -------------------------------------------------------

  const installUrl = `${conversion.htmlUrl}/installations/new`;
  ctx.reporter.blank();
  ctx.reporter.step("Installing the app on your book");
  ctx.reporter.info(
    `One more browser step: choose ${options.repo} on the page that opens. Until the app is installed it can do nothing at all, so the wizard waits here rather than assuming.`,
  );
  ctx.reporter.literal(installUrl);
  await ctx.browser.open(installUrl);

  const installationId = await waitForInstallation(ctx.http, ctx.clock, {
    appId: conversion.appId,
    pem: privateKey,
    repo: options.repo,
    apiBase: options.apiBase,
    timeoutMs: BROWSER_STEP_TIMEOUT_MS,
    installUrl,
  });
  ctx.reporter.ok(`Installed on ${options.repo}.`);

  await ctx.journal.update((data) => {
    data.collaborate = { ...data.collaborate, installationId, appId: conversion.appId };
  }, nowIso(ctx));

  return { clientId: conversion.clientId, installationId, appId: conversion.appId };
}

/**
 * `wrangler secret put NAME --name WORKER`, value on stdin.
 *
 * `--name` targets the Worker regardless of the current directory: without it
 * wrangler may offer to create a *new* Worker and put the secret on the wrong
 * one. The value never appears in argv, which is world-readable in the process
 * table on most systems.
 */
async function putSecret(
  ctx: WizardContext,
  workerName: string,
  name: string,
  value: string,
): Promise<void> {
  // Defence in depth: `workerName` is validated where it is chosen, and this
  // refuses to hand wrangler a "name" that is really an option even if a future
  // path forgets.
  if (validateWorkerName(workerName) !== null || looksLikeFlag(workerName)) {
    throw new WizardError(
      `"${workerName}" is not a usable Cloudflare Worker name, so no credential was sent anywhere.`,
      "Run `create-authorbot publish` and choose a name made of lowercase letters, numbers, and hyphens, then run `create-authorbot collaborate` again.",
    );
  }
  const result = await runWrangler(ctx, ["secret", "put", name, "--name", workerName], {
    purpose: `store ${name} on your Worker`,
    mutates: true,
    stdin: value,
    timeoutMs: 120_000,
  });
  if (result === null) {
    throw new WizardError(
      "wrangler is not available, so the credentials cannot be stored.",
      `Run \`npm install\` in ${ctx.directory} and run \`create-authorbot collaborate\` again.`,
    );
  }
  if (result.code !== 0) {
    // The output is redacted by the reporter, but it is also deliberately not
    // included here: a failed `secret put` sometimes echoes what it received.
    throw new WizardError(
      `Cloudflare would not store ${name} (exit ${String(result.code)}).`,
      `Check that wrangler is signed in (\`npx wrangler whoami\`) and that the Worker "${workerName}" exists, then run \`create-authorbot collaborate\` again.`,
    );
  }
  await ctx.actions.secretSet(name, `the ${workerName} Worker`);
}

async function readClientIdFromWrangler(ctx: WizardContext): Promise<string | null> {
  const file = path.join(ctx.directory, "wrangler.jsonc");
  if (!(await ctx.fs.exists(file))) {
    return null;
  }
  const text = await ctx.fs.readFile(file);
  const match = /"GITHUB_CLIENT_ID"\s*:\s*"([^"]+)"/.exec(text);
  return match?.[1] ?? null;
}

/**
 * The three checks §3.4 requires before the site is allowed to point at the
 * API: it refuses anonymous callers, it can start a sign-in, and it has seeded
 * the project with the author as maintainer.
 */
/**
 * Polls a URL until it answers with `want`, or the deadline passes.
 *
 * Returns the last response either way, so the caller reports what it actually
 * saw rather than a timeout. A request that throws — DNS not resolving here
 * yet, connection refused mid-rollout — counts as "not yet", not as an answer.
 */
async function pollForStatus(
  ctx: WizardContext,
  url: string,
  want: number,
): Promise<{ status: number }> {
  const deadline = ctx.clock.now().getTime() + 45_000;
  let last: { status: number } = { status: 0 };
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await ctx.http.request(url, { timeoutMs: 20_000 });
      last = { status: response.status };
      if (response.status === want) {
        return last;
      }
    } catch {
      // Unreachable from here for now; the deadline decides.
    }
    if (ctx.clock.now().getTime() >= deadline) {
      return last;
    }
    await ctx.clock.sleep(Math.min(2_000 * attempt, 8_000));
  }
}

async function verifyHealth(
  ctx: WizardContext,
  siteUrl: string,
  databaseName: string,
  projectSlug: string,
  login: string,
): Promise<void> {
  const base = siteUrl.replace(/\/$/, "");

  // A Worker that was deployed seconds ago is not reachable everywhere yet, and
  // a hostname created minutes ago may still be cached locally as
  // non-existent. Both produce a confident failure about an API that is
  // perfectly fine — and both have: this check reported "answered 404" on
  // three separate runs that passed on retry with no change to anything.
  //
  // So poll. The deadline is what decides, not the first answer.
  const me = await pollForStatus(ctx, `${base}/v1/me`, 401);
  if (me.status !== 401) {
    throw new WizardError(
      `The API at ${base}/v1/me answered ${String(me.status)} instead of refusing an anonymous caller (401).`,
      "The site was NOT switched over, so nothing your readers see has changed. Run `create-authorbot collaborate` again in a minute; if it persists, check the Worker's logs in the Cloudflare dashboard.",
    );
  }

  // Ask the deployed Worker whether it can actually do Git work, rather than
  // inferring it from a route that answers the same either way.
  //
  // The credential check before the deploy catches a value this wizard
  // dropped. This catches everything after that: a malformed key, an
  // installation that was revoked, an app deleted between runs. In all of
  // those the wizard used to report "The API answers correctly" over a book
  // that could not sync a single chapter, and the author found out three
  // symptoms later.
  const health = await ctx.http.request(`${base}/v1/health`, { timeoutMs: 20_000 });
  if (health.status === 200) {
    let gitIntegration: unknown;
    try {
      gitIntegration = (JSON.parse(health.body) as { gitIntegration?: unknown }).gitIntegration;
    } catch {
      gitIntegration = undefined;
    }
    if (gitIntegration === "incomplete" || gitIntegration === "unconfigured") {
      throw new WizardError(
        `The API is running but reports its GitHub App as "${String(gitIntegration)}", so it cannot commit anything back to your book.`,
        "The site was NOT switched over, so your readers are unaffected. Collaboration would have looked switched on while every chapter silently failed to save. Delete the app at https://github.com/settings/apps and run `create-authorbot collaborate` again to create a fresh one.",
      );
    }
  }
  // A 404 means an older API that predates this endpoint: nothing to assert,
  // and refusing to proceed would be worse than the check being absent.

  const start = await ctx.http.request(`${base}/v1/auth/github`, {
    timeoutMs: 20_000,
    followRedirects: false,
  });
  const location = start.headers["location"] ?? "";
  if (start.status < 300 || start.status >= 400 || !location.includes("client_id=")) {
    throw new WizardError(
      `Signing in does not start correctly: ${base}/v1/auth/github answered ${String(start.status)}.`,
      "The site was NOT switched over, so your readers are unaffected. This usually means the app's client id did not reach the Worker; run `create-authorbot collaborate` again.",
    );
  }
  if (!location.includes("state=")) {
    throw new WizardError(
      "Signing in starts without the security token that protects the sign-in round trip.",
      "The site was NOT switched over. Please report this — it indicates a mismatch between the wizard and the deployed API.",
    );
  }

  const seeded = await runWrangler(
    ctx,
    [
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--json",
      "--command",
      "SELECT p.slug AS slug, a.external_identity AS maintainer FROM projects p " +
        "JOIN project_memberships m ON m.project_id = p.id AND m.role = 'maintainer' AND m.revoked_at IS NULL " +
        "JOIN actors a ON a.id = m.actor_id",
    ],
    { purpose: "confirm your book is registered and you are its maintainer", mutates: false, timeoutMs: 120_000 },
  );
  // §3.4 requires this check to *pass* before the stage declares success, so a
  // read-back that did not happen is a failure rather than a warning. Warning
  // and carrying on set `publication.api_url` — the flag that puts sign-in and
  // the New chapter button in front of readers — on the strength of a check
  // that never ran.
  if (seeded === null || seeded.code !== 0) {
    throw new WizardError(
      "The API answered correctly, but the database could not be read back to confirm that your book is registered with you as its maintainer.",
      "The site was NOT switched over, so your readers are unaffected. Check that wrangler is signed in (`npx wrangler whoami`), then run `create-authorbot collaborate` again — everything already done is skipped.",
    );
  }
  if (!hasMaintainerRow(seeded.stdout, projectSlug, `github:${login}`)) {
    throw new WizardError(
      "The API is running but has not yet registered your book with you as its maintainer.",
      "The site was NOT switched over. Wait a few seconds for the first request to finish setting up, then run `create-authorbot collaborate` again.",
    );
  }
}

/**
 * Whether the read-back contains a row that is *both* this book and this
 * author.
 *
 * The previous test was `text.includes(slug) && text.includes("github:" + login)`
 * over the whole result set, which two unrelated rows satisfy just as well as
 * one correct one — and on a shared database (or simply a second project) that
 * is not a hypothetical. The rows are parsed and matched field by field
 * instead. Parsing rather than adding a `WHERE` also keeps the author's GitHub
 * login out of the SQL string entirely.
 */
export function hasMaintainerRow(stdout: string, slug: string, maintainer: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  return rowsOf(parsed).some(
    (row) => row["slug"] === slug && row["maintainer"] === maintainer,
  );
}

/**
 * `wrangler d1 execute --json` has shipped both shapes across versions: an
 * array of statement results each carrying `results`, and a bare array of rows.
 * Both are unwrapped rather than pinning to whichever one is current.
 */
function rowsOf(parsed: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (Array.isArray(record["results"])) {
      visit(record["results"]);
      return;
    }
    rows.push(record);
  };
  visit(parsed);
  return rows;
}
