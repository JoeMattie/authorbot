/**
 * Integration coverage (Phase 6 contract §6), driving the real `runCli`
 * through injected fakes.
 *
 * What is covered here, in the contract's own words: the full happy path,
 * resume after an interrupt at each stage boundary, dry-run changes nothing,
 * non-interactive mode, destructive-confirmation refusal, and the reporting
 * of every externally-created resource.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLCHAIN_VERSION } from "../src/scaffold/render.js";
import { STAGE_NAMES, type StageName } from "../src/stages/names.js";
import {
  FakeProcessRunner,
  fakeGitHub,
  happyRunner,
  manifestBrowser,
  withHealthyApi,
} from "./fakes.js";
import { HAPPY_ANSWERS, makeHarness, type Harness } from "./harness.js";

const DIR = "/work/my-book";
const SITE = "https://hollow-creek-anomaly.novelist.workers.dev";

/** A harness wired for a run that can get all the way through `agent`. */
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

describe("the whole flow", () => {
  it("goes from nothing to a live, collaborating book", async () => {
    const harness = fullHarness();

    const code = await harness.run(["--dir", DIR]);

    expect(code).toBe(0);
    const journal = harness.journal();
    expect(journal).not.toBeNull();

    const stages = (journal as { stages: Record<string, { status: string }> }).stages;
    for (const name of ["doctor", "book", "publish", "collaborate", "agent"] satisfies StageName[]) {
      expect(stages[name]?.status, `${name} should be done`).toBe("done");
    }

    // The book exists and is complete.
    expect(harness.fs.files.has(`${DIR}/book.yml`)).toBe(true);
    expect(harness.fs.files.has(`${DIR}/.github/workflows/publish.yml`)).toBe(true);
    expect(harness.fs.files.has(`${DIR}/chapters/.gitkeep`)).toBe(true);

    // And it was validated, committed, pushed, deployed, and migrated.
    expect(harness.runner.ran("authorbot", "validate")).toBe(true);
    expect(harness.runner.ran("git", "commit")).toBe(true);
    expect(harness.runner.ran("gh", "repo", "create")).toBe(true);
    expect(harness.runner.ran("wrangler", "deploy")).toBe(true);
    expect(harness.runner.ran("wrangler", "d1", "create")).toBe(true);
    expect(harness.runner.ran("wrangler", "d1", "migrations", "apply")).toBe(true);
    expect(harness.out.all()).toContain("export AUTHORBOT_PROJECT=hollow-creek-anomaly");
  });

  it("applies database migrations before deploying the API (ADR-0021 §4)", async () => {
    const harness = fullHarness();
    await harness.run(["--dir", DIR]);

    const order = harness.runner.calls.map((call) => call.args.join(" "));
    const migrate = order.findIndex((line) => line.startsWith("d1 migrations apply"));
    // The deploy that follows the migration is the collaboration deploy; the
    // publish stage's earlier deploy is a static site with no schema at all.
    const deployAfter = order.findIndex((line, index) => index > migrate && line === "deploy");
    expect(migrate).toBeGreaterThan(-1);
    expect(deployAfter).toBeGreaterThan(migrate);
  });

  it("switches on the site's controls only after the health checks pass", async () => {
    const harness = fullHarness();
    await harness.run(["--dir", DIR]);

    const bookYml = harness.fs.files.get(`${DIR}/book.yml`) ?? "";
    expect(bookYml).toContain("api_url:");

    // The health probes must precede the write that makes sign-in appear.
    const probes = harness.http.requests.map((request) => request.url);
    expect(probes.some((url) => url === `${SITE}/v1/me`)).toBe(true);
    expect(probes.some((url) => url === `${SITE}/v1/auth/github`)).toBe(true);
  });

  it("does not switch the controls on when the API is unhealthy", async () => {
    const github = fakeGitHub();
    // `/v1/me` answering 200 means the API is not refusing anonymous callers.
    github.client.route(
      (url) => url.pathname === "/v1/me",
      () => ({ status: 200, headers: {}, body: "{}" }),
    );
    github.client.route(
      (url) => url.pathname === "/",
      () => ({ status: 200, headers: {}, body: "ok" }),
    );
    const harness = makeHarness({
      directory: DIR,
      answers: HAPPY_ANSWERS,
      runner: happyRunner({ login: "novelist", siteUrl: SITE }),
      http: github.client,
      browser: manifestBrowser({ code: "c" }),
      env: {
        env: {
          NO_COLOR: "1",
          PATH: "/usr/bin",
          AUTHORBOT_GITHUB_API: github.apiBase,
          AUTHORBOT_GITHUB_WEB: github.webBase,
        },
      },
    });

    const code = await harness.run(["--dir", DIR]);

    expect(code).toBe(1);
    expect(harness.out.all()).toMatch(/site was NOT switched over/i);
    expect(harness.fs.files.get(`${DIR}/book.yml`) ?? "").not.toContain("api_url:");
  });

  it("lists every externally-created resource with how to delete it", async () => {
    const harness = fullHarness();
    await harness.run(["--dir", DIR]);

    const output = harness.out.all();
    expect(output).toContain("What now exists, and how to remove it");
    expect(output).toMatch(/gh repo delete/);
    expect(output).toMatch(/wrangler delete --name/);
    expect(output).toMatch(/wrangler d1 delete/);
    expect(output).toMatch(/github\.com\/settings\/apps\/[^\s]*\/advanced/);
  });

  it("never prints a secret, and never writes one to the journal", async () => {
    const github = fakeGitHub();
    withHealthyApi(github.client, SITE);
    const harness = makeHarness({
      directory: DIR,
      answers: HAPPY_ANSWERS,
      runner: happyRunner({ login: "novelist", siteUrl: SITE }),
      http: github.client,
      browser: manifestBrowser({ code: "c" }),
      env: {
        env: {
          NO_COLOR: "1",
          PATH: "/usr/bin",
          AUTHORBOT_GITHUB_API: github.apiBase,
          AUTHORBOT_GITHUB_WEB: github.webBase,
        },
      },
    });

    await harness.run(["--dir", DIR]);

    const everywhere = `${harness.out.all()}\n${harness.fs.everything()}`;
    for (const secret of [
      github.secrets.clientSecret,
      github.secrets.webhookSecret,
      github.secrets.pem,
      String(HAPPY_ANSWERS["publish.cloudflareApiToken"]),
    ]) {
      expect(everywhere).not.toContain(secret);
    }

    // But they did reach their destinations, on stdin rather than argv.
    const secretPuts = harness.runner.calls.filter(
      (call) => call.args[0] === "secret" && call.args[1] === "put",
    );
    expect(secretPuts.length).toBeGreaterThanOrEqual(4);
    for (const call of secretPuts) {
      expect(call.stdin ?? "").not.toBe("");
      // Nothing sensitive in the visible command line.
      expect(call.args.join(" ")).not.toContain(github.secrets.clientSecret);
    }
    const journalText = harness.fs.files.get(`${DIR}/.authorbot-setup.json`) ?? "";
    expect(journalText).toContain("SESSION_SECRET");
    expect(journalText).toContain("GITHUB_APP_PRIVATE_KEY");
  });

  it("asks the book stage only the three questions the contract allows", async () => {
    const harness = fullHarness();
    await harness.run(["book", "--dir", DIR]);

    const bookPrompts = harness.prompter.asked
      .map((entry) => entry.id)
      .filter((id) => id.startsWith("book."));
    expect(bookPrompts).toEqual(["book.title", "book.slug", "book.visibility", "book.createRemote"]);
  });
});

