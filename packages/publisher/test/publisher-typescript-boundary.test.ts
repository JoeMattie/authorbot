import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("publisher TypeScript module-resolution boundary", () => {
  it("keeps browser-island typechecking on Bundler and the published Node build on NodeNext", async () => {
    const [typecheck, build, lockfile] = await Promise.all([
      readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
      readFile(new URL("../tsconfig.build.json", import.meta.url), "utf8"),
      readFile(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8"),
    ]);
    expect(typecheck).toContain('"moduleResolution": "Bundler"');
    expect(build).toContain('"moduleResolution": "NodeNext"');
    expect(build).toContain('"module": "NodeNext"');
    expect(lockfile).not.toMatch(/^\s+yjs@/m);
    expect(lockfile).not.toContain("@milkdown/plugin-collab");
  });
});
