// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRangeHighlights,
  rangeForSelector,
} from "../site/src/islands/range-highlight.js";

afterEach(() => {
  document.body.textContent = "";
});

describe("persisted range highlights", () => {
  it("resolves normalized offsets across inline formatting", () => {
    const block = document.createElement("p");
    block.append("Some ");
    const emphasis = document.createElement("em");
    emphasis.textContent = "emphasized";
    block.append(emphasis, " words");
    document.body.append(block);

    const range = rangeForSelector(block, {
      textPosition: { start: 5, end: 19 },
      textQuote: { exact: "emphasized wor" },
    });

    expect(range?.toString()).toBe("emphasized wor");
  });

  it("fails closed when the persisted quote no longer matches", () => {
    const block = document.createElement("p");
    block.textContent = "The live chapter changed.";
    document.body.append(block);
    expect(
      rangeForSelector(block, {
        textPosition: { start: 4, end: 8 },
        textQuote: { exact: "drift" },
      }),
    ).toBeNull();
  });

  it("unwraps island marks without changing the prose", () => {
    const block = document.createElement("p");
    block.append("The ");
    const mark = document.createElement("mark");
    mark.className = "ab-inline-highlight";
    mark.textContent = "drift";
    block.append(mark, " appeared.");
    document.body.append(block);

    clearRangeHighlights(block);

    expect(block.textContent).toBe("The drift appeared.");
    expect(block.querySelector("mark")).toBeNull();
  });
});
