/**
 * `publish` - the reading site (Phase 6 contract §3.3).
 *
 * Cloudflare only (ADR-0020), so there is no host question to ask. The stage
 * is not complete until the site actually loads: a deploy command that exits
 * zero is not evidence that a reader can reach the book, and reporting success
 * on that basis is how an author ends up sharing a URL that 404s.
 */
import path from "node:path";
import { WizardError } from "../errors.js";
import type { Stage, StageOutcome, WizardContext } from "../context.js";
import { nowIso } from "../context.js";
import { looksLikeFlag, validateRepo, validateWorkerName } from "../slug.js";
import { renderWrangler } from "../scaffold/wrangler.js";
import { TOOLCHAIN_VERSION } from "../scaffold/render.js";
import { checkGh, checkWrangler, requireTool } from "../tools.js";
import { runAuthorbot, runWrangler } from "../toolchain.js";
import { commitGenerated, requireBookDirectory, readBookIdentity } from "./shared.js";

export const publishStage: Stage = async (ctx: WizardContext): Promise<StageOutcome> => {
  ctx.reporter.heading("Publishing your reading site");
  ctx.reporter.explain(
    "This puts your book on the web at an address you can share. Cloudflare's free tier covers a book of this size. Nothing here is finished until the site actually loads - the wizard waits and checks.",
  );

  await requireBookDirectory(ctx);
  const identity = await readBookIdentity(ctx);

  const wrangler = await checkWrangler(ctx.actions);
  if (wrangler.status === "missing") {
    // The book pins its own wrangler; installing the book's dependencies is
    // the fix, and it is also what CI does.
    await installBookDependencies(ctx);
  }
  const wranglerAfter = await checkWrangler(ctx.actions);
  const apiToken = ctx.env.env["CLOUDFLARE_API_TOKEN"];
  if (wranglerAfter.status !== "ok" && (apiToken === undefined || apiToken.length === 0)) {
    throw new WizardError(
      "Cloudflare is not set up yet: wrangler is either missing or not signed in.",
      "Run `wrangler login` and approve in your browser, then run `create-authorbot publish` again. On a machine with no browser, create an API token with the \"Edit Cloudflare Workers\" template and set CLOUDFLARE_API_TOKEN instead.",
    );
  }

  // ---- the Worker's name --------------------------------------------------

  const workerName = await ctx.prompter.text({
    id: "publish.workerName",
    message: "What should the Worker serving your site be called?",
    hint: "It becomes part of your default address: https://<name>.<your-subdomain>.workers.dev. Renaming it later creates a second Worker rather than moving this one, so the old address keeps serving the old book.",
    defaultValue: ctx.journal.data.publish?.workerName ?? identity.slug,
    validate: validateWorkerName,
  });

  const customDomain = await ctx.prompter.text({
    id: "publish.customDomain",
    message: "A custom domain for the site? Leave blank to use the workers.dev address.",
    hint: "The whole hostname, exactly as a reader would type it - book.example.com, not example.com and not just `book`. Whatever you enter is the address your book takes over, so an apex domain means the site at that apex. Cloudflare must already manage DNS for it. You can add one later without redoing any of this.",
    defaultValue: ctx.journal.data.publish?.customDomain ?? "",
    validate: (value) => {
      if (value.length === 0) {
        return null;
      }
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value)) {
        return "Enter a hostname like book.example.com, or leave it blank.";
      }
      return null;
    },
  });

  if (customDomain.length > 0) {
    await confirmDomainIsFree(ctx, customDomain);
  }

  // ---- configuration ------------------------------------------------------

  ctx.reporter.blank();
  ctx.reporter.step(
    `Pinning the toolchain at @authorbot/cli ${TOOLCHAIN_VERSION} so every future build is the one you tested`,
  );
  ctx.reporter.info(
    "The pin lives in your package.json and package-lock.json, so it shows up in your history and an upgrade arrives as a reviewable pull request rather than a silent change.",
  );

  await ctx.actions.writeFile({
    filePath: path.join(ctx.directory, "wrangler.jsonc"),
    contents: renderWrangler({
      workerName,
      ...(customDomain.length > 0 ? { customDomain } : {}),
    }),
    purpose: "tells Cloudflare what to serve and where",
  });

  await ctx.journal.update((data) => {
    data.publish = {
      ...data.publish,
      workerName,
      ...(customDomain.length > 0 ? { customDomain } : {}),
    };
  }, nowIso(ctx));

  await installBookDependencies(ctx);

  await commitGenerated(ctx, {
    files: ["wrangler.jsonc", "package.json", "package-lock.json"],
    message: "Configure publishing",
    // Publishing does not need the push: `wrangler deploy` has already put the
    // site up from this machine, and CI takes over from the author's next
    // push. Collaboration is the one that cannot wait, because the API reads
    // the repository rather than the working tree.
    push: false,
    done: "Committed the publishing configuration, so CI deploys what you just deployed.",
    failed:
      "Could not commit the publishing configuration. Commit wrangler.jsonc and package.json yourself - CI deploys from the commit, not from your working tree.",
  });

  // ---- CI credentials -----------------------------------------------------

  // `identity.repo` is the verified `origin`, not whatever the journal claims.
  await configureRepositorySecrets(ctx, identity.repo);

  // ---- build and deploy ---------------------------------------------------

  ctx.reporter.blank();
  ctx.reporter.step("Building the site");
  const build = await runAuthorbot(ctx, ["build", ".", "--out", "_site"], {
    purpose: "render your book into a website",
    mutates: true,
    required: true,
    onFailure: `Run \`npx authorbot build . --out _site\` in ${ctx.directory} to see the full report.`,
  });
  if (build === null) {
    throw new WizardError(
      "The Authorbot toolchain is not installed in your book directory, so the site cannot be built.",
      `Run \`npm install\` in ${ctx.directory}, then run \`create-authorbot publish\` again.`,
    );
  }
  ctx.reporter.ok("Site built.");

  ctx.reporter.step("Deploying to Cloudflare");
  const deploy = await runWrangler(ctx, ["deploy"], {
    purpose: "put the site on Cloudflare",
    mutates: true,
    timeoutMs: 300_000,
    dryRunStdout: `https://${workerName}.example.workers.dev`,
  });
  if (deploy === null) {
    throw new WizardError(
      "wrangler is not available, so the site cannot be deployed.",
      `Run \`npm install\` in ${ctx.directory} (it installs wrangler for you), then run \`create-authorbot publish\` again.`,
    );
  }
  if (deploy.code !== 0) {
    throw deployFailure(deploy.stderr || deploy.stdout, workerName);
  }

  const siteUrl = deployedUrl(deploy.stdout + deploy.stderr, workerName, customDomain);

  await ctx.actions.resource({
    kind: "cloudflare-worker",
    name: workerName,
    description: "The Cloudflare Worker serving your reading site.",
    deleteWith: `wrangler delete --name ${workerName}`,
  });

  // ---- verification (the stage is not done until a reader could load it) ---

  if (ctx.actions.dryRun) {
    const planned = siteUrl ?? `https://${workerName}.<subdomain>.workers.dev`;
    ctx.actions.note(
      `check: GET ${planned}`,
      "Waits for the site to answer before reporting success.",
    );
    // Recorded in memory only (the journal is read-only in a dry run) so the
    // stages after this one can plan against the address this would produce.
    await ctx.journal.update((data) => {
      data.publish = { ...data.publish, workerName, siteUrl: planned };
    }, nowIso(ctx));
    return { continue: true, note: "planned only" };
  }

  if (siteUrl === null) {
    ctx.reporter.warn(
      "The deploy succeeded but did not print a URL, so it could not be checked automatically.",
    );
    ctx.reporter.info(
      `Find the address in your Cloudflare dashboard under Workers & Pages > ${workerName}.`,
    );
    return { continue: true, note: "deployed; URL unknown" };
  }

  const live = await ctx.reporter.during(`Waiting for ${siteUrl} to answer`, () =>
    waitForSite(ctx, siteUrl),
  );
  if (!live) {
    // Before calling a deploy failed, ask a resolver that is not this
    // machine's. A brand-new hostname is very often looked up (and cached as
    // "does not exist") moments before it is created - including by this
    // wizard's own check that the domain was free - and a negative cache
    // outlives the poll. The site is then live to the entire internet while
    // the one machine that just deployed it insists it is not.
    const published = await resolvesPublicly(ctx, siteUrl);
    if (published) {
      ctx.reporter.blank();
      ctx.reporter.ok(`Your book is live: ${siteUrl}`);
      ctx.reporter.warn(
        "Your machine cannot see it yet, but public DNS can, so the deploy worked.",
      );
      ctx.reporter.info(
        "This is a stale negative DNS entry on your side: the name was looked up just before it existed, and that answer is cached until it expires - usually a few minutes. Everyone else can already read the site.",
      );
      await ctx.journal.update((data) => {
        data.publish = { ...data.publish, workerName, siteUrl };
      }, nowIso(ctx));
      return { continue: true, note: `published at ${siteUrl} (local DNS still stale)` };
    }

    throw new WizardError(
      `The deploy finished but ${siteUrl} is not serving your book yet.`,
      "A first deploy sometimes takes a minute to propagate. Open that address in a browser; if it is still failing in a few minutes, run `create-authorbot publish` again.",
    );
  }

  await ctx.journal.update((data) => {
    data.publish = { ...data.publish, workerName, siteUrl };
  }, nowIso(ctx));

  ctx.reporter.blank();
  ctx.reporter.ok(`Your book is live: ${siteUrl}`);
  ctx.reporter.info(
    "It says it has no chapters yet, which is the correct thing for it to say. From here, `collaborate` adds sign-in and the New chapter button.",
  );

  return { continue: true, note: `published at ${siteUrl}` };
};

