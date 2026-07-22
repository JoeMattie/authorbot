/*
 * The substantial diff parser/renderers live in this split chunk. Import the
 * core package only: `diff2html/ui` is the highlight.js/file-toggle layer and
 * is deliberately not part of revision review.
 */
import { html, type Diff2HtmlConfig } from "diff2html";
import "./revision-diff.css";

export type RevisionDiffLayout = "line-by-line" | "side-by-side";

/** Render server-generated unified diff text with no file list or syntax highlighter. */
export function renderRevisionDiffHtml(
  unifiedDiff: string,
  layout: RevisionDiffLayout,
): string {
  return html(unifiedDiff, {
    // Diff2Html models these runtime string values as a nominal enum in its
    // declarations even though the public config accepts the literal.
    colorScheme: "dark" as NonNullable<Diff2HtmlConfig["colorScheme"]>,
    diffStyle: "word",
    drawFileList: false,
    matching: "lines",
    outputFormat: layout,
  });
}
