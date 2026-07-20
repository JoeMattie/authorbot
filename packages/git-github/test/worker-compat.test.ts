/**
 * Guard rail for the phase's hard rule: everything under `src/` — including
 * `src/testing/`, which is an in-process object and not a server — must run
 * unchanged in a Cloudflare Worker. This test is the only place in the
 * package that touches `node:` modules, and it does so from `test/`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /from\s+["']node:/, why: "node: builtin import" },
  { pattern: /require\(\s*["']node:/, why: "node: builtin require" },
  { pattern: /from\s+["'](fs|path|crypto|http|https|url|buffer|stream)["']/, why: "bare node builtin" },
  { pattern: /\bBuffer\b/, why: "Buffer is Node-only; use Uint8Array" },
  { pattern: /\bprocess\.(env|cwd)\b/, why: "process is Node-only; take config as arguments" },
  { pattern: /\bcreateHash\b|\bcreateHmac\b/, why: "node:crypto API; use crypto.subtle" },
];

describe("worker compatibility", () => {
  const files = sourceFiles(SRC);

  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file.slice(SRC.length + 1), file] as const))(
    "src/%s uses no Node-only API",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        expect(pattern.test(source), `${file}: ${why}`).toBe(false);
      }
    },
  );

  it("hashes with WebCrypto rather than node:crypto", () => {
    const source = readFileSync(join(SRC, "git-objects.ts"), "utf8");
    expect(source).toContain("crypto.subtle.digest");
  });
});
