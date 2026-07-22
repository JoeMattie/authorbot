import { describe, expect, it } from "vitest";
import {
  isSafeRepositoryDocumentPath,
  validateRepositoryDocument,
} from "../src/repository-documents.js";

describe("repository planning document validation", () => {
  it("validates and canonicalizes outline and timeline YAML", async () => {
    const outline = await validateRepositoryDocument({
      kind: "outline",
      path: "story/outline.yml",
      content: "schema: authorbot.story-graph/v1\r\nnodes: []\r\n\r\n",
    });
    expect(outline).toMatchObject({
      ok: true,
      document: {
        targetId: "outline",
        label: "Outline",
        content: "schema: authorbot.story-graph/v1\nnodes: []\n",
      },
    });
    if (outline.ok) expect(outline.document.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);

    expect(
      await validateRepositoryDocument({
        kind: "timeline",
        path: "planning/time.yaml",
        content: "schema: authorbot.timeline/v1\nevents: []\n",
      }),
    ).toMatchObject({ ok: true, document: { targetId: "timeline", label: "Timeline" } });
  });

  it("validates character frontmatter and safe Markdown", async () => {
    const result = await validateRepositoryDocument({
      kind: "character",
      path: "story/characters/mara.md",
      content: [
        "---",
        "schema: authorbot.character/v1",
        "id: character:mara",
        "name: Mara Voss",
        "---",
        "",
        "Mara follows [the signal](https://example.com).",
      ].join("\n"),
    });
    expect(result).toMatchObject({
      ok: true,
      document: { targetId: "character:mara", label: "Mara Voss" },
    });
  });

  it("rejects invalid schemas, unsafe prose, and mismatched extensions", async () => {
    expect(
      await validateRepositoryDocument({
        kind: "outline",
        path: "story/outline.yml",
        content: "schema: wrong\nnodes: []\n",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await validateRepositoryDocument({
        kind: "character",
        path: "story/characters/mara.md",
        content: [
          "---",
          "schema: authorbot.character/v1",
          "id: character:mara",
          "name: Mara",
          "---",
          "",
          "<script>alert(1)</script>",
          "[bad](javascript:alert(1))",
        ].join("\n"),
      }),
    ).toEqual({
      ok: false,
      issues: [
        "character Markdown must not contain raw HTML",
        "character Markdown uses forbidden URL scheme javascript",
      ],
    });
    expect(
      await validateRepositoryDocument({
        kind: "timeline",
        path: "story/timeline.md",
        content: "schema: authorbot.timeline/v1\nevents: []\n",
      }),
    ).toEqual({
      ok: false,
      issues: ["timeline documents must use a .yml or .yaml path"],
    });
  });

  it.each([
    "../story/outline.yml",
    "/story/outline.yml",
    "story//outline.yml",
    "story/./outline.yml",
    "story\\outline.yml",
    "C:/story/outline.yml",
  ])("refuses unsafe repository path %s", (path) => {
    expect(isSafeRepositoryDocumentPath(path)).toBe(false);
  });
});
