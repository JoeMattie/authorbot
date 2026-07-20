import { describe, expect, it } from "vitest";
import { resolveTarget, type RangeTarget } from "../src/index.js";

const ID_A = "01900000-0000-7000-8000-00000000000a";
const ID_B = "01900000-0000-7000-8000-00000000000b";
const ID_C = "01900000-0000-7000-8000-00000000000c";
const ID_UNKNOWN = "01900000-0000-7000-8000-0000000000ff";

function marker(id: string): string {
  return `<!-- authorbot:block id="${id}" -->`;
}

function doc(blocks: [string, string][]): string {
  const body = blocks.map(([id, text]) => `${marker(id)}\n${text}`).join("\n\n");
  return `---\nschema: authorbot.chapter/v1\n---\n\n${body}\n`;
}

function target(
  blockId: string,
  quote: { exact: string; prefix?: string; suffix?: string },
  position?: { start: number; end: number },
): RangeTarget {
  return {
    blockId,
    ...(position !== undefined ? { textPosition: position } : {}),
    textQuote: quote,
  };
}

describe("resolveTarget", () => {
  const source = doc([
    [ID_A, "The drift appeared on a Tuesday, in the fourth decimal place."],
    [ID_B, "Mara logged every suspicion with a timestamp."],
    [ID_C, "Nothing respectable ever looks there."],
  ]);

  it("step 2: stored position verified against exact quote -> exact", () => {
    const norm = "The drift appeared on a Tuesday, in the fourth decimal place.";
    const start = norm.indexOf("fourth");
    const result = resolveTarget(
      source,
      target(ID_A, { exact: "fourth" }, { start, end: start + 6 }),
    );
    expect(result).toEqual({
      kind: "exact",
      span: { blockId: ID_A, start, end: start + 6 },
    });
  });

  it("step 3: stale position but unique quote in block -> relocated", () => {
    const result = resolveTarget(
      source,
      target(ID_A, { exact: "fourth" }, { start: 0, end: 6 }),
    );
    expect(result.kind).toBe("relocated");
    expect(result.span?.blockId).toBe(ID_A);
    const norm = "The drift appeared on a Tuesday, in the fourth decimal place.";
    expect(result.span?.start).toBe(norm.indexOf("fourth"));
  });

  it("no position at all still resolves as relocated via quote", () => {
    const result = resolveTarget(source, target(ID_B, { exact: "timestamp" }));
    expect(result.kind).toBe("relocated");
    expect(result.span?.blockId).toBe(ID_B);
  });

  it("step 4: quote moved to another block -> relocated chapter-wide", () => {
    const result = resolveTarget(source, target(ID_A, { exact: "suspicion" }));
    expect(result.kind).toBe("relocated");
    expect(result.span?.blockId).toBe(ID_B);
  });

  it("unknown blockId falls through to chapter-wide search", () => {
    const result = resolveTarget(source, target(ID_UNKNOWN, { exact: "respectable" }));
    expect(result.kind).toBe("relocated");
    expect(result.span?.blockId).toBe(ID_C);
  });

  it("repeated phrase without disambiguating context -> ambiguous", () => {
    const repeated = doc([[ID_A, "the drift and the drift and the drift"]]);
    const result = resolveTarget(repeated, target(ID_A, { exact: "the drift" }));
    expect(result).toEqual({ kind: "ambiguous" });
  });

  it("repeated phrase disambiguated by prefix and suffix -> relocated", () => {
    const repeated = doc([[ID_A, "alpha the drift beta the drift gamma"]]);
    const result = resolveTarget(
      repeated,
      target(ID_A, { exact: "the drift", prefix: "beta ", suffix: " gamma" }),
    );
    expect(result.kind).toBe("relocated");
    expect(result.span?.start).toBe("alpha the drift beta ".length);
  });

  it("repeated phrase across blocks disambiguated chapter-wide", () => {
    const repeated = doc([
      [ID_A, "before the drift after"],
      [ID_B, "left the drift right"],
    ]);
    const result = resolveTarget(
      repeated,
      target(ID_UNKNOWN, { exact: "the drift", prefix: "left ", suffix: " right" }),
    );
    expect(result.kind).toBe("relocated");
    expect(result.span?.blockId).toBe(ID_B);
  });

  it("absent quote -> missing (never fuzzy)", () => {
    const result = resolveTarget(source, target(ID_A, { exact: "wormhole" }));
    expect(result).toEqual({ kind: "missing" });
  });

  it("empty exact quote -> missing", () => {
    const result = resolveTarget(source, target(ID_A, { exact: "" }));
    expect(result).toEqual({ kind: "missing" });
  });

  it("quote at block start with edge-truncated prefix context", () => {
    const repeated = doc([[ID_A, "drift alpha drift beta"]]);
    const result = resolveTarget(
      repeated,
      target(ID_A, { exact: "drift", prefix: "", suffix: " alpha" }),
    );
    expect(result.kind).toBe("relocated");
    expect(result.span?.start).toBe(0);
  });

  it("quote at block end with edge-truncated suffix context", () => {
    const repeated = doc([[ID_A, "alpha drift beta drift"]]);
    const result = resolveTarget(
      repeated,
      target(ID_A, { exact: "drift", prefix: "beta ", suffix: "" }),
    );
    expect(result.kind).toBe("relocated");
    expect(result.span?.start).toBe("alpha drift beta ".length);
  });

  it("NFC-normalizes the quote before matching", () => {
    const unicodeDoc = doc([[ID_A, "Café opens at dawn."]]);
    // Selector arrives NFD; document text is NFC.
    const result = resolveTarget(unicodeDoc, target(ID_A, { exact: "Café" }));
    expect(result.kind).toBe("relocated");
    expect(result.span).toEqual({ blockId: ID_A, start: 0, end: 4 });
  });

  it("position is measured on the normalized stream, not raw source", () => {
    const spaced = doc([[ID_A, "The   drift\nappeared."]]);
    // Normalized: "The drift appeared."
    const result = resolveTarget(
      spaced,
      target(ID_A, { exact: "drift" }, { start: 4, end: 9 }),
    );
    expect(result).toEqual({ kind: "exact", span: { blockId: ID_A, start: 4, end: 9 } });
  });
});

