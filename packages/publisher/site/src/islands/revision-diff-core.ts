/*
 * The diff parser/renderers live in this split chunk. Import the
 * core package only: `diff2html/ui` is the highlight.js/file-toggle layer and
 * is deliberately not part of revision review.
 */
import { html, type Diff2HtmlConfig } from "diff2html";
import "./revision-diff.css";

export type RevisionDiffLayout = "line-by-line" | "side-by-side";

/**
 * Diff2Html defaults line rematching to 200 characters, shorter than ordinary
 * manuscript paragraphs. Match prose lines up to the renderer's own default
 * word-highlight ceiling instead of silently pairing long paragraphs by index.
 */
const MAX_PROSE_LINE_MATCH_SIZE = 10_000;

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
    // `words` pairs nearby changed lines and then rematches changed word
    // chunks, instead of treating an edited prose line as one paragraph blob.
    matching: "words",
    maxLineSizeInBlockForComparison: MAX_PROSE_LINE_MATCH_SIZE,
    outputFormat: layout,
  });
}
