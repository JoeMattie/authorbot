import { describe, expect, it } from "vitest";
import { stackCards } from "../site/src/islands/anchor.js";

/** Gutter collision stacking (Phase 2b contract §2.1). */
describe("stackCards", () => {
  it("keeps non-colliding cards at their desired tops", () => {
    const tops = stackCards([
      { id: "a", desiredTop: 0, height: 50 },
      { id: "b", desiredTop: 200, height: 50 },
    ]);
    expect(tops.get("a")).toBe(0);
    expect(tops.get("b")).toBe(200);
  });

  it("pushes colliding cards below their predecessor plus the gap", () => {
    const tops = stackCards(
      [
        { id: "a", desiredTop: 100, height: 80 },
        { id: "b", desiredTop: 120, height: 40 },
        { id: "c", desiredTop: 130, height: 40 },
      ],
      12,
    );
    expect(tops.get("a")).toBe(100);
    expect(tops.get("b")).toBe(100 + 80 + 12);
    expect(tops.get("c")).toBe(192 + 40 + 12);
  });

  it("orders by desired top regardless of input order, ties by id", () => {
    const tops = stackCards(
      [
        { id: "later", desiredTop: 300, height: 10 },
        { id: "b", desiredTop: 50, height: 30 },
        { id: "a", desiredTop: 50, height: 30 },
      ],
      10,
    );
    expect(tops.get("a")).toBe(50);
    expect(tops.get("b")).toBe(90);
    expect(tops.get("later")).toBe(300);
  });

  it("never overlaps for any assignment", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: `card-${String(i).padStart(2, "0")}`,
      desiredTop: (i * 7) % 40,
      height: 25 + (i % 3) * 10,
    }));
    const tops = stackCards(items, 8);
    const placed = items
      .map((item) => ({ top: tops.get(item.id) as number, height: item.height }))
      .sort((a, b) => a.top - b.top);
    for (let i = 1; i < placed.length; i += 1) {
      const prev = placed[i - 1] as { top: number; height: number };
      const current = placed[i] as { top: number; height: number };
      expect(current.top).toBeGreaterThanOrEqual(prev.top + prev.height + 8);
    }
  });

  it("handles the empty gutter", () => {
    expect(stackCards([]).size).toBe(0);
  });
});
