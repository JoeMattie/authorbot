import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";
import { extractBlocks, type BlockScanResult } from "./blocks.js";

export interface ParsedChapter {
  /**
   * Parsed YAML frontmatter, or undefined when the document has none (or the
   * YAML failed to parse — see `frontmatterError`). Raw data: schema
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

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]);

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