/**
 * `npm install` in the book directory. This is what produces
 * `package-lock.json`, which both workflows require - `npm ci` refuses to run
 * without it, deliberately, because an install without a lockfile is an
 * unpinned install.
 */
async function installBookDependencies(ctx: WizardContext): Promise<void> {
  const lockfile = path.join(ctx.directory, "package-lock.json");
  const modules = path.join(ctx.directory, "node_modules");
  if ((await ctx.fs.exists(lockfile)) && (await ctx.fs.exists(modules))) {
    return;
  }
  ctx.reporter.step("Installing the toolchain your book pins (npm install)");
  ctx.reporter.info(
    "This creates package-lock.json, which records the exact versions with their checksums. Commit it - your CI refuses to build without it.",
  );
  const result = await ctx.actions.run({
    purpose: "install the pinned Authorbot toolchain and wrangler",
    command: "npm",
    args: ["install", "--no-audit", "--no-fund"],
    cwd: ctx.directory,
    mutates: true,
    timeoutMs: 600_000,
  });
  if (result.code !== 0) {
    throw new WizardError(
      `\`npm install\` failed in ${ctx.directory}:\n${(result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n")}`,
      "Check your network connection and run `npm install` in the book directory yourself; then run this command again.",
    );
  }
  ctx.reporter.ok("Toolchain installed and pinned.");
}