describe("resume", () => {
  /**
   * Runs the flow, interrupting after `stopAfter` completes, then re-runs from
   * scratch and asserts the finished stages are not repeated. Contract §2.2
   * and exit criterion 4: no duplicate resources.
   */
  async function interruptAfter(stopAfter: StageName): Promise<{ first: Harness; second: Harness }> {
    const first = fullHarness();
    const upTo = STAGE_NAMES.slice(0, STAGE_NAMES.indexOf(stopAfter) + 1);
    for (const stage of upTo) {
      await first.run([stage, "--dir", DIR]);
    }

    // A new process, sharing only what is on disk - which is the real shape
    // of "the wizard crashed and I ran it again".
    const second = fullHarness();
    for (const [name, contents] of first.fs.files) {
      second.fs.seed(name, contents);
    }
    for (const directory of first.fs.directories) {
      second.fs.directories.add(directory);
    }
    return { first, second };
  }

  it.each(["doctor", "book", "publish", "collaborate"] satisfies StageName[])(
    "resumes cleanly after an interrupt at the %s boundary",
    async (stopAfter) => {
      const { second } = await interruptAfter(stopAfter);

      const code = await second.run(["--dir", DIR]);
      expect(code).toBe(0);

      // Nothing already created is created a second time.
      const created = second.runner.calls.filter(
        (call) =>
          call.args.slice(0, 3).join(" ") === "repo create" ||
          call.args.slice(0, 2).join(" ") === "d1 create",
      );
      const completedBefore = STAGE_NAMES.slice(0, STAGE_NAMES.indexOf(stopAfter) + 1);
      if (completedBefore.includes("book")) {
        expect(second.runner.ran("gh", "repo", "create")).toBe(false);
      }
      if (completedBefore.includes("collaborate")) {
        expect(created.some((call) => call.args[0] === "d1")).toBe(false);
      }
    },
  );

  it("re-runs a stage when it is named explicitly, because that is an instruction", async () => {
    const { second } = await interruptAfter("book");
    await second.run(["book", "--dir", DIR]);
    // The scaffold was re-checked (and found identical), not skipped.
    expect(second.prompter.askedIds()).toContain("book.title");
  });

  it("skips a finished stage in a bare re-run, and says so", async () => {
    const { second } = await interruptAfter("book");
    await second.run(["--dir", DIR]);
    expect(second.out.all()).toMatch(/Already done: book/);
  });

  it("records where it got to when a stage fails, with the resume command", async () => {
    const runner = happyRunner({ login: "novelist", siteUrl: SITE }).on(["git", "commit"], {
      code: 1,
      stdout: "",
      stderr: "Please tell me who you are",
    });
    const harness = makeHarness({
      directory: DIR,
      answers: HAPPY_ANSWERS,
      runner,
    });

    const code = await harness.run(["--dir", DIR]);

    expect(code).toBe(1);
    const output = harness.out.all();
    expect(output).toMatch(/Where you got to/);
    expect(output).toMatch(/create-authorbot book/);
    expect(output).toMatch(/git config --global user\.name/);
    const journal = harness.journal() as { stages: Record<string, { status: string }> };
    expect(journal.stages["doctor"]?.status).toBe("done");
    expect(journal.stages["book"]?.status).toBe("failed");
  });
});

