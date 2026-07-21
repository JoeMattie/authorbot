import path from "node:path";
import { BUILD_USAGE, runBuild } from "./build.js";
import { UPGRADE_USAGE, runUpgrade } from "./upgrade/upgrade.js";
import type { Finding, ValidationReport } from "./validate/findings.js";
import { RepoAccessError, validateBookRepo } from "./validate/index.js";

const USAGE = `Usage: authorbot validate <path> [--json] [--quiet]

Validate an Authorbot book repository (Phase 0 contract section 5).

Options:
  --json       machine-readable output: { valid, errors, warnings }
  --quiet      human-readable output shows errors only
  -h, --help   show this help

Exit codes:
  0  valid (warnings allowed)
  1  one or more error findings
  2  usage or I/O error`;

const TOP_USAGE = `Usage: authorbot <command> [options]

Commands:
  validate <path>   validate a book repository (Phase 0 contract)
  build <repo>      build the static reading site (Phase 1 contract)
  upgrade [path]    move to a newer Authorbot release, as a pull request
                    (ADR-0021)

Run "authorbot <command> --help" for command options.

Setting up a new book? This is the toolchain that validates and builds one.
The guided setup is a different command:

  npx @authorbot/create`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: CliIo = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

function renderHuman(target: string, report: ValidationReport, quiet: boolean): string {
  const shown: Finding[] = quiet ? report.errors : [...report.errors, ...report.warnings];
  const byPath = new Map<string, Finding[]>();
  for (const finding of shown) {
    const group = byPath.get(finding.path);
    if (group === undefined) {
      byPath.set(finding.path, [finding]);
    } else {
      group.push(finding);
    }
  }
  const lines: string[] = [];
  for (const filePath of [...byPath.keys()].sort()) {
    lines.push(filePath);
    for (const finding of byPath.get(filePath) ?? []) {
      const pointer = finding.pointer === undefined ? "" : ` [${finding.pointer}]`;
      lines.push(`  ${finding.severity} ${finding.code}${pointer}: ${finding.message}`);
    }
    lines.push("");
  }
  const status = report.valid ? "valid" : "invalid";
  lines.push(
    `${target}: ${status} (${report.errors.length} error${report.errors.length === 1 ? "" : "s"}, ` +
      `${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"})`,
  );
  return lines.join("\n");
}

/**
 * Hand-rolled argv handling (no CLI framework, contract section 1).
 * Returns the process exit code.
 */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    io.err(TOP_USAGE);
    return 2;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    io.out(`${TOP_USAGE}\n\n${USAGE}\n\n${BUILD_USAGE}\n\n${UPGRADE_USAGE}`);
    return 0;
  }
  if (command === "build") {
    return runBuild(rest, io);
  }
  if (command === "upgrade") {
    return runUpgrade(rest, io);
  }
  if (command !== "validate") {
    io.err(`authorbot: unknown command "${command}"\n\n${TOP_USAGE}`);
    return 2;
  }

  let json = false;
  let quiet = false;
  const positionals: string[] = [];
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "-h" || arg === "--help") {
      io.out(USAGE);
      return 0;
    } else if (arg.startsWith("-")) {
      io.err(`authorbot: unknown option "${arg}"\n\n${USAGE}`);
      return 2;
    } else {
      positionals.push(arg);
    }
  }
  const target = positionals[0];
  if (target === undefined || positionals.length !== 1) {
    io.err(`authorbot: validate takes exactly one <path>\n\n${USAGE}`);
    return 2;
  }

  // Resolve relative paths against the process working directory (standard
  // CLI behavior). INIT_CWD is deliberately NOT consulted: pnpm/npm export it
  // to every nested process, so honoring it would resolve paths against the
  // wrong base (or a wrong same-named repo) whenever a package script changes
  // directory before invoking authorbot.
  const resolved = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);

  let report: ValidationReport;
  try {
    report = await validateBookRepo(resolved);
  } catch (error) {
    if (error instanceof RepoAccessError) {
      io.err(`authorbot: ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(renderHuman(target, report, quiet));
  }
  return report.valid ? 0 : 1;
}