/**
 * Stores the Cloudflare credentials CI needs, as GitHub repository secrets.
 *
 * The token is read with hidden input and handed to `gh secret set` on stdin -
 * never as an argument (argv is visible in the process table) and never
 * written to a file.
 */
async function configureRepositorySecrets(ctx: WizardContext, repo: string | null): Promise<void> {
  if (repo === null) {
    ctx.reporter.info(
      "No GitHub repository yet, so there is nothing to give CI. Publishing from your machine still works; run `create-authorbot book` when you want the repository.",
    );
    return;
  }
  // The token about to be collected goes to this repository and nowhere else,
  // so the destination is checked before it is asked for rather than after.
  // `--repo -x` would be an option to `gh`, not a repository.
  if (validateRepo(repo) !== null || looksLikeFlag(repo)) {
    throw new WizardError(
      `"${repo}" is not a GitHub repository name, so nothing was sent anywhere.`,
      "A repository is written owner/name. Check the `origin` remote in your book directory (`git remote -v`), then run `create-authorbot publish` again.",
    );
  }
  const gh = await checkGh(ctx.actions);
  if (gh.status !== "ok") {
    ctx.reporter.warn(
      "Skipping the CI credentials: the GitHub CLI is not signed in. Run `gh auth login`, then `create-authorbot publish` again.",
    );
    return;
  }

  if (ctx.journal.hasSecret("CLOUDFLARE_API_TOKEN")) {
    ctx.reporter.info("CI already has its Cloudflare credentials.");
    return;
  }

  // §2.4: a dry run changes nothing and asks for nothing. Only the `gh secret
  // set` below was suppressed, so the run still reached the hidden-input
  // prompt and asked the author to paste a live Cloudflare API token during an
  // operation that had just promised to leave their Cloudflare account exactly
  // as it was. A plan line says the same thing and costs no credential.
  if (ctx.actions.dryRun) {
    ctx.actions.note(
      `ask: a Cloudflare API token and account id, to store as repository secrets on ${repo}`,
      "In a real run this is a hidden prompt; the token would be piped straight to `gh secret set` and never written down.",
    );
    await ctx.actions.secretSet("CLOUDFLARE_API_TOKEN", `the ${repo} repository`);
    await ctx.actions.secretSet("CLOUDFLARE_ACCOUNT_ID", `the ${repo} repository`);
    return;
  }

  const wanted = await ctx.prompter.confirm({
    id: "publish.setCiSecrets",
    message: "Give GitHub Actions permission to publish your book automatically?",
    hint: "Without this, every publish is a manual step from your own machine. With it, pushing a chapter publishes it.",
    defaultValue: true,
  });
  if (!wanted) {
    ctx.reporter.info(
      "Skipped. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as repository secrets when you want automatic publishing.",
    );
    return;
  }

  // The template is a starting point, not the finished token. It omits D1 -
  // which the collaborate stage needs, and whose absence shows up much later
  // as a migration failing in CI rather than as anything wrong here - and it
  // leaves the two resource scopes empty, which a token cannot be saved with.
  // Both were left for the author to work out from Cloudflare's error
  // messages, which do not mention Authorbot at all.
  ctx.reporter.info(
    "Create a token at https://dash.cloudflare.com/profile/api-tokens, starting from the \"Edit Cloudflare Workers\" template. It is sent straight to GitHub and never written down.",
  );
  ctx.reporter.info("Before saving it, adjust three things the template leaves out:");
  ctx.reporter.info(
    "  1. Add the permission `Account > D1 > Edit`. Publishing works without it, but turning on collaboration later does not.",
  );
  ctx.reporter.info(
    "  2. Account Resources: Include > your account. The template leaves this empty and the token cannot be saved.",
  );
  ctx.reporter.info(
    "  3. Zone Resources: Include > All zones (or just the zone holding your custom domain, if you gave one).",
  );

  const token = ctx.vault.register(
    "CLOUDFLARE_API_TOKEN",
    await ctx.prompter.secret({
      id: "publish.cloudflareApiToken",
      message: "Cloudflare API token:",
    }),
  );
  const accountId = await ctx.prompter.text({
    id: "publish.cloudflareAccountId",
    message: "Your Cloudflare account ID?",
    hint: "It is on the right-hand side of your Cloudflare dashboard's Workers & Pages page. Not a secret, but CI needs it.",
    validate: (value) =>
      /^[0-9a-f]{32}$/i.test(value.trim()) ? null : "That should be a 32-character hexadecimal id.",
  });

  await ctx.actions.run({
    purpose: "give CI its Cloudflare token",
    command: "gh",
    args: ["secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", repo],
    stdin: token,
    cwd: ctx.directory,
    mutates: true,
    required: true,
  });
  await ctx.actions.secretSet("CLOUDFLARE_API_TOKEN", `the ${repo} repository`);

  await ctx.actions.run({
    purpose: "give CI your Cloudflare account id",
    command: "gh",
    args: ["secret", "set", "CLOUDFLARE_ACCOUNT_ID", "--repo", repo],
    stdin: accountId.trim(),
    cwd: ctx.directory,
    mutates: true,
    required: true,
  });
  ctx.reporter.ok("CI can publish your book.");
}

