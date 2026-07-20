/**
 * Per-project serial command queue shared by the Phase 3 and Phase 4 command
 * handlers (Phase 3 contract §3 "the same serialized command"; Phase 4
 * contract §2 "serialized compare-and-set"). One instance is created by
 * `createApi` so votes/overrides and claims/submissions are mutually
 * serialized — a claim can never interleave with the cancel that races it.
 *
 * Single-process guarantee only; DB unique indexes and NULL-abort
 * compare-and-swap statements are the cross-isolate backstops.
 */
export type ProjectSerializer = <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;

export function createProjectSerializer(): ProjectSerializer {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(projectId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    chains.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };
}
