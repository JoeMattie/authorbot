import {
  extractBlocks,
  forbiddenUrlScheme,
  isAuthorbotComment,
  parseChapterMarkdown,
} from "@authorbot/markdown";
import type {
  Definition,
  Image,
  Link,
  Nodes,
  Root,
  RootContent,
} from "mdast";
import type { Position } from "unist";

/**
 * Markdown-to-HTML rendering from the `@authorbot/markdown` mdast AST
 * (Phase 1 contract section 4). No HTML serializer library: every emitted
 * byte goes through this module so the safety rules are enforced in one
 * place.
 *
 * - All text and attribute values are HTML-escaped.
 * - Authorbot marker comments are stripped; other raw HTML is emitted
 *   verbatim only when `content.raw_html` is true, and otherwise rendered as
 *   escaped text so hostile markup can never reach the output unescaped.
 * - Links/images whose URL scheme is outside the Phase 0 allow-list
 *   (`http`, `https`, `mailto`, relative) are not rendered as links: the
 *   link text survives as plain text and the image collapses to its alt text.
 * - Semantic blocks identified by a valid marker carry `id="b-<uuid>"`.
 */

export interface RenderOptions {
  /** `content.raw_html` from book.yml (default false). */
  rawHtmlAllowed?: boolean;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for use in HTML content or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Stable key for a node's source position (anchor lookup). */
function positionKey(position: Position | undefined): string | undefined {
  if (position === undefined) {
    return undefined;
  }
  return `${position.start.line}:${position.start.column}`;
}

/**
 * Map from a block node's position key to its block UUID, built from the
 * contract's own marker scan so anchor association matches validation
 * exactly (including markers inside blockquotes and list items).
 */
function buildAnchorMap(ast: Root): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const marker of extractBlocks(ast).markers) {
    if (!marker.valid) {
      continue;
    }
    const key = positionKey(marker.blockPosition);
    if (key !== undefined && !anchors.has(key)) {
      anchors.set(key, marker.id);
    }
  }
  return anchors;
}

interface RenderState {
  rawHtmlAllowed: boolean;
  /**
   * Position-keyed anchors, consumed on use: in mdast a container and its
   * first child can share a start position (a list and its first list item),
   * and the listItem hoist re-reads a child's anchor, so without consumption
   * one marker could stamp the same id on two elements (invalid HTML and an
   * ambiguous annotation target). The first node to claim a key — always the
   * outermost, since rendering is depth-first from the parent — owns it.
   */
  anchors: Map<string, string>;
  definitions: ReadonlyMap<string, Definition>;
}

/** ` id="b-<uuid>"` when the node is an anchored semantic block, else "". */
function anchorAttr(node: Nodes, state: RenderState): string {
  const key = positionKey(node.position);
  if (key === undefined) {
    return "";
  }
  const id = state.anchors.get(key);
  if (id === undefined) {
    return "";
  }
  state.anchors.delete(key);
  return ` id="b-${escapeHtml(id)}"`;
}

function renderChildren(node: { children: Nodes[] }, state: RenderState): string {
  return node.children.map((child) => renderNode(child, state)).join("");
}

function renderLink(node: Link, state: RenderState): string {
  const inner = renderChildren(node, state);
  if (forbiddenUrlScheme(node.url) !== null) {
    return inner; // disallowed scheme: keep the text, drop the link
  }
  const title =
    node.title === null || node.title === undefined
      ? ""
      : ` title="${escapeHtml(node.title)}"`;
  return `<a href="${escapeHtml(node.url)}"${title}>${inner}</a>`;
}

function renderImage(node: Image): string {
  const alt = node.alt ?? "";
  if (forbiddenUrlScheme(node.url) !== null) {
    return escapeHtml(alt); // disallowed scheme: collapse to alt text
  }
  const title =
    node.title === null || node.title === undefined
      ? ""
      : ` title="${escapeHtml(node.title)}"`;
  return `<img src="${escapeHtml(node.url)}" alt="${escapeHtml(alt)}"${title} />`;
}