/**
 * Recognises the failure modes worth explaining rather than retrying blindly
 * (contract §5).
 */
function deployFailure(output: string, workerName: string): WizardError {
  const text = output.trim();
  if (/already exists|name is not available|conflict/i.test(text)) {
    return new WizardError(
      `Cloudflare already has a Worker called "${workerName}" that this account cannot deploy to.`,
      "Run `create-authorbot publish` again and choose a different name, or delete the existing Worker in the Cloudflare dashboard if it is yours and unused.",
    );
  }
  if (/authentication|unauthorized|10000|invalid token/i.test(text)) {
    return new WizardError(
      "Cloudflare rejected the credentials.",
      "Run `wrangler login` again, or check that CLOUDFLARE_API_TOKEN is a current token with the \"Edit Cloudflare Workers\" permissions.",
    );
  }
  if (/rate limit|429/i.test(text)) {
    return new WizardError(
      "Cloudflare is rate-limiting this account.",
      "Wait a few minutes and run `create-authorbot publish` again; everything already done will be skipped.",
    );
  }
  return new WizardError(
    `The deploy failed:\n${text.split("\n").slice(-10).join("\n")}`,
    `Run \`npx wrangler deploy\` in your book directory to see the full output, then run \`create-authorbot publish\` again.`,
  );
}

