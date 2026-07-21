import { describe, expect, it } from "vitest";
import { checkWorkItemDelimiters, parseChapterMarkdown } from "@authorbot/markdown";
import { workItemSchema } from "@authorbot/schemas";
import {
  escapeWorkItemText,
  ORIGINAL_TEXT_END,
  ORIGINAL_TEXT_ESCAPE,
  ORIGINAL_TEXT_START,
  parseWorkItemArtifact,
  renderWorkItemArtifact,
  unescapeWorkItemText,
  workItemFilePath,
  type WorkItemArtifactInput,
} from "../src/index.js";

const BASE: WorkItemArtifactInput = {
  id: "0190f500-0000-7000-8000-000000000001",
  type: "revise_range",
  status: "ready",
  sourceAnnotationId: "0190f300-0000-7000-8000-000000000002",
  chapterId: "0190f27d-0000-7000-8000-000000000003",
  baseRevision: 4,
  priority: "normal",
  createdBy: "system:rule-engine",
  createdAt: "2026-07-19T18:20:00Z",
  context: "The interferometer scene needs the narrator to stay skeptical.",
  originalText: "the interferometer was telling the truth",
  requestedChange: "Rework the clause so the doubt survives.",
};

describe("renderWorkItemArtifact", () => {
  it("emits authorbot.work-item/v1 frontmatter with the §13 sections", () => {
    const file = renderWorkItemArtifact(BASE);
    expect(file.path).toBe(workItemFilePath(BASE.id));
    const parsed = parseChapterMarkdown(file.content);
    const fm = workItemSchema.parse(parsed.frontmatter);
    expect(fm.status).toBe("ready");
    expect(fm.base_revision).toBe(4);
    for (const heading of [
      "## Context",
      "## Original text",
      "## Requested change",
      "## Acceptance criteria",
      "## Submission contract",
    ]) {
      expect(file.content).toContain(heading);
    }
    expect(file.content).toContain(ORIGINAL_TEXT_START);
    expect(file.content).toContain(ORIGINAL_TEXT_END);
    expect(file.content).toContain(
      "Submit a `range_replacement` against chapter revision 4",
    );
    expect(file.content.endsWith("\n")).toBe(true);
    expect(file.content.endsWith("\n\n")).toBe(false);
  });

  it("names the submission type per work type", () => {
    expect(renderWorkItemArtifact({ ...BASE, type: "revise_block" }).content).toContain(
      "`block_replacement`",
    );
    expect(renderWorkItemArtifact({ ...BASE, type: "revise_chapter" }).content).toContain(
      "`chapter_replacement`",
    );
  });

  it("refuses work types without a Phase 3 submission vocabulary", () => {
    expect(() => renderWorkItemArtifact({ ...BASE, type: "write_chapter" })).toThrow(
      /no submission type/,
    );
  });

  it("is byte-stable and only the status line changes on a status re-render", () => {
    const ready = renderWorkItemArtifact(BASE);
    const cancelled = renderWorkItemArtifact({ ...BASE, status: "cancelled" });
    expect(renderWorkItemArtifact(BASE).content).toBe(ready.content);
    const diffs = diffLines(ready.content, cancelled.content);
    expect(diffs).toEqual(["status: ready", "status: cancelled"]);
  });
});

