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
import { reportFatal } from "./errors.js";
import { SecretVault, redactError } from "./secrets.js";
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
import { invocationCommand } from "./invocation.js";

const out: OutputPort = {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
  error: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

const runner = new NodeProcessRunner();

// One vault for the whole process, shared by everything that can write: the
// reporter (inside `runCli`), the prompter, and the handlers below. A second
// vault would be a second, emptier set of secrets to redact against.
const vault = new SecretVault();

const fatal = (error: unknown): void => {
  reportFatal(out, (value) => redactError(vault, value), error);
};

// Nothing reaches Node's default handler, which prints a raw stack trace
// (contract §5). These cover what `runCli`'s own try/catch cannot: a throw from
// outside it, and a rejection nobody is awaiting.
process.on("uncaughtException", (error) => {
  fatal(error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  fatal(reason);
  process.exit(1);
});

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    runner,
    vault,
    prompter: new TtyPrompter({ input: process.stdin, output: out, vault }),
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
      invocation: invocationCommand(process.argv[1]),
    },
    out,
  });
} catch (error) {
  fatal(error);
  process.exitCode = 1;
} finally {
  // Let the process end.
  //
  // Once a readline interface has attached to a TTY stdin, closing it does not
  // reliably release the underlying handle, so Node finishes every last piece
  // of work and then sits in the event loop forever with nothing to do. The
  // author sees the whole run complete, "ok Done.", and no prompt back —
  // indistinguishable from a hang, and only Ctrl-C ends it.
  //
  // The mirror of the timer that was `unref()`d and let the process exit too
  // early. Here the handle is real work's leftovers, so pause rather than
  // destroy: anything still legitimately reading stdin keeps its data, and a
  // process with nothing left to do simply exits.
  process.stdin.pause();
}
