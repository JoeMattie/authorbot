import { describe, expect, it } from "vitest";
import { parseChapterMarkdown } from "@authorbot/markdown";
import { annotationSchema, replySchema } from "@authorbot/schemas";
import {
  annotationFilePath,
  renderAnnotationArtifact,
  renderReplyArtifact,
  replyFilePath,
  type AnnotationArtifactInput,
  type ReplyArtifactInput,
} from "../src/index.js";

const ANNOTATION_ID = "019f32b1-7b00-7896-92ab-30424bda2cd7";
const CHAPTER_ID = "019d0bc2-a980-734d-b0c1-aa819448d107";
const BLOCK_ID = "019d0bc8-27c0-7913-8d7f-5c68d2b54c4c";
const REPLY_ID = "019f36b1-0a40-7da6-b2af-504a917ff686";

function rangeInput(): AnnotationArtifactInput {
  return {
    id: ANNOTATION_ID,
    kind: "suggestion",
    scope: "range",
    chapterId: CHAPTER_ID,
    chapterRevision: 2,
    author: "github:jparish",
    status: "open",
    createdAt: "2026-07-05T14:32:00Z",
    target: {
      blockId: BLOCK_ID,
      textPosition: { start: 126, end: 166 },
      textQuote: {
        exact: "the interferometer was telling the truth",
        prefix: " alternative was admitting that ",
        suffix: ".",
      },
    },
    body: "Body text.",
  };
}

describe("renderAnnotationArtifact", () => {
  it("renders the exact pinned bytes for a range suggestion", () => {
    const file = renderAnnotationArtifact(rangeInput());
    expect(file.path).toBe(`.authorbot/annotations/${ANNOTATION_ID}/annotation.md`);
    expect(file.content).toBe(
      "---\n" +
        "schema: authorbot.annotation/v1\n" +
        `id: ${ANNOTATION_ID}\n` +
        "kind: suggestion\n" +
        "scope: range\n" +
        `chapter_id: ${CHAPTER_ID}\n` +
        "chapter_revision: 2\n" +
        "author: github:jparish\n" +
        "status: open\n" +
        "created_at: 2026-07-05T14:32:00Z\n" +
        "target:\n" +
        `  blockId: ${BLOCK_ID}\n` +
        "  textPosition:\n" +
        "    start: 126\n" +
        "    end: 166\n" +
        "  textQuote:\n" +
        "    exact: the interferometer was telling the truth\n" +
        '    prefix: " alternative was admitting that "\n' +
        "    suffix: .\n" +
        "---\n" +
        "\n" +
        "Body text.\n",
    );
  });

  it("is byte-stable: same input, same bytes", () => {
    const a = renderAnnotationArtifact(rangeInput());
    const b = renderAnnotationArtifact(rangeInput());
    expect(b.content).toBe(a.content);
    expect(b.path).toBe(a.path);
  });

  it("normalizes body whitespace so equivalent bodies render identical bytes", () => {
    const base = renderAnnotationArtifact(rangeInput());
    const padded = renderAnnotationArtifact({ ...rangeInput(), body: "\nBody text.\n\n\n" });
    const crlf = renderAnnotationArtifact({ ...rangeInput(), body: "Body text.\r\n" });
    expect(padded.content).toBe(base.content);
    expect(crlf.content).toBe(base.content);
  });

  it("round-trips through the Phase 0 annotation schema", () => {
    const file = renderAnnotationArtifact(rangeInput());
    const parsed = parseChapterMarkdown(file.content);
    expect(parsed.frontmatterError).toBeUndefined();
    const record = annotationSchema.parse(parsed.frontmatter);
    expect(record.id).toBe(ANNOTATION_ID);
    expect(record.status).toBe("open");
    expect(record.scope).toBe("range");
    if (record.scope === "range") {
      expect(record.target.textQuote.exact).toBe("the interferometer was telling the truth");
      expect(record.target.textQuote.prefix).toBe(" alternative was admitting that ");
    }
  });

  it("round-trips YAML-hostile quote text", () => {
    const input = rangeInput();
    input.target = {
      blockId: BLOCK_ID,
      textPosition: { start: 0, end: 10 },
      textQuote: {
        exact: 'she said: "no - really?" #not-a-comment',
        prefix: "- list-looking ",
        suffix: ": trailing",
      },
    };
    const file = renderAnnotationArtifact(input);
    const parsed = parseChapterMarkdown(file.content);
    expect(parsed.frontmatterError).toBeUndefined();
    const record = annotationSchema.parse(parsed.frontmatter);
    if (record.scope === "range") {
      expect(record.target.textQuote.exact).toBe('she said: "no - really?" #not-a-comment');
      expect(record.target.textQuote.prefix).toBe("- list-looking ");
      expect(record.target.textQuote.suffix).toBe(": trailing");
    }
  });

  it("withdraw is a status-only frontmatter change", () => {
    const open = renderAnnotationArtifact(rangeInput());
    const withdrawn = renderAnnotationArtifact({ ...rangeInput(), status: "withdrawn" });
    expect(withdrawn.path).toBe(open.path);
    expect(withdrawn.content).toBe(open.content.replace("status: open\n", "status: withdrawn\n"));
  });

  it("chapter scope renders without a target and rejects one", () => {
    const input: AnnotationArtifactInput = {
      ...rangeInput(),
      kind: "comment",
      scope: "chapter",
    };
    delete input.target;
    const file = renderAnnotationArtifact(input);
    expect(file.content).not.toContain("target:");
    annotationSchema.parse(parseChapterMarkdown(file.content).frontmatter);

    expect(() =>
      renderAnnotationArtifact({ ...input, target: { blockId: BLOCK_ID } }),
    ).toThrow(/chapter scope/);
  });

  it("rejects malformed records before they can reach the repository", () => {
    // range scope without target
    const missingTarget = rangeInput();
    delete missingTarget.target;
    expect(() => renderAnnotationArtifact(missingTarget)).toThrow();
    // non-UUID id
    expect(() => renderAnnotationArtifact({ ...rangeInput(), id: "not-a-uuid" })).toThrow();
    // internal actor UUID instead of an actor reference
    expect(() =>
      renderAnnotationArtifact({ ...rangeInput(), author: ANNOTATION_ID }),
    ).toThrow();
  });
});