function renderNode(node: Nodes, state: RenderState): string {
  switch (node.type) {
    case "yaml":
      return ""; // frontmatter
    case "html": {
      if (isAuthorbotComment(node.value)) {
        return ""; // marker comments are stripped (contract section 4)
      }
      // Raw HTML is never emitted when content.raw_html is false: it is
      // rendered as escaped text instead so nothing hostile survives.
      return state.rawHtmlAllowed ? node.value : escapeHtml(node.value);
    }
    case "text":
      return escapeHtml(node.value);
    case "paragraph":
      return `<p${anchorAttr(node, state)}>${renderChildren(node, state)}</p>\n`;
    case "heading": {
      const level = Math.min(Math.max(node.depth, 1), 6);
      return `<h${level}${anchorAttr(node, state)}>${renderChildren(node, state)}</h${level}>\n`;
    }
    case "blockquote":
      return `<blockquote${anchorAttr(node, state)}>\n${renderChildren(node, state)}</blockquote>\n`;
    case "code": {
      const lang =
        node.lang === null || node.lang === undefined || node.lang === ""
          ? ""
          : ` class="language-${escapeHtml(node.lang)}"`;
      return `<pre${anchorAttr(node, state)}><code${lang}>${escapeHtml(node.value)}\n</code></pre>\n`;
    }
    case "list": {
      const anchor = anchorAttr(node, state);
      const inner = renderChildren(node, state);
      if (node.ordered === true) {
        const start =
          node.start === null || node.start === undefined || node.start === 1
            ? ""
            : ` start="${node.start}"`;
        return `<ol${anchor}${start}>\n${inner}</ol>\n`;
      }
      return `<ul${anchor}>\n${inner}</ul>\n`;
    }
    case "listItem": {
      // A marker opening a list item associates with the item's first block;
      // hoist that anchor onto the <li> so the item itself is addressable.
      // Hoisting consumes the anchor, so the child block (blockquote, code
      // block, ...) rendered below cannot emit the id a second time.
      let anchor = anchorAttr(node, state);
      if (anchor === "") {
        const firstBlock = node.children.find((child) => child.type !== "html");
        if (firstBlock !== undefined) {
          anchor = anchorAttr(firstBlock, state);
        }
      }
      const inner = node.children
        .map((child) => {
          if (child.type === "paragraph") {
            // Tight rendering: paragraphs inside list items render inline.
            return renderChildren(child, state);
          }
          return renderNode(child, state);
        })
        .join("");
      return `<li${anchor}>${inner}</li>\n`;
    }
    case "thematicBreak":
      return "<hr />\n";
    case "break":
      return "<br />\n";
    case "emphasis":
      return `<em>${renderChildren(node, state)}</em>`;
    case "strong":
      return `<strong>${renderChildren(node, state)}</strong>`;
    case "delete":
      return `<del>${renderChildren(node, state)}</del>`;
    case "inlineCode":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "link":
      return renderLink(node, state);
    case "image":
      return renderImage(node);
    case "linkReference": {
      const definition = state.definitions.get(node.identifier.toLowerCase());
      if (definition === undefined) {
        return renderChildren(node, state);
      }
      return renderLink(
        {
          type: "link",
          url: definition.url,
          title: definition.title ?? null,
          children: node.children,
        },
        state,
      );
    }
    case "imageReference": {
      const definition = state.definitions.get(node.identifier.toLowerCase());
      if (definition === undefined) {
        return escapeHtml(node.alt ?? "");
      }
      return renderImage({
        type: "image",
        url: definition.url,
        title: definition.title ?? null,
        alt: node.alt ?? "",
      });
    }
    case "definition":
      return "";
    default: {
      // Unknown containers render their children; unknown leaves render
      // nothing. Nothing unescaped can escape through here.
      const children = (node as { children?: Nodes[] }).children;
      if (Array.isArray(children)) {
        return children.map((child) => renderNode(child, state)).join("");
      }
      return "";
    }
  }
}

function collectDefinitions(ast: Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  const walk = (node: Nodes): void => {
    if (node.type === "definition") {
      const key = node.identifier.toLowerCase();
      if (!definitions.has(key)) {
        definitions.set(key, node);
      }
    }
    const children = (node as { children?: Nodes[] }).children;
    if (Array.isArray(children)) {
      for (const child of children) {
        walk(child);
      }
    }
  };
  walk(ast);
  return definitions;
}

/** Render a parsed chapter/character mdast tree to sanitized HTML. */
export function renderAstToHtml(ast: Root, options: RenderOptions = {}): string {
  const state: RenderState = {
    rawHtmlAllowed: options.rawHtmlAllowed === true,
    anchors: buildAnchorMap(ast),
    definitions: collectDefinitions(ast),
  };
  return (ast.children as RootContent[])
    .map((child) => renderNode(child, state))
    .join("");
}

/** Parse Markdown source (frontmatter tolerated) and render it. */
export function renderMarkdownToHtml(
  source: string,
  options: RenderOptions = {},
): string {
  return renderAstToHtml(parseChapterMarkdown(source).ast, options);
}
