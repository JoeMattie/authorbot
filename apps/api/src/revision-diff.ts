import { createTwoFilesPatch } from "diff";

/** Keep a pathological proposal from monopolizing one Worker invocation. */
export const REVISION_DIFF_TIMEOUT_MS = 100;

export interface RevisionDiffInput {
  baseContent: string;
  proposedContent: string;
  /** Null for repository documents without an embedded numeric revision. */
  baseRevision: number | null;
  path?: string;
}

export interface RevisionDiffResult {
  /** Standard unified diff consumed by Diff2Html and non-browser clients. */
  unifiedDiff: string | null;
  /** True when the bounded diff computation gave up; snapshots stay usable. */
  computationLimited: boolean;
}

/**
 * Build a transport- and renderer-neutral proposal diff.
 *
 * The before/after snapshots remain part of the authorized proposal response,
 * so hitting the CPU bound degrades to a plain comparison instead of hiding
 * the review material or retrying an expensive computation indefinitely.
 */
export function createRevisionDiff(input: RevisionDiffInput): RevisionDiffResult {
  const path = safeDiffPath(input.path);
  const unifiedDiff = createTwoFilesPatch(
    `a/${path}`,
    `b/${path}`,
    input.baseContent,
    input.proposedContent,
    input.baseRevision === null ? "base" : `revision ${input.baseRevision}`,
    "proposed",
    { context: 4, timeout: REVISION_DIFF_TIMEOUT_MS },
  );
  return {
    unifiedDiff: unifiedDiff ?? null,
    computationLimited: unifiedDiff === undefined,
  };
}

/** File headers are diff syntax, so never place caller-controlled newlines in them. */
function safeDiffPath(path: string | undefined): string {
  if (path === undefined || path.length === 0) return "chapter.md";
  const oneLine = path.replace(/[\r\n\0]/g, "").trim();
  return oneLine.length === 0 ? "chapter.md" : oneLine.slice(0, 512);
}