/**
 * Extracts the live URL from wrangler's output, preferring a custom domain
 * when one was configured. Parsing output is unpleasant but it is where the
 * *actual* deployed address appears - the workers.dev subdomain is account
 * specific and cannot be predicted.
 */
export function deployedUrl(
  output: string,
  workerName: string,
  customDomain: string,
): string | null {
  if (customDomain.length > 0) {
    return `https://${customDomain}`;
  }
  const matches = output.match(/https:\/\/[^\s"']+/g) ?? [];
  const workersDev = matches.find((url) => url.includes(".workers.dev"));
  if (workersDev !== undefined) {
    return workersDev.replace(/[).,]+$/, "");
  }
  const any = matches.find((url) => url.includes(workerName));
  return any === undefined ? null : any.replace(/[).,]+$/, "");
}

/**
 * Polls until the site serves something. A fresh Worker can take a few seconds
 * to become reachable, so a single request immediately after deploy would
 * report failure for a site that is about to work.
 */
/**
 * Refuses to take over a hostname that is already serving a site, unless the
 * author says so in as many words.
 *
 * A Worker custom domain is not additive: Cloudflare routes that hostname to
 * this Worker, and whatever answered there before stops answering. Typing a
 * domain one letter shorter than intended - `example.com` where
 * `book.example.com` was meant - therefore replaces a personal site with a
 * book that has no chapters in it yet, and the wizard's own promise is that
 * nothing destructive happens without asking first.
 *
 * The check is a plain GET. Anything that answers counts as occupied: this
 * cannot tell a beloved blog from a parking page, so it does not try to judge,
 * it just makes sure a human looked. A domain that does not answer is left to
 * proceed silently, which is the ordinary case for a subdomain minted for the
 * book.
 */