describe("--dry-run", () => {
  it("changes nothing at all", async () => {
    const harness = fullHarness();

    const code = await harness.run(["--dir", DIR, "--dry-run"]);

    expect(code).toBe(0);
    // Not one byte written: no book, no journal, no backups.
    expect(harness.fs.writes).toEqual([]);
    expect(harness.journal()).toBeNull();
    // And nothing that changes the world was executed.
    expect(harness.runner.ran("git", "init")).toBe(false);
    expect(harness.runner.ran("git", "commit")).toBe(false);
    expect(harness.runner.ran("gh", "repo", "create")).toBe(false);
    expect(harness.runner.ran("wrangler", "deploy")).toBe(false);
    expect(harness.runner.ran("wrangler", "d1", "create")).toBe(false);
    expect(harness.runner.ran("npm", "install")).toBe(false);
  });

  it("still runs read-only probes, so the report about the machine is true", async () => {
    const harness = fullHarness();
    await harness.run(["doctor", "--dir", DIR, "--dry-run"]);
    expect(harness.runner.ran("gh", "auth", "status")).toBe(true);
    expect(harness.runner.ran("wrangler", "whoami")).toBe(true);
  });

  it("prints the full plan: every command, file, and remote resource", async () => {
    const harness = fullHarness();
    await harness.run(["--dir", DIR, "--dry-run"]);

    const output = harness.out.all();
    expect(output).toContain("Plan (nothing above or below this line was changed)");
    expect(output).toMatch(/create: .*book\.yml/);
    expect(output).toMatch(/create: .*\.github\/workflows\/publish\.yml/);
    expect(output).toMatch(/run: git init/);
    expect(output).toMatch(/would create github-repo/);
    expect(output).toMatch(/would create d1-database/);
    expect(output).toMatch(/would set secret SESSION_SECRET/);
    expect(output).toMatch(/Nothing was changed/);
  });

  it("never opens a browser or contacts GitHub", async () => {
    const harness = fullHarness();
    await harness.run(["--dir", DIR, "--dry-run"]);
    expect(harness.browser.opened).toEqual([]);
    expect(harness.http.requests).toEqual([]);
  });
});

