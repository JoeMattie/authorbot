import path from "node:path";
import { storyGraphSchema } from "@authorbot/schemas";
import type { BookSettings } from "./book.js";
import type { ChapterInfo } from "./chapters.js";
import { emitSchemaIssues, isRecord, parseYamlDoc } from "./common.js";
import type { FindingCollector } from "./findings.js";
import { readTextIfExists } from "./fs-utils.js";
import type { StoryWorld } from "./story-world.js";

/**
 * Resolve a story-graph link endpoint (`<kind>:<slug>`): graph nodes first,
 * then the story-world collections. `location:*`/`concept:*` are warnings
 * when their collection is absent (contract section 5).
 */
function checkGraphRef(
  ref: string,
  nodeIds: ReadonlySet<string>,
  world: StoryWorld,
  rel: string,
  pointer: string,
  findings: FindingCollector,
): void {
  if (nodeIds.has(ref)) {
    return;
  }
  const kind = ref.split(":", 1)[0] ?? "";
  if (kind === "character" && world.characterIds.has(ref)) {
    return;
  }
  if (kind === "event" && world.eventIds.has(ref)) {
    return;
  }
  if (kind === "location") {
    if (world.locationIds.has(ref)) {
      return;
    }
    findings.add(
      world.locationsCollectionExists ? "error" : "warning",
      "STORY_GRAPH_REF_UNRESOLVED",
      rel,
      `link endpoint "${ref}" does not match any graph node or location record` +
        (world.locationsCollectionExists ? "" : " (no story/locations collection; warning in Phase 0)"),
      pointer,
    );
    return;
  }
  if (kind === "concept") {
    if (world.conceptIds.has(ref)) {
      return;
    }
    findings.add(
      world.conceptsCollectionExists ? "error" : "warning",
      "STORY_GRAPH_REF_UNRESOLVED",
      rel,
      `link endpoint "${ref}" does not match any graph node or concept record` +
        (world.conceptsCollectionExists ? "" : " (no story/concepts collection; warning in Phase 0)"),
      pointer,
    );
    return;
  }
  findings.error(
    "STORY_GRAPH_REF_UNRESOLVED",
    rel,
    `link endpoint "${ref}" does not match any graph node or known record`,
    pointer,
  );
}

/** Validate `story/outline.yml`: schema plus parent/link/chapter_id resolution. */
export async function checkStoryGraph(
  root: string,
  book: BookSettings,
  chaptersById: ReadonlyMap<string, ChapterInfo>,
  world: StoryWorld,
  findings: FindingCollector,
): Promise<void> {
  const source = await readTextIfExists(path.join(root, book.outlinePath));
  if (source === undefined) {
    return; // the story graph is optional
  }
  const rel = book.outlinePath;
  const parsed = parseYamlDoc(source);
  if (!parsed.ok) {
    findings.error("STORY_GRAPH_INVALID", rel, `story graph is not valid YAML: ${parsed.error}`);
    return;
  }
  const result = storyGraphSchema.safeParse(parsed.data);
  if (!result.success) {
    emitSchemaIssues(findings, "STORY_GRAPH_INVALID", rel, result.error);
  }
  if (!isRecord(parsed.data)) {
    return;
  }

  const nodes = Array.isArray(parsed.data.nodes) ? parsed.data.nodes : [];
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (isRecord(node) && typeof node.id === "string") {
      nodeIds.add(node.id);
    }
  }

  for (const [index, node] of nodes.entries()) {
    if (!isRecord(node)) {
      continue;
    }
    if (typeof node.parent === "string" && !nodeIds.has(node.parent)) {
      findings.error(
        "STORY_GRAPH_REF_UNRESOLVED",
        rel,
        `parent "${node.parent}" does not match any graph node`,
        `/nodes/${index}/parent`,
      );
    }
    if (node.type === "chapter" && typeof node.chapter_id === "string" && !chaptersById.has(node.chapter_id)) {
      findings.error(
        "STORY_GRAPH_REF_UNRESOLVED",
        rel,
        `chapter_id "${node.chapter_id}" does not match any chapter`,
        `/nodes/${index}/chapter_id`,
      );
    }
  }

  // Parent cycles: every parent can resolve while no chain ever reaches a
  // root, leaving the cycle's nodes (and everything below them) reachable
  // from no root - the outline page would silently lose them at build time.
  const parentOf = new Map<string, string>();
  for (const node of nodes) {
    if (isRecord(node) && typeof node.id === "string" && typeof node.parent === "string") {
      parentOf.set(node.id, node.parent);
    }
  }
  const safe = new Set<string>(); // chain reaches a root or an unresolved parent
  const inCycle = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (!isRecord(node) || typeof node.id !== "string") {
      continue;
    }
    const chain: string[] = [];
    const chainSet = new Set<string>();
    let current: string | undefined = node.id;
    while (current !== undefined && !safe.has(current) && !inCycle.has(current)) {
      if (chainSet.has(current)) {
        const cycle = chain.slice(chain.indexOf(current));
        for (const member of cycle) {
          inCycle.add(member);
        }
        findings.error(
          "STORY_GRAPH_INVALID",
          rel,
          `parent cycle ${[...cycle, current].join(" -> ")}: no node in the cycle is reachable from a root`,
          `/nodes/${index}/parent`,
        );
        break;
      }
      chainSet.add(current);
      chain.push(current);
      current = parentOf.get(current);
    }
    if (current === undefined || safe.has(current)) {
      for (const id of chain) {
        safe.add(id);
      }
    }
  }

  const links = Array.isArray(parsed.data.links) ? parsed.data.links : [];
  for (const [index, link] of links.entries()) {
    if (!isRecord(link)) {
      continue;
    }
    for (const endpoint of ["from", "to"] as const) {
      const ref = link[endpoint];
      if (typeof ref === "string") {
        checkGraphRef(ref, nodeIds, world, rel, `/links/${index}/${endpoint}`, findings);
      }
    }
  }
}
