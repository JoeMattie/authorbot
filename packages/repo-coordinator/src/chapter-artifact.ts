/**
 * Minimal-edit chapter frontmatter update for the atomic apply commit
 * (Phase 4 contract §5; design §14.2).
 *
 * `applyChapterFrontmatterUpdate` takes a full chapter file (frontmatter +
 * marked-up Markdown body - typically the output of the `@authorbot/markdown`
 * patch engine, whose frontmatter still shows the base revision) and
 * re-renders **only the frontmatter**:
 *
 * - `revision` is bumped to the given value (must be strictly greater than
 *   the stored one - an apply may never move a revision backwards);
 * - `authors` gains `{ actor }` for the applying actor when not already
 *   present (contract §6 "stable order": existing entries keep their order,
 *   a new author is appended last);
 * - every other field, the field order, YAML comments, and the entire body
 *   are preserved byte-for-byte (the frontmatter is edited via the `yaml`
 *   Document API, not re-serialized from a plain object).
 *
 * The resulting frontmatter is validated against the canonical
 * `authorbot.chapter/v1` schema before the bytes are returned, so a malformed
 * chapter can never reach the book repository. Deterministic: the same input
 * always produces the same bytes.
 */
import { isSeq, parseDocument } from "yaml";
import { chapterFrontmatterSchema, type ChapterFrontmatter } from "@authorbot/schemas";

export interface ChapterFrontmatterUpdate {
  /** New revision; must be strictly greater than the stored revision. */
  revision: number;
  /** Actor reference (`github:octocat`) to credit in `authors`. */
  author: string;
}

export interface UpdatedChapterFile {
  /** Full updated file bytes (frontmatter + unchanged body). */
  content: string;
  /** The validated updated frontmatter. */
  frontmatter: ChapterFrontmatter;
}

/** Split `---\n<yaml>\n---\n<body>` keeping the body bytes exact. */
function splitChapterSource(source: string): { yamlText: string; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("chapter file: missing frontmatter");
  }
  const close = normalized.indexOf("\n---\n", 3);
  if (close === -1) {
    throw new Error("chapter file: unterminated frontmatter");
  }
  return { yamlText: normalized.slice(4, close + 1), body: normalized.slice(close + 5) };
}

/** Apply the revision bump + author credit. See module docs. */
export function applyChapterFrontmatterUpdate(
  source: string,
  update: ChapterFrontmatterUpdate,
): UpdatedChapterFile {
  const { yamlText, body } = splitChapterSource(source);
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error(`chapter file: unparseable frontmatter: ${doc.errors[0]?.message ?? ""}`);
  }

  const current = doc.toJS() as Record<string, unknown> | null;
  if (current === null || typeof current !== "object") {
    throw new Error("chapter file: frontmatter is not a mapping");
  }
  const storedRevision = current["revision"];
  if (typeof storedRevision !== "number" || !Number.isInteger(storedRevision)) {
    throw new Error("chapter file: frontmatter has no integer revision");
  }
  if (update.revision <= storedRevision) {
    throw new Error(
      `chapter file: revision must increase (stored ${storedRevision}, requested ${update.revision})`,
    );
  }

  doc.set("revision", update.revision);

  const authors = doc.get("authors");
  if (!isSeq(authors)) {
    throw new Error("chapter file: frontmatter has no authors list");
  }
  const knownAuthors = (authors.toJSON() as unknown[]).map((item) =>
    item !== null && typeof item === "object" ? (item as { actor?: unknown }).actor : undefined,
  );
  if (!knownAuthors.includes(update.author)) {
    authors.add(doc.createNode({ actor: update.author }));
  }

  const frontmatter = chapterFrontmatterSchema.parse(doc.toJS());
  // Pinned emission options for the *edited* nodes; untouched nodes keep
  // their original style, comments, and order (Document-level edit).
  const updatedYaml = doc.toString({ indent: 2, lineWidth: 0 });
  return { content: `---\n${updatedYaml}---\n${body}`, frontmatter };
}
