import { describe, expect, it } from "vitest";
import { createRevisionDiff } from "../src/revision-diff.js";

describe("revision proposal unified diffs", () => {
  it("includes bounded context and stable before/after labels", () => {
    const result = createRevisionDiff({
      path: "chapters/opening.md",
      baseRevision: 7,
      baseContent: "one\ntwo\nthree\n",
      proposedContent: "one\nTWO\nthree\n",
    });

    expect(result.computationLimited).toBe(false);
    expect(result.unifiedDiff).toContain("--- a/chapters/opening.md\trevision 7");
    expect(result.unifiedDiff).toContain("+++ b/chapters/opening.md\tproposed");
    expect(result.unifiedDiff).toContain("-two");
    expect(result.unifiedDiff).toContain("+TWO");
  });

  it("keeps hostile prose as inert diff text for the frontend escaping boundary", () => {
    const result = createRevisionDiff({
      baseRevision: 1,
      baseContent: "safe\n",
      proposedContent: '<img src=x onerror="globalThis.pwned=true">\n<script>alert(1)</script>\n',
    });

    expect(result.unifiedDiff).toContain('+<img src=x onerror="globalThis.pwned=true">');
    expect(result.unifiedDiff).toContain("+<script>alert(1)</script>");
  });

  it("strips diff-header control characters from a supplied path", () => {
    const result = createRevisionDiff({
      path: "chapter.md\n+++ injected\0",
      baseRevision: 2,
      baseContent: "before\n",
      proposedContent: "after\n",
    });

    expect(result.unifiedDiff).not.toContain("\n+++ injected");
    expect(result.unifiedDiff).toContain("a/chapter.md+++ injected");
  });
});
