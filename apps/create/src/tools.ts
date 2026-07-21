/**
 * Prerequisite detection (Phase 6 contract §3.1).
 *
 * Every probe here is read-only, which is why `doctor` works unchanged under
 * `--dry-run`: looking at a machine changes nothing. Nothing is ever
 * installed unasked, and the two credential flows (`gh auth login`,
 * `wrangler login`) are offered rather than scripted - both are interactive
 * and browser-driven, and a wizard that tried to script them would be a
 * wizard that asked for a password.
 */
import type { Actions } from "./actions.js";
import { WizardError } from "./errors.js";

export type ToolStatus = "ok" | "missing" | "unauthenticated" | "unknown";

export interface ToolReport {
  /** Command name as invoked. */
  readonly name: string;
  /** Author-facing description of what it is for. */
  readonly purpose: string;
  readonly status: ToolStatus;
  /** Version string when detected. */
  readonly version?: string;
  /** For `gh`: the signed-in login. */
  readonly account?: string;
  /** What to do about it, when the status is not ok. */
  readonly remedy?: string;
  /** True when the wizard cannot proceed past `book` without it. */
  readonly required: boolean;
}

export const MINIMUM_NODE_MAJOR = 22;

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

/**
 * Node is checked from the version already running rather than by spawning
 * `node --version`: the wizard *is* a Node process, so the version that
 * matters is this one, not whichever `node` happens to be first on PATH.
 */
export function checkNode(reportedVersion: string): ToolReport {
  const match = /v?(\d+)\./.exec(reportedVersion);
  const major = match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  if (major >= MINIMUM_NODE_MAJOR) {
    return {
      name: "node",
      purpose: "runs Authorbot itself",
      status: "ok",
      version: reportedVersion,
      required: true,
    };
  }
  return {
    name: "node",
    purpose: "runs Authorbot itself",
    status: "missing",
    version: reportedVersion,
    required: true,
    remedy: `Authorbot needs Node ${String(MINIMUM_NODE_MAJOR)} or newer; this is ${reportedVersion}. Install a current version from https://nodejs.org and run again.`,
  };
}

async function versionOf(
  actions: Actions,
  command: string,
  args: readonly string[],
): Promise<string | null> {
  const result = await actions.run({
    purpose: `check whether ${command} is installed`,
    command,
    args,
    mutates: false,
    timeoutMs: 20_000,
  });
  if (result.code !== 0) {
    return null;
  }
  return firstLine(result.stdout) || firstLine(result.stderr) || "installed";
}

export async function checkGit(actions: Actions): Promise<ToolReport> {
  const version = await versionOf(actions, "git", ["--version"]);
  if (version === null) {
    return {
      name: "git",
      purpose: "keeps the history of your book",
      status: "missing",
      required: true,
      remedy: "Install Git from https://git-scm.com/downloads and run again.",
    };
  }
  return {
    name: "git",
    purpose: "keeps the history of your book",
    status: "ok",
    version,
    required: true,
  };
}

export async function checkPnpm(actions: Actions): Promise<ToolReport> {
  const version = await versionOf(actions, "pnpm", ["--version"]);
  if (version === null) {
    return {
      name: "pnpm",
      purpose: "only needed if you work on Authorbot itself",
      status: "missing",
      required: false,
      remedy:
        "Not needed to write a book - your repository uses npm. Install with `npm install -g pnpm` only if you plan to work on Authorbot's own source.",
    };
  }
  return {
    name: "pnpm",
    purpose: "only needed if you work on Authorbot itself",
    status: "ok",
    version,
    required: false,
  };
}

/**
 * `gh` plus its auth state. The two are reported as one line because an
 * installed-but-signed-out `gh` is, for the author's purposes, the same
 * problem with a different fix.
 */
export async function checkGh(actions: Actions): Promise<ToolReport> {
  const version = await versionOf(actions, "gh", ["--version"]);
  if (version === null) {
    return {
      name: "gh",
      purpose: "creates your repository on GitHub and proves who you are",
      status: "missing",
      required: true,
      remedy: "Install the GitHub CLI from https://cli.github.com and run again.",
    };
  }
  const status = await actions.run({
    purpose: "check whether the GitHub CLI is signed in",
    command: "gh",
    args: ["auth", "status"],
    mutates: false,
    timeoutMs: 20_000,
  });
  if (status.code !== 0) {
    return {
      name: "gh",
      purpose: "creates your repository on GitHub and proves who you are",
      status: "unauthenticated",
      version,
      required: true,
      remedy: "Run `gh auth login` and sign in with your browser, then run this again.",
    };
  }
  const login = await ghLogin(actions);
  return {
    name: "gh",
    purpose: "creates your repository on GitHub and proves who you are",
    status: "ok",
    version,
    required: true,
    ...(login === null ? {} : { account: login }),
  };
}

/** The signed-in GitHub login, or null. Contract §3.2: the author's name. */
export async function ghLogin(actions: Actions): Promise<string | null> {
  const result = await actions.run({
    purpose: "read your GitHub username",
    command: "gh",
    args: ["api", "user", "--jq", ".login"],
    mutates: false,
    timeoutMs: 20_000,
  });
  if (result.code !== 0) {
    return null;
  }
  const login = result.stdout.trim();
  return login.length > 0 ? login : null;
}

export async function checkWrangler(actions: Actions): Promise<ToolReport> {
  const version = await versionOf(actions, "wrangler", ["--version"]);
  if (version === null) {
    return {
      name: "wrangler",
      purpose: "puts your reading site on Cloudflare",
      status: "missing",
      required: false,
      remedy:
        "Needed only to publish. Your book repository installs it for you (`npm install` in the book directory), or install it globally with `npm install -g wrangler`.",
    };
  }
  const who = await actions.run({
    purpose: "check whether Cloudflare is signed in",
    command: "wrangler",
    args: ["whoami"],
    mutates: false,
    timeoutMs: 30_000,
  });
  if (who.code !== 0) {
    return {
      name: "wrangler",
      purpose: "puts your reading site on Cloudflare",
      status: "unauthenticated",
      version,
      required: false,
      remedy:
        "Run `wrangler login` and approve in your browser, or set CLOUDFLARE_API_TOKEN, then run this again.",
    };
  }
  const account = /([\w.+-]+@[\w.-]+)/.exec(who.stdout)?.[1];
  return {
    name: "wrangler",
    purpose: "puts your reading site on Cloudflare",
    status: "ok",
    version,
    required: false,
    ...(account === undefined ? {} : { account }),
  };
}

/**
 * Asserts a tool is usable before a stage that depends on it, with a message
 * naming the fix rather than the missing binary.
 */
export function requireTool(report: ToolReport, stage: string): void {
  if (report.status === "ok") {
    return;
  }
  throw new WizardError(
    `The "${stage}" step needs ${report.name}, which is ${
      report.status === "missing" ? "not installed" : "not signed in"
    }.`,
    report.remedy ?? `Install ${report.name} and run again.`,
  );
}