describe("parseWorkItemArtifact", () => {
  it("restores frontmatter (status intact) and sections", () => {
    const file = renderWorkItemArtifact({ ...BASE, status: "cancelled" });
    const parsed = parseWorkItemArtifact(file.content);
    expect(parsed.record.status).toBe("cancelled");
    expect(parsed.record.id).toBe(BASE.id);
    expect(parsed.sections.context).toBe(BASE.context);
    expect(parsed.sections.originalText).toBe(BASE.originalText);
    expect(parsed.sections.requestedChange).toBe(BASE.requestedChange);
    expect(parsed.sections.acceptanceCriteria).toEqual([
      "Preserve point of view.",
      "Change only the selected span.",
      "Keep continuity facts intact.",
    ]);
  });

  it("round-trips original text that contains delimiter-lookalike lines", () => {
    const nasty = [
      "First line.",
      ORIGINAL_TEXT_END, // would prematurely close the block if unescaped
      ORIGINAL_TEXT_START, // would open a nested block
      "## Requested change", // would look like the next heading
      `${ORIGINAL_TEXT_ESCAPE}already escaped?`, // a literal escape marker
      "  ## Context (indented, not a heading)",
      "Last line.",
    ].join("\n");
    const file = renderWorkItemArtifact({ ...BASE, originalText: nasty });

    // The document still parses unambiguously: exactly one real start/end.
    const startCount = file.content.split("\n").filter((l) => l === ORIGINAL_TEXT_START).length;
    const endCount = file.content.split("\n").filter((l) => l === ORIGINAL_TEXT_END).length;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);

    const parsed = parseWorkItemArtifact(file.content);
    expect(parsed.sections.originalText).toBe(nasty);
  });

  it("keeps the delimiter validator happy when the quote contains code fences", () => {
    // A bare/unbalanced code fence in the quoted target, left un-escaped, would
    // open a fenced code block that swallows the authorbot:original:end
    // delimiter, so the Phase 0 delimiter validator no longer sees it as an
    // HTML comment (WORK_ITEM_DELIMITER_INVALID). Escaping fence lines fixes it.
    for (const fenced of [
      "```",
      "```ts\nconst x = 1;",
      "~~~",
      "  ```",
      "prose then\n```\ncode\n```",
    ]) {
      const file = renderWorkItemArtifact({ ...BASE, originalText: fenced });
      const check = checkWorkItemDelimiters(file.content);
      expect(check.valid, `fenced quote ${JSON.stringify(fenced)}`).toBe(true);
      // And it still round-trips exactly.
      expect(parseWorkItemArtifact(file.content).sections.originalText).toBe(fenced);
    }
  });

  it("keeps the delimiter validator happy when context/requestedChange contain fences", () => {
    const file = renderWorkItemArtifact({
      ...BASE,
      context: "Explain:\n```\nfoo\n```",
      requestedChange: "Wrap it:\n~~~\nbar\n~~~",
    });
    expect(checkWorkItemDelimiters(file.content).valid).toBe(true);
  });

  it("round-trips context/requestedChange containing heading-like lines", () => {
    const context = ["Intro.", "## Original text", "Body after a fake heading."].join("\n");
    const file = renderWorkItemArtifact({ ...BASE, context });
    const parsed = parseWorkItemArtifact(file.content);
    expect(parsed.sections.context).toBe(context);
  });

  it("throws on a missing section", () => {
    const file = renderWorkItemArtifact(BASE);
    const broken = file.content.replace("## Submission contract", "## Nope");
    expect(() => parseWorkItemArtifact(broken)).toThrow(/missing section/);
  });
});

describe("escape helpers", () => {
  it("escape then unescape is the identity for arbitrary text", () => {
    const samples = [
      "plain",
      ORIGINAL_TEXT_START,
      ORIGINAL_TEXT_END,
      "## Context",
      `${ORIGINAL_TEXT_ESCAPE}${ORIGINAL_TEXT_ESCAPE}nested`,
      "<!-- authorbot:original:whatever -->",
      "line one\nline two\n## Requested change",
    ];
    for (const sample of samples) {
      expect(unescapeWorkItemText(escapeWorkItemText(sample))).toBe(sample.replace(/\r\n/g, "\n"));
    }
  });
});

/**
 * The escaper must cover everything the VALIDATOR counts (security review).
 *
 * The escape predicate used to be `line.startsWith("<!-- authorbot:original:")`
 * while `@authorbot/markdown` counts a delimiter with
 * `/^\s*<!--\s*authorbot:original:(start|end)\s*-->\s*$/`. The gap between a
 * literal prefix and a whitespace-tolerant regex was reachable from ordinary
 * user input: an annotation body containing a delimiter line with ONE LEADING
 * SPACE passed the markdown safety scan, was emitted unescaped into
 * `## Context`, and the committed artifact then failed `checkWorkItemDelimiters`
 * — `WORK_ITEM_DELIMITER_INVALID`, permanently, because nothing on the write
 * path runs that check and the bad bytes land first. Repeatable at will by
 * anyone who could comment.
 *
 * These cases enumerate the whitespace variations the validator tolerates and
 * assert the two properties that together close the hole: the rendered artifact
 * VALIDATES, and the free text still round-trips byte for byte.
 */
