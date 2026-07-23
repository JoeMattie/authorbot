/**
 * The collaborator skill (Phase 8) must not drift from the API it documents.
 *
 * `skills/authorbot-collaborator/` teaches an agent to drive this API without
 * reading the source. The contract (§5, §6.3) is explicit that documentation
 * which drifts from the API is worse than none, so this pins three things a
 * build should refuse to let rot:
 *
 *  - every `/v1/...` path the skill mentions exists in `openapi/openapi.yaml`;
 *  - every scope name the skill mentions is a real, mintable API scope;
 *  - the loop and the four safety rules are byte-identical everywhere they
 *    are repeated - the whole point of the shared blocks is that an agent
 *    reading a role file gets the same rules as one reading SKILL.md.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { EDITORIAL_CAPABILITIES } from "@authorbot/domain";
import { API_SCOPES } from "../src/api-scopes.js";

const SKILL_DIR = fileURLToPath(
  new URL("../../../skills/authorbot-collaborator/", import.meta.url),
);
const SPEC_PATH = fileURLToPath(new URL("../../../openapi/openapi.yaml", import.meta.url));
const WORKFLOW_PATH = fileURLToPath(new URL("../../../examples/agent-workflow.mjs", import.meta.url));
const DRAFT_EXAMPLE_PATH = `${SKILL_DIR}examples/submit-chapter-draft.py`;

interface Spec {
  paths: Record<string, unknown>;
}
const spec = YAML.parse(readFileSync(SPEC_PATH, "utf8")) as Spec;
const specPaths = new Set(Object.keys(spec.paths));

/** Every markdown file in the skill, recursively. */
function skillFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  };
  walk(SKILL_DIR);
  return out;
}

const files = skillFiles();
const allText = files.map((f) => readFileSync(f, "utf8")).join("\n");

/**
 * The API templates paths with `{project}` and `{annotationId}`; the spec uses
 * `{projectId}`, `{workItemId}`, etc. Normalise every `{...}` segment to a
 * single placeholder so a documented path matches its spec entry regardless of
 * which noun the parameter is named after.
 */
const normalise = (path: string): string => path.replace(/\{[^}]+\}/g, "{}");
const specPathSet = new Set([...specPaths].map(normalise));

