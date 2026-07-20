// @vitest-environment happy-dom
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_SUBMIT_POLLS,
  RENEWAL_PROMPT_MS,
  STALE_HINT,
  SUBMIT_IDLE,
  blockSource,
  chapterBody,
  claimStorageKey,
  clearClaim,
  formatRemaining,
  leaseStatus,
  loadClaim,
  prefillFor,
  remainingLabel,
  renewalPromptLeadMs,
  saveClaim,
  stripBlockMarkers,
  submissionTypeFor,
  submitPollDelayMs,
  submitReduce,
  toStoredClaim,
  type StoredClaim,
  type SubmitState,
} from "../site/src/islands/work-state.js";
import type { TaskBundle } from "../site/src/islands/api.js";

/**
 * Phase 4 contract §7 unit rules: the lease countdown / T-5m renewal prompt,
 * the honest submit ladder (`submit → syncing → completed | conflict`), the
 * refresh-surviving claim storage, and the target prefill.
 */

const BLOCK_ID = "019cadfe-7360-7049-a30b-1f5898a5020a";
const OTHER_BLOCK = "019cadfe-7360-7049-a30b-1f5898a5020b";

const CHAPTER_SOURCE = [
  "---",
  "id: 019cadfd-8900-7140-98fb-ceff64cada33",
  "title: Baseline",
  "revision: 4",
  "---",
  "",
  `<!-- authorbot:block id="${BLOCK_ID}" -->`,
  "The drift appeared on a Tuesday.",
  "",
  `<!-- authorbot:block id="${OTHER_BLOCK}" -->`,
  "Nobody wrote it down.",
  "",
].join("\n");

const bundle = (over: Partial<TaskBundle> = {}): TaskBundle => ({
  workItem: {
    id: "0190f301-7045-7b2d-9d91-95b3c8228b54",
    type: "revise_range",
    acceptanceCriteria: ["Preserve point of view"],
    priority: "normal",
  },
  lease: {
    id: "0190f305-7045-7b2d-9d91-95b3c8228b55",
    token: "opaque-token",
    expiresAt: "2026-07-19T19:00:00.000Z",
    maxExpiresAt: "2026-07-19T22:00:00.000Z",
  },
  document: {
    chapterId: "019cadfd-8900-7140-98fb-ceff64cada33",
    revision: 4,
    contentHash: `sha256:${"a".repeat(64)}`,
    source: CHAPTER_SOURCE,
  },
  target: { blockId: BLOCK_ID, exact: "appeared on a Tuesday", start: 10, end: 31 },
  context: { annotationBody: "Tighten this.", chapterSummary: "A baseline chapter.", storyRefs: ["character:mara"] },
  submissionSchema: "authorbot.submission/range-replacement/v1",
  ...over,
});

const AT_1830 = Date.parse("2026-07-19T18:30:00.000Z");

describe("lease countdown (contract §2/§7)", () => {
  it("reports remaining time, and prompts only inside the last five minutes", () => {
    const lease = bundle().lease;
    const half = leaseStatus(lease, AT_1830);
    expect(half.remainingMs).toBe(30 * 60_000);
    expect(half.expired).toBe(false);
    expect(half.promptRenewal).toBe(false);
    expect(half.renewable).toBe(true);

    // Exactly at T-5m the prompt is on (inclusive boundary).
    const atPrompt = leaseStatus(lease, Date.parse(lease.expiresAt) - RENEWAL_PROMPT_MS);
    expect(atPrompt.promptRenewal).toBe(true);
    const justBefore = leaseStatus(lease, Date.parse(lease.expiresAt) - RENEWAL_PROMPT_MS - 1);
    expect(justBefore.promptRenewal).toBe(false);
  });

  it("clamps at expiry and stops prompting once expired", () => {
    const lease = bundle().lease;
    const gone = leaseStatus(lease, Date.parse(lease.expiresAt) + 60_000);
    expect(gone.remainingMs).toBe(0);
    expect(gone.expired).toBe(true);
    expect(gone.promptRenewal).toBe(false);
    expect(remainingLabel(gone)).toBe("Lease expired");
  });

  it("marks a lease at its max total duration as not renewable", () => {
    const lease = { ...bundle().lease, maxExpiresAt: "2026-07-19T19:00:00.000Z" };
    expect(leaseStatus(lease, AT_1830).renewable).toBe(false);
  });

  it("formats mm:ss and h:mm:ss", () => {
    expect(formatRemaining(0)).toBe("00:00");
    expect(formatRemaining(65_000)).toBe("01:05");
    expect(formatRemaining(30 * 60_000)).toBe("30:00");
    expect(formatRemaining(3 * 3600_000 + 61_000)).toBe("3:01:01");
    expect(remainingLabel(leaseStatus(bundle().lease, AT_1830))).toBe("Lease expires in 30:00");
  });
});