describe("--non-interactive", () => {
  const CONFIG = `directory: ${DIR}
stages: [doctor, book]
answers:
  book.title: The Hollow Creek Anomaly
  book.slug: hollow-creek-anomaly
  book.visibility: private
  book.createRemote: false
`;

  it("completes from a config file without asking anything", async () => {
    const harness = fullHarness();
    harness.fs.seed("/work/setup.yml", CONFIG);
    // A prompter that throws on every call: proof nothing was asked.
    const forbidding = harness.deps.prompter;
    void forbidding;

    const code = await harness.run(["--non-interactive", "--config", "/work/setup.yml"]);

    expect(code).toBe(0);
    expect(harness.fs.files.has(`${DIR}/book.yml`)).toBe(true);
    expect(harness.fs.files.get(`${DIR}/book.yml`)).toContain("The Hollow Creek Anomaly");
    // The scripted prompter was never consulted; the config answered instead.
    expect(harness.prompter.asked).toEqual([]);
  });

  it("fails loudly, naming the missing key, rather than prompting", async () => {
    const harness = fullHarness();
    harness.fs.seed(
      "/work/incomplete.yml",
      `directory: ${DIR}\nstages: [book]\nanswers:\n  book.title: A Book\n`,
    );

    const code = await harness.run(["--non-interactive", "--config", "/work/incomplete.yml"]);

    expect(code).toBe(2);
    // Strict even where a default exists: the slug becomes part of every URL
    // the book ever publishes, so an unattended run must not invent one.
    expect(harness.out.all()).toMatch(/book\.slug/);
    expect(harness.out.all()).toMatch(/--non-interactive forbids asking/);
  });

  it("refuses to run without a config file", async () => {
    const harness = fullHarness();
    const code = await harness.run(["--non-interactive"]);
    expect(code).toBe(2);
    expect(harness.out.all()).toMatch(/needs a config file/);
  });

  it("rejects a config value that is not usable", async () => {
    const harness = fullHarness();
    harness.fs.seed(
      "/work/bad.yml",
      `directory: ${DIR}\nstages: [book]\nanswers:\n  book.title: A Book\n  book.slug: "Not A Slug"\n  book.visibility: private\n`,
    );
    const code = await harness.run(["--non-interactive", "--config", "/work/bad.yml"]);
    expect(code).toBe(1);
    expect(harness.out.all()).toMatch(/book\.slug/);
  });

  it("rejects an unknown selection value", async () => {
    const harness = fullHarness();
    harness.fs.seed(
      "/work/bad.yml",
      `directory: ${DIR}\nstages: [book]\nanswers:\n  book.title: A Book\n  book.slug: a-book\n  book.visibility: secret\n`,
    );
    const code = await harness.run(["--non-interactive", "--config", "/work/bad.yml"]);
    expect(code).toBe(1);
    // The message wraps at 80 columns, so match the distinctive fragment.
    expect(harness.out.all()).toMatch(/is not one of/);
    expect(harness.out.all()).toMatch(/book\.visibility/);
  });

  it("says --config alone does nothing, instead of silently ignoring it", async () => {
    const harness = fullHarness();
    const code = await harness.run(["--config", "/work/setup.yml"]);
    expect(code).toBe(2);
    expect(harness.out.all()).toMatch(/only has an effect with --non-interactive/);
  });
});

