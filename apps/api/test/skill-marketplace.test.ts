/**
 * The plugin marketplace manifest and the skill's own frontmatter (Phase 8).
 *
 * `.claude-plugin/marketplace.json` is what makes the repository installable
 * with `/plugin marketplace add JoeMattie/authorbot`, and `SKILL.md`'s
 * frontmatter is the only thing an agent sees when deciding whether the skill
 * is relevant. Both are hand-written JSON/YAML that nothing else exercises, so
 * a typo in either ships silently. This asserts they parse and carry what the
 * respective loaders require.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const ROOT = new URL("../../../", import.meta.url);
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8");

describe(".claude-plugin/marketplace.json", () => {
  const manifest = JSON.parse(read(".claude-plugin/marketplace.json")) as {
    name?: string;
    owner?: { name?: string };
    plugins?: Array<{ name?: string; source?: string; description?: string }>;
  };

  it("has a marketplace name and owner", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.owner?.name).toBeTruthy();
  });

  it("lists the collaborator plugin with a name, source, and description", () => {
    const plugin = manifest.plugins?.find((p) => p.name === "authorbot-collaborator");
    expect(plugin, "the authorbot-collaborator plugin must be listed").toBeTruthy();
    expect(plugin?.source, "a plugin needs a source Claude Code can fetch").toBeTruthy();
    expect(plugin?.description).toBeTruthy();
  });

  it("has a matching plugin manifest", () => {
    const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as { name?: string };
    expect(plugin.name).toBe("authorbot-collaborator");
  });
});

describe("SKILL.md frontmatter", () => {
  const raw = read("skills/authorbot-collaborator/SKILL.md");

  it("begins with YAML frontmatter", () => {
    expect(raw.startsWith("---\n")).toBe(true);
  });

  const front = raw.slice(4, raw.indexOf("\n---", 4));
  const meta = YAML.parse(front) as { name?: string; description?: string };

  it("names the skill to match its directory", () => {
    // The skills CLI requires `name` to equal the parent directory.
    expect(meta.name).toBe("authorbot-collaborator");
  });

  it("has a description that says what it does and when to use it", () => {
    expect(meta.description).toBeTruthy();
    expect(meta.description?.toLowerCase()).toContain("use when");
  });
});