/**
 * Stored context is VERIFICATION, not just a tiebreaker among several exact
 * matches (design §10.2: never attach to a merely similar sentence). Each
 * case below silently rewrote text outside the declared target before the
 * context checks were applied on every acceptance path.
 */
describe("resolveTarget context verification (design §10.2, contract §5/§8.5)", () => {
  const BLOCK_TEXT = "AAAAAAAAAA the door BBBBBBBBBBBBBBBBBBBBB the door CCCC";

  it("step 2: a different occurrence drifting onto the stored offsets is not `exact`", () => {
    // The target is the SECOND "the door" at offsets 42..50, stored with its
    // surrounding context. A concurrent insertion at the head of the block
    // slides the FIRST occurrence into exactly offsets 42..50.
    const original = doc([[ID_A, BLOCK_TEXT]]);
    expect(BLOCK_TEXT.indexOf("the door", 20)).toBe(42);
    expect(BLOCK_TEXT.indexOf("the door")).toBe(11);
    const shift = 42 - 11; // characters inserted ahead of the first occurrence
    const stored = target(
      ID_A,
      {
        exact: "the door",
        prefix: "AAAAAAAAAA the door BBBBBBBBBBBBBBBBBBBBB ",
        suffix: " CCCC",
      },
      { start: 42, end: 50 },
    );
    expect(resolveTarget(original, stored)).toEqual({
      kind: "exact",
      span: { blockId: ID_A, start: 42, end: 50 },
    });

    const shifted = doc([[ID_A, `${"X".repeat(shift - 1)} ${BLOCK_TEXT}`]]);
    // The wrong occurrence now sits exactly on the stored offsets.
    const shiftedText = `${"X".repeat(shift - 1)} ${BLOCK_TEXT}`;
    expect(shiftedText.slice(42, 50)).toBe("the door");
    expect(shiftedText.indexOf("the door")).toBe(42);
    const result = resolveTarget(shifted, stored);
    // The quote alone matches at 42, but the stored prefix does not — that is
    // the first occurrence wearing the target's offsets, not the target.
    if (result.kind === "exact") {
      throw new Error("resolved `exact` onto an occurrence the stored context refutes");
    }
    // It must land on the real target (now further along) or refuse entirely,
    // never on the wrong sentence.
    if (result.span !== undefined) {
      expect(shifted).toContain(BLOCK_TEXT);
      expect(result.span.start).toBeGreaterThan(50);
    }
  });

  it("a lone candidate whose context disagrees is not accepted", () => {
    // The target block is gone and the quote survives exactly once elsewhere —
    // but in prose bearing no resemblance to the stored surroundings.
    const source = doc([
      [ID_B, "A totally unrelated paragraph mentioning the door once."],
    ]);
    const result = resolveTarget(
      source,
      target(ID_A, {
        exact: "the door",
        prefix: "She hesitated at ",
        suffix: " of the observatory.",
      }),
    );
    expect(result.kind).toBe("missing");
    expect(result.span).toBeUndefined();
  });

  it("a lone candidate whose context AGREES still relocates (§10.2 step 4)", () => {
    // Cross-block relocation remains by design; only unverified relocation is
    // refused. Same quote, same surroundings, different block.
    const source = doc([
      [ID_B, "She hesitated at the door of the observatory."],
    ]);
    const result = resolveTarget(
      source,
      target(ID_A, {
        exact: "the door",
        prefix: "She hesitated at ",
        suffix: " of the observatory.",
      }),
    );
    expect(result).toEqual({
      kind: "relocated",
      span: { blockId: ID_B, start: 17, end: 25 },
    });
  });

  it("a selector with no stored context falls back to uniqueness alone", () => {
    const source = doc([[ID_A, "The drift appeared on a Tuesday."]]);
    expect(resolveTarget(source, target(ID_A, { exact: "drift appeared" }))).toEqual({
      kind: "relocated",
      span: { blockId: ID_A, start: 4, end: 18 },
    });
    const twice = doc([[ID_A, "drift appeared and drift appeared"]]);
    expect(resolveTarget(twice, target(ID_A, { exact: "drift appeared" })).kind).toBe("ambiguous");
  });
});
