import path from "node:path";
import { checkWorkItemDelimiters, isUuidv7, type DelimiterIssue } from "@authorbot/markdown";
import {
  annotationSchema,
  attributionSchema,
  decisionSchema,
  releaseSchema,
  replySchema,
  workItemSchema,
} from "@authorbot/schemas";
import type { ChapterInfo } from "./chapters.js";
import { emitSchemaIssues, isRecord, parseYamlDoc, readFrontmatter } from "./common.js";
import type { FindingCollector, ValidationCode } from "./findings.js";
import { listDirEntries, readTextIfExists } from "./fs-utils.js";

interface AnnotationRecord {
  /** Annotation directory name under `.authorbot/annotations/`. */
  dirName: string;
  /** Repo-relative path of `annotation.md`. */
  rel: string;
  raw: Record<string, unknown> | undefined;
}

function delimiterMessage(issue: DelimiterIssue): string {
  switch (issue.reason) {
    case "unopened_end":
      return "authorbot:original:end delimiter with no matching start";
    case "unclosed_start":
      return "authorbot:original:start delimiter is never closed";
    case "nested_start":
      return "nested authorbot:original:start delimiter";
    case "too_many_sections":
      return "more than one balanced original-text section";
  }
}

/** File or directory basename without its extension. */
function baseName(name: string): string {
  return name.replace(/\.(?:md|yml|yaml)$/, "");
}

/**
 * Contract section 4 pins ID-derived record locations
 * (`.authorbot/annotations/<id>/`, `.authorbot/work-items/<id>.md`, ...):
 * report when the containing directory/file name does not equal the record's
 * frontmatter id (or attribution `chapter_id`).
 */
function checkPathMatchesId(
  actual: string,
  id: unknown,
  what: string,
  rel: string,
  code: ValidationCode,
  pointer: string,
  findings: FindingCollector,
): void {
  if (typeof id === "string" && id.length > 0 && baseName(actual) !== id) {
    findings.error(
      code,
      rel,
      `${what} "${actual}" does not match the record's ${pointer.slice(1)} "${id}" (contract section 4 pins ID-derived paths)`,
      pointer,
    );
  }
}

/**
 * Track ids across record files: report a finding when two records declare
 * the same id (the id would resolve ambiguously in cross-reference checks).
 */
function recordId(
  id: unknown,
  rel: string,
  firstSeen: Map<string, string>,
  ids: Set<string>,
  what: string,
  code: ValidationCode,
  findings: FindingCollector,
): void {
  if (typeof id !== "string" || !isUuidv7(id)) {
    return;
  }
  const first = firstSeen.get(id);
  if (first !== undefined) {
    findings.error(code, rel, `${what} id "${id}" is already declared by ${first}`, "/id");
  } else {
    firstSeen.set(id, rel);
  }
  ids.add(id);
}

/** Load a Markdown record's frontmatter, reporting schema problems as `code`. */
function loadRecordFrontmatter(
  source: string,
  rel: string,
  code: ValidationCode,
  findings: FindingCollector,
): Record<string, unknown> | undefined {
  const { fm, fmError } = readFrontmatter(source);
  if (fmError !== undefined) {
    findings.error(code, rel, `frontmatter is not valid YAML: ${fmError}`);
    return undefined;
  }
  if (fm === undefined) {
    findings.error(code, rel, "missing YAML frontmatter");
    return undefined;
  }
  return fm;
}

