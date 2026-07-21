import path from "node:path";
import type { CliIo } from "./cli.js";
import type { Finding, ValidationReport } from "./validate/findings.js";
import { RepoAccessError, validateBookRepo } from "./validate/index.js";

export const BUILD_USAGE = `Usage: authorbot build <repo> [--out <dir>] [--base-url <url>] [--api-url <path>] [--include-drafts] [--force]

Build the static reading site for an Authorbot book repository (Phase 1
contract sections 1-3). Refuses to build when validation reports errors
(warnings are allowed); --force overrides.

Options:
  --out <dir>       output directory (default: _site)
  --base-url <url>  public base URL or base path; prefixes internal links
                    and is recorded in authorbot-build.json
  --api-url <path>  collaboration API base PATH; enables the annotation
                    islands on chapter pages (Phase 2b). Root-relative only
                    ("/" or a base path like "/my-book") - the API is
                    same-origin with the site, so an absolute URL is
                    rejected (ADR-0019). Overrides publication.api_url in
                    book.yml. Without either, zero JavaScript is emitted.
  --include-drafts  also publish draft/proposed chapters, with a draft banner
  --force           build despite validation errors (prominent warning)
  -h, --help        show this help

Exit codes:
  0  site built
  1  validation errors (build refused; use --force to override)
  2  usage or I/O error`;

function renderFindings(findings: Finding[], io: CliIo): void {
  for (const finding of findings) {
    const pointer = finding.pointer === undefined ? "" : ` [${finding.pointer}]`;
    io.err(`  ${finding.severity} ${finding.code} ${finding.path}${pointer}: ${finding.message}`);
  }
}

/**
 * `authorbot build` - thin wrapper around `@authorbot/publisher` with the
 * contract's validate-gate. Returns the process exit code.
 */
export async function runBuild(args: string[], io: CliIo): Promise<number> {
  let out = "_site";
  let baseUrl: string | undefined;
  let apiUrl: string | undefined;
  let includeDrafts = false;
  let force = false;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      io.out(BUILD_USAGE);
      return 0;
    } else if (arg === "--include-drafts") {
      includeDrafts = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--out" || arg === "--base-url" || arg === "--api-url") {
      const value = args[i + 1];
      if (value === undefined) {
        io.err(`authorbot: ${arg} requires a value\n\n${BUILD_USAGE}`);
        return 2;
      }
      if (arg === "--out") {
        out = value;
      } else if (arg === "--base-url") {
        baseUrl = value;
      } else {
        apiUrl = value;
      }
      i += 1;
    } else if (arg.startsWith("-")) {
      io.err(`authorbot: unknown option "${arg}"\n\n${BUILD_USAGE}`);
      return 2;
    } else {
      positionals.push(arg);
    }
  }

  const target = positionals[0];
  if (target === undefined || positionals.length !== 1) {
    io.err(`authorbot: build takes exactly one <repo>\n\n${BUILD_USAGE}`);
    return 2;
  }

  // Relative paths resolve against the process cwd (same policy as validate;
  // INIT_CWD is deliberately ignored).
  const repoPath = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  const outDir = path.isAbsolute(out) ? out : path.resolve(process.cwd(), out);

  // Validate-gate (Phase 1 contract section 1).
  let report: ValidationReport;
  try {
    report = await validateBookRepo(repoPath);
  } catch (error) {
    if (error instanceof RepoAccessError) {
      io.err(`authorbot: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (report.errors.length > 0) {
    if (!force) {
      io.err(`authorbot: ${target} has ${report.errors.length} validation error(s); build refused.`);
      renderFindings(report.errors, io);
      io.err("Fix the errors or pass --force to build anyway.");
      return 1;
    }
    io.err("WARNING: building despite validation errors (--force).");
    io.err(`WARNING: ${report.errors.length} error(s) follow; the output may be incomplete.`);
    renderFindings(report.errors, io);
  }
  if (report.warnings.length > 0) {
    io.err(`authorbot: ${report.warnings.length} validation warning(s) (allowed).`);
  }

  // Loaded lazily so `authorbot validate` never pays the Astro import cost.
  const { buildSite, PublisherError } = await import("@authorbot/publisher");
  try {
    const manifest = await buildSite({
      repoPath,
      outDir,
      baseUrl,
      apiUrl,
      includeDrafts,
      onWarning: (message) => {
        io.err(`authorbot: warning: ${message}`);
      },
    });
    io.out(
      `built ${manifest.chapters.length} chapter(s) to ${outDir} ` +
        `(commit ${manifest.commit ?? "none"}, publisher ${manifest.publisher_version})`,
    );
    return 0;
  } catch (error) {
    if (error instanceof PublisherError) {
      io.err(`authorbot: ${error.message}`);
      return 2;
    }
    throw error;
  }
}
