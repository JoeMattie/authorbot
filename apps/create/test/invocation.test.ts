/**
 * Telling the author to run a command that exists.
 *
 * Roughly twenty messages — every resume hint, most error remedies — said
 * `create-authorbot <stage>`. That binary exists only for a global install;
 * `npx @authorbot/create`, the documented way in, unpacks to a cache directory
 * and leaves nothing on PATH. So the advice offered at the moment something
 * had already failed was itself `command not found`, which is what happened to
 * the first author to hit a failed publish.
 */
import { describe, expect, it } from "vitest";
import { invocationCommand } from "../src/invocation.js";
import { Reporter } from "../src/ui/reporter.js";
import { SecretVault } from "../src/secrets.js";
import type { OutputPort } from "../src/ports.js";

function reporterFor(invocation: string): { reporter: Reporter; lines: string[] } {
  const lines: string[] = [];
  const out: OutputPort = {
    write: (l) => {
      lines.push(l);
    },
    error: (l) => {
      lines.push(l);
    },
  };
  const reporter = new Reporter(
    out,
    new SecretVault(),
    { colour: false, unicode: false, width: 80 },
    invocation,
  );
  return { reporter, lines };
}

describe("invocationCommand", () => {
  it("names npx when running from the npx cache", () => {
    expect(invocationCommand("/home/joe/.npm/_npx/933882d9c6bb5550/node_modules/.bin/x")).toBe(
      "npx @authorbot/create",
    );
  });

  it("names the binary when it is genuinely installed", () => {
    expect(invocationCommand("/usr/lib/node_modules/@authorbot/create/dist/bin.js")).toBe(
      "create-authorbot",
    );
  });

  it("falls back to the binary name when argv says nothing", () => {
    expect(invocationCommand(undefined)).toBe("create-authorbot");
  });
});

describe("Reporter", () => {
  it("rewrites the resume hint to the command the author can actually run", () => {
    const { reporter, lines } = reporterFor("npx @authorbot/create");

    reporter.literal("create-authorbot publish");

    expect(lines.join("\n")).toContain("npx @authorbot/create publish");
    expect(lines.join("\n")).not.toContain("create-authorbot publish");
  });

  it("rewrites it inside wrapped prose too, not only in literals", () => {
    const { reporter, lines } = reporterFor("npx @authorbot/create");

    reporter.info("Run `create-authorbot book` first to create one.");

    expect(lines.join(" ")).toContain("npx @authorbot/create book");
  });

  it("leaves the text alone for a real install", () => {
    const { reporter, lines } = reporterFor("create-authorbot");

    reporter.literal("create-authorbot publish");

    expect(lines.join("\n")).toContain("create-authorbot publish");
    expect(lines.join("\n")).not.toContain("npx");
  });
});
