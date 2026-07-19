import path from "node:path";
import { bookConfigSchema } from "@authorbot/schemas";
import {
  emitSchemaIssues,
  isRecord,
  parseYamlDoc,
  unsafePathReason,
  unsafeRepoPathReason,
} from "./common.js";
import type { FindingCollector } from "./findings.js";
import { readTextIfExists } from "./fs-utils.js";

/** Settings the rest of the validator needs, with design section 25 defaults. */
export interface BookSettings {
  /** `content.raw_html` (default false). */
  rawHtmlAllowed: boolean;
  chaptersGlob: string;
  charactersGlob: string;
  outlinePath: string;
  timelinePath: string;
}

export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  rawHtmlAllowed: false,
  chaptersGlob: "chapters/*.md",
  charactersGlob: "story/characters/*.md",
  outlinePath: "story/outline.yml",
  timelinePath: "story/timeline.yml",
};

function settingPath(
  findings: FindingCollector,
  raw: unknown,
  fallback: string,
  pointer: string,
): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return fallback;
  }
  const reason = unsafeRepoPathReason(raw);
  if (reason !== null) {
    findings.error("PATH_UNSAFE", "book.yml", `configured path "${raw}" ${reason}`, pointer);
    return fallback;
  }
  return raw;
}

/**
 * Load and validate `book.yml`. Always returns usable settings: defaults are
 * applied when the file is missing or invalid so validation can continue.
 */
export async function loadBookConfig(
  root: string,
  findings: FindingCollector,
): Promise<BookSettings> {
  const settings = { ...DEFAULT_BOOK_SETTINGS };
  const source = await readTextIfExists(path.join(root, "book.yml"));
  if (source === undefined) {
    findings.error("BOOK_CONFIG_MISSING", "book.yml", "book.yml is absent or unreadable");
    return settings;
  }
  const parsed = parseYamlDoc(source);
  if (!parsed.ok) {
    findings.error("BOOK_CONFIG_INVALID", "book.yml", `book.yml is not valid YAML: ${parsed.error}`);
    return settings;
  }

  if (isRecord(parsed.data)) {
    const data = parsed.data;
    if (typeof data.slug === "string") {
      const reason = unsafePathReason(data.slug);
      if (reason !== null) {
        findings.error("PATH_UNSAFE", "book.yml", `book slug "${data.slug}" ${reason}`, "/slug");
      }
    }
    const content = isRecord(data.content) ? data.content : {};
    const planning = isRecord(data.planning) ? data.planning : {};
    settings.rawHtmlAllowed = content.raw_html === true;
    settings.chaptersGlob = settingPath(
      findings,
      content.chapters_glob,
      settings.chaptersGlob,
      "/content/chapters_glob",
    );
    settings.charactersGlob = settingPath(
      findings,
      planning.characters_glob,
      settings.charactersGlob,
      "/planning/characters_glob",
    );
    settings.outlinePath = settingPath(
      findings,
      planning.outline,
      settings.outlinePath,
      "/planning/outline",
    );
    settings.timelinePath = settingPath(
      findings,
      planning.timeline,
      settings.timelinePath,
      "/planning/timeline",
    );
  }

  const result = bookConfigSchema.safeParse(parsed.data);
  if (!result.success) {
    emitSchemaIssues(findings, "BOOK_CONFIG_INVALID", "book.yml", result.error);
  }
  return settings;
}