describe("submit state machine (contract §7)", () => {
  const run = (events: Parameters<typeof submitReduce>[1][]): SubmitState =>
    events.reduce(submitReduce, { ...SUBMIT_IDLE });

  it("walks submit → syncing → completed", () => {
    const state = run([
      { type: "submit" },
      { type: "accepted", operationId: "op-1", submissionId: "sub-1" },
      { type: "poll-pending" },
      { type: "poll-committed" },
    ]);
    expect(state.phase).toBe("completed");
    expect(state.operationId).toBe("op-1");
    expect(state.submissionId).toBe("sub-1");
  });

  it("surfaces a conflict honestly, with the conflict work item", () => {
    const state = run([
      { type: "submit" },
      { type: "accepted", operationId: "op-1", submissionId: "sub-1" },
      { type: "poll-conflict", conflictWorkItemId: "wi-conflict" },
    ]);
    expect(state.phase).toBe("conflict");
    expect(state.conflictWorkItemId).toBe("wi-conflict");
    expect(state.message).toContain("could not be applied");
    expect(state.message).toContain("left untouched");
  });

  it("never invents a cause: with no reason it does not claim the chapter changed", () => {
    // The conflict path also catches payloads the patch engine refused on an
    // UNMOVED base. Asserting someone else's concurrent edit would be a lie.
    const state = run([
      { type: "submit" },
      { type: "accepted", operationId: "op-1", submissionId: "sub-1" },
      { type: "poll-conflict", conflictWorkItemId: null },
    ]);
    expect(state.message).not.toContain("changed underneath");
  });

  it("reports the pipeline's own reason when it is known", () => {
    const state = run([
      { type: "submit" },
      { type: "accepted", operationId: "op-1", submissionId: "sub-1" },
      {
        type: "poll-conflict",
        conflictWorkItemId: "wi-conflict",
        reason: "the chapter moved to revision 7 after the lease's base revision 5",
      },
    ]);
    expect(state.message).toContain("moved to revision 7");
    expect(state.message).toContain("left untouched");
  });

  it("returns to editing after a rejected submission, and can retry", () => {
    const rejected = run([{ type: "submit" }, { type: "rejected", message: "lease has expired" }]);
    expect(rejected.phase).toBe("failed");
    expect(rejected.message).toBe("lease has expired");
    expect(submitReduce(rejected, { type: "submit" }).phase).toBe("submitting");
  });

  it("goes stale after the bounded poll budget instead of spinning forever", () => {
    let state = run([{ type: "submit" }, { type: "accepted", operationId: "op", submissionId: "s" }]);
    for (let i = 0; i < MAX_SUBMIT_POLLS; i += 1) {
      state = submitReduce(state, { type: "poll-pending" });
    }
    expect(state.phase).toBe("stale");
    expect(state.message).toBe(STALE_HINT);
    // Late polls after settling are ignored (no zombie transitions).
    expect(submitReduce(state, { type: "poll-committed" }).phase).toBe("stale");
  });

  it("backs the poll delay off and caps it", () => {
    expect(submitPollDelayMs(0)).toBe(1_000);
    expect(submitPollDelayMs(3)).toBe(3_000);
    expect(submitPollDelayMs(99)).toBe(5_000);
  });
});

