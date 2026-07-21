#!/usr/bin/env node
/**
 * `create-authorbot`. The npx entry point (Phase 6 contract §1) — deliberately
 * `npx`, never `curl | bash`: the toolchain already requires Node, so piping a
 * remote script into a shell would buy nothing and cost the ability to audit
 * what runs.
 *
 * This file does one thing: build the real ports and hand them to `runCli`.
 * Everything testable lives behind that boundary.
 */
import { runCli } from "./cli.js";
import { NodeProcessRunner } from "./runtime/process.js";
import { TtyPrompter } from "./runtime/prompt.js";
import {
  CryptoRandom,
  FetchHttpClient,
  NodeFileSystem,
  NodeLoopbackServerFactory,
  SystemBrowserOpener,
  SystemClock,
} from "./runtime/node-ports.js";
import type { OutputPort } from "./ports.js";

const out: OutputPort = {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
  error: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

const runner = new NodeProcessRunner();

process.exitCode = await runCli(process.argv.slice(2), {
  runner,
  prompter: new TtyPrompter({ input: process.stdin, output: out }),
  fs: new NodeFileSystem(),
  http: new FetchHttpClient(),
  browser: new SystemBrowserOpener(runner),
  loopback: new NodeLoopbackServerFactory(),
  clock: new SystemClock(),
  random: new CryptoRandom(),
  env: {
    cwd: process.cwd(),
    env: process.env,
    columns: process.stdout.columns ?? 80,
    isTty: process.stdout.isTTY === true,
    nodeVersion: process.version,
  },
  out,
});