describe("adversarial free text cannot break repo validation", () => {
  /** Every whitespace shape `DELIMITER_LINE` in delimiters.ts accepts. */
  const delimiterVariants: string[] = [];
  for (const which of ["start", "end"]) {
    for (const lead of ["", " ", "  ", "\t", "   "]) {
      for (const inner of [" ", "", "  ", "\t"]) {
        for (const before of [" ", "", "  "]) {
          for (const trail of ["", " ", "  "]) {
            delimiterVariants.push(
              `${lead}<!--${inner}authorbot:original:${which}${before}-->${trail}`,
            );
          }
        }
      }
    }
  }

  it("renders a valid artifact for every delimiter-lookalike a body can carry", () => {
    for (const variant of delimiterVariants) {
      const body = ["Please fix this:", variant, "…and that."].join("\n");
      // Through each free-text section in turn: all three are escaped by the
      // same predicate, and a hole in any one of them breaks the artifact.
      for (const field of ["context", "requestedChange", "originalText"] as const) {
        const file = renderWorkItemArtifact({ ...BASE, [field]: body });
        const check = checkWorkItemDelimiters(file.content);
        expect(check.valid, `${field} = ${JSON.stringify(variant)}: ${JSON.stringify(check.issues)}`)
          .toBe(true);
        // Exactly one real section, opened and closed by the renderer's own
        // delimiters — not by anything the body smuggled in.
        expect(check.sections, JSON.stringify(variant)).toHaveLength(1);
        expect(parseWorkItemArtifact(file.content).sections[field], JSON.stringify(variant)).toBe(
          body,
        );
      }
    }
  });

  it("escape/unescape stays the identity over those same variants", () => {
    for (const variant of delimiterVariants) {
      expect(unescapeWorkItemText(escapeWorkItemText(variant))).toBe(variant);
    }
  });

  it("renders and validates for pseudo-random hostile bodies", () => {
    // A small deterministic generator rather than a fuzzing dependency: the
    // alphabet is exactly the fragments that have historically broken either
    // the delimiter validator or the section parser, so a random arrangement
    // of them is a far denser search than any hand-written list.
    const fragments = [
      "ordinary prose",
      " <!-- authorbot:original:start -->",
      "\t<!--  authorbot:original:end  -->",
      "<!-- authorbot:original:escape -->",
      "<!-- authorbot:original:submitted:start -->",
      "## Context",
      "  ## Original text",
      "## Completion",
      "```",
      "  ~~~ts",
      "---",
      "",
    ];
    let seed = 0x9e3779b9;
    const next = (bound: number): number => {
      // xorshift32 — deterministic, so a failure is reproducible.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed) % bound;
    };
    for (let iteration = 0; iteration < 250; iteration += 1) {
      const lines: string[] = [];
      for (let i = 0; i < 1 + next(6); i += 1) {
        lines.push(fragments[next(fragments.length)] as string);
      }
      const body = lines.join("\n");
      const file = renderWorkItemArtifact({
        ...BASE,
        context: body,
        originalText: body,
        requestedChange: body,
      });
      const check = checkWorkItemDelimiters(file.content);
      expect(check.valid, `body ${JSON.stringify(body)}: ${JSON.stringify(check.issues)}`).toBe(
        true,
      );
      const parsed = parseWorkItemArtifact(file.content);
      // Context and Requested change are `normalizeTrim`ed on the way in by
      // design (they are prose, not a quoted span), so the round-trip identity
      // for them is against the trimmed text. Original text is preserved
      // byte-exactly and is compared as written.
      expect(parsed.sections.context, JSON.stringify(body)).toBe(body.trim());
      expect(parsed.sections.requestedChange, JSON.stringify(body)).toBe(body.trim());
      expect(parsed.sections.originalText, JSON.stringify(body)).toBe(body);
    }
  });
});

function diffLines(a: string, b: string): string[] {
  const la = a.split("\n");
  const lb = b.split("\n");
  const diffs: string[] = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) diffs.push(la[i] ?? "", lb[i] ?? "");
  }
  return diffs;
}
