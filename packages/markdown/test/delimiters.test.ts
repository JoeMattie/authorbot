import { describe, expect, it } from "vitest";
import { checkWorkItemDelimiters } from "../src/index.js";

const START = "<!-- authorbot:original:start -->";
const END = "<!-- authorbot:original:end -->";

describe("checkWorkItemDelimiters", () => {
  it("accepts exactly one balanced pair", () => {
    const source = ["## Original text", "", START, "Exact original text.", END, ""].join("\n");
    const result = checkWorkItemDelimiters(source);
    expect(result.valid).toBe(true);
    expect(result.sections).toEqual([{ startLine: 3, endLine: 5 }]);
    expect(result.issues).toHaveLength(0);
  });

  it("accepts zero pairs (section absent)", () => {
    const result = checkWorkItemDelimiters("## Context\n\nNo original text section.\n");
    expect(result.valid).toBe(true);
    expect(result.sections).toHaveLength(0);
  });

  it("rejects a start without an end", () => {
    const result = checkWorkItemDelimiters([START, "Dangling.", ""].join("\n"));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([{ reason: "unclosed_start", line: 1 }]);
  });

  it("rejects an end without a start", () => {
    const result = checkWorkItemDelimiters(["Text.", END, ""].join("\n"));
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([{ reason: "unopened_end", line: 2 }]);
  });

  it("rejects nested pairs", () => {
    const source = [START, START, "inner", END, END, ""].join("\n");
    const result = checkWorkItemDelimiters(source);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.reason === "nested_start" && i.line === 2)).toBe(true);
  });

  it("rejects more sections than allowed (default 1)", () => {
    const source = [START, "one", END, "", START, "two", END, ""].join("\n");
    const result = checkWorkItemDelimiters(source);
    expect(result.valid).toBe(false);
    expect(result.sections).toHaveLength(2);
    expect(result.issues).toEqual([{ reason: "too_many_sections", line: 5 }]);
  });

  it("honors a caller-supplied maxSections", () => {
    const source = [START, "one", END, "", START, "two", END, ""].join("\n");
    expect(checkWorkItemDelimiters(source, { maxSections: 2 }).valid).toBe(true);
    expect(checkWorkItemDelimiters(source, { maxSections: 0 }).valid).toBe(false);
  });

  it("tolerates surrounding whitespace and CRLF line endings", () => {
    const source = `  ${START}  \r\ntext\r\n\t${END}\r\n`;
    const result = checkWorkItemDelimiters(source);
    expect(result.valid).toBe(true);
    expect(result.sections).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it("ignores delimiter text that is not alone on its line", () => {
    const source = [`prose mentioning ${START} inline`, ""].join("\n");
    const result = checkWorkItemDelimiters(source);
    expect(result.valid).toBe(true);
    expect(result.sections).toHaveLength(0);
  });

  it("ignores delimiter pairs quoted inside fenced code blocks", () => {
    const source = [
      "## Docs",
      "",
      "```markdown",
      START,
      "quoted example, not a real delimiter",
      END,
      "```",
      "",
      "## Original text",
      "",
      START,
      "The real original text.",
      END,
      "",
    ].join("\n");
    const result = checkWorkItemDelimiters(source);
    expect(result.valid).toBe(true);
    expect(result.sections).toEqual([{ startLine: 11, endLine: 13 }]);
  });

  it("ignores an unpaired delimiter quoted inside a fence", () => {
    const source = ["```", START, "```", ""].join("\n");
    const result = checkWorkItemDelimiters(source);
    expect(result.valid).toBe(true);
    expect(result.sections).toHaveLength(0);
  });

  it("ignores delimiter lines inside indented code blocks", () => {
    const source = ["Paragraph.", "", `    ${START}`, "", `    ${END}`, ""].join("\n");
    const result = checkWorkItemDelimiters(source);
    expect(result.valid).toBe(true);
    expect(result.sections).toHaveLength(0);
  });

  it("ignores delimiter lines inside YAML frontmatter block scalars", () => {
    const source = [
      "---",
      "schema: authorbot.work-item/v1",
      "notes: |",
      `  ${START}`,
      `  ${END}`,
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const result = checkWorkItemDelimiters(source);
    expect(result.valid).toBe(true);
    expect(result.sections).toHaveLength(0);
  });
});