describe("destructive confirmation", () => {
  it("never overwrites an existing file without being told to", async () => {
    const harness = fullHarness({ "overwrite:book.yml": false });
    harness.fs.seed(`${DIR}/book.yml`, "# a book the author already had\ntitle: Mine\n");

    const code = await harness.run(["book", "--dir", DIR]);

    // Refusing is a decision, not a fault: exit 0, and the file is untouched.
    expect(code).toBe(0);
    expect(harness.fs.files.get(`${DIR}/book.yml`)).toBe(
      "# a book the author already had\ntitle: Mine\n",
    );
    expect(harness.out.all()).toMatch(/left untouched/i);
  });

  it("keeps a backup when it is told to replace one", async () => {
    const harness = fullHarness({ "overwrite:book.yml": true });
    harness.fs.seed(`${DIR}/book.yml`, "# older\ntitle: Mine\n");

    await harness.run(["book", "--dir", DIR]);

    const backups = [...harness.fs.files.keys()].filter((name) => name.includes("book.yml.bak-"));
    expect(backups).toHaveLength(1);
    expect(harness.fs.files.get(backups[0] ?? "")).toBe("# older\ntitle: Mine\n");
    expect(harness.fs.files.get(`${DIR}/book.yml`)).toContain("The Hollow Creek Anomaly");
  });

  it("offers overwriting with a default of no", async () => {
    const harness = fullHarness({ "overwrite:book.yml": false });
    harness.fs.seed(`${DIR}/book.yml`, "# older\n");
    await harness.run(["book", "--dir", DIR]);
    const prompt = harness.prompter.asked.find((entry) => entry.id === "overwrite:book.yml");
    expect(prompt?.destructive).toBe(true);
  });

  it("in non-interactive mode a destructive step must be stated explicitly", async () => {
    const harness = fullHarness();
    harness.fs.seed(`${DIR}/book.yml`, "# older\n");
    harness.fs.seed(
      "/work/setup.yml",
      `directory: ${DIR}\nstages: [book]\nanswers:\n  book.title: A Book\n  book.slug: a-book\n  book.visibility: private\n  book.createRemote: false\n`,
    );

    const code = await harness.run(["--non-interactive", "--config", "/work/setup.yml"]);

    expect(code).toBe(2);
    expect(harness.out.all()).toMatch(/overwrite:book\.yml/);
    expect(harness.out.all()).toMatch(/destructive: must be explicit/);
  });

  it("leaves .gitkeep placeholders alone rather than arguing about them", async () => {
    const harness = fullHarness();
    harness.fs.seed(`${DIR}/chapters/.gitkeep`, "not empty any more");
    await harness.run(["book", "--dir", DIR]);
    expect(harness.fs.files.get(`${DIR}/chapters/.gitkeep`)).toBe("not empty any more");
  });
});

describe("prerequisites and failure messages", () => {
  it("stops before the book stage when a required tool is missing", async () => {
    const runner = happyRunner().remove("git").on(["git", "--version"], {
      code: 127,
      stdout: "",
      stderr: "git: not found",
    });
    const harness = makeHarness({ directory: DIR, answers: HAPPY_ANSWERS, runner });

    const code = await harness.run(["--dir", DIR]);

    expect(code).toBe(0);
    expect(harness.out.all()).toMatch(/git-scm\.com/);
    expect(harness.fs.files.has(`${DIR}/book.yml`)).toBe(false);
  });

  it("explains an already-taken repository name instead of pushing into it", async () => {
    const runner = happyRunner({ login: "novelist" }).on(["gh", "repo", "create"], {
      code: 1,
      stdout: "",
      stderr: "GraphQL: Name already exists on this account",
    });
    const harness = makeHarness({ directory: DIR, answers: HAPPY_ANSWERS, runner });

    const code = await harness.run(["book", "--dir", DIR]);

    expect(code).toBe(1);
    expect(harness.out.all()).toMatch(/already has a repository called/);
    expect(harness.out.all()).toMatch(/Pick a different short name/);
  });

  it("refuses to collaborate before the site is published", async () => {
    const harness = fullHarness();
    await harness.run(["book", "--dir", DIR]);
    const code = await harness.run(["collaborate", "--dir", DIR]);
    expect(code).toBe(1);
    expect(harness.out.all()).toMatch(/not published yet/);
    expect(harness.out.all()).toMatch(/create-authorbot publish/);
  });

  it("refuses to work on a directory that holds no book", async () => {
    const harness = fullHarness();
    const code = await harness.run(["publish", "--dir", DIR]);
    expect(code).toBe(1);
    expect(harness.out.all()).toMatch(/no book in/);
  });

  it("never shows a stack trace for an unexpected failure", async () => {
    const runner = new FakeProcessRunner();
    runner.on(["git", "--version"], () => {
      throw new Error("something nobody predicted at /some/path/file.ts:1:1");
    });
    const harness = makeHarness({ directory: DIR, answers: HAPPY_ANSWERS, runner });

    const code = await harness.run(["book", "--dir", DIR]);

    expect(code).toBe(1);
    const output = harness.out.all();
    expect(output).toMatch(/bug in the wizard/);
    expect(output).not.toMatch(/\bat Object\./);
    expect(output).not.toMatch(/node_modules/);
  });
});

