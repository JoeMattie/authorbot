/**
 * Phase 6 contract §3.6: byte-stable `book.yml` rendering.
 *
 * Two properties are load-bearing and everything here tests one of them:
 * the same config always produces the same bytes (so a replayed outbox row is
 * a no-op commit), and absent optional sections stay absent (so the diff a
 * maintainer reviews contains only what they changed).
 */
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { bookConfigSchema } from "@authorbot/schemas";
import {
  BOOK_CONFIG_PATH,
  mergeBookConfigArtifact,
  orderBookConfig,
  renderBookConfigArtifact,
} from "../src/book-config-artifact.js";

const MINIMAL = {
  schema: "authorbot.book/v1",
  id: "01900000-0000-7000-8000-0000000000bb",
  title: "Hollow Creek Anomaly",
  slug: "hollow-creek-anomaly",
  language: "en",
} as const;

const FULL = {
  ...MINIMAL,
  license: "CC-BY-NC-4.0",
  repository: { default_branch: "main" },
  content: { chapters_glob: "chapters/*.md", raw_html: false },
  planning: { method: "custom", outline: "story/outline.yml" },
  publication: { chapter_url: "/chapters/{slug}/", show_revision: true },
  governance: {
    rules: {
      suggestion_to_work_item: {
        version: 3,
        when: {
          all: [
            { metric: "approvals", operator: "gte", value: 3 },
            { metric: "human_maintainer_approvals", operator: "gte", value: 1 },
          ],
        },
        action: { type: "create_work_item", work_type: "revise_range" },
      },
    },
  },
} as const;

describe("renderBookConfigArtifact", () => {
  it("writes to book.yml", () => {
    expect(renderBookConfigArtifact(MINIMAL).path).toBe(BOOK_CONFIG_PATH);
    expect(BOOK_CONFIG_PATH).toBe("book.yml");
  });

  it("round-trips through YAML back to the same document", () => {
    const rendered = renderBookConfigArtifact(FULL);
    expect(parse(rendered.content)).toEqual(FULL);
    // And the result is still a valid authorbot.book/v1 document.
    expect(() => bookConfigSchema.parse(parse(rendered.content))).not.toThrow();
  });

  it("is byte-stable regardless of the input's key order", () => {
    const shuffled = {
      governance: FULL.governance,
      publication: FULL.publication,
      slug: FULL.slug,
      title: FULL.title,
      language: FULL.language,
      id: FULL.id,
      schema: FULL.schema,
      license: FULL.license,
      planning: FULL.planning,
      content: FULL.content,
      repository: FULL.repository,
    };
    expect(renderBookConfigArtifact(shuffled).content).toBe(
      renderBookConfigArtifact(FULL).content,
    );
  });

  it("emits top-level keys in schema order, not insertion order", () => {
    const keys = Object.keys(orderBookConfig(bookConfigSchema.parse(FULL)));
    expect(keys).toEqual([
      "schema",
      "id",
      "title",
      "slug",
      "language",
      "license",
      "repository",
      "content",
      "planning",
      "publication",
      "governance",
    ]);
  });

  it("sorts rule names so a JSON round trip cannot reorder governance", () => {
    const twoRules = {
      ...MINIMAL,
      governance: {
        rules: {
          zebra_rule: FULL.governance.rules.suggestion_to_work_item,
          alpha_rule: FULL.governance.rules.suggestion_to_work_item,
        },
      },
    };
    const rendered = renderBookConfigArtifact(twoRules).content;
    expect(rendered.indexOf("alpha_rule")).toBeLessThan(rendered.indexOf("zebra_rule"));
  });

  it("leaves absent optional sections absent (minimal diffs)", () => {
    const rendered = renderBookConfigArtifact(MINIMAL).content;
    for (const section of ["repository", "content", "planning", "publication", "governance"]) {
      expect(rendered).not.toContain(`${section}:`);
    }
  });

  it("ends with exactly one trailing newline", () => {
    const content = renderBookConfigArtifact(FULL).content;
    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
  });

  it("refuses to render an invalid document (last line of defence)", () => {
    expect(() => renderBookConfigArtifact({ ...MINIMAL, id: "not-a-uuid" })).toThrow();
    expect(() => renderBookConfigArtifact({ title: "no schema" })).toThrow();
  });
});

