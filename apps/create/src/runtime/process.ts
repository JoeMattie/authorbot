/**
 * Real process execution. The only module in the package that imports
 * `node:child_process`.
 *
 * `spawn` with an argv array, never a shell string: the wizard passes
 * author-supplied values (a title, a slug, a repository name) as arguments,
 * and a shell would interpret them.
 */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import type { ExecOptions, ExecResult, ProcessRunner } from "../ports.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The environment a child gets, minus the parent npm's own configuration.
 *
 * `npx @authorbot/create` is the documented way to run this wizard, and npx
 * exports its whole config as `npm_config_*` - `npm_config_prefix`,
 * `npm_config_local_prefix`, `npm_config_globalconfig`, a dozen more. A child
 * `npm install` inherits them and resolves against npx's cache directory
 * instead of the book, so the install fails every time.
 *
 * It fails ONLY through npx. Run the same binary directly and the environment
 * is clean and everything works, which is what made this look like the
 * author's machine rather than the wizard: it could not be reproduced by
 * anyone testing the built output, only by anyone actually using it.
 *
 * Stripped for npm and npx alone. Other tools are not confused by these, and
 * scrubbing an environment more broadly than the problem is how a tool that
 * needed one of them breaks later for no visible reason.
 */
function childEnvironment(env: NodeJS.ProcessEnv, command: string): NodeJS.ProcessEnv {
  const base = command.replace(/\.(cmd|exe)$/i, "");
  if (base !== "npm" && base !== "npx") {
    return { ...env };
  }
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_/i.test(key) || /^NPM_CONFIG_/.test(key)) {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

export class NodeProcessRunner implements ProcessRunner {
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  run(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd ?? process.cwd(),
        env: { ...childEnvironment(this.#env, command), ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (!settled) {
          child.kill("SIGTERM");
          // SIGKILL after a grace period: a hung `wrangler` that ignores
          // SIGTERM must not hold the wizard open forever.
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }
      }, timeoutMs);
      timer.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          // A signalled death is a failure; report it as a non-zero exit
          // rather than as `null`, which every caller would have to handle.
          code: code ?? (signal === null ? 1 : 128),
          stdout,
          stderr,
        });
      });

      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin);
      } else {
        // Close stdin so a tool that would otherwise wait for input fails
        // fast instead of hanging until the timeout.
        child.stdin.end();
      }
    });
  }

  async which(command: string): Promise<string | null> {
    if (command.includes(path.sep)) {
      return (await isExecutable(command)) ? command : null;
    }
    const pathVar = this.#env["PATH"] ?? "";
    const extensions =
      process.platform === "win32" ? (this.#env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
    for (const directory of pathVar.split(path.delimiter)) {
      if (directory.length === 0) {
        continue;
      }
      for (const extension of extensions) {
        const candidate = path.join(directory, `${command}${extension}`);
        if (await isExecutable(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  }
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