describe("claim persistence (refresh survival)", () => {
  const project = "hollow-creek-anomaly";

  it("round-trips a claim through sessionStorage", () => {
    const claim = toStoredClaim(bundle(), "new prose");
    saveClaim(window.sessionStorage, project, claim);
    expect(window.sessionStorage.getItem(claimStorageKey(project))).not.toBeNull();
    const back = loadClaim(window.sessionStorage, project);
    expect(back?.lease.token).toBe("opaque-token");
    expect(back?.draft).toBe("new prose");
    expect(back?.document.revision).toBe(4);
    expect(back?.target?.exact).toBe("appeared on a Tuesday");

    clearClaim(window.sessionStorage, project);
    expect(loadClaim(window.sessionStorage, project)).toBeNull();
  });

  it("rejects malformed or partial stored state rather than half-restoring", () => {
    window.sessionStorage.setItem(claimStorageKey(project), "{not json");
    expect(loadClaim(window.sessionStorage, project)).toBeNull();
    window.sessionStorage.setItem(claimStorageKey(project), JSON.stringify({ workItemId: "w" }));
    expect(loadClaim(window.sessionStorage, project)).toBeNull();
    window.sessionStorage.clear();
  });

  it("never reaches for localStorage (the token must not outlive the tab)", async () => {
    // A source-level invariant: no island module may name localStorage, so a
    // lease token can never be persisted beyond the session.
    // `import.meta.url` is an http URL under happy-dom; vitest runs with the
    // package root as cwd.
    const dir = path.join(process.cwd(), "site/src/islands");
    const files = await readdir(dir);
    for (const file of files.filter((name) => name.endsWith(".ts"))) {
      // Any *use* of it (property access / indexing) — prose in doc comments
      // explaining why it is avoided is fine.
      expect(await readFile(path.join(dir, file), "utf8")).not.toMatch(/localStorage\s*[.[]/);
    }
  });

  it("survives an unavailable storage", () => {
    expect(() => saveClaim(null, project, toStoredClaim(bundle(), ""))).not.toThrow();
    expect(loadClaim(null, project)).toBeNull();
    expect(() => clearClaim(null, project)).not.toThrow();
  });
});

describe("prefill (contract §7 'textarea prefilled with the target')", () => {
  const claimOf = (b: TaskBundle): Pick<StoredClaim, "workItem" | "document" | "target"> => ({
    workItem: b.workItem,
    document: b.document,
    target: b.target ?? null,
  });

  it("prefills a range item with the quoted span", () => {
    expect(prefillFor(claimOf(bundle()))).toBe("appeared on a Tuesday");
  });

  it("prefills a block item with the block's source, without its marker", () => {
    const b = bundle({ workItem: { ...bundle().workItem, type: "revise_block" } });
    const filled = prefillFor(claimOf(b));
    expect(filled).toBe("The drift appeared on a Tuesday.");
    expect(filled).not.toContain("authorbot:block");
  });

  it("prefills a chapter item with the marker-free body only", () => {
    const b = bundle({ workItem: { ...bundle().workItem, type: "revise_chapter" } });
    const filled = prefillFor(claimOf(b));
    expect(filled).toContain("The drift appeared on a Tuesday.");
    expect(filled).toContain("Nobody wrote it down.");
    expect(filled).not.toContain("authorbot:block");
    expect(filled).not.toContain("title: Baseline");
  });

  it("maps work-item types to submission types (contract §4)", () => {
    expect(submissionTypeFor("revise_range")).toBe("range_replacement");
    expect(submissionTypeFor("revise_block")).toBe("block_replacement");
    expect(submissionTypeFor("resolve_conflict")).toBe("chapter_replacement");
    expect(submissionTypeFor("write_chapter")).toBeNull();
    expect(submissionTypeFor("unknown_future_type")).toBeNull();
  });

  it("extracts block source and chapter body precisely", () => {
    expect(blockSource(CHAPTER_SOURCE, OTHER_BLOCK)).toBe("Nobody wrote it down.");
    expect(blockSource(CHAPTER_SOURCE, "missing")).toBeNull();
    expect(chapterBody(CHAPTER_SOURCE)).toContain("authorbot:block");
    expect(stripBlockMarkers(chapterBody(CHAPTER_SOURCE))).not.toContain("<!--");
  });
});

/**
 * The renewal prompt lead time is operator-configurable
 * (`LEASE_RENEWAL_PROMPT_BEFORE`, contract §2) and the renew response carries
 * the resulting `renewalPromptAt`. Hardcoding the 5-minute default made that
 * setting inert on the only surface it governs.
 */
describe("renewal prompt lead time (contract §2/§7)", () => {
  const base = {
    id: "lease-1",
    token: "t",
    maxExpiresAt: "2026-07-19T22:00:00.000Z",
  };
  const at = (iso: string): number => Date.parse(iso);

  it("falls back to the §7 default when the server supplied no prompt instant", () => {
    const lease = { ...base, expiresAt: "2026-07-19T19:00:00.000Z" };
    expect(renewalPromptLeadMs(lease)).toBe(5 * 60_000);
    expect(leaseStatus(lease, at("2026-07-19T18:54:00.000Z")).promptRenewal).toBe(false);
    expect(leaseStatus(lease, at("2026-07-19T18:56:00.000Z")).promptRenewal).toBe(true);
  });

  it("honours a configured lead time longer than the default", () => {
    // PT15M before expiry.
    const lease = {
      ...base,
      expiresAt: "2026-07-19T19:00:00.000Z",
      renewalPromptAt: "2026-07-19T18:45:00.000Z",
    };
    expect(renewalPromptLeadMs(lease)).toBe(15 * 60_000);
    // 10 minutes out: inside the configured window, outside the old constant.
    expect(leaseStatus(lease, at("2026-07-19T18:50:00.000Z")).promptRenewal).toBe(true);
    expect(leaseStatus(lease, at("2026-07-19T18:40:00.000Z")).promptRenewal).toBe(false);
  });

  it("honours a configured lead time shorter than the default", () => {
    // A boot-valid config (PT4M lease, PT1M prompt) under which the hardcoded
    // 5-minute threshold exceeded the whole lease, showing the banner from
    // second zero for the lease's entire life.
    const lease = {
      ...base,
      expiresAt: "2026-07-19T18:34:00.000Z",
      renewalPromptAt: "2026-07-19T18:33:00.000Z",
    };
    expect(renewalPromptLeadMs(lease)).toBe(60_000);
    expect(leaseStatus(lease, at("2026-07-19T18:30:00.000Z")).promptRenewal).toBe(false);
    expect(leaseStatus(lease, at("2026-07-19T18:33:30.000Z")).promptRenewal).toBe(true);
  });

  it("ignores a nonsensical prompt instant rather than disabling the prompt", () => {
    const lease = {
      ...base,
      expiresAt: "2026-07-19T19:00:00.000Z",
      renewalPromptAt: "2026-07-19T19:30:00.000Z", // after expiry
    };
    expect(renewalPromptLeadMs(lease)).toBe(5 * 60_000);
  });
});
