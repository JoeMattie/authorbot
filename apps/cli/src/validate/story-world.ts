import path from "node:path";
import { characterSchema, timelineSchema } from "@authorbot/schemas";
import type { BookSettings } from "./book.js";
import type { ChapterInfo } from "./chapters.js";
import { emitSchemaIssues, isRecord, parseYamlDoc, readFrontmatter } from "./common.js";
import type { FindingCollector } from "./findings.js";
import {
  expandGlob,
  isDirectory,
  listDirEntries,
  readTextIfExists,
  repoRelative,
} from "./fs-utils.js";

/**
 * The story-world entity index used for reference resolution.
 *
 * `location:*` / `concept:*` references are warnings unless the referenced
 * collection exists (contract section 5); `character:*` and `event:*`
 * references are always errors when unresolved.
 */
export interface StoryWorld {
  characterIds: ReadonlySet<string>;
  eventIds: ReadonlySet<string>;
  locationIds: ReadonlySet<string>;
  conceptIds: ReadonlySet<string>;
  locationsCollectionExists: boolean;
  conceptsCollectionExists: boolean;
}

/** Harvest raw frontmatter `id` strings from every *.md in a directory. */
async function harvestFrontmatterIds(root: string, dirRel: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const dirAbs = path.join(root, dirRel);
  for (const entry of await listDirEntries(dirAbs)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const source = await readTextIfExists(path.join(dirAbs, entry.name));
    if (source === undefined) {
      continue;
    }
    const { fm } = readFrontmatter(source);
    if (fm !== undefined && typeof fm.id === "string") {
      ids.add(fm.id);
    }
  }
  return ids;
}

async function loadCharacters(
  root: string,
  book: BookSettings,
  findings: FindingCollector,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const abs of await expandGlob(root, book.charactersGlob)) {
    const rel = repoRelative(root, abs);
    const source = await readTextIfExists(abs);
    if (source === undefined) {
      findings.error("CHARACTER_FILE_INVALID", rel, "character file is unreadable");
      continue;
    }
    const { fm, fmError } = readFrontmatter(source);
    if (fmError !== undefined) {
      findings.error("CHARACTER_FILE_INVALID", rel, `frontmatter is not valid YAML: ${fmError}`);
      continue;
    }
    if (fm === undefined) {
      findings.error("CHARACTER_FILE_INVALID", rel, "missing YAML frontmatter");
      continue;
    }
    // Harvest leniently so one bad field does not cascade into ref errors.
    if (typeof fm.id === "string") {
      ids.add(fm.id);
    }
    const result = characterSchema.safeParse(fm);
    if (!result.success) {
      emitSchemaIssues(findings, "CHARACTER_FILE_INVALID", rel, result.error);
    }
  }
  return ids;
}

interface TimelineLoad {
  eventIds: Set<string>;
  /** Raw events for the cross-reference pass (kept lenient). */
  rawEvents: unknown[];
  /** Repo-relative timeline path, when the file exists. */
  rel: string | undefined;
}

async function loadTimeline(
  root: string,
  book: BookSettings,
  findings: FindingCollector,
): Promise<TimelineLoad> {
  const load: TimelineLoad = { eventIds: new Set(), rawEvents: [], rel: undefined };
  const source = await readTextIfExists(path.join(root, book.timelinePath));
  if (source === undefined) {
    return load; // the timeline is optional
  }
  const rel = book.timelinePath;
  load.rel = rel;
  const parsed = parseYamlDoc(source);
  if (!parsed.ok) {
    findings.error("TIMELINE_INVALID", rel, `timeline is not valid YAML: ${parsed.error}`);
    return load;
  }
  const result = timelineSchema.safeParse(parsed.data);
  if (!result.success) {
    emitSchemaIssues(findings, "TIMELINE_INVALID", rel, result.error);
  }
  if (isRecord(parsed.data) && Array.isArray(parsed.data.events)) {
    load.rawEvents = parsed.data.events;
    for (const event of load.rawEvents) {
      if (isRecord(event) && typeof event.id === "string") {
        load.eventIds.add(event.id);
      }
    }
  }
  return load;
}

