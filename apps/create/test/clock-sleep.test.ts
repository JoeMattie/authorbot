/**
 * `SystemClock.sleep` against a real Node process.
 *
 * The timer used to be `unref()`d, which means it does not hold the event loop
 * open. Whenever a sleep was the only thing pending — precisely the case while
 * polling a freshly deployed site, prompts finished and no fetch in flight —
 * Node ran out of work and exited mid-await. The wizard disappeared after
 * "Waiting for <url> to answer", leaving the author with a deploy that had in
 * fact happened and no word either way.
 *
 * This has to spawn a real process: inside vitest the runner's own handles
 * keep the loop alive, so an unref'd timer resolves perfectly well and the bug
 * is invisible. What is being asserted is a property of a Node process with
 * nothing else to do.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The built output, not the source: this spawns a bare `node`, which cannot
// load TypeScript. `pnpm build` runs before `pnpm test` in CI, and the CLI's
// suite already tests its dist for the same reason.
const CLOCK = path.join(HERE, "..", "dist", "runtime", "node-ports.js");

/** Runs `source` as an ES module in a process of its own. */
async function runModule(source: string): Promise<{ stdout: string; stderr: string }> {
  return await run("node", ["--input-type=module", "-e", source], {
    cwd: path.join(HERE, ".."),
    timeout: 30_000,
  });
}

describe("SystemClock.sleep in a process with nothing else to do", () => {
  it("keeps the process alive until it resolves", async () => {
    const { stdout } = await runModule(`
      import { SystemClock } from ${JSON.stringify(CLOCK)};
      const clock = new SystemClock();
      await clock.sleep(300);
      console.log("RESOLVED");
    `);

    // With an unref'd timer this prints nothing and the process exits early
    // with V8's "unsettled top-level await" notice.
    expect(stdout).toContain("RESOLVED");
  });

  it("survives a poll loop of the shape publish uses", async () => {
    const { stdout } = await runModule(`
      import { SystemClock } from ${JSON.stringify(CLOCK)};
      const clock = new SystemClock();
      for (let i = 0; i < 3; i += 1) {
        await clock.sleep(100);
      }
      console.log("POLLED 3");
    `);

    expect(stdout).toContain("POLLED 3");
  });
});
