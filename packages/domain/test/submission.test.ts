import { describe, expect, it } from "vitest";
import { WORK_ITEM_TYPES, type WorkItemType } from "@authorbot/schemas";
import {
  CONTENT_HASH_REGEX,
  LEASE_TOKEN_PREFIX,
  MAX_SUBMISSION_CONTENT_BYTES,
  SUBMISSION_SCHEMA_IDS,
  SUBMISSION_TYPES,
  WORK_ITEM_SUBMISSION_TYPES,
  checkSubmissionBase,
  checkSubmissionTypeMatches,
  contentHashSchema,
  requiredSubmissionType,
  submitWorkCommandSchema,
  type SubmissionType,
} from "../src/index.js";

// Synthetic fixtures only — never real credentials.
const FAKE_LEASE_TOKEN = `${LEASE_TOKEN_PREFIX}${"Zx9-_".repeat(8)}Zx9`;
const UUID_A = "0190f301-7045-7b2d-9d91-95b3c8228b54";
const UUID_B = "0190f305-1111-7b2d-9d91-95b3c8228b54";
const HASH = `sha256:${"ab12".repeat(16)}`;

const VALID = {
  workItemId: UUID_A,
  leaseId: UUID_B,
  leaseToken: FAKE_LEASE_TOKEN,
  type: "range_replacement",
  baseRevision: 4,
  baseContentHash: HASH,
  content: "two compatible histories",
} as const;

describe("submission types and capability mapping (contract sections 1, 4)", () => {
  it("Phase 4 pins exactly the three replacement types", () => {
    expect([...SUBMISSION_TYPES]).toEqual([
      "range_replacement",
      "block_replacement",
      "chapter_replacement",
    ]);
  });

  it("bundle submissionSchema ids follow design section 15.3", () => {
    expect(SUBMISSION_SCHEMA_IDS.range_replacement).toBe(
      "authorbot.submission/range-replacement/v1",
    );
    expect(SUBMISSION_SCHEMA_IDS.block_replacement).toBe(
      "authorbot.submission/block-replacement/v1",
    );
    expect(SUBMISSION_SCHEMA_IDS.chapter_replacement).toBe(
      "authorbot.submission/chapter-replacement/v1",
    );
  });

  // Exhaustive over every work-item type.
  const EXPECTED: Record<WorkItemType, SubmissionType | null> = {
    revise_range: "range_replacement",
    revise_block: "block_replacement",
    revise_chapter: "chapter_replacement",
    resolve_conflict: "chapter_replacement",
    write_chapter: null,
    planning: null,
  };
  for (const workItemType of WORK_ITEM_TYPES) {
    it(`${workItemType} requires ${EXPECTED[workItemType] ?? "no submission (deferred flow)"}`, () => {
      expect(requiredSubmissionType(workItemType)).toBe(EXPECTED[workItemType]);
      expect(WORK_ITEM_SUBMISSION_TYPES[workItemType]).toBe(EXPECTED[workItemType]);
    });
  }

  it("the mapping covers every work-item type and nothing else", () => {
    expect(Object.keys(WORK_ITEM_SUBMISSION_TYPES).sort()).toEqual([...WORK_ITEM_TYPES].sort());
  });
});

describe("checkSubmissionTypeMatches (exhaustive matrix)", () => {
  for (const workItemType of WORK_ITEM_TYPES) {
    for (const submissionType of SUBMISSION_TYPES) {
      const required = WORK_ITEM_SUBMISSION_TYPES[workItemType];
      const expected =
        required === null
          ? "submission-not-supported"
          : required === submissionType
            ? "allowed"
            : "submission-type-mismatch";
      it(`${workItemType} + ${submissionType} -> ${expected}`, () => {
        const decision = checkSubmissionTypeMatches(workItemType, submissionType);
        expect(decision.allowed).toBe(expected === "allowed");
        if (!decision.allowed) {
          expect(decision.reason).toBe(expected);
          expect(decision.message).toContain(workItemType);
        }
      });
    }
  }
});