describe("upgrade delegates", () => {
  it("forwards the flags to `authorbot upgrade`", async () => {
    const harness = fullHarness();
    await harness.run(["book", "--dir", DIR]);
    harness.fs.seed(path.join(DIR, "node_modules", ".bin", "authorbot"), "#!/bin/sh\n");

    await harness.run(["upgrade", "--dir", DIR, "--check"]);

    const call = harness.runner.calls.find((entry) => entry.args.includes("upgrade"));
    expect(call?.args).toEqual(["upgrade", "--check"]);
  });

  it("degrades with a clear message when the CLI is not installed", async () => {
    const runner = happyRunner().remove("authorbot").remove("npx");
    const harness = makeHarness({ directory: DIR, answers: HAPPY_ANSWERS, runner });
    harness.fs.seed(`${DIR}/book.yml`, "schema: authorbot.book/v1\ntitle: T\nslug: t\n");

    const code = await harness.run(["upgrade", "--dir", DIR]);

    expect(code).toBe(0);
    expect(harness.out.all()).toMatch(/not available here/);
    expect(harness.out.all()).toMatch(/npm install/);
  });

  // `authorbot upgrade --check` reports its finding through the exit code
  // (ADR-0021 §3). These three cases pin the wire contract between the wizard
  // and whichever CLI version the author has installed.
  const checkHarness = (code: number) => {
    const runner = happyRunner().on(["authorbot", "upgrade"], {
      code,
      stdout: "0.1.0 -> 0.2.0\n",
      stderr: "",
    });
    const harness = makeHarness({ directory: DIR, answers: HAPPY_ANSWERS, runner });
    harness.fs.seed(`${DIR}/book.yml`, "schema: authorbot.book/v1\ntitle: T\nslug: t\n");
    return harness;
  };

  // The reporter wraps at 80 columns, so assertions collapse whitespace rather
  // than depending on where a phrase happens to break.
  const said = (harness: Harness) => harness.out.all().replace(/\s+/g, " ");

  it("reads exit 10 from --check as an available upgrade", async () => {
    const harness = checkHarness(10);
    const code = await harness.run(["upgrade", "--dir", DIR, "--check"]);
    expect(code).toBe(0);
    expect(said(harness)).toMatch(/An upgrade is available\./);
    expect(said(harness)).not.toMatch(/it updates your book's file format/);
  });

  it("reads exit 11 as an upgrade that carries a format migration", async () => {
    const harness = checkHarness(11);
    const code = await harness.run(["upgrade", "--dir", DIR, "--check"]);
    expect(code).toBe(0);
    expect(said(harness)).toMatch(/it updates your book's file format/);
    expect(said(harness)).toMatch(/pull request you review before anything lands/);
  });

  // The bug this pins: treating ANY non-zero code as "available" reported a
  // broken check to the author as good news.
  it("treats an unrecognised non-zero --check code as a failure, not good news", async () => {
    const harness = checkHarness(2);
    const code = await harness.run(["upgrade", "--dir", DIR, "--check"]);
    expect(code).not.toBe(0);
    expect(harness.out.all()).not.toMatch(/An upgrade is available/);
  });

  it("recovers an old CLI with the exact transient helper instead of dirtying the book", async () => {
    const runner = happyRunner().on(["authorbot", "upgrade"], {
      code: 2,
      stdout: "",
      stderr: 'authorbot: unknown command "upgrade"\n',
    });
    const harness = makeHarness({ directory: DIR, answers: HAPPY_ANSWERS, runner });
    harness.fs.seed(`${DIR}/book.yml`, "schema: authorbot.book/v1\ntitle: T\nslug: t\n");

    const code = await harness.run(["upgrade", "--dir", DIR]);
    const output = said(harness);

    expect(code).not.toBe(0);
    expect(output).toContain(
      `npx --yes @authorbot/cli@${TOOLCHAIN_VERSION} upgrade --to ${TOOLCHAIN_VERSION}`,
    );
    expect(output).not.toContain("npm install --save-dev");
  });
});

describe("help and version", () => {
  it("lists every stage", async () => {
    const harness = fullHarness();
    await harness.run(["--help"]);
    for (const name of STAGE_NAMES) {
      expect(harness.out.stdout.join("\n")).toContain(name);
    }
  });

  it("prints an example config that the parser accepts", async () => {
    const harness = fullHarness();
    const code = await harness.run(["--example-config"]);
    expect(code).toBe(0);
    expect(harness.out.stdout.join("\n")).toContain("book.title");
  });
});
