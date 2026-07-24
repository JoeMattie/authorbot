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
 * Assign each card a top such that cards never overlap, preserving desired
 * order (ties broken by id for determinism). Without a viewport limit, cards
 * only move downward from their desired tops. When `availableHeight` is
 * provided, the stack may move upward to stay inside that viewport whenever
 * its actual card heights fit; anchoring whitespace never creates overflow.
 * Returns assigned tops keyed by id.
 */
export function stackCards(
  items: readonly StackItem[],
  gap = 12,
  availableHeight?: number,
  pinnedId?: string | null,
): Map<string, number> {
  const sorted = [...items].sort(
    (a, b) => a.desiredTop - b.desiredTop || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const assigned = new Map<string, number>();
  if (sorted.length === 0) return assigned;

  const heightLimit =
    availableHeight !== undefined &&
    Number.isFinite(availableHeight) &&
    availableHeight > 0
      ? availableHeight
      : null;
  const stackHeight =
    sorted.reduce((total, item) => total + item.height, 0) +
    gap * Math.max(0, sorted.length - 1);

  // If the cards themselves cannot fit, pack them from the top. The rail may
  // scroll, but only for real content rather than a distant anchor's blank
  // chapter-space offset.
  if (heightLimit !== null && stackHeight > heightLimit) {
    if (sorted.length === 1 && sorted[0]?.id === pinnedId) {
      const item = sorted[0] as StackItem;
      assigned.set(item.id, heightLimit - item.height);
      return assigned;
    }
    let top = 0;
    for (const item of sorted) {
      assigned.set(item.id, top);
      top += item.height + gap;
    }
    return assigned;
  }

  let cursor = Number.NEGATIVE_INFINITY;
  for (const item of sorted) {
    const desiredTop = heightLimit !== null
      ? Math.min(
          Math.max(0, item.desiredTop),
          Math.max(0, heightLimit - item.height),
        )
      : item.desiredTop;
    const top = Math.max(desiredTop, cursor);
    assigned.set(item.id, top);
    cursor = top + item.height + gap;
  }

  // A collision near the bottom can push later cards past the viewport even
  // though the complete stack fits. Walk backward just enough to keep the
  // group visible while preserving order and gaps.
  if (heightLimit !== null && cursor - gap > heightLimit) {
    let nextTop = heightLimit;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const item = sorted[index] as StackItem;
      const top = Math.min(assigned.get(item.id) as number, nextTop - item.height);
      assigned.set(item.id, top);
      nextTop = top - gap;
    }
  }
  return assigned;
}