describe("content hash shape", () => {
  it("accepts sha256: + 64 lowercase hex", () => {
    expect(contentHashSchema.safeParse(HASH).success).toBe(true);
    expect(CONTENT_HASH_REGEX.test(HASH)).toBe(true);
  });

  it("rejects wrong algorithm, case, and length", () => {
    for (const bad of [
      `sha1:${"ab12".repeat(16)}`,
      `sha256:${"AB12".repeat(16)}`,
      `sha256:${"ab12".repeat(16)}00`,
      `sha256:${"ab12".repeat(15)}ab1`,
      "ab12".repeat(16),
      "sha256:",
    ]) {
      expect(contentHashSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("submitWorkCommandSchema (contract section 4 body)", () => {
  it("accepts a valid range replacement", () => {
    const parsed = submitWorkCommandSchema.parse(VALID);
    expect(parsed.type).toBe("range_replacement");
    expect(parsed.content).toBe("two compatible histories");
    expect(parsed.summary).toBeUndefined();
  });

  it("accepts block and chapter replacements with content", () => {
    for (const type of ["block_replacement", "chapter_replacement"] as const) {
      expect(submitWorkCommandSchema.safeParse({ ...VALID, type }).success).toBe(true);
    }
  });

  it("accepts optional summary and notes (normalized like annotation bodies)", () => {
    const parsed = submitWorkCommandSchema.parse({
      ...VALID,
      summary: "  tightened the phrasing\r\n",
      notes: "read aloud twice",
    });
    expect(parsed.summary).toBe("tightened the phrasing");
    expect(parsed.notes).toBe("read aloud twice");
  });

  it("folds CRLF in content but never trims it", () => {
    const parsed = submitWorkCommandSchema.parse({ ...VALID, content: "  a\r\nb " });
    expect(parsed.content).toBe("  a\nb ");
  });

  it("allows empty content only for range_replacement (a deletion)", () => {
    expect(submitWorkCommandSchema.safeParse({ ...VALID, content: "" }).success).toBe(true);
    for (const type of ["block_replacement", "chapter_replacement"] as const) {
      const result = submitWorkCommandSchema.safeParse({ ...VALID, type, content: "" });
      expect(result.success).toBe(false);
    }
  });

  it("enforces the 512 KiB content cap in UTF-8 bytes", () => {
    const atCap = "a".repeat(MAX_SUBMISSION_CONTENT_BYTES);
    expect(submitWorkCommandSchema.safeParse({ ...VALID, content: atCap }).success).toBe(true);
    expect(submitWorkCommandSchema.safeParse({ ...VALID, content: `${atCap}a` }).success).toBe(
      false,
    );
    // Multi-byte: é is 2 UTF-8 bytes, so half-a-cap-plus-one of them overflows.
    const multiByte = "é".repeat(MAX_SUBMISSION_CONTENT_BYTES / 2 + 1);
    expect(submitWorkCommandSchema.safeParse({ ...VALID, content: multiByte }).success).toBe(false);
  });

  it("rejects unknown submission types (write_chapter flows are deferred)", () => {
    expect(submitWorkCommandSchema.safeParse({ ...VALID, type: "write_chapter" }).success).toBe(
      false,
    );
  });

  it("rejects a malformed lease token, ids, revision, and hash", () => {
    expect(
      submitWorkCommandSchema.safeParse({ ...VALID, leaseToken: "authorbot_lease_short" }).success,
    ).toBe(false);
    expect(submitWorkCommandSchema.safeParse({ ...VALID, workItemId: "not-a-uuid" }).success).toBe(
      false,
    );
    expect(submitWorkCommandSchema.safeParse({ ...VALID, leaseId: "not-a-uuid" }).success).toBe(
      false,
    );
    for (const baseRevision of [0, -1, 1.5]) {
      expect(submitWorkCommandSchema.safeParse({ ...VALID, baseRevision }).success).toBe(false);
    }
    expect(
      submitWorkCommandSchema.safeParse({ ...VALID, baseContentHash: "sha256:xyz" }).success,
    ).toBe(false);
  });

  it("rejects missing required fields and unknown keys (strict)", () => {
    for (const key of [
      "workItemId",
      "leaseId",
      "leaseToken",
      "type",
      "baseRevision",
      "baseContentHash",
      "content",
    ] as const) {
      const { [key]: _omitted, ...rest } = VALID;
      expect(submitWorkCommandSchema.safeParse(rest).success).toBe(false);
    }
    expect(
      submitWorkCommandSchema.safeParse({ ...VALID, idempotencyKey: "k" }).success,
    ).toBe(false);
  });
});

describe("checkSubmissionBase (base must match the lease's bundle)", () => {
  const bundle = { baseRevision: 4, baseContentHash: HASH };

  it("allows an exact match", () => {
    expect(checkSubmissionBase(bundle, { baseRevision: 4, baseContentHash: HASH })).toEqual({
      allowed: true,
    });
  });

  it("denies a revision mismatch (checked before the hash)", () => {
    const other = `sha256:${"ff00".repeat(16)}`;
    expect(
      checkSubmissionBase(bundle, { baseRevision: 5, baseContentHash: other }),
    ).toMatchObject({ allowed: false, reason: "base-revision-mismatch" });
  });

  it("denies a hash mismatch at the right revision", () => {
    expect(
      checkSubmissionBase(bundle, {
        baseRevision: 4,
        baseContentHash: `sha256:${"ff00".repeat(16)}`,
      }),
    ).toMatchObject({ allowed: false, reason: "base-hash-mismatch" });
  });
});
