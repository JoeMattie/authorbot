import { describe, expect, it } from "vitest";
import {
  applyBlockReplacement,
  applyChapterReplacement,
  applyRangeReplacement,
  buildBlockCharMap,
  generateUuidv7,
  isUuidv7,
  listMarkedBlocks,
  normalizeBlockText,
  parseChapterMarkdown,
  PatchError,
  resolveTarget,
  type RangeTarget,
} from "../src/index.js";

/**
 * Property tests (Phase 4 contract §5, exit criterion 5) with hand-rolled
 * seeded generators: replacements never alter text outside the declared
 * span, markers stay stable, and every produced document parse-validates.
 * Failures print the seed for replay.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const WORDS = [
  "drift",
  "signal",
  "mara",
  "voss",
  "calibration",
  "café",
  "naïve",
  "θ",
  "quiet",
  "résumé",
  "folder",
  "night",
  "pump",
  "residual",
  "anomaly",
  "😀",
  "seventy",
  "minutes",
];

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[int(rng, 0, items.length - 1)];
  if (item === undefined) {
    throw new Error("empty pick");
  }
  return item;
}

function words(rng: Rng, min: number, max: number): string {
  const n = int(rng, min, max);
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(pick(rng, WORDS));
  }
  return out.join(" ");
}

function genBlockContent(rng: Rng): string {
  const roll = rng();
  if (roll < 0.15) {
    return `## ${words(rng, 2, 4)}`;
  }
  if (roll < 0.3) {
    return `\`\`\`js\n${words(rng, 2, 5)}\n${words(rng, 1, 4)}\n\`\`\``;
  }
  // Paragraph, sometimes with inline markup.
  const parts: string[] = [words(rng, 3, 8)];
  if (rng() < 0.3) {
    parts.push(`*${pick(rng, WORDS)}*`);
    parts.push(words(rng, 1, 4));
  }
  if (rng() < 0.2) {
    parts.push(`\`${pick(rng, WORDS)}\``);
    parts.push(words(rng, 1, 3));
  }
  return parts.join(" ");
}

function genDoc(rng: Rng): { source: string; ids: string[] } {
  const n = int(rng, 2, 6);
  const ids: string[] = [];
  const blocks: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = generateUuidv7();
    ids.push(id);
    blocks.push(`<!-- authorbot:block id="${id}" -->\n${genBlockContent(rng)}`);
  }
  const source = `---\nschema: authorbot.chapter/v1\nrevision: 1\n---\n\n${blocks.join("\n\n")}\n`;
  return { source, ids };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** A random selector for an existing block, snapped to code-point bounds. */
function genTarget(rng: Rng, source: string): RangeTarget | undefined {
  const blocks = listMarkedBlocks(source);
  if (blocks.length === 0) {
    return undefined;
  }
  const block = pick(rng, blocks);
  const norm = normalizeBlockText(block.node).text;
  if (norm.length === 0) {
    return undefined;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let start = int(rng, 0, norm.length - 1);
    let end = Math.min(norm.length, start + int(rng, 1, 15));
    while (start > 0 && isLowSurrogate(norm.charCodeAt(start))) {
      start -= 1;
    }
    while (end < norm.length && isLowSurrogate(norm.charCodeAt(end))) {
      end += 1;
    }
    const exact = norm.slice(start, end);
    if (exact.trim() === "") {
      continue;
    }
    return {
      blockId: block.id,
      textPosition: { start, end },
      textQuote: {
        exact,
        prefix: norm.slice(Math.max(0, start - 32), start),
        suffix: norm.slice(end, end + 32),
      },
    };
  }
  return undefined;
}

function collapse(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

function assertDocValid(source: string, seed: number): void {
  const parsed = parseChapterMarkdown(source);
  expect(parsed.blocks.malformed, `seed ${seed}: malformed markers`).toEqual([]);
  expect(parsed.blocks.unmarked, `seed ${seed}: unmarked blocks`).toEqual([]);
  const ids = parsed.blocks.markers.map((m) => m.id);
  expect(new Set(ids).size, `seed ${seed}: duplicate ids`).toBe(ids.length);
}

const RUNS = 120;

/**
 * Property tests loop `RUNS` generated documents through parse → patch →
 * re-parse, so they are legitimately far slower than a unit test. Vitest's 5s
 * default is sized for the latter, and these were passing locally at ~4.9s
 * while timing out on a slower CI runner - green on the machine that wrote
 * them, red on the machine that gates the release.
 *
 * The generous ceiling keeps that from recurring without weakening the test:
 * a genuine infinite loop still fails, just later.
 */
const PROPERTY_TIMEOUT_MS = 60_000;

describe("property: char map matches normalizeBlockText", () => {
  it("produces the identical normalized stream for random documents", () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = mulberry32(seed);
      const { source } = genDoc(rng);
      for (const block of listMarkedBlocks(source)) {
        const map = buildBlockCharMap(source, block.node);
        const norm = normalizeBlockText(block.node).text;
        expect(map.text, `seed ${seed}`).toBe(norm);
        expect(map.units.length, `seed ${seed}`).toBe(norm.length);
      }
    }
  }, PROPERTY_TIMEOUT_MS);
});

