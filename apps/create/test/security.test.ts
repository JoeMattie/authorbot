/**
 * Regression tests for the findings of the wizard's security review.
 *
 * Each test here names the specific thing that was wrong, and each fails if the
 * corresponding fix is reverted. They are gathered in one file rather than
 * scattered because they share a premise the rest of the suite does not: that
 * `.authorbot-setup.json`, the `--config` file, and a subprocess's stderr are
 * all *attacker-influenceable inputs* rather than the wizard's own bookkeeping.
 */
import { describe, expect, it } from "vitest";
import { parseJournal, emptyJournal } from "../src/journal.js";
import { hasMaintainerRow } from "../src/stages/collaborate.js";
import { statesMatch } from "../src/github/manifest-flow.js";
import { Reporter, themeFor } from "../src/ui/reporter.js";
import { TtyPrompter } from "../src/runtime/prompt.js";
import { reportFatal } from "../src/errors.js";
import {
  CREDENTIAL_ENV_VARS,
  REDACTED,
  SecretVault,
  redactError,
  registerEnvironmentCredentials,
} from "../src/secrets.js";
import {
  CollectingOutput,
  fakeEnvironment,
  fakeGitHub,
  happyRunner,
  manifestBrowser,
  withHealthyApi,
} from "./fakes.js";
import { HAPPY_ANSWERS, makeHarness, type Harness } from "./harness.js";

const DIR = "/work/my-book";
const SITE = "https://hollow-creek-anomaly.novelist.workers.dev";
const SLUG = "hollow-creek-anomaly";
const NOW = "2026-07-20T12:00:00.000Z";

function fullHarness(overrides: Partial<Record<string, unknown>> = {}): Harness {
  const github = fakeGitHub();
  withHealthyApi(github.client, SITE);
  return makeHarness({
    directory: DIR,
    answers: { ...HAPPY_ANSWERS, ...overrides },
    runner: happyRunner({ login: "novelist", siteUrl: SITE }),
    http: github.client,
    browser: manifestBrowser({ code: "one-time-code" }),
    env: {
      env: {
        NO_COLOR: "1",
        PATH: "/usr/bin",
        AUTHORBOT_GITHUB_API: github.apiBase,
        AUTHORBOT_GITHUB_WEB: github.webBase,
      },
    },
  });
}

/** A `book.yml` good enough for the stages that only read identity out of it. */
const BOOK_YML = `schema: authorbot.book/v1
title: The Hollow Creek Anomaly
slug: ${SLUG}
id: 0192f2a0-1111-7222-8333-444455556666
repository:
  default_branch: main
`;