async function confirmDomainIsFree(ctx: WizardContext, domain: string): Promise<void> {
  // Already ours. Re-running `publish` - after a failed deploy, or to pick up
  // a new chapter - would otherwise find the book itself sitting there and ask
  // the author to confirm replacing their own site, every time. The stage is
  // meant to be re-runnable, and a prompt that cries wolf on the ordinary path
  // is how a genuine warning stops being read.
  if (ctx.journal.data.publish?.customDomain === domain) {
    return;
  }

  if (ctx.actions.dryRun) {
    ctx.actions.note(
      `check: GET https://${domain}`,
      "Confirms the hostname is free before the book takes it over.",
    );
    return;
  }

  let occupied = false;
  try {
    const response = await ctx.http.request(`https://${domain}`, { timeoutMs: 10_000 });
    occupied = response.status >= 200 && response.status < 400;
  } catch {
    // Unreachable, no DNS, TLS failure: nothing is being replaced, so there is
    // nothing to warn about. A domain Cloudflare does not manage yet fails the
    // deploy later with an error that says so.
    return;
  }
  if (!occupied) {
    return;
  }

  ctx.reporter.blank();
  ctx.reporter.warn(`https://${domain} is already serving a site.`);
  ctx.reporter.info(
    `Adding it as a custom domain sends that hostname to your book instead. Whatever lives there now stops being reachable at ${domain}.`,
  );
  ctx.reporter.info(
    `If you meant a subdomain of it - book.${domain}, say - answer no and enter that instead.`,
  );

  const proceed = await ctx.prompter.confirm({
    id: "publish.replaceExistingSite",
    message: `Replace what is at ${domain} with your book?`,
    hint: "This is the answer that cannot be undone by re-running the wizard: the previous site has to be put back by whoever deployed it.",
    defaultValue: false,
  });

  if (!proceed) {
    throw new WizardError(
      `Stopped before taking over ${domain}.`,
      "Run `create-authorbot publish` again and give a hostname that is not already serving something - a subdomain like book.example.com is the usual choice. Nothing was deployed.",
    );
  }
}

/**
 * Whether the wider internet can resolve this hostname, regardless of what
 * this machine's resolver believes.
 *
 * Asked over DNS-over-HTTPS precisely because it is not the system resolver:
 * an ordinary lookup would consult the same cache that is the problem. A
 * hostname that answers here but not locally means the deploy landed and this
 * machine is holding a stale "does not exist" - the difference between "your
 * book is live" and "your deploy failed", which is not a distinction to leave
 * to a coin toss.
 *
 * Any doubt returns false: this only ever upgrades a failure into a success,
 * so it has to be sure. A network that blocks DoH simply reports what it
 * reported before.
 */
async function resolvesPublicly(ctx: WizardContext, url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }

  for (const type of ["A", "AAAA"]) {
    try {
      const response = await ctx.http.request(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { accept: "application/dns-json" }, timeoutMs: 10_000 },
      );
      if (response.status !== 200) {
        continue;
      }
      const body = JSON.parse(response.body) as { Status?: number; Answer?: unknown[] };
      // Status 0 is NOERROR; an Answer section means the name exists and has
      // an address, which is as much as this needs to know.
      if (body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0) {
        return true;
      }
    } catch {
      // Blocked, offline, or malformed: fall through to the next type and, if
      // that fails too, report nothing rather than guessing.
    }
  }
  return false;
}

async function waitForSite(ctx: WizardContext, url: string): Promise<boolean> {
  const deadline = ctx.clock.now().getTime() + 120_000;
  let attempt = 0;
  while (ctx.clock.now().getTime() < deadline) {
    attempt += 1;
    try {
      const response = await ctx.http.request(url, { timeoutMs: 15_000 });
      if (response.status >= 200 && response.status < 400) {
        return true;
      }
    } catch {
      // Not yet reachable; the loop's deadline is the only thing that decides.
    }
    await ctx.clock.sleep(Math.min(2_000 * attempt, 10_000));
  }
  return false;
}
