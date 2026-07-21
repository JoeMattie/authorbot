/**
 * Running the pinned toolchain from the book directory.
 *
 * ADR-0022 moved the toolchain pin into the book's own `package.json`, so the
 * `authorbot` and `wrangler` a book should run are the ones inside its
 * `node_modules` — not whatever happens to be installed globally. Resolution
 * order is therefore:
 *
 *   1. `<book>/node_modules/.bin/<tool>` — the pinned version, exactly what CI
 *      will run.
 *   2. the tool on PATH — a global install, used with a note that it may not
 *      match the pin.
 *   3. `npx --no-install <tool>` — last resort; `--no-install` because
 *      silently downloading an unpinned package mid-setup is precisely the
 *      unpinned install the pin exists to prevent.
 */
import path from "node:path";
import type { WizardContext } from "./context.js";
import type { ExecResult } from "./ports.js";

export interface ToolInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /** How it was found, for the author-facing note. */
  readonly source: "pinned" | "path" | "npx";
}

export async function resolveTool(
  ctx: WizardContext,
  tool: string,
): Promise<ToolInvocation | null> {
  const local = path.join(ctx.directory, "node_modules", ".bin", tool);
  if (await ctx.fs.exists(local)) {
    return { command: local, args: [], source: "pinned" };
  }
  const onPath = await ctx.runner.which(tool);
  if (onPath !== null) {
    return { command: tool, args: [], source: "path" };
  }
  const npx = await ctx.runner.which("npx");
  if (npx !== null && (await npxCanRun(ctx, tool))) {
    return { command: "npx", args: ["--no-install", tool], source: "npx" };
  }
  return null;
}

/**
 * Whether `npx --no-install <tool>` would actually run something.
 *
 * `--no-install` succeeds only when the package is already in npx's cache.
 * When it is not, npx exits non-zero with a registry error — and a caller
 * comparing exit codes cannot tell that apart from the tool running and
 * reporting a genuine problem. That is exactly how a book that validates
 * cleanly was reported as failing validation: `authorbot` was merely absent,
 * and npx's refusal to install it was read as the book being invalid.
 *
 * Probing keeps the two apart. An unrunnable tool resolves to null, which
 * callers already handle by saying the toolchain is not installed yet rather
 * than blaming the author's files for a failure that never involved them.
 */
async function npxCanRun(ctx: WizardContext, tool: string): Promise<boolean> {
  const probe = await ctx.runner.run("npx", ["--no-install", tool, "--version"], {
    cwd: ctx.directory,
  });
  return probe.code === 0;
}

export interface RunToolOptions {
  readonly purpose: string;
  readonly mutates?: boolean;
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly required?: boolean;
  readonly onFailure?: string;
  readonly dryRunStdout?: string;
}

/**
 * Runs a toolchain command. Returns null when the tool cannot be found at all,
 * which callers turn into an explanation rather than a crash — a missing
 * `wrangler` before the book's `npm install` has run is an ordinary situation,
 * not an error.
 */
export async function runTool(
  ctx: WizardContext,
  tool: string,
  args: readonly string[],
  options: RunToolOptions,
): Promise<ExecResult | null> {
  const resolved = await resolveTool(ctx, tool);
  if (resolved === null) {
    return null;
  }
  return await ctx.actions.run({
    purpose: options.purpose,
    command: resolved.command,
    args: [...resolved.args, ...args],
    cwd: options.cwd ?? ctx.directory,
    mutates: options.mutates ?? false,
    timeoutMs: options.timeoutMs ?? 180_000,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.required === undefined ? {} : { required: options.required }),
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    ...(options.dryRunStdout === undefined ? {} : { dryRunStdout: options.dryRunStdout }),
  });
}

export function runAuthorbot(
  ctx: WizardContext,
  args: readonly string[],
  options: RunToolOptions,
): Promise<ExecResult | null> {
  return runTool(ctx, "authorbot", args, options);
}

export function runWrangler(
  ctx: WizardContext,
  args: readonly string[],
  options: RunToolOptions,
): Promise<ExecResult | null> {
  return runTool(ctx, "wrangler", args, options);
}
