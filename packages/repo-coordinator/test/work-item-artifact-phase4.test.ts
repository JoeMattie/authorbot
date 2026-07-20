/**
 * Phase 4 additions to the work-item artifact: completion metadata on
 * applied items, and the both-texts `resolve_conflict` artifact (contract
 * §5). The Phase 3 shape is covered by work-item-artifact.test.ts.
 */
import { checkWorkItemDelimiters } from "@authorbot/markdown";
import { describe, expect, it } from "vitest";
import {
  COMPLETION_HEADING,
  DEFAULT_CONFLICT_ACCEPTANCE_CRITERIA,
  parseWorkItemArtifact,
  renderWorkItemArtifact,
  SUBMITTED_TEXT_END,
  SUBMITTED_TEXT_START,
  type WorkItemArtifactInput,
} from "../src/work-item-artifact.js";
import { nowIso, uuidv7 } from "./helpers.js";

function baseInput(overrides: Partial<WorkItemArtifactInput> = {}): WorkItemArtifactInput {
  return {
    id: uuidv7(),
    type: "revise_range",
    status: "ready",
    sourceAnnotationId: uuidv7(),
    chapterId: uuidv7(),
    baseRevision: 4,
    priority: "normal",
    createdBy: "system:rule-engine",
    createdAt: nowIso(),
    context: "Voters preferred the honest phrasing.",
    originalText: "the interferometer was telling the truth",
    requestedChange: "Use the phrasing proposed in the suggestion.",
    ...overrides,
  };
}

describe("completion metadata (applied work items)", () => {
  const completion = {
    submissionId: uuidv7(),
    appliedRevision: 5,
    completedAt: "2026-07-19T18:20:00Z",
    completedBy: "github:jparish",
  };

  it("appends a Completion section and round-trips it", () => {
    const plain = baseInput({ status: "completed" });
    const { content } = renderWorkItemArtifact({ ...plain, completion });
    const parsed = parseWorkItemArtifact(content);
    expect(parsed.record.status).toBe("completed");
    expect(parsed.sections.completion).toEqual(completion);
    // The §13 sections are byte-intact: the completed render extends the
    // uncompleted one (same frontmatter status) by exactly the new section.
    const without = renderWorkItemArtifact(plain);
    expect(content.startsWith(without.content.trimEnd())).toBe(true);
    expect(parsed.sections.submissionContract).not.toContain("Completed");
  });

  it("rejects multi-line completion values", () => {
    expect(() =>
      renderWorkItemArtifact(
        baseInput({ completion: { ...completion, completedBy: "github:a\nb" } }),
      ),
    ).toThrow(/single line/);
  });

  it("escapes a free-text line equal to the Completion heading", () => {
    const input = baseInput({ context: `see below\n${COMPLETION_HEADING}\nnot a heading` });
    const parsed = parseWorkItemArtifact(renderWorkItemArtifact(input).content);
    expect(parsed.sections.context).toBe(`see below\n${COMPLETION_HEADING}\nnot a heading`);
    expect(parsed.sections.completion).toBeUndefined();
  });

  it("throws on a Completion section with missing fields", () => {
    const { content } = renderWorkItemArtifact(
      baseInput({ status: "completed", completion }),
    );
    expect(() => parseWorkItemArtifact(content.replace("- Submission: ", "- Sub: "))).toThrow(
      /missing "Submission"/,
    );
  });
});

describe("resolve_conflict artifact (both texts, distinct delimiters)", () => {
  const submitted = "The instrument was *honest* from the first pass.";
  const current = "The interferometer had already been recalibrated twice.";

  function conflictInput(overrides: Partial<WorkItemArtifactInput> = {}): WorkItemArtifactInput {
    return baseInput({
      type: "resolve_conflict",
      status: "ready",
      baseRevision: 5,
      createdBy: "system:authorbot",
      originalText: current,
      requestedChange: "Merge the change below with the current text.",
      submittedText: submitted,
      acceptanceCriteria: DEFAULT_CONFLICT_ACCEPTANCE_CRITERIA,
      ...overrides,
    });
  }

  it("carries both texts between distinct delimiter pairs and round-trips", () => {
    const { content } = renderWorkItemArtifact(conflictInput());
    expect(content).toContain(SUBMITTED_TEXT_START);
    expect(content).toContain(SUBMITTED_TEXT_END);
    const parsed = parseWorkItemArtifact(content);
    expect(parsed.record.type).toBe("resolve_conflict");
    expect(parsed.sections.originalText).toBe(current);
    expect(parsed.sections.submittedText).toBe(submitted);
    expect(parsed.sections.requestedChange).toBe("Merge the change below with the current text.");
    expect(parsed.sections.acceptanceCriteria).toEqual([...DEFAULT_CONFLICT_ACCEPTANCE_CRITERIA]);
    // Submission contract names chapter_replacement at the current revision.
    expect(parsed.sections.submissionContract).toContain("`chapter_replacement`");
    expect(parsed.sections.submissionContract).toContain("revision 5");
  });

  it("keeps the Phase 0 delimiter validator green (exactly one balanced pair)", () => {
    const { content } = renderWorkItemArtifact(conflictInput());
    const result = checkWorkItemDelimiters(content);
    expect(result.valid).toBe(true);
    expect(result.sections).toHaveLength(1);
  });

  it("round-trips hostile submitted text (delimiters, fences, headings) byte-exactly", () => {
    const hostile = [
      SUBMITTED_TEXT_END,
      "```js",
      "## Requested change",
      COMPLETION_HEADING,
      "<!-- authorbot:original:start -->",
      "  indented, trailing spaces  ",
      "",
    ].join("\n");
    const { content } = renderWorkItemArtifact(
      conflictInput({ submittedText: hostile, originalText: hostile }),
    );
    const parsed = parseWorkItemArtifact(content);
    expect(parsed.sections.submittedText).toBe(hostile);
    expect(parsed.sections.originalText).toBe(hostile);
    expect(checkWorkItemDelimiters(content).valid).toBe(true);
  });

  it("rejects unbalanced submitted delimiters on parse", () => {
    const { content } = renderWorkItemArtifact(conflictInput());
    expect(() =>
      parseWorkItemArtifact(content.replace(`${SUBMITTED_TEXT_END}\n`, "")),
    ).toThrow(/authorbot:original:submitted/);
  });
});
