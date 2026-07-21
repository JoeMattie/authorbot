/**
 * The API-side `SubmissionApplier` (Phase 4 contract §5; design §12.6): the
 * patch/rebase/conflict decision table injected into the
 * `@authorbot/repo-coordinator` processor, which owns everything around it
 * (frontmatter bump + author credit, attribution append, artifact rendering,
 * the atomic commit, finalize batches, crash recovery).
 *
 * Invoked at drain time on every commit attempt, always against the CURRENT
 * branch head (read through the writer), so a non-fast-forward retry
 * re-resolves instead of committing a stale result.
 *
 * Documented policy decisions (contract §5 ambiguities):
 *
 * - **Overlap detection without the base source.** The projection stores no
 *   historical chapter sources, so "changed regions do not overlap" is
 *   decided conservatively by TWO conditions, both required against a moved
 *   base: the stored selector still resolves via §10.2 steps 1-4 with its
 *   stored context intact, AND the resolution stays inside the declared
 *   block. Unique resolution alone is not a sufficient proxy - a concurrent
 *   edit that deletes the target block lets step 4's chapter-wide search
 *   resurrect the quote elsewhere, which is a relocation onto text the
 *   submitter never saw rather than evidence of non-overlap. Crossing block
 *   boundaries against a moved base is therefore a conflict.
 *   `block_replacement` and `chapter_replacement`
 *   against a moved base are ALWAYS conflicts (their declared target is the
 *   whole block/chapter and intactness cannot be proven without the base) -
 *   "never clobber" wins over cleverness.
 * - **Patch refusals on an unmoved base** (selector missing/ambiguous/not
 *   contiguous, invalid replacement, result validation failure) also take
 *   the conflict path: the §9.5 machine offers `applying → completed |
 *   conflict` only, and an explicit conflict work item is the honest surface
 *   for a human to repair.
 * - The applied result is re-validated chapter-level (Phase 0: marker
 *   health, no raw HTML, allowed URL schemes) before it may commit.
 */
