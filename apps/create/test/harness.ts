/**
 * Builds a `CliDeps` out of fakes and runs the real `runCli`.
 *
 * Every integration test goes through this, so they exercise argument parsing,
 * journal opening, context wiring, stage ordering, and error reporting - not a
 * test-only re-implementation of any of them.
 */
import { NodeLoopbackServerFactory } from "../src/runtime/node-ports.js";
import { runCli, type CliDeps } from "../src/cli.js";
import type { Environment, LoopbackServerFactory } from "../src/ports.js";
import {
  CollectingOutput,
  FakeBrowser,
  FakeClock,
  FakeHttpClient,
  FakeProcessRunner,
  MemoryFileSystem,
  ScriptedPrompter,
  SeededRandom,
  fakeEnvironment,
  happyRunner,
} from "./fakes.js";

export interface Harness {
  readonly deps: CliDeps;
  readonly runner: FakeProcessRunner;
  readonly prompter: ScriptedPrompter;
  readonly fs: MemoryFileSystem;
  readonly http: FakeHttpClient;
  readonly browser: FakeBrowser;
  readonly clock: FakeClock;
  readonly out: CollectingOutput;
  readonly directory: string;
  run(argv: readonly string[]): Promise<number>;
  /** Parsed `.authorbot-setup.json`, or null when it has not been written. */
  journal(): Record<string, unknown> | null;
}

export interface HarnessOptions {
  readonly directory?: string;
  readonly answers?: Record<string, unknown>;
  readonly useDefaults?: boolean;
  readonly runner?: FakeProcessRunner;
  readonly http?: FakeHttpClient;
  readonly browser?: FakeBrowser;
  readonly env?: Partial<Environment>;
  readonly loopback?: LoopbackServerFactory;
  readonly login?: string;
  readonly siteUrl?: string;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const directory = options.directory ?? "/work/my-book";
  const runner =
    options.runner ??
    happyRunner({
      ...(options.login === undefined ? {} : { login: options.login }),
      ...(options.siteUrl === undefined ? {} : { siteUrl: options.siteUrl }),
    });
  const prompter = new ScriptedPrompter(options.answers ?? {}, {
    ...(options.useDefaults === undefined ? {} : { useDefaults: options.useDefaults }),
  });
  const fs = new MemoryFileSystem();
  const http = options.http ?? new FakeHttpClient();
  const browser = options.browser ?? new FakeBrowser();
  const clock = new FakeClock();
  const out = new CollectingOutput();

  const deps: CliDeps = {
    runner,
    prompter,
    fs,
    http,
    browser,
    loopback: options.loopback ?? new NodeLoopbackServerFactory(),
    clock,
    random: new SeededRandom(),
    env: fakeEnvironment({ cwd: "/work", ...options.env }),
    out,
  };

  return {
    deps,
    runner,
    prompter,
    fs,
    http,
    browser,
    clock,
    out,
    directory,
    run: (argv) => runCli(argv, deps),
    journal: () => {
      const text = fs.files.get(`${directory}/.authorbot-setup.json`);
      return text === undefined ? null : (JSON.parse(text) as Record<string, unknown>);
    },
  };
}

/** Answers for a full non-stop run, so tests only state what they care about. */
export const HAPPY_ANSWERS: Record<string, unknown> = {
  "book.title": "The Hollow Creek Anomaly",
  "book.slug": "hollow-creek-anomaly",
  "book.visibility": "private",
  "book.createRemote": true,
  "publish.workerName": "hollow-creek-anomaly",
  "publish.customDomain": "",
  "publish.setCiSecrets": true,
  "publish.cloudflareApiToken": "cf_token_abcdefghijklmnop",
  "publish.cloudflareAccountId": "0123456789abcdef0123456789abcdef",
  "collaborate.proceed": true,
  "collaborate.d1Name": "hollow-creek-anomaly-authorbot",
  "agent.name": "drafting-agent",
  "agent.mintNow": false,
  "flow.continue.publish": true,
  "flow.continue.collaborate": true,
  "flow.continue.agent": true,
  "flow.continue.upgrade": false,
  "doctor.login.gh": false,
  "doctor.login.wrangler": false,
};
