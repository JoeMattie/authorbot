/**
 * Gutter anchoring math (Phase 2b contract §2.1): cards align beside their
 * anchor block and stack downward on collision. Pure so the math is unit
 * tested without a layout engine.
 */

export interface StackItem {
  /** Stable identity (annotation id). */
  id: string;
  /** Ideal top: the anchor block's offset within the gutter. */
  desiredTop: number;
  /** Measured card height. */
  height: number;
}

/**
 * Assign each card a top ≥ its desired top such that cards never overlap,
 * preserving desired order (ties broken by id for determinism). Returns
 * assigned tops keyed by id.
 */
export function stackCards(items: readonly StackItem[], gap = 12): Map<string, number> {
  const sorted = [...items].sort(
    (a, b) => a.desiredTop - b.desiredTop || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const assigned = new Map<string, number>();
  let cursor = Number.NEGATIVE_INFINITY;
  for (const item of sorted) {
    const top = Math.max(item.desiredTop, cursor);
    assigned.set(item.id, top);
    cursor = top + item.height + gap;
  }
  return assigned;
}