function checkTimelineRefs(
  load: TimelineLoad,
  world: StoryWorld,
  chaptersById: ReadonlyMap<string, ChapterInfo>,
  findings: FindingCollector,
): void {
  if (load.rel === undefined) {
    return;
  }
  const rel = load.rel;
  for (const [index, event] of load.rawEvents.entries()) {
    if (!isRecord(event)) {
      continue;
    }
    if (Array.isArray(event.participants)) {
      for (const [j, ref] of event.participants.entries()) {
        if (typeof ref === "string" && ref.startsWith("character:") && !world.characterIds.has(ref)) {
          findings.error(
            "TIMELINE_REF_UNRESOLVED",
            rel,
            `participant "${ref}" does not match any character record`,
            `/events/${index}/participants/${j}`,
          );
        }
      }
    }
    if (Array.isArray(event.locations)) {
      for (const [j, ref] of event.locations.entries()) {
        if (typeof ref === "string" && ref.startsWith("location:") && !world.locationIds.has(ref)) {
          findings.add(
            world.locationsCollectionExists ? "error" : "warning",
            "TIMELINE_REF_UNRESOLVED",
            rel,
            `location "${ref}" does not match any location record` +
              (world.locationsCollectionExists ? "" : " (no story/locations collection; warning in Phase 0)"),
            `/events/${index}/locations/${j}`,
          );
        }
      }
    }
    if (Array.isArray(event.chapter_refs)) {
      for (const [j, ref] of event.chapter_refs.entries()) {
        if (typeof ref === "string" && !chaptersById.has(ref)) {
          findings.error(
            "TIMELINE_REF_UNRESOLVED",
            rel,
            `chapter_ref "${ref}" does not match any chapter id`,
            `/events/${index}/chapter_refs/${j}`,
          );
        }
      }
    }
  }
}

/** Load characters, locations, concepts, and the timeline; check timeline refs. */
export async function loadStoryWorld(
  root: string,
  book: BookSettings,
  chaptersById: ReadonlyMap<string, ChapterInfo>,
  findings: FindingCollector,
): Promise<StoryWorld> {
  const characterIds = await loadCharacters(root, book, findings);
  const locationsCollectionExists = await isDirectory(path.join(root, "story/locations"));
  const conceptsCollectionExists = await isDirectory(path.join(root, "story/concepts"));
  const locationIds = locationsCollectionExists
    ? await harvestFrontmatterIds(root, "story/locations")
    : new Set<string>();
  const conceptIds = conceptsCollectionExists
    ? await harvestFrontmatterIds(root, "story/concepts")
    : new Set<string>();

  const timeline = await loadTimeline(root, book, findings);
  const world: StoryWorld = {
    characterIds,
    eventIds: timeline.eventIds,
    locationIds,
    conceptIds,
    locationsCollectionExists,
    conceptsCollectionExists,
  };
  checkTimelineRefs(timeline, world, chaptersById, findings);
  return world;
}

/** Chapter `timeline_refs` / `character_refs` resolution (CHAPTER_REF_UNRESOLVED). */
export function checkChapterWorldRefs(
  chapters: ChapterInfo[],
  world: StoryWorld,
  findings: FindingCollector,
): void {
  for (const chapter of chapters) {
    const raw = chapter.raw;
    if (raw === undefined) {
      continue;
    }
    if (Array.isArray(raw.timeline_refs)) {
      for (const [index, ref] of raw.timeline_refs.entries()) {
        if (typeof ref === "string" && ref.startsWith("event:") && !world.eventIds.has(ref)) {
          findings.error(
            "CHAPTER_REF_UNRESOLVED",
            chapter.path,
            `timeline_ref "${ref}" does not match any timeline event`,
            `/timeline_refs/${index}`,
          );
        }
      }
    }
    if (Array.isArray(raw.character_refs)) {
      for (const [index, ref] of raw.character_refs.entries()) {
        if (typeof ref === "string" && ref.startsWith("character:") && !world.characterIds.has(ref)) {
          findings.error(
            "CHAPTER_REF_UNRESOLVED",
            chapter.path,
            `character_ref "${ref}" does not match any character record`,
            `/character_refs/${index}`,
          );
        }
      }
    }
  }
}
