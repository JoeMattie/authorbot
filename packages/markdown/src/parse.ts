import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";
import { extractBlocks, type BlockScanResult } from "./blocks.js";

export interface ParsedChapter {
  /**
   * Parsed YAML frontmatter, or undefined when the document has none (or the
   * YAML failed to parse - see `frontmatterError`). Raw data: schema
   * validation is the CLI's concern.
   */
  frontmatter: unknown;
  /** YAML parse error message, when the frontmatter block was unparseable. */
  frontmatterError: string | undefined;
  /** mdast tree (frontmatter appears as a leading `yaml` node). */
  ast: Root;
  /** Block-marker scan per contract section 3. */
  blocks: BlockScanResult;
}

/**
 * GFM (tables, strikethrough, autolink literals, task lists, footnotes) is
 * part of the dialect: published sites render pipe tables, and the safety
 * scan sees autolink literals as ordinary `link` nodes so the URL-scheme
 * check applies to them unchanged.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ["yaml"]);

/**
 * Same dialect WITHOUT frontmatter support - for text that is a chapter
 * BODY rather than a chapter file (submission payloads, patch replacements).
 *
 * The distinction is a safety boundary, not a nicety. `remark-frontmatter`
 * swallows everything between a leading `---` fence and its closing `---`
 * into one opaque `yaml` node, and the safety scan only visits `html`,
 * `link`, `image`, and `definition` nodes. Scanning body text with the
 * frontmatter-aware processor therefore let a payload that merely STARTED
 * with `---` hide raw HTML and forbidden URL schemes from the scan entirely.
 * Body text has no frontmatter to parse, so nothing is lost by refusing to
 * look for it.
 */
const proseProcessor = unified().use(remarkParse).use(remarkGfm);

/**
 * Parse chapter BODY text (no frontmatter): mdast tree plus the block-marker
 * scan. Use this - never {@link parseChapterMarkdown} - whenever the input is
 * untrusted body content such as a submission's `content`.
 */
export function parseProseMarkdown(source: string): Pick<ParsedChapter, "ast" | "blocks"> {
  const ast = proseProcessor.parse(source);
  return { ast, blocks: extractBlocks(ast) };
}

/** Parse a chapter Markdown file: frontmatter, mdast tree, and block markers. */
export function parseChapterMarkdown(source: string): ParsedChapter {
  const ast = processor.parse(source);

  let frontmatter: unknown;
  let frontmatterError: string | undefined;
  const first = ast.children[0];
  if (first !== undefined && first.type === "yaml") {
    try {
      frontmatter = parseYaml(first.value);
    } catch (error) {
      frontmatterError = error instanceof Error ? error.message : String(error);
    }
  }

  return { frontmatter, frontmatterError, ast, blocks: extractBlocks(ast) };
}