describe("the collaborator skill matches the API", () => {
  it("finds skill files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("mentions only paths that exist in the OpenAPI spec", () => {
    // `/v1/...` up to the first whitespace, backtick, or query string.
    const mentioned = new Set(
      [...allText.matchAll(/\/v1\/[A-Za-z0-9/{}_-]+/g)].map((m) => normalise(m[0])),
    );
    const unknown = [...mentioned].filter((p) => !specPathSet.has(p));
    expect(unknown, `paths documented but not in the spec: ${unknown.join(", ")}`).toEqual([]);
  });

  it("mentions only capabilities or compatibility scopes that the API knows", () => {
    // An authority name is `<resource>:<verb>` where the resource is one Authorbot
    // actually has. This deliberately excludes markers like `authorbot:block`,
    // which are not scopes; the point is that a scope the skill *names as a
    // scope* is real, not that every colon in the docs is one.
    const RESOURCES = [
      "chapters",
      "comments",
      "suggestions",
      "replies",
      "feedback",
      "work",
      "summaries",
      "revisions",
      "history",
      "annotations",
      "submissions",
      "tokens",
      "members",
      "votes",
    ];
    const re = new RegExp(`\`((?:${RESOURCES.join("|")}):[a-z]+)\``, "g");
    const scopeShaped = new Set([...allText.matchAll(re)].map((m) => m[1] ?? ""));
    const known = new Set<string>([...API_SCOPES, ...EDITORIAL_CAPABILITIES]);
    const unknown = [...scopeShaped].filter((s) => !known.has(s));
    expect(unknown, `authority names unknown to the API: ${unknown.join(", ")}`).toEqual([]);
    // And the skill must actually mention some names, or this asserts nothing.
    expect(scopeShaped.size).toBeGreaterThan(0);
  });

  it("documents every canonical editorial capability", () => {
    const api = readFileSync(`${SKILL_DIR}references/api.md`, "utf8");
    for (const capability of EDITORIAL_CAPABILITIES) {
      expect(api, `missing capability ${capability}`).toContain(`\`${capability}\``);
    }
  });

  it("documents the direct chapter-draft schema without requiring endpoint probing", () => {
    const skill = readFileSync(`${SKILL_DIR}SKILL.md`, "utf8");
    expect(skill).toContain("POST /v1/projects/{project}/chapter-submissions");
    expect(skill).toContain('"title": "Required chapter title"');
    expect(skill).toContain('"body": "Required Markdown prose"');
    expect(skill).toContain('"slug": "optional-url-slug"');
    expect(skill).toContain('"summary": "Optional chapter summary"');
    expect(skill).toContain("Saving creates a draft only");
  });

  it("pins a descriptive user agent in the guidance and both reference clients", () => {
    expect(allText).toContain("Python-urllib/...");
    expect(allText).toContain("authorbot-agent/1.0");

    const workflow = readFileSync(WORKFLOW_PATH, "utf8");
    expect(workflow).toContain('"user-agent": "authorbot-agent/1.0"');

    const python = readFileSync(DRAFT_EXAMPLE_PATH, "utf8");
    expect(python).toContain('USER_AGENT = "authorbot-agent/1.0"');
    expect(python).toContain('"title": title, "body": body');
    expect(python).toContain('/chapter-submissions"');
    expect(python).toContain('"chapters:write" in effective');
    expect(python).toContain("for attempt in range(3)");
  });

  it("documents exact feedback, Work, revision, planning, and history schemas", () => {
    const api = readFileSync(`${SKILL_DIR}references/api.md`, "utf8");
    expect(api).toContain('"kind": "suggestion"');
    expect(api).toContain('"scope": "range"');
    expect(api).toContain('"textPosition": { "start": 48, "end": 74 }');
    expect(api).toContain('"leaseToken": "..."');
    expect(api).toContain('"proposalType": "chapter_replacement"');
    expect(api).toContain('"proposalType": "chapter_summary"');
    expect(api).toContain('"proposalType": "repository_document"');
    expect(api).toContain("/history/{revision}/restore");
  });

  it("documents the bounded story-bible routes without guessed storyRefs paths", () => {
    const api = readFileSync(`${SKILL_DIR}references/api.md`, "utf8");
    expect(api).toContain("/v1/projects/{project}/story/outline");
    expect(api).toContain("/v1/projects/{project}/story/timeline");
    expect(api).toContain("/v1/projects/{project}/story/characters?limit=20&cursor=");
    expect(api).toContain('"storyApi": {');
    expect(api).toContain("Follow `nextCursor` until it is `null`");
    expect(api).toContain("never probe `/story`, `/story-refs`");
  });
});

/** Content between `<!-- BEGIN NAME ... -->` and `<!-- END NAME -->`, or null. */
function block(text: string, name: string): string | null {
  const re = new RegExp(`<!-- BEGIN ${name}[^>]*-->\\n([\\s\\S]*?)<!-- END ${name} -->`);
  const m = re.exec(text);
  return m ? (m[1] ?? null) : null;
}

describe("the shared blocks are identical wherever they appear", () => {
  const byFile = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

  it("has the safety rules in SKILL.md, PROMPT.md and every role file", () => {
    const carriers = [...byFile].filter(
      ([f]) => f.endsWith("SKILL.md") || f.endsWith("PROMPT.md") || f.includes("/roles/"),
    );
    const blocks = carriers.map(([f, text]) => [f, block(text, "SAFETY RULES")] as const);
    const missing = blocks.filter(([, b]) => b === null).map(([f]) => f);
    expect(missing, `files missing the safety-rules block: ${missing.join(", ")}`).toEqual([]);
    const distinct = new Set(blocks.map(([, b]) => b));
    expect(distinct.size, "the safety-rules block differs between files").toBe(1);
  });

  it("has the loop identical in SKILL.md and PROMPT.md", () => {
    const skill = block(byFile.get(`${SKILL_DIR}SKILL.md`) ?? "", "LOOP");
    const prompt = block(byFile.get(`${SKILL_DIR}PROMPT.md`) ?? "", "LOOP");
    expect(skill).not.toBeNull();
    expect(prompt).toBe(skill);
  });
});
