/**
 * How `resolveTool` decides what to run — and, more importantly, when it
 * decides it cannot run anything.
 *
 * The npx tier used to be returned unconditionally whenever `npx` itself was
 * on PATH. `npx --no-install <tool>` then exited non-zero because the package
 * was not cached, and the caller — comparing exit codes — reported a perfectly
 * valid book as having failed validation, with a message inviting the author
 * to file a bug against their own files. Resolution has to distinguish "the
 * tool is absent" from "the tool ran and objected", so that is what these
 * tests pin down.
 */
import { describe, expect, it } from "vitest";
import { resolveTool } from "../src/toolchain.js";
import { FakeProcessRunner } from "./fakes.js";
import type { WizardContext } from "../src/context.js";

/** A context carrying only what `resolveTool` reaches for. */
function contextWith(runner: FakeProcessRunner, existing: readonly string[] = []): WizardContext {
  const present = new Set(existing);
  return {
    directory: "/book",
    runner,
    fs: { exists: (p: string) => Promise.resolve(present.has(p)) },
  } as unknown as WizardContext;
}

describe("resolveTool", () => {
  it("prefers the version pinned in the book's node_modules", async () => {
    const runner = new FakeProcessRunner();
    const ctx = contextWith(runner, ["/book/node_modules/.bin/authorbot"]);

    const resolved = await resolveTool(ctx, "authorbot");

    expect(resolved?.source).toBe("pinned");
    expect(resolved?.command).toBe("/book/node_modules/.bin/authorbot");
  });

  it("falls back to a global install when nothing is pinned", async () => {
    const runner = new FakeProcessRunner(["npx", "authorbot"]);
    const resolved = await resolveTool(contextWith(runner), "authorbot");

    expect(resolved?.source).toBe("path");
    expect(resolved?.command).toBe("authorbot");
  });

  it("does not offer npx when npx cannot actually run the tool", async () => {
    // npx is installed, but `--no-install` refuses because the package is not
    // cached — precisely the situation in a freshly scaffolded book.
    const runner = new FakeProcessRunner(["npx"]);
    runner.on(["npx", "--no-install", "authorbot", "--help"], {
      code: 1,
      stdout: "",
      stderr: 'npx canceled due to missing packages and no YES option: ["authorbot@0.0.2"]',
    });

    // Null is the contract: callers turn it into "the toolchain is not
    // installed yet", never into a claim about the author's book.
    await expect(resolveTool(contextWith(runner), "authorbot")).resolves.toBeNull();
  });

  it("offers npx when the tool is genuinely cached there", async () => {
    const runner = new FakeProcessRunner(["npx"]);
    runner.on(["npx", "--no-install", "authorbot", "--help"], {
      code: 0,
      stdout: "0.1.3\n",
      stderr: "",
    });

    const resolved = await resolveTool(contextWith(runner), "authorbot");

    expect(resolved?.source).toBe("npx");
    expect(resolved?.args).toEqual(["--no-install", "authorbot"]);
  });

  it("returns null when the tool is nowhere at all", async () => {
    const runner = new FakeProcessRunner([]);
    await expect(resolveTool(contextWith(runner), "authorbot")).resolves.toBeNull();
  });

  it("probes with a flag the toolchain actually accepts", async () => {
    // `authorbot --version` is not a command and exits non-zero, so probing
    // with it reported a working toolchain as missing. Both tools resolved
    // here accept `--help` and exit 0; this pins that choice rather than
    // leaving it to be rediscovered.
    const runner = new FakeProcessRunner(["npx"]);
    await resolveTool(contextWith(runner), "authorbot");

    const probe = runner.calls.find((c) => c.command === "npx");
    expect(probe?.args).toEqual(["--no-install", "authorbot", "--help"]);
  });
});