/**
 * Regression: a settings PATCH is a read-modify-write of the `book_configs`
 * projection, and that projection can be arbitrarily stale - it freezes while
 * a project is diverged, and `projectBookConfig` keeps the previous row on an
 * `invalid` outcome. Rendering the whole file from that copy reverted anything
 * the author had committed directly to Git, including the three fields §3.6
 * declares never editable. Writing only the paths the maintainer edited, onto
 * the bytes at the branch head, is what makes that impossible.
 */
describe("mergeBookConfigArtifact (Phase 6 §3.6)", () => {
  const HEAD = `# Replace the placeholder title/slug/id before publishing.
schema: authorbot.book/v1
id: 01900000-0000-7000-8000-0000000000bb
title: Old Title
slug: hollow-creek-anomaly
language: en
content:
  chapters_glob: chapters/*.md
  # Raw HTML is off. Turning it on is a security decision.
  raw_html: false
repository:
  default_branch: release
# Secrets never belong in this file.
`;

  it("never reverts a never-editable field the author changed in Git", () => {
    // The stale projection still believes raw_html is on and the branch is
    // `main`; the author has since closed the XSS hole and repointed the
    // branch in a reviewed commit. A title edit must not undo either.
    const stale = {
      ...MINIMAL,
      title: "Stale Title",
      content: { chapters_glob: "old/*.md", raw_html: true },
      repository: { default_branch: "main" },
    };
    const merged = mergeBookConfigArtifact(HEAD, { ...stale, title: "New Title" }, ["title"]);
    const parsed = bookConfigSchema.parse(parse(merged.content));

    expect(parsed.title).toBe("New Title");
    expect(parsed.content?.raw_html).toBe(false);
    expect(parsed.content?.chapters_glob).toBe("chapters/*.md");
    expect(parsed.repository?.default_branch).toBe("release");
  });

  it("keeps the author's comments and untouched key order", () => {
    const merged = mergeBookConfigArtifact(HEAD, { ...MINIMAL, title: "New Title" }, ["title"]);
    expect(merged.content).toContain("# Replace the placeholder title/slug/id");
    expect(merged.content).toContain("# Raw HTML is off.");
    expect(merged.content).toContain("# Secrets never belong in this file.");
  });

  it("writes every path the maintainer did edit", () => {
    const next = {
      ...MINIMAL,
      title: "New Title",
      license: "CC-BY-4.0",
      publication: { show_revision: true },
    };
    const merged = mergeBookConfigArtifact(HEAD, next, [
      "title",
      "license",
      "publication.show_revision",
    ]);
    const parsed = bookConfigSchema.parse(parse(merged.content));
    expect(parsed.title).toBe("New Title");
    expect(parsed.license).toBe("CC-BY-4.0");
    expect(parsed.publication?.show_revision).toBe(true);
    // …and still nothing else.
    expect(parsed.content?.raw_html).toBe(false);
  });

  it("removes a cleared field, and the section it emptied", () => {
    const head = `${HEAD}publication:\n  show_revision: true\n`;
    const merged = mergeBookConfigArtifact(head, MINIMAL, ["publication.show_revision"]);
    expect(parse(merged.content).publication).toBeUndefined();
  });

  it("renders in full when the repository has no book.yml yet", () => {
    expect(mergeBookConfigArtifact(null, MINIMAL, ["title"]).content).toBe(
      renderBookConfigArtifact(MINIMAL).content,
    );
  });

  it("refuses to commit bytes that are not a valid authorbot.book/v1 document", () => {
    // The head carries a key this deployment's strict schema rejects.
    const head = `${HEAD}unknown_key: 1\n`;
    expect(() => mergeBookConfigArtifact(head, MINIMAL, ["title"])).toThrow(/invalid|unrecognized/i);
  });

  it("ends with exactly one trailing newline", () => {
    const merged = mergeBookConfigArtifact(HEAD, { ...MINIMAL, title: "X" }, ["title"]);
    expect(merged.content.endsWith("\n")).toBe(true);
    expect(merged.content.endsWith("\n\n")).toBe(false);
    expect(merged.path).toBe(BOOK_CONFIG_PATH);
  });
});