describe("property: range replacement", () => {
  it("never alters anything outside the declared span; markers stable; round-trips", () => {
    let successes = 0;
    for (let seed = 1; seed <= RUNS * 2; seed += 1) {
      const rng = mulberry32(seed);
      const { source } = genDoc(rng);
      const target = genTarget(rng, source);
      if (target === undefined) {
        continue;
      }

      // Generated selectors must resolve exactly or be honestly ambiguous
      // (repeated phrases with identical context) - never missing.
      const resolvedKind = resolveTarget(source, target).kind;
      expect(resolvedKind === "exact" || resolvedKind === "ambiguous", `seed ${seed}`).toBe(true);

      const replacement = rng() < 0.15 ? "" : words(rng, 1, 4);
      let result;
      try {
        result = applyRangeReplacement(source, target, replacement);
      } catch (error) {
        if (error instanceof PatchError) {
          // Conservative refusals only - never a wrong edit.
          expect(
            ["not_contiguous", "target_ambiguous", "validation_failed"],
            `seed ${seed}: unexpected code ${error.code}`,
          ).toContain(error.code);
          continue;
        }
        throw error;
      }
      successes += 1;

      // 1. Source bytes outside the span are untouched.
      const ss = result.sourceSpan;
      const removedLength =
        source.length - (result.source.length - (ss.end - ss.start));
      expect(result.source.slice(0, ss.start), `seed ${seed}`).toBe(source.slice(0, ss.start));
      expect(result.source.slice(ss.start, ss.end), `seed ${seed}`).toBe(replacement);
      expect(result.source.slice(ss.end), `seed ${seed}`).toBe(
        source.slice(ss.start + removedLength),
      );

      // 2. Marker id sequence is unchanged.
      expect(
        parseChapterMarkdown(result.source).blocks.markers.map((m) => m.id),
        `seed ${seed}`,
      ).toEqual(parseChapterMarkdown(source).blocks.markers.map((m) => m.id));

      // 3. Parse-validate round trip.
      assertDocValid(result.source, seed);

      // 4. The new block's normalized text is exactly prefix+replacement+suffix.
      const span = target.textPosition;
      if (span !== undefined && result.resolution === "exact") {
        const oldBlock = listMarkedBlocks(source).find((b) => b.id === target.blockId);
        const newBlock = listMarkedBlocks(result.source).find((b) => b.id === target.blockId);
        expect(oldBlock, `seed ${seed}`).toBeDefined();
        expect(newBlock, `seed ${seed}`).toBeDefined();
        const oldNorm = normalizeBlockText(oldBlock!.node).text;
        const newNorm = normalizeBlockText(newBlock!.node).text;
        expect(newNorm, `seed ${seed}`).toBe(
          collapse(oldNorm.slice(0, span.start) + replacement + oldNorm.slice(span.end)),
        );
        // 5. The returned span points at the normalized replacement.
        expect(newNorm.slice(result.span.start, result.span.end), `seed ${seed}`).toBe(
          collapse(replacement),
        );
      }
    }
    // The generator must exercise the success path meaningfully.
    expect(successes).toBeGreaterThan(RUNS / 2);
  }, PROPERTY_TIMEOUT_MS);

  it("keeps selectors in untouched blocks resolvable after an edit elsewhere", () => {
    let checked = 0;
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = mulberry32(seed + 7_000_000);
      const { source } = genDoc(rng);
      const blocks = listMarkedBlocks(source);
      if (blocks.length < 2) {
        continue;
      }
      const target = genTarget(rng, source);
      const bystander = genTarget(rng, source);
      if (
        target === undefined ||
        bystander === undefined ||
        bystander.blockId === target.blockId ||
        resolveTarget(source, bystander).kind !== "exact"
      ) {
        continue;
      }
      let result;
      try {
        result = applyRangeReplacement(source, target, words(rng, 1, 3));
      } catch (error) {
        if (error instanceof PatchError) {
          continue;
        }
        throw error;
      }
      // The bystander's block is untouched: still exact at the same offsets.
      const after = resolveTarget(result.source, bystander);
      expect(after.kind, `seed ${seed}`).toBe("exact");
      expect(after.span, `seed ${seed}`).toEqual({
        blockId: bystander.blockId,
        start: bystander.textPosition?.start,
        end: bystander.textPosition?.end,
      });
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  }, PROPERTY_TIMEOUT_MS);
});