async function loadAnnotations(
  root: string,
  findings: FindingCollector,
): Promise<{ records: AnnotationRecord[]; ids: Set<string> }> {
  const annotationsRoot = path.join(root, ".authorbot", "annotations");
  const records: AnnotationRecord[] = [];
  const ids = new Set<string>();
  const firstSeen = new Map<string, string>();
  for (const entry of await listDirEntries(annotationsRoot)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const rel = `.authorbot/annotations/${entry.name}/annotation.md`;
    const source = await readTextIfExists(path.join(annotationsRoot, entry.name, "annotation.md"));
    if (source === undefined) {
      findings.error("ANNOTATION_INVALID", rel, "annotation.md is missing or unreadable");
      records.push({ dirName: entry.name, rel, raw: undefined });
      continue;
    }
    const fm = loadRecordFrontmatter(source, rel, "ANNOTATION_INVALID", findings);
    if (fm !== undefined) {
      recordId(fm.id, rel, firstSeen, ids, "annotation", "ANNOTATION_INVALID", findings);
      checkPathMatchesId(
        entry.name,
        fm.id,
        "annotation directory",
        rel,
        "ANNOTATION_INVALID",
        "/id",
        findings,
      );
      const result = annotationSchema.safeParse(fm);
      if (!result.success) {
        emitSchemaIssues(findings, "ANNOTATION_INVALID", rel, result.error);
      }
      // Selector coherence (design section 10.1): an end offset before the
      // start offset can never anchor. Cross-field rule the JSON-Schema-
      // generable Zod object cannot express, so it lives here.
      if (isRecord(fm.target) && isRecord(fm.target.textPosition)) {
        const { start, end } = fm.target.textPosition;
        if (typeof start === "number" && typeof end === "number" && end < start) {
          findings.error(
            "ANNOTATION_INVALID",
            rel,
            `target.textPosition end ${end} is before start ${start}`,
            "/target/textPosition",
          );
        }
      }
    }
    records.push({ dirName: entry.name, rel, raw: fm });
  }
  return { records, ids };
}

async function checkAnnotationRefsAndReplies(
  root: string,
  records: AnnotationRecord[],
  chaptersById: ReadonlyMap<string, ChapterInfo>,
  findings: FindingCollector,
): Promise<void> {
  for (const record of records) {
    const raw = record.raw;
    if (raw !== undefined && typeof raw.chapter_id === "string") {
      const chapter = chaptersById.get(raw.chapter_id);
      if (chapter === undefined) {
        findings.error(
          "ANNOTATION_REF_UNRESOLVED",
          record.rel,
          `chapter_id "${raw.chapter_id}" does not match any chapter`,
          "/chapter_id",
        );
      } else {
        if (
          isRecord(raw.target) &&
          typeof raw.target.blockId === "string" &&
          !chapter.blockIds.has(raw.target.blockId)
        ) {
          findings.error(
            "ANNOTATION_REF_UNRESOLVED",
            record.rel,
            `target block "${raw.target.blockId}" does not exist in ${chapter.path}`,
            "/target/blockId",
          );
        }
        if (
          typeof raw.chapter_revision === "number" &&
          typeof chapter.revision === "number" &&
          raw.chapter_revision > chapter.revision
        ) {
          findings.error(
            "ANNOTATION_REF_UNRESOLVED",
            record.rel,
            `chapter_revision ${raw.chapter_revision} is beyond ${chapter.path} revision ${chapter.revision}`,
            "/chapter_revision",
          );
        }
      }
    }

    // Replies. A reply's `annotation_id` must reference the annotation whose
    // directory contains it (contract section 4 path scheme), not just any
    // annotation in the repository.
    const enclosingAnnotationId =
      record.raw !== undefined && typeof record.raw.id === "string"
        ? record.raw.id
        : record.dirName;
    const repliesDir = path.join(root, ".authorbot", "annotations", record.dirName, "replies");
    const replyFiles = (await listDirEntries(repliesDir)).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    );
    const replies: { rel: string; raw: Record<string, unknown> | undefined }[] = [];
    const replyIds = new Set<string>();
    for (const entry of replyFiles) {
      const rel = `.authorbot/annotations/${record.dirName}/replies/${entry.name}`;
      const source = await readTextIfExists(path.join(repliesDir, entry.name));
      if (source === undefined) {
        findings.error("ANNOTATION_INVALID", rel, "reply file is unreadable");
        continue;
      }
      const fm = loadRecordFrontmatter(source, rel, "ANNOTATION_INVALID", findings);
      if (fm !== undefined) {
        if (typeof fm.id === "string" && isUuidv7(fm.id)) {
          replyIds.add(fm.id);
        }
        checkPathMatchesId(
          entry.name,
          fm.id,
          "reply file",
          rel,
          "ANNOTATION_INVALID",
          "/id",
          findings,
        );
        const result = replySchema.safeParse(fm);
        if (!result.success) {
          emitSchemaIssues(findings, "ANNOTATION_INVALID", rel, result.error);
        }
      }
      replies.push({ rel, raw: fm });
    }
    for (const reply of replies) {
      const raw = reply.raw;
      if (raw === undefined) {
        continue;
      }
      if (typeof raw.annotation_id === "string" && raw.annotation_id !== enclosingAnnotationId) {
        findings.error(
          "ANNOTATION_REF_UNRESOLVED",
          reply.rel,
          `annotation_id "${raw.annotation_id}" does not match the enclosing annotation "${enclosingAnnotationId}"`,
          "/annotation_id",
        );
      }
      if (typeof raw.parent_reply_id === "string" && !replyIds.has(raw.parent_reply_id)) {
        findings.error(
          "ANNOTATION_REF_UNRESOLVED",
          reply.rel,
          `parent_reply_id "${raw.parent_reply_id}" does not match any reply of this annotation`,
          "/parent_reply_id",
        );
      }
    }
  }
}

