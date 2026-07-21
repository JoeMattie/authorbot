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

export class NodeProcessRunner implements ProcessRunner {
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  run(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd ?? process.cwd(),
        env: { ...this.#env, ...options.env },
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