describe("property: block replacement", () => {
  it("preserves the marker and all bytes outside the block; fresh ids are valid", () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = mulberry32(seed + 1_000_000);
      const { source, ids } = genDoc(rng);
      const targetId = pick(rng, ids);
      const marked = listMarkedBlocks(source).find((b) => b.id === targetId);
      expect(marked, `seed ${seed}`).toBeDefined();
      const blockStart = marked!.blockPosition.start.offset ?? 0;
      const blockEnd = marked!.blockPosition.end.offset ?? 0;

      const parts: string[] = [];
      const extra = int(rng, 0, 2);
      for (let i = 0; i <= extra; i += 1) {
        parts.push(words(rng, 2, 7) + ".");
      }
      const result = applyBlockReplacement(source, targetId, parts.join("\n\n"));

      expect(result.blockIds[0], `seed ${seed}`).toBe(targetId);
      expect(result.blockIds.length, `seed ${seed}`).toBe(extra + 1);
      for (const id of result.blockIds.slice(1)) {
        expect(isUuidv7(id), `seed ${seed}`).toBe(true);
        expect(ids.includes(id), `seed ${seed}`).toBe(false);
      }
      expect(new Set(result.blockIds).size, `seed ${seed}`).toBe(result.blockIds.length);

      // Bytes outside the replaced block region are untouched.
      expect(result.source.startsWith(source.slice(0, blockStart)), `seed ${seed}`).toBe(true);
      expect(result.source.endsWith(source.slice(blockEnd)), `seed ${seed}`).toBe(true);

      assertDocValid(result.source, seed);
    }
  }, PROPERTY_TIMEOUT_MS);
});

describe("property: chapter replacement", () => {
  it("reuses ids exactly for byte-identical blocks and validates round-trip", () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = mulberry32(seed + 2_000_000);
      const { source } = genDoc(rng);
      const oldBlocks = listMarkedBlocks(source).map((b) => ({
        id: b.id,
        content: source.slice(
          b.blockPosition.start.offset ?? 0,
          b.blockPosition.end.offset ?? 0,
        ),
      }));

      // Shuffle, keep some byte-identical, rewrite the rest, sometimes drop.
      const shuffled = [...oldBlocks].sort(() => rng() - 0.5);
      const plans: { content: string; expectId: string | undefined }[] = [];
      const consumed = new Set<string>();
      for (const b of shuffled) {
        const roll = rng();
        if (roll < 0.2) {
          continue; // dropped
        }
        if (roll < 0.7 && !consumed.has(b.id)) {
          // Kept byte-identical: unless an identical twin appears earlier,
          // the id must be reused. Skip contents duplicated in the doc to
          // keep the expectation exact.
          const twins = oldBlocks.filter((o) => o.content === b.content);
          if (twins.length === 1) {
            plans.push({ content: b.content, expectId: b.id });
            consumed.add(b.id);
            continue;
          }
        }
        plans.push({ content: `${words(rng, 3, 8)}.`, expectId: undefined });
      }
      if (plans.length === 0) {
        plans.push({ content: `${words(rng, 3, 6)}.`, expectId: undefined });
      }

      const result = applyChapterReplacement(source, plans.map((p) => p.content).join("\n\n"));

      expect(result.blocks.length, `seed ${seed}`).toBe(plans.length);
      for (let i = 0; i < plans.length; i += 1) {
        const plan = plans[i];
        const got = result.blocks[i];
        expect(got, `seed ${seed}`).toBeDefined();
        if (plan?.expectId !== undefined) {
          expect(got, `seed ${seed} block ${i}`).toEqual({ id: plan.expectId, reused: true });
        } else {
          expect(got?.reused, `seed ${seed} block ${i}`).toBe(false);
          expect(isUuidv7(got?.id ?? ""), `seed ${seed} block ${i}`).toBe(true);
          expect(oldBlocks.some((o) => o.id === got?.id), `seed ${seed} block ${i}`).toBe(false);
        }
      }

      // Frontmatter byte-preserved; document round-trips valid.
      expect(
        result.source.startsWith("---\nschema: authorbot.chapter/v1\nrevision: 1\n---\n"),
        `seed ${seed}`,
      ).toBe(true);
      assertDocValid(result.source, seed);

      // A selector into a kept byte-identical block still resolves exactly.
      const keptIndex = plans.findIndex((p) => p.expectId !== undefined);
      const kept = plans[keptIndex];
      if (kept?.expectId !== undefined) {
        const newBlock = listMarkedBlocks(result.source).find((b) => b.id === kept.expectId);
        expect(newBlock, `seed ${seed}`).toBeDefined();
        const norm = normalizeBlockText(newBlock!.node).text;
        if (norm.length > 0) {
          const end = Math.min(norm.length, 5);
          const exact = norm.slice(0, end);
          if (exact.trim() !== "" && !isLowSurrogate(norm.charCodeAt(end))) {
            const after = resolveTarget(result.source, {
              blockId: kept.expectId,
              textPosition: { start: 0, end },
              textQuote: { exact, suffix: norm.slice(end, end + 32) },
            });
            expect(["exact", "relocated", "ambiguous"], `seed ${seed}`).toContain(after.kind);
            if (after.kind === "exact") {
              expect(after.span?.blockId, `seed ${seed}`).toBe(kept.expectId);
            }
          }
        }
      }
    }
  }, PROPERTY_TIMEOUT_MS);
});
