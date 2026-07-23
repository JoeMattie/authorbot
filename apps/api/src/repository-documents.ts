/**
 * Validation and canonical identity for the repository-backed planning
 * documents edited through Phase 11 revision proposals.
 *
 * These helpers are deliberately independent of HTTP and Git. The proposal
 * route validates bytes before retaining them, and the coordinator later
 * compares the immutable base hash before committing the exact same bytes.
 */
import { parseChapterMarkdown, scanSafety } from "@authorbot/markdown";
import {
  characterSchema,
  storyGraphSchema,
  timelineSchema,
} from "@authorbot/schemas";
import { parse as parseYaml } from "yaml";
import { sha256Hex } from "./crypto.js";

export const MAX_REPOSITORY_DOCUMENT_BYTES = 512 * 1024;

export type RepositoryDocumentKind = "outline" | "timeline" | "character";

export interface ValidatedRepositoryDocument {
  kind: RepositoryDocumentKind;
  /** Fixed names for singleton documents; canonical frontmatter id for a character. */
  targetId: string;
  path: string;
  label: string;
  /** LF-normalized, newline-terminated canonical bytes retained by the proposal. */
  content: string;
  contentHash: string;
}

export type RepositoryDocumentValidation =
  | { ok: true; document: ValidatedRepositoryDocument }
  | { ok: false; issues: string[] };

/** Reject traversal and non-file spellings before any repository read. */
export function isSafeRepositoryDocumentPath(path: string): boolean {
  if (path === "" || path.trim() !== path || path.startsWith("/") || path.startsWith("\\")) {
    return false;
  }
  if (/^[A-Za-z]:/u.test(path) || path.includes("\\")) return false;
  const parts = path.split("/");
  return !parts.some((part) => part === "" || part === "." || part === "..");
}

/** Minimal contained glob matcher for configured repository documents. */
export function repositoryPathMatchesGlob(path: string, glob: string): boolean {
  if (!isSafeRepositoryDocumentPath(path) || !isSafeRepositoryDocumentPath(glob)) {
    return false;
  }
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`, "u").test(path);
}

export async function validateRepositoryDocument(input: {
  kind: RepositoryDocumentKind;
  path: string;
  content: string;
}): Promise<RepositoryDocumentValidation> {
  const { kind, path } = input;
  const issues: string[] = [];
  if (!isSafeRepositoryDocumentPath(path)) {
    return { ok: false, issues: ["path must be a contained repository-relative file"] };
  }
  const extensionOk = kind === "character" ? path.endsWith(".md") : /\.ya?ml$/u.test(path);
  if (!extensionOk) {
    issues.push(
      kind === "character"
        ? "character documents must use a .md path"
        : `${kind} documents must use a .yml or .yaml path`,
    );
  }
  const byteLength = new TextEncoder().encode(input.content).length;
  if (byteLength === 0) issues.push("document must not be empty");
  if (byteLength > MAX_REPOSITORY_DOCUMENT_BYTES) {
    issues.push(`document must be at most ${MAX_REPOSITORY_DOCUMENT_BYTES} bytes`);
  }
  if (issues.length > 0) return { ok: false, issues };

  const content = canonicalText(input.content);
  if (kind === "character") {
    const parsed = parseChapterMarkdown(content);
    if (parsed.frontmatterError !== undefined) {
      issues.push(`character frontmatter is not valid YAML: ${parsed.frontmatterError}`);
    }
    const character = characterSchema.safeParse(parsed.frontmatter);
    if (!character.success) {
      issues.push(...character.error.issues.map((issue) => `character ${issue.path.join(".") || "document"}: ${issue.message}`));
    }
    const safety = scanSafety(parsed.ast);
    if (safety.rawHtml.length > 0) issues.push("character Markdown must not contain raw HTML");
    for (const finding of safety.forbiddenUrls) {
      issues.push(`character Markdown uses forbidden URL scheme ${finding.scheme}`);
    }
    if (issues.length > 0 || !character.success) return { ok: false, issues };
    return {
      ok: true,
      document: {
        kind,
        targetId: character.data.id,
        path,
        label: character.data.name,
        content,
        contentHash: `sha256:${await sha256Hex(content)}`,
      },
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    return {
      ok: false,
      issues: [`${kind} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const parsed = kind === "outline" ? storyGraphSchema.safeParse(raw) : timelineSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${kind} ${issue.path.join(".") || "document"}: ${issue.message}`,
      ),
    };
  }
  return {
    ok: true,
    document: {
      kind,
      targetId: kind,
      path,
      label: kind === "outline" ? "Outline" : "Timeline",
      content,
      contentHash: `sha256:${await sha256Hex(content)}`,
    },
  };
}

function canonicalText(source: string): string {
  return `${source.replace(/\r\n?/gu, "\n").trimEnd()}\n`;
}
