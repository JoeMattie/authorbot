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
 * The Worker runs `MIRROR_MODE=queue` until Phase 5 wires a Durable Object
 * alarm to a GitHub-App writer.
 *
 * Drains are serialized per project: the repo-coordinator processor assumes a
 * single drainer per project (rows found `processing` at drain entry are
 * treated as crash leftovers), so overlapping requests must never drain
 * concurrently. The post-drain hook runs inside the same chain.
 */
import type { SqlDatabase } from "@authorbot/database";
import {
  createProcessor,
  LocalGitAdapter,
  type BookRepoWriter,
  type DrainResult,
  type Processor,
} from "@authorbot/repo-coordinator";
import type { Clock } from "./deps.js";
import { finalizeSubmissionOutcomes } from "./reanchor.js";
import { createSubmissionApplier } from "./submission-applier.js";

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
  const clock = options.clock ?? { now: (): Date => new Date() };
  const processor = createProcessor({
    db: options.db,
    writer,
    clock,
    submissionApplier: createSubmissionApplier({ db: options.db, writer, clock }),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });

  // Per-project drain chain: each new drain waits for the previous one,
  // whether it succeeded or failed (single-drainer invariant).
  const chains = new Map<string, Promise<unknown>>();
  const drain = (projectId: string): Promise<DrainResult> => {
    const previous = chains.get(projectId) ?? Promise.resolve();
    const run = async (): Promise<DrainResult> => {
      const result = await processor.drain(projectId);
      // Phase 4 post-drain hook (module docs): §10.3 re-anchoring + conflict
      // problem recording, inside the same serialized chain.
      await finalizeSubmissionOutcomes({ db: options.db, writer, clock }, result.outcomes);
      return result;
    };
    const next = previous.then(run, run);
    chains.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  };

  return {
    drain,
    onMutationCommitted: async (projectId: string): Promise<void> => {
      await drain(projectId);
    },
    writer,
    processor,
  };
}
