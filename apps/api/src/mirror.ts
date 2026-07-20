/**
 * Inline mirror wiring (Phase 2 contract §5, `MIRROR_MODE=inline`): connects
 * `AppDeps.onMutationCommitted` to the @authorbot/repo-coordinator outbox
 * processor so every accepted command is rendered and committed to the book
 * repository in-process, right after its 202 batch lands.
 *
 * Phase 4: the processor is created with the API's `SubmissionApplier`
 * (submission-applier.ts — the §12.6 patch/rebase/conflict decision table),
 * and every drain is followed by the post-drain hook (reanchor.ts): §10.3
 * re-anchoring of the applied chapter's other annotations and the conflict
 * problem/event recording. The writer must support `readFile`
 * (`LocalGitAdapter` does) — the applier and the attribution append read the
 * branch head through it.
 *
 * Node-only (the default `LocalGitAdapter` spawns `git`), so this module is
 * exported via `@authorbot/api/local` and never reaches the Worker bundle.
 * Constructing `LocalGitAdapter` is the reason: a live reference to it from a
 * Worker-reachable module would pull `node:child_process` into the bundle.
 * `MIRROR_MODE=durable` (Phase 5 contract §5) gets the same drain through
 * coordinator.ts with a `GitHubBookRepoWriter` instead.
 *
 * The drain itself — processor + Phase 4 post-drain hook, serialized per
 * project — lives in the Worker-safe drain.ts and is shared with the Durable
 * Object, so inline and durable modes cannot diverge.
 */
import type { SqlDatabase } from "@authorbot/database";
import {
  LocalGitAdapter,
  type BookRepoWriter,
  type DrainResult,
  type Processor,
} from "@authorbot/repo-coordinator";
import type { Clock } from "./deps.js";
import { createDrainRunner } from "./drain.js";

export interface InlineMirrorOptions {
  db: SqlDatabase;
  /** Work tree of the book repository checkout; builds a `LocalGitAdapter`. */
  workTreePath?: string;
  /** Alternative to `workTreePath`: inject a writer directly (tests). */
  writer?: BookRepoWriter;
  clock?: Clock;
  /** Maximum commit attempts per operation (default 3, contract §5). */
  maxAttempts?: number;
}

export interface InlineMirror {
  /** Wire this as `AppDeps.onMutationCommitted`. */
  onMutationCommitted(projectId: string): Promise<void>;
  /**
   * Drain the project's outbox now and return the outcomes (used by tests
   * and by manual drains in `MIRROR_MODE=queue`). Serialized with — and
   * identical to — the drains triggered through `onMutationCommitted`.
   */
  drain(projectId: string): Promise<DrainResult>;
  writer: BookRepoWriter;
  processor: Processor;
}

export function createInlineMirror(options: InlineMirrorOptions): InlineMirror {
  const writer =
    options.writer ??
    (options.workTreePath !== undefined
      ? new LocalGitAdapter({ workTreePath: options.workTreePath })
      : undefined);
  if (writer === undefined) {
    throw new Error("createInlineMirror requires either workTreePath or writer");
  }
  const runner = createDrainRunner({
    db: options.db,
    writer,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });

  return {
    drain: runner.drain,
    onMutationCommitted: async (projectId: string): Promise<void> => {
      await runner.drain(projectId);
    },
    writer,
    processor: runner.processor,
  };
}
