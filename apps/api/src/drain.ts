/**
 * The outbox drain runner shared by every mirror mode (Phase 2 contract §5,
 * Phase 4 post-drain hook, Phase 5 contract §5).
 *
 * There is exactly ONE drain implementation in the API. `MIRROR_MODE=inline`
 * (mirror.ts, Node/dev, `LocalGitAdapter`) and `MIRROR_MODE=durable`
 * (coordinator.ts, Worker, `GitHubBookRepoWriter`) differ only in which
 * `BookRepoWriter` they inject; the sequence — processor drain, then the §10.3
 * re-anchor / conflict-recording hook, inside one serialized chain — is this
 * module and is therefore identical in both.
 *
 * WORKER-SAFE: no node-only import may enter this file or the modules it
 * pulls in. In particular it must never construct `LocalGitAdapter` (that
 * would drag `node:child_process` into the Worker bundle); mirror.ts owns that
 * construction and passes the resulting writer in.
 *
 * Serialization: the repo-coordinator processor assumes a single drainer per
 * project (rows found `processing` at drain entry are treated as crash
 * leftovers, so an overlapping drain would reprocess a row another drain is
 * mid-flight on). `createDrainRunner` therefore chains drains per project id —
 * a second call while one is running waits, it does not run beside it.
 */
import type { SqlDatabase } from "@authorbot/database";
import {
  createProcessor,
  type BookRepoWriter,
  type DrainResult,
  type Processor,
} from "@authorbot/repo-coordinator";
import type { Clock } from "./deps.js";
import { finalizeSubmissionOutcomes } from "./reanchor.js";
import { createSubmissionApplier } from "./submission-applier.js";

export interface DrainRunnerOptions {
  db: SqlDatabase;
  writer: BookRepoWriter;
  clock?: Clock;
  /** Maximum commit attempts per operation (default 3, Phase 2 contract §5). */
  maxAttempts?: number;
  /**
   * Outbox kinds to leave `pending` on this drain (processor option of the
   * same name). The coordinator uses it to stop prose commits while the
   * project is `diverged`.
   */
  pausedKinds?(projectId: string): Promise<readonly string[]>;
}

export interface DrainRunner {
  /**
   * Drain the project's outbox and run the Phase 4 post-drain hook. Calls for
   * the same project are serialized: overlapping callers share the queue, they
   * never drain concurrently.
   */
  drain(projectId: string): Promise<DrainResult>;
  writer: BookRepoWriter;
  processor: Processor;
}

export function createDrainRunner(options: DrainRunnerOptions): DrainRunner {
  const clock = options.clock ?? { now: (): Date => new Date() };
  const processor = createProcessor({
    db: options.db,
    writer: options.writer,
    clock,
    submissionApplier: createSubmissionApplier({ db: options.db, writer: options.writer, clock }),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.pausedKinds !== undefined ? { pausedKinds: options.pausedKinds } : {}),
  });

  // Per-project drain chain: each new drain waits for the previous one,
  // whether it succeeded or failed (single-drainer invariant).
  const chains = new Map<string, Promise<unknown>>();
  const drain = (projectId: string): Promise<DrainResult> => {
    const previous = chains.get(projectId) ?? Promise.resolve();
    const run = async (): Promise<DrainResult> => {
      const result = await processor.drain(projectId);
      // Phase 4 post-drain hook: §10.3 re-anchoring of the applied chapter's
      // other annotations plus conflict problem/event recording, inside the
      // same serialized chain.
      await finalizeSubmissionOutcomes(
        { db: options.db, writer: options.writer, clock },
        projectId,
        result.outcomes,
      );
      return result;
    };
    const next = previous.then(run, run);
    chains.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  };

  return { drain, writer: options.writer, processor };
}