describe("renderReplyArtifact", () => {
  function replyInput(): ReplyArtifactInput {
    return {
      id: REPLY_ID,
      annotationId: ANNOTATION_ID,
      author: "github:avery-cole",
      createdAt: "2026-07-06T09:10:00Z",
      body: "Agreed, approving.",
    };
  }

  it("renders the exact pinned bytes", () => {
    const file = renderReplyArtifact(replyInput());
    expect(file.path).toBe(
      `.authorbot/annotations/${ANNOTATION_ID}/replies/${REPLY_ID}.md`,
    );
    expect(file.content).toBe(
      "---\n" +
        "schema: authorbot.reply/v1\n" +
        `id: ${REPLY_ID}\n` +
        `annotation_id: ${ANNOTATION_ID}\n` +
        "author: github:avery-cole\n" +
        "status: open\n" +
        "created_at: 2026-07-06T09:10:00Z\n" +
        "---\n" +
        "\n" +
        "Agreed, approving.\n",
    );
    expect(renderReplyArtifact(replyInput()).content).toBe(file.content);
  });

  it("includes parent_reply_id only when present and round-trips the schema", () => {
    const withoutParent = renderReplyArtifact(replyInput());
    expect(withoutParent.content).not.toContain("parent_reply_id");
    const nullParent = renderReplyArtifact({ ...replyInput(), parentReplyId: null });
    expect(nullParent.content).toBe(withoutParent.content);

    const parentId = "019f36b1-0a40-7da6-b2af-504a917ff687";
    const withParent = renderReplyArtifact({ ...replyInput(), parentReplyId: parentId });
    const parsed = replySchema.parse(parseChapterMarkdown(withParent.content).frontmatter);
    expect(parsed.parent_reply_id).toBe(parentId);
  });

  it("rewrites only the status line when a reply is withdrawn", () => {
    const open = renderReplyArtifact(replyInput());
    const withdrawn = renderReplyArtifact({ ...replyInput(), status: "withdrawn" });
    expect(withdrawn.path).toBe(open.path);
    expect(withdrawn.content).toBe(open.content.replace("status: open\n", "status: withdrawn\n"));
    expect(
      replySchema.parse(parseChapterMarkdown(withdrawn.content).frontmatter).status,
    ).toBe("withdrawn");
  });
});

describe("artifact paths", () => {
  it("match the Phase 0 contract §4 locations", () => {
    expect(annotationFilePath("abc")).toBe(".authorbot/annotations/abc/annotation.md");
    expect(replyFilePath("abc", "def")).toBe(".authorbot/annotations/abc/replies/def.md");
  });
});