import {
  createRepositories,
  type ChapterProjectionRecord,
  type SqlDatabase,
  type WorkItemRecord,
} from "@authorbot/database";
import {
  PatchError,
  applyBlockReplacement,
  applyChapterReplacement,
  applyRangeReplacement,
  listMarkedBlocks,
  parseChapterMarkdown,
  scanSafety,
  type RangeTarget,
} from "@authorbot/markdown";
import type {
  BookRepoWriter,
  SubmissionApplier,
  SubmissionApplyContext,
  SubmissionApplyOutcome,
} from "@authorbot/repo-coordinator";
import { chapterFrontmatterSchema } from "@authorbot/schemas";
import type { Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";
import { sha256Hex } from "./crypto.js";

export interface CreateSubmissionApplierOptions {
  db: SqlDatabase;
  /** Same writer the processor commits through; `readFile` is required. */
  writer: BookRepoWriter;
  clock?: Clock;
}

export function createSubmissionApplier(options: CreateSubmissionApplierOptions): SubmissionApplier {
  const repos = createRepositories(options.db);
  const clock = options.clock ?? { now: () => new Date() };

  async function apply(context: SubmissionApplyContext): Promise<SubmissionApplyOutcome> {
    const { submission, workItem, branch } = context;
    const chapter = await mustChapter(workItem.chapterId);
    if (options.writer.readFile === undefined) {
      throw new Error("submission applier requires a writer with readFile");
    }
    const currentSource = await options.writer.readFile(branch, chapter.path);
    if (currentSource === null) {
      throw new Error(`chapter source ${chapter.path} not found at branch head`);
    }
    const currentParsed = parseChapterMarkdown(currentSource);
    const currentFm = chapterFrontmatterSchema.safeParse(currentParsed.frontmatter);
    if (!currentFm.success || currentFm.data.id !== chapter.id) {
      throw new Error(`chapter ${chapter.path}: invalid frontmatter at branch head`);
    }
    const currentRevision = currentFm.data.revision;

    const conflict = (reason: string): SubmissionApplyOutcome => ({
      result: "conflict",
      reason,
      currentText: currentTargetText(currentSource, workItem, submission.type),
      currentRevision,
      conflictWorkItemId: uuidv7(clock.now()),
    });

    // §12.6 decision table (module docs).
    if (submission.baseRevision !== currentRevision && submission.type !== "range_replacement") {
      return conflict(
        `the chapter moved to revision ${currentRevision} after the lease's base revision ` +
          `${submission.baseRevision}; a ${submission.type} target cannot be rebased deterministically`,
      );
    }
    if (submission.baseRevision === currentRevision) {
      const currentHash = `sha256:${await sha256Hex(currentSource)}`;
      if (submission.baseContentHash !== currentHash) {
        return conflict(
          "the chapter content at the base revision does not match the submission's base hash",
        );
      }
    }

    const movedBase = submission.baseRevision !== currentRevision;

    let patchedSource: string;
    try {
      if (submission.type === "range_replacement") {
        const target = rangeTargetOf(workItem);
        if (target === null) {
          return conflict("the work item carries no usable range selector");
        }
        const applied = applyRangeReplacement(currentSource, target, submission.content);
        // Contract §5 requires "unique match AND no overlap with the changed
        // regions" before a moved base may rebase. Unique resolution alone
        // does not establish the second conjunct: when the concurrent edit
        // DELETED the target block, §10.2 step 4 legitimately searches the
        // whole chapter and can land the stale replacement in a block the
        // submitter never saw - overwriting the concurrent editor's own text.
        // Against a moved base we therefore require the resolution to stay
        // inside the declared block; crossing out of it is a conflict for a
        // human to merge, never a silent relocation.
        if (movedBase && applied.span.blockId !== target.blockId) {
          return conflict(
            `the chapter moved to revision ${currentRevision} after the lease's base revision ` +
              `${submission.baseRevision} and the declared block ${target.blockId} no longer ` +
              `holds the target; the quote was found in block ${applied.span.blockId}, which is ` +
              `not the region this submission was written against`,
          );
        }
        patchedSource = applied.source;
      } else if (submission.type === "block_replacement") {
        const blockId = blockIdOf(workItem);
        if (blockId === null) {
          return conflict("the work item carries no block selector");
        }
        patchedSource = applyBlockReplacement(currentSource, blockId, submission.content).source;
      } else {
        patchedSource = applyChapterReplacement(currentSource, submission.content).source;
      }
    } catch (error) {
      if (error instanceof PatchError) {
        return conflict(`${error.code}: ${error.message}`);
      }
      throw error;
    }

    // Chapter-level Phase 0 validation of the result (contract §5). The
    // patch engine already asserted marker health; re-check plus safety.
    const resultParsed = parseChapterMarkdown(patchedSource);
    const safety = scanSafety(resultParsed.ast);
    if (
      resultParsed.blocks.malformed.length > 0 ||
      resultParsed.blocks.unmarked.length > 0 ||
      safety.rawHtml.length > 0 ||
      safety.forbiddenUrls.length > 0
    ) {
      return conflict("the applied result failed chapter-level Phase 0 validation");
    }

    return {
      result: "applied",
      chapterPath: chapter.path,
      patchedSource,
      newRevision: currentRevision + 1,
      blockIds: resultParsed.blocks.markers.filter((m) => m.valid).map((m) => m.id),
    };
  }

  async function mustChapter(id: string): Promise<ChapterProjectionRecord> {
    const chapter = await repos.chapters.getById(id);
    if (chapter === null) {
      throw new Error(`chapter ${id} not found in the projection`);
    }
    return chapter;
  }

  return { apply };
}

/**
 * The "current text at the target" a conflict artifact shows (§13 "both
 * texts"): the target block's current source for range/block targets, the
 * whole current body for chapter scope, empty when the block vanished.
 */
function currentTargetText(
  currentSource: string,
  workItem: WorkItemRecord,
  submissionType: string,
): string {
  if (submissionType === "chapter_replacement") {
    const parsed = parseChapterMarkdown(currentSource);
    const first = parsed.ast.children[0];
    const fmEnd = first !== undefined && first.type === "yaml" ? first.position?.end.offset : 0;
    return currentSource.slice(fmEnd ?? 0).trim();
  }
  const blockId = blockIdOf(workItem);
  if (blockId === null) {
    return "";
  }
  const block = listMarkedBlocks(currentSource).find((b) => b.id === blockId);
  if (block === undefined) {
    return "";
  }
  const start = block.blockPosition.start.offset;
  const end = block.blockPosition.end.offset;
  return start === undefined || end === undefined ? "" : currentSource.slice(start, end);
}

/** The work item's stored range selector, if usable. */
function rangeTargetOf(workItem: WorkItemRecord): RangeTarget | null {
  const target = workItem.target as {
    blockId?: unknown;
    textPosition?: { start?: unknown; end?: unknown };
    textQuote?: { exact?: unknown; prefix?: unknown; suffix?: unknown };
  } | null;
  if (target === null || typeof target !== "object") return null;
  if (typeof target.blockId !== "string") return null;
  const exact = target.textQuote?.exact;
  if (typeof exact !== "string") return null;
  const result: RangeTarget = {
    blockId: target.blockId,
    textQuote: {
      exact,
      ...(typeof target.textQuote?.prefix === "string" ? { prefix: target.textQuote.prefix } : {}),
      ...(typeof target.textQuote?.suffix === "string" ? { suffix: target.textQuote.suffix } : {}),
    },
  };
  const start = target.textPosition?.start;
  const end = target.textPosition?.end;
  if (typeof start === "number" && typeof end === "number") {
    result.textPosition = { start, end };
  }
  return result;
}

function blockIdOf(workItem: WorkItemRecord): string | null {
  const target = workItem.target as { blockId?: unknown } | null;
  return target !== null && typeof target === "object" && typeof target.blockId === "string"
    ? target.blockId
    : null;
}