async function checkWorkItems(
  root: string,
  annotationIds: ReadonlySet<string>,
  chaptersById: ReadonlyMap<string, ChapterInfo>,
  findings: FindingCollector,
): Promise<Set<string>> {
  const workItemsDir = path.join(root, ".authorbot", "work-items");
  const ids = new Set<string>();
  const firstSeen = new Map<string, string>();
  const loaded: { rel: string; raw: Record<string, unknown> | undefined }[] = [];
  for (const entry of await listDirEntries(workItemsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const rel = `.authorbot/work-items/${entry.name}`;
    const source = await readTextIfExists(path.join(workItemsDir, entry.name));
    if (source === undefined) {
      findings.error("WORK_ITEM_INVALID", rel, "work item file is unreadable");
      continue;
    }
    const fm = loadRecordFrontmatter(source, rel, "WORK_ITEM_INVALID", findings);
    if (fm !== undefined) {
      recordId(fm.id, rel, firstSeen, ids, "work item", "WORK_ITEM_INVALID", findings);
      checkPathMatchesId(
        entry.name,
        fm.id,
        "work item file",
        rel,
        "WORK_ITEM_INVALID",
        "/id",
        findings,
      );
      const result = workItemSchema.safeParse(fm);
      if (!result.success) {
        emitSchemaIssues(findings, "WORK_ITEM_INVALID", rel, result.error);
      }
    }
    const delimiters = checkWorkItemDelimiters(source);
    for (const issue of delimiters.issues) {
      findings.error(
        "WORK_ITEM_DELIMITER_INVALID",
        rel,
        delimiterMessage(issue),
        `line ${issue.line}`,
      );
    }
    loaded.push({ rel, raw: fm });
  }

  for (const { rel, raw } of loaded) {
    if (raw === undefined) {
      continue;
    }
    // Per-type reference requirements (schema keeps these fields optional for
    // write_chapter/planning; the validator enforces them per type — see
    // packages/schemas/src/work-item.ts). A revise_* item without a chapter
    // and base revision has no target document (design section 9.1/13); range
    // and block revisions also need their source annotation.
    if (
      raw.type === "revise_range" ||
      raw.type === "revise_block" ||
      raw.type === "revise_chapter"
    ) {
      if (typeof raw.chapter_id !== "string") {
        findings.error(
          "WORK_ITEM_REF_UNRESOLVED",
          rel,
          `type "${raw.type}" requires chapter_id (no target document without it)`,
          "/chapter_id",
        );
      }
      if (typeof raw.base_revision !== "number") {
        findings.error(
          "WORK_ITEM_REF_UNRESOLVED",
          rel,
          `type "${raw.type}" requires base_revision`,
          "/base_revision",
        );
      }
      if (
        (raw.type === "revise_range" || raw.type === "revise_block") &&
        typeof raw.source_annotation_id !== "string"
      ) {
        findings.error(
          "WORK_ITEM_REF_UNRESOLVED",
          rel,
          `type "${raw.type}" requires source_annotation_id`,
          "/source_annotation_id",
        );
      }
    }
    if (typeof raw.source_annotation_id === "string" && !annotationIds.has(raw.source_annotation_id)) {
      findings.error(
        "WORK_ITEM_REF_UNRESOLVED",
        rel,
        `source_annotation_id "${raw.source_annotation_id}" does not match any annotation`,
        "/source_annotation_id",
      );
    }
    if (typeof raw.chapter_id === "string") {
      const chapter = chaptersById.get(raw.chapter_id);
      if (chapter === undefined) {
        findings.error(
          "WORK_ITEM_REF_UNRESOLVED",
          rel,
          `chapter_id "${raw.chapter_id}" does not match any chapter`,
          "/chapter_id",
        );
      } else if (
        typeof raw.base_revision === "number" &&
        typeof chapter.revision === "number" &&
        raw.base_revision > chapter.revision
      ) {
        findings.error(
          "WORK_ITEM_REF_UNRESOLVED",
          rel,
          `base_revision ${raw.base_revision} is beyond ${chapter.path} revision ${chapter.revision}`,
          "/base_revision",
        );
      }
    }
  }
  return ids;
}

async function checkDecisions(
  root: string,
  annotationIds: ReadonlySet<string>,
  workItemIds: ReadonlySet<string>,
  findings: FindingCollector,
): Promise<void> {
  const decisionsDir = path.join(root, ".authorbot", "decisions");
  for (const entry of await listDirEntries(decisionsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) {
      continue;
    }
    const rel = `.authorbot/decisions/${entry.name}`;
    const source = await readTextIfExists(path.join(decisionsDir, entry.name));
    if (source === undefined) {
      findings.error("DECISION_INVALID", rel, "decision file is unreadable");
      continue;
    }
    const parsed = parseYamlDoc(source);
    if (!parsed.ok) {
      findings.error("DECISION_INVALID", rel, `decision is not valid YAML: ${parsed.error}`);
      continue;
    }
    const result = decisionSchema.safeParse(parsed.data);
    if (!result.success) {
      emitSchemaIssues(findings, "DECISION_INVALID", rel, result.error);
    }
    if (!isRecord(parsed.data)) {
      continue;
    }
    const raw = parsed.data;
    checkPathMatchesId(entry.name, raw.id, "decision file", rel, "DECISION_INVALID", "/id", findings);
    if (typeof raw.source_annotation_id === "string" && !annotationIds.has(raw.source_annotation_id)) {
      findings.error(
        "DECISION_REF_UNRESOLVED",
        rel,
        `source_annotation_id "${raw.source_annotation_id}" does not match any annotation`,
        "/source_annotation_id",
      );
    }
    if (typeof raw.work_item_id === "string" && !workItemIds.has(raw.work_item_id)) {
      findings.error(
        "DECISION_REF_UNRESOLVED",
        rel,
        `work_item_id "${raw.work_item_id}" does not match any work item`,
        "/work_item_id",
      );
    }
  }
}

async function checkReleases(
  root: string,
  chaptersById: ReadonlyMap<string, ChapterInfo>,
  findings: FindingCollector,
): Promise<void> {
  const releasesDir = path.join(root, ".authorbot", "releases");
  for (const entry of await listDirEntries(releasesDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) {
      continue;
    }
    const rel = `.authorbot/releases/${entry.name}`;
    const source = await readTextIfExists(path.join(releasesDir, entry.name));
    if (source === undefined) {
      findings.error("RELEASE_INVALID", rel, "release file is unreadable");
      continue;
    }
    const parsed = parseYamlDoc(source);
    if (!parsed.ok) {
      findings.error("RELEASE_INVALID", rel, `release is not valid YAML: ${parsed.error}`);
      continue;
    }
    const result = releaseSchema.safeParse(parsed.data);
    if (!result.success) {
      emitSchemaIssues(findings, "RELEASE_INVALID", rel, result.error);
    }
    if (!isRecord(parsed.data)) {
      continue;
    }
    checkPathMatchesId(
      entry.name,
      parsed.data.id,
      "release file",
      rel,
      "RELEASE_INVALID",
      "/id",
      findings,
    );
    if (!Array.isArray(parsed.data.chapters)) {
      continue;
    }
    for (const [index, pin] of parsed.data.chapters.entries()) {
      if (!isRecord(pin) || typeof pin.chapter_id !== "string") {
        continue;
      }
      const chapter = chaptersById.get(pin.chapter_id);
      if (chapter === undefined) {
        findings.error(
          "RELEASE_REF_UNRESOLVED",
          rel,
          `chapter_id "${pin.chapter_id}" does not match any chapter`,
          `/chapters/${index}/chapter_id`,
        );
      } else if (
        typeof pin.revision === "number" &&
        typeof chapter.revision === "number" &&
        pin.revision > chapter.revision
      ) {
        findings.error(
          "RELEASE_REF_UNRESOLVED",
          rel,
          `revision ${pin.revision} is beyond ${chapter.path} revision ${chapter.revision}`,
          `/chapters/${index}/revision`,
        );
      }
    }
  }
}

async function checkAttribution(
  root: string,
  chaptersById: ReadonlyMap<string, ChapterInfo>,
  findings: FindingCollector,
): Promise<void> {
  const attributionDir = path.join(root, ".authorbot", "attribution");
  for (const entry of await listDirEntries(attributionDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) {
      continue;
    }
    const rel = `.authorbot/attribution/${entry.name}`;
    const source = await readTextIfExists(path.join(attributionDir, entry.name));
    if (source === undefined) {
      findings.error("ATTRIBUTION_INVALID", rel, "attribution file is unreadable");
      continue;
    }
    const parsed = parseYamlDoc(source);
    if (!parsed.ok) {
      findings.error("ATTRIBUTION_INVALID", rel, `attribution is not valid YAML: ${parsed.error}`);
      continue;
    }
    const result = attributionSchema.safeParse(parsed.data);
    if (!result.success) {
      emitSchemaIssues(findings, "ATTRIBUTION_INVALID", rel, result.error);
    }
    if (!isRecord(parsed.data)) {
      continue;
    }
    checkPathMatchesId(
      entry.name,
      parsed.data.chapter_id,
      "attribution file",
      rel,
      "ATTRIBUTION_INVALID",
      "/chapter_id",
      findings,
    );
    // Contract section 5 makes unresolved chapter IDs errors; the code table
    // has no ATTRIBUTION_REF_UNRESOLVED, so the dangling reference is
    // reported under ATTRIBUTION_INVALID.
    if (
      typeof parsed.data.chapter_id === "string" &&
      isUuidv7(parsed.data.chapter_id) &&
      !chaptersById.has(parsed.data.chapter_id)
    ) {
      findings.error(
        "ATTRIBUTION_INVALID",
        rel,
        `chapter_id "${parsed.data.chapter_id}" does not match any chapter`,
        "/chapter_id",
      );
    }
  }
}

/**
 * Validate every `.authorbot/` governance record: annotations and replies,
 * work items (including original-text delimiters), decisions, releases, and
 * attribution, with the cross-reference checks of contract section 5.
 */
export async function checkAuthorbotRecords(
  root: string,
  chaptersById: ReadonlyMap<string, ChapterInfo>,
  findings: FindingCollector,
): Promise<void> {
  const { records, ids: annotationIds } = await loadAnnotations(root, findings);
  await checkAnnotationRefsAndReplies(root, records, chaptersById, findings);
  const workItemIds = await checkWorkItems(root, annotationIds, chaptersById, findings);
  await checkDecisions(root, annotationIds, workItemIds, findings);
  await checkReleases(root, chaptersById, findings);
  await checkAttribution(root, chaptersById, findings);
}