/** Writes a journal to disk the way a hostile repository would ship one. */
function plantJournal(harness: Harness, data: Record<string, unknown>): void {
  harness.fs.seed(
    `${DIR}/.authorbot-setup.json`,
    JSON.stringify({ ...emptyJournal(NOW), ...data }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// ERROR 1 - the journal is a security input, so it is validated
// ---------------------------------------------------------------------------

describe("the journal is validated on load, not cast through", () => {
  it("drops a repo that is not owner/repo rather than adopting it", () => {
    const parsed = parseJournal(
      JSON.stringify({ ...emptyJournal(NOW), book: { repo: "--repo=/tmp/evil", slug: "ok" } }),
      NOW,
    );
    expect(parsed.book?.repo).toBeUndefined();
    // The rest of the section survives: one bad field is not a corrupt journal.
    expect(parsed.book?.slug).toBe("ok");
  });

  it("keeps a well-formed repo, so a real resume still works", () => {
    const parsed = parseJournal(
      JSON.stringify({ ...emptyJournal(NOW), book: { repo: "novelist/my-book" } }),
      NOW,
    );
    expect(parsed.book?.repo).toBe("novelist/my-book");
  });

  it.each([
    ["a non-https scheme", "http://evil.example.com"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a file: URL", "file:///etc/passwd"],
    ["credentials in the authority", "https://user:pw@evil.example.com"],
    ["not a URL at all", "not a url"],
  ])("drops a siteUrl with %s - it becomes an OAuth callback host", (_label, siteUrl) => {
    const parsed = parseJournal(
      JSON.stringify({ ...emptyJournal(NOW), publish: { siteUrl } }),
      NOW,
    );
    expect(parsed.publish?.siteUrl).toBeUndefined();
  });

  it("keeps an ordinary https siteUrl", () => {
    const parsed = parseJournal(
      JSON.stringify({ ...emptyJournal(NOW), publish: { siteUrl: SITE } }),
      NOW,
    );
    expect(parsed.publish?.siteUrl).toBe(SITE);
  });

  it.each([
    ["slug", { book: { slug: "--not-a-slug" } }, (d: ReturnType<typeof parseJournal>) => d.book?.slug],
    [
      "workerName",
      { publish: { workerName: "--name=other-worker" } },
      (d: ReturnType<typeof parseJournal>) => d.publish?.workerName,
    ],
    [
      "d1Name",
      { collaborate: { d1Name: "--config=/tmp/evil.jsonc" } },
      (d: ReturnType<typeof parseJournal>) => d.collaborate?.d1Name,
    ],
    [
      "d1Id",
      { collaborate: { d1Id: "not-a-uuid" } },
      (d: ReturnType<typeof parseJournal>) => d.collaborate?.d1Id,
    ],
    [
      "installationId",
      { collaborate: { installationId: "--x" } },
      (d: ReturnType<typeof parseJournal>) => d.collaborate?.installationId,
    ],
  ])("drops a %s that fails its own shape", (_label, section, read) => {
    const parsed = parseJournal(JSON.stringify({ ...emptyJournal(NOW), ...section }), NOW);
    expect(read(parsed)).toBeUndefined();
  });

  it("keeps a d1 name with the underscores D1 actually allows", () => {
    const parsed = parseJournal(
      JSON.stringify({ ...emptyJournal(NOW), collaborate: { d1Name: "my_book_db" } }),
      NOW,
    );
    expect(parsed.collaborate?.d1Name).toBe("my_book_db");
  });

  it("drops a title carrying terminal control characters", () => {
    const parsed = parseJournal(
      JSON.stringify({ ...emptyJournal(NOW), book: { title: "Book[2J[H" } }),
      NOW,
    );
    expect(parsed.book?.title).toBeUndefined();
  });
});

describe("the repository outranks the journal about where the book lives", () => {
  /**
   * The attack in one test: a book repository that ships its own
   * `.authorbot-setup.json` naming someone else's repository. The author
   * clones it and runs `create-authorbot publish`, which would otherwise send
   * their Cloudflare API token to `attacker/collector` - the journal used to
   * outrank `git remote get-url origin`, so the true origin was never even
   * consulted.
   */
  function plantedRepoHarness(answers: Record<string, unknown>): Harness {
    const harness = fullHarness(answers);
    harness.fs.seed(`${DIR}/book.yml`, BOOK_YML);
    plantJournal(harness, {
      book: { title: "The Hollow Creek Anomaly", slug: SLUG, repo: "attacker/collector" },
    });
    return harness;
  }

  it("never sends a repository secret to the repository the journal names", async () => {
    const harness = plantedRepoHarness({ "book.repoConflict": false });

    await harness.run(["publish", "--dir", DIR]);

    const touchedAttacker = harness.runner.calls.some((call) =>
      call.args.some((arg) => arg.includes("attacker/collector")),
    );
    expect(touchedAttacker).toBe(false);
    expect(harness.runner.ran("gh", "secret", "set")).toBe(false);
  });

  it("treats the disagreement as a conflict the author must resolve explicitly", async () => {
    const harness = plantedRepoHarness({ "book.repoConflict": false });

    const code = await harness.run(["publish", "--dir", DIR]);

    const prompt = harness.prompter.asked.find((entry) => entry.id === "book.repoConflict");
    expect(prompt, "the conflict must be raised, not resolved silently").toBeDefined();
    expect(prompt?.destructive).toBe(true);
    // Declining is a decision, not a fault - and nothing was changed.
    expect(code).toBe(0);
    const said = harness.out.all().replace(/\s+/g, " ");
    expect(said).toContain("attacker/collector");
    expect(said).toContain("novelist/hollow-creek-anomaly");
  });

  it("uses the real origin, not the journal's claim, once the author agrees", async () => {
    const harness = plantedRepoHarness({ "book.repoConflict": true });

    await harness.run(["publish", "--dir", DIR]);

    const secretSets = harness.runner.calls.filter(
      (call) => call.args[0] === "secret" && call.args[1] === "set",
    );
    expect(secretSets.length).toBeGreaterThan(0);
    for (const call of secretSets) {
      expect(call.args).toContain("novelist/hollow-creek-anomaly");
      expect(call.args).not.toContain("attacker/collector");
    }
  });

  it("does not announce a repository the journal invented as 'already on GitHub'", async () => {
    // `book` short-circuited on the journal alone, which made the wizard say
    // the book was already published to a repository the author has no link to.
    const harness = fullHarness({ "book.repoConflict": false });
    plantJournal(harness, {
      book: { title: "The Hollow Creek Anomaly", slug: SLUG, repo: "attacker/collector" },
    });

    await harness.run(["book", "--dir", DIR]);

    expect(harness.out.all()).not.toContain("Already on GitHub: attacker/collector");
  });
});

// ---------------------------------------------------------------------------
// ERROR 2 - values destined for argv are names, never flags
// ---------------------------------------------------------------------------

describe("a journal value can never become a command-line flag", () => {
  it("never hands wrangler a database 'name' that is really --config", async () => {
    const harness = fullHarness();
    harness.fs.seed(`${DIR}/book.yml`, BOOK_YML);
    plantJournal(harness, {
      book: { title: "The Hollow Creek Anomaly", slug: SLUG, repo: "novelist/hollow-creek-anomaly" },
      publish: { workerName: SLUG, siteUrl: SITE },
      collaborate: {
        d1Name: "--config=/tmp/evil.jsonc",
        d1Id: "11111111-2222-4333-8444-555555555555",
      },
    });

    await harness.run(["collaborate", "--dir", DIR]);

    // Not as an argument, and not smuggled inside one either.
    for (const call of harness.runner.calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain("/tmp/evil.jsonc");
      }
    }
  });

  it("never hands wrangler a Worker 'name' that is really an option", async () => {
    const harness = fullHarness();
    harness.fs.seed(`${DIR}/book.yml`, BOOK_YML);
    plantJournal(harness, {
      book: { title: "The Hollow Creek Anomaly", slug: SLUG, repo: "novelist/hollow-creek-anomaly" },
      publish: { workerName: "--name=someone-elses-worker", siteUrl: SITE },
    });

    await harness.run(["collaborate", "--dir", DIR]);

    for (const call of harness.runner.calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain("someone-elses-worker");
      }
    }
  });

  it("leaves no argv value at all that begins with a dash but is not a real flag", async () => {
    const harness = fullHarness();
    await harness.run(["--dir", DIR]);

    // Every leading-dash argument the wizard produces on the happy path is one
    // it wrote itself. A value that arrived from data would show up here.
    const known = new Set([
      "-b",
      "-m",
      "--private",
      "--public",
      "--source",
      "--remote",
      "--push",
      "--description",
      "--json",
      "--jq",
      "--command",
      "--name",
      "--repo",
      "--out",
      "--quiet",
      "--exit-code",
      "--cached",
      "--no-audit",
      "--no-fund",
      "--save-dev",
      "--no-install",
      "--check",
      "--version",
      "--is-inside-work-tree",
      // The end-of-options separator, which is the opposite of a risk: it is
      // what stops a following filename from ever being read as a flag.
      "--",
    ]);
    for (const call of harness.runner.calls) {
      for (const arg of call.args) {
        if (arg.startsWith("-")) {
          expect(known, `unexpected flag-shaped argument ${arg}`).toContain(arg);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ERROR 3 - the one value that is meant to be read
// ---------------------------------------------------------------------------

describe("the minted agent token is actually shown", () => {
  it("prints the token verbatim through revealOnce", () => {
    const vault = new SecretVault();
    const out = new CollectingOutput();
    const reporter = new Reporter(out, vault, themeFor(fakeEnvironment()));
    const token = "abk_live_agent_token_value_9876543210";
    vault.register("AGENT_TOKEN", token);

    reporter.revealOnce(token);

    // The test that was missing: the printed output CONTAINS the token.
    expect(out.all()).toContain(token);
    expect(out.all()).not.toContain(REDACTED);
  });

  it("still redacts the token through every other method", () => {
    const vault = new SecretVault();
    const out = new CollectingOutput();
    const reporter = new Reporter(out, vault, themeFor(fakeEnvironment()));
    const token = "abk_live_agent_token_value_9876543210";
    vault.register("AGENT_TOKEN", token);

    reporter.literal(token);
    reporter.info(token);

    expect(out.all()).not.toContain(token);
  });

  it("refuses to reveal the same one-time value twice", () => {
    const reporter = new Reporter(
      new CollectingOutput(),
      new SecretVault(),
      themeFor(fakeEnvironment()),
    );
    reporter.revealOnce("a-one-time-value-1234");
    expect(() => reporter.revealOnce("a-one-time-value-1234")).toThrow(/already been shown/);
  });

  it("shows the token to the author when the agent stage mints one", async () => {
    const token = "abk_minted_agent_token_0123456789abcdef";
    const github = fakeGitHub();
    withHealthyApi(github.client, SITE);
    github.client.route(
      (url) => url.pathname === `/v1/projects/${SLUG}/agent-tokens`,
      () => ({ status: 201, headers: {}, body: JSON.stringify({ token }) }),
    );
    const harness = makeHarness({
      directory: DIR,
      answers: { ...HAPPY_ANSWERS },
      runner: happyRunner({ login: "novelist", siteUrl: SITE }),
      http: github.client,
      env: {
        env: {
          NO_COLOR: "1",
          PATH: "/usr/bin",
          AUTHORBOT_API_TOKEN: "maintainer-token-value-abcdef",
        },
      },
    });
    harness.fs.seed(`${DIR}/book.yml`, BOOK_YML);
    plantJournal(harness, {
      book: { title: "The Hollow Creek Anomaly", slug: SLUG, repo: "novelist/hollow-creek-anomaly" },
      publish: { workerName: SLUG, siteUrl: SITE },
      collaborate: { apiVerified: true },
    });

    const code = await harness.run(["agent", "--dir", DIR]);

    expect(code).toBe(0);
    // The banner says this is the only time it will ever be shown; it has to
    // be true. The server keeps only a hash, so a redacted print loses it.
    expect(harness.out.all()).toContain(token);
    // The maintainer credential used to mint it is a different matter.
    expect(harness.out.all()).not.toContain("maintainer-token-value-abcdef");
  });
});

// ---------------------------------------------------------------------------
// WARN 4 - env-sourced credentials are registered too
// ---------------------------------------------------------------------------

describe("credentials that arrive through the environment", () => {
  it("registers every known credential-bearing variable that is set", () => {
    const vault = new SecretVault();
    const registered = registerEnvironmentCredentials(vault, {
      CLOUDFLARE_API_TOKEN: "cf-token-value-0123456789",
      GITHUB_TOKEN: "gh-token-value-0123456789",
      NPM_TOKEN: "npm-token-value-0123456789",
      PATH: "/usr/bin",
      HOME: "/home/someone",
    });

    expect(new Set(registered)).toEqual(
      new Set(["CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"]),
    );
    // Registered means redacted: the vault now scrubs the value on the way out.
    expect(vault.redact("token is cf-token-value-0123456789")).not.toContain(
      "cf-token-value-0123456789",
    );
    // And it does not sweep up things that are not credentials.
    expect(vault.redact("/usr/bin")).toBe("/usr/bin");
  });

  it("covers every credential the publish stage can touch", () => {
    // The companion assertion the reviewer asked for. The existing property
    // test only proves redaction works for secrets the vault was TOLD about,
    // so the blind spot is precisely the set of names nobody registers.
    for (const name of ["CLOUDFLARE_API_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) {
      expect(CREDENTIAL_ENV_VARS as readonly string[]).toContain(name);
    }
  });

  it("does not echo a Cloudflare token back when wrangler prints it in stderr", async () => {
    const token = "cf-env-token-value-0123456789abcdef";
    const runner = happyRunner({ login: "novelist", siteUrl: SITE }).on(["wrangler", "deploy"], {
      code: 1,
      stdout: "",
      // Exactly the shape that leaked: an *unrecognised* failure, whose last
      // ten stderr lines are quoted verbatim into a WizardError the reporter
      // then prints - with the tool having echoed its own credential.
      stderr: `Upload step failed while publishing\nrequest used CLOUDFLARE_API_TOKEN=${token}\n`,
    });
    const harness = makeHarness({
      directory: DIR,
      answers: HAPPY_ANSWERS,
      runner,
      env: { env: { NO_COLOR: "1", PATH: "/usr/bin", CLOUDFLARE_API_TOKEN: token } },
    });
    harness.fs.seed(`${DIR}/book.yml`, BOOK_YML);
    plantJournal(harness, {
      book: { title: "The Hollow Creek Anomaly", slug: SLUG },
    });

    const code = await harness.run(["publish", "--dir", DIR]);

    expect(code).not.toBe(0);
    expect(`${harness.out.all()}\n${harness.fs.everything()}`).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// WARN 5 - the maintainer check is a gate, and it is exact
// ---------------------------------------------------------------------------

describe("the seeded-maintainer health check", () => {
  /** A collaborate run whose only unusual part is the read-back. */
  function collaborateHarness(execute: { code: number; stdout: string }): Harness {
    const github = fakeGitHub();
    withHealthyApi(github.client, SITE);
    const runner = happyRunner({ login: "novelist", siteUrl: SITE }).on(
      ["wrangler", "d1", "execute"],
      { code: execute.code, stdout: execute.stdout, stderr: "" },
    );
    const harness = makeHarness({
      directory: DIR,
      answers: HAPPY_ANSWERS,
      runner,
      http: github.client,
      browser: manifestBrowser({ code: "one-time-code" }),
      env: {
        env: {
          NO_COLOR: "1",
          PATH: "/usr/bin",
          AUTHORBOT_GITHUB_API: github.apiBase,
          AUTHORBOT_GITHUB_WEB: github.webBase,
        },
      },
    });
    harness.fs.seed(`${DIR}/book.yml`, BOOK_YML);
    plantJournal(harness, {
      book: { title: "The Hollow Creek Anomaly", slug: SLUG, repo: "novelist/hollow-creek-anomaly" },
      publish: { workerName: SLUG, siteUrl: SITE },
    });
    return harness;
  }

  it("fails the stage when the read-back cannot be done, instead of warning", async () => {
    const harness = collaborateHarness({ code: 1, stdout: "" });

    const code = await harness.run(["collaborate", "--dir", DIR]);

    expect(code).not.toBe(0);
    // §3.4: the check has to pass BEFORE the site is allowed to point at the
    // API. Warning and carrying on set api_url on the strength of a check that
    // never ran.
    expect(harness.fs.files.get(`${DIR}/book.yml`) ?? "").not.toContain("api_url:");
    const said = harness.out.all().replace(/\s+/g, " ");
    expect(said).toMatch(/NOT switched over/);
    expect(said).toMatch(/collaborate` again/);
  });

  it("is not satisfied by two unrelated rows that each match one half", async () => {
    // The loose test was `text.includes(slug) && text.includes("github:" + login)`
    // over the whole result set: someone else's project plus someone else's
    // maintainer passed it, with no row that was both.
    const harness = collaborateHarness({
      code: 0,
      stdout: JSON.stringify([
        {
          results: [
            { slug: "someone-elses-book", maintainer: "github:novelist" },
            { slug: SLUG, maintainer: "github:someone-else" },
          ],
        },
      ]),
    });

    const code = await harness.run(["collaborate", "--dir", DIR]);

    expect(code).not.toBe(0);
    expect(harness.fs.files.get(`${DIR}/book.yml`) ?? "").not.toContain("api_url:");
  });

  it("passes on a row that is this book and this author", () => {
    const stdout = JSON.stringify([
      { results: [{ slug: SLUG, maintainer: "github:novelist" }] },
    ]);
    expect(hasMaintainerRow(stdout, SLUG, "github:novelist")).toBe(true);
  });

  it("rejects a split match, unparseable output, and an empty result set", () => {
    expect(
      hasMaintainerRow(
        JSON.stringify([
          {
            results: [
              { slug: "other", maintainer: "github:novelist" },
              { slug: SLUG, maintainer: "github:someone-else" },
            ],
          },
        ]),
        SLUG,
        "github:novelist",
      ),
    ).toBe(false);
    expect(hasMaintainerRow("not json", SLUG, "github:novelist")).toBe(false);
    expect(hasMaintainerRow(JSON.stringify([{ results: [] }]), SLUG, "github:novelist")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WARN 6 - no output path outside the vault, and nothing escapes to Node
// ---------------------------------------------------------------------------

describe("every output path goes through the vault", () => {
  it("redacts a secret that reaches a prompt's message or hint", async () => {
    const vault = new SecretVault();
    const out = new CollectingOutput();
    const secret = "a-secret-that-reached-a-prompt-1234";
    vault.register("LEAKED", secret);
    const prompter = new TtyPrompter({
      input: { isTTY: false } as unknown as NodeJS.ReadStream,
      output: out,
      vault,
    });

    // `secret()` writes its preamble and then refuses, without needing a TTY -
    // which makes it the one prompt whose output is reachable in a test.
    await expect(
      prompter.secret({ id: "x", message: `paste ${secret}`, hint: `it is ${secret}` }),
    ).rejects.toThrow();

    expect(out.all()).not.toContain(secret);
    expect(vault.leaks(out.all())).toBe(false);
  });

  it("renders an escaped failure as a redacted message with a next action", () => {
    const vault = new SecretVault();
    const out = new CollectingOutput();
    const secret = "a-secret-in-a-stack-frame-1234567";
    vault.register("LEAKED", secret);

    reportFatal(out, (error) => redactError(vault, error), new Error(`boom ${secret}`));

    const printed = out.all();
    expect(printed).not.toContain(secret);
    expect(printed).toMatch(/Problem:/);
    expect(printed).toMatch(/What to do:/);
    // §5: never a bare stack trace.
    expect(printed).not.toMatch(/\bat Object\./);
    expect(printed).not.toMatch(/node_modules/);
  });

  it("still says something useful for a thrown non-Error", () => {
    const out = new CollectingOutput();
    reportFatal(out, (error) => String(error), "just a string");
    expect(out.all()).toContain("just a string");
  });
});

// ---------------------------------------------------------------------------
// WARN 7 - a dry run asks for nothing
// ---------------------------------------------------------------------------

describe("--dry-run", () => {
  it("never asks for a live Cloudflare API token", async () => {
    const harness = fullHarness();

    const code = await harness.run(["--dir", DIR, "--dry-run"]);

    expect(code).toBe(0);
    // It promised to change nothing; asking an author to paste a live
    // credential is not nothing.
    expect(harness.prompter.askedIds()).not.toContain("publish.cloudflareApiToken");
    const secretPrompts = harness.prompter.asked.filter((entry) => entry.kind === "secret");
    expect(secretPrompts).toEqual([]);
  });

  it("says in the plan what it would have asked for", async () => {
    const harness = fullHarness();
    await harness.run(["--dir", DIR, "--dry-run"]);
    const said = harness.out.all().replace(/\s+/g, " ");
    expect(said).toMatch(/ask: a Cloudflare API token/);
    expect(said).toMatch(/would set secret CLOUDFLARE_API_TOKEN/);
  });
});

// ---------------------------------------------------------------------------
// WARN 8 - constant-time state, and config file permissions
// ---------------------------------------------------------------------------

describe("manifest flow state comparison", () => {
  it("accepts only the exact state", () => {
    expect(statesMatch("abc123", "abc123")).toBe(true);
    expect(statesMatch("abc124", "abc123")).toBe(false);
    expect(statesMatch("abc123x", "abc123")).toBe(false);
    expect(statesMatch("", "abc123")).toBe(false);
    expect(statesMatch(null, "abc123")).toBe(false);
  });

  it("does not throw on a length mismatch, which timingSafeEqual would", () => {
    expect(() => statesMatch("short", "a-much-longer-state-value")).not.toThrow();
  });
});

describe("--config file permissions", () => {
  const CONFIG_WITH_SECRET = `directory: ${DIR}
stages: [doctor]
answers:
  doctor.login.gh: false
  doctor.login.wrangler: false
  publish.cloudflareApiToken: cf_token_abcdefghijklmnop
`;

  it("warns when a config file carrying a credential is world-readable", async () => {
    const harness = fullHarness();
    harness.fs.seed("/work/setup.yml", CONFIG_WITH_SECRET);
    harness.fs.chmod("/work/setup.yml", 0o644);

    await harness.run(["--non-interactive", "--config", "/work/setup.yml"]);

    const said = harness.out.all().replace(/\s+/g, " ");
    expect(said).toMatch(/readable by other users/);
    expect(said).toMatch(/publish\.cloudflareApiToken/);
    expect(said).toMatch(/chmod 600/);
  });

  it("stays quiet when the same file is private", async () => {
    const harness = fullHarness();
    harness.fs.seed("/work/setup.yml", CONFIG_WITH_SECRET);
    harness.fs.chmod("/work/setup.yml", 0o600);

    await harness.run(["--non-interactive", "--config", "/work/setup.yml"]);

    expect(harness.out.all()).not.toMatch(/readable by other users/);
  });

  it("stays quiet for a config that carries no credential at all", async () => {
    const harness = fullHarness();
    harness.fs.seed(
      "/work/plain.yml",
      `directory: ${DIR}\nstages: [doctor]\nanswers:\n  doctor.login.gh: false\n  doctor.login.wrangler: false\n`,
    );
    harness.fs.chmod("/work/plain.yml", 0o644);

    await harness.run(["--non-interactive", "--config", "/work/plain.yml"]);

    expect(harness.out.all()).not.toMatch(/readable by other users/);
  });
});

describe("the book's address is corroborated, not taken on trust", () => {
  /**
   * The sibling of the repository attack. `parseJournal` can only prove
   * `siteUrl` is a well-formed https URL - `https://evil.example` passes that
   * perfectly. It becomes the GitHub App's callback and webhook target and
   * receives a maintainer bearer token when an agent credential is minted, so
   * a value nothing local corroborates must be looked at by a human.
   */
  function plantedSiteHarness(answers: Record<string, unknown>): Harness {
    const harness = fullHarness(answers);
    harness.fs.seed(`${DIR}/book.yml`, BOOK_YML);
    plantJournal(harness, {
      book: { title: "The Hollow Creek Anomaly", slug: SLUG, repo: "novelist/hollow-creek-anomaly" },
      publish: { workerName: SLUG, siteUrl: "https://evil.example" },
    });
    return harness;
  }

  it("stops before wiring a planted address into the GitHub App", async () => {
    const harness = plantedSiteHarness({ "publish.siteUrlUncorroborated": false });

    await harness.run(["collaborate", "--dir", DIR]);

    const reachedEvil = harness.runner.calls.some((call) =>
      call.args.some((arg) => arg.includes("evil.example")),
    );
    expect(reachedEvil).toBe(false);
    expect(harness.out.all().replace(/\s+/g, " ")).toMatch(/sign-in codes/);
  });

  it("names what the address controls, so agreeing is an informed choice", async () => {
    const harness = plantedSiteHarness({ "publish.siteUrlUncorroborated": false });

    await harness.run(["collaborate", "--dir", DIR]);

    const said = harness.out.all().replace(/\s+/g, " ");
    expect(said).toMatch(/maintainer credential/);
    expect(said).toContain("https://evil.example");
  });
});
