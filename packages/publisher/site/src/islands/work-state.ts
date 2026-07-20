/**
 * Pure state for the Phase 4 claim-and-edit island (contract §7): lease
 * countdown / renewal-prompt math, the submit state machine, and the
 * session-scoped persistence that survives a page refresh.
 *
 * Kept framework-free and DOM-free (except the storage helpers, which take a
 * `Storage` so they run under happy-dom and in tests) so the rules are unit
 * testable without a browser.
 */
import type { BundleTarget, TaskBundle } from "./api.js";

/**
 * FALLBACK renewal prompt lead time — design §25 / contract §7 default
 * (PT5M before expiry), used only until the server tells us otherwise.
 *
 * The lead time is operator-configurable (`LEASE_RENEWAL_PROMPT_BEFORE`,
 * contract §2), and the renew response carries the resulting
 * `renewalPromptAt`. Treating the 5-minute default as a constant made that
 * setting inert on the one surface it governs — and under a valid config such
 * as `LEASE_DURATION=PT4M` with `LEASE_RENEWAL_PROMPT_BEFORE=PT1M` the banner
 * showed for the lease's entire life. {@link leaseStatus} therefore derives
 * the lead time from the lease's own `renewalPromptAt` whenever the server has
 * supplied one, falling back to this constant otherwise.
 *
 * Contract §3 pins the claim response's `lease` object to
 * `{ id, token, expiresAt, maxExpiresAt }`, so a freshly claimed lease has no
 * server-supplied prompt time and uses this default until its first renewal.
 */
export const RENEWAL_PROMPT_MS = 5 * 60_000;

/** How often the countdown re-renders. One second: it shows mm:ss. */
export const COUNTDOWN_TICK_MS = 1_000;

/** Bounded operation polling, mirroring the Phase 2b composer (§2.5). */
export const MAX_SUBMIT_POLLS = 40;

/** 1s, 1s, 2s, 3s, 5s … capped at 5s — an apply commit is slower than an annotation. */
export function submitPollDelayMs(poll: number): number {
  const ladder = [1_000, 1_000, 2_000, 3_000, 5_000];
  return ladder[Math.min(poll, ladder.length - 1)] ?? 5_000;
}

export interface LeaseHandle {
  id: string;
  token: string;
  expiresAt: string;
  maxExpiresAt: string;
  /**
   * Server-computed instant at which a UI should prompt for renewal, when
   * known (the renew response supplies it). Its distance from `expiresAt` is
   * the operator's configured lead time.
   */
  renewalPromptAt?: string;
}

/**
 * Effective renewal-prompt lead time for a lease: the server-supplied
 * `renewalPromptAt` distance when present and sane, else the §7 default.
 */
export function renewalPromptLeadMs(lease: LeaseHandle): number {
  if (lease.renewalPromptAt === undefined) {
    return RENEWAL_PROMPT_MS;
  }
  const lead = parseTime(lease.expiresAt) - parseTime(lease.renewalPromptAt);
  return lead > 0 ? lead : RENEWAL_PROMPT_MS;
}

export interface LeaseStatus {
  /** Milliseconds until expiry; clamped at 0. */
  remainingMs: number;
  expired: boolean;
  /** True inside the last `RENEWAL_PROMPT_MS` before expiry (contract §7). */
  promptRenewal: boolean;
  /** False once the lease sits at its max total duration — renewal is futile. */
  renewable: boolean;
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function leaseStatus(lease: LeaseHandle, now: number): LeaseStatus {
  const expiresAt = parseTime(lease.expiresAt);
  const maxExpiresAt = parseTime(lease.maxExpiresAt);
  const remainingMs = Math.max(0, expiresAt - now);
  return {
    remainingMs,
    expired: remainingMs === 0,
    promptRenewal: remainingMs > 0 && remainingMs <= renewalPromptLeadMs(lease),
    // A renewal can only ever move `expiresAt` up to `maxExpiresAt`.
    renewable: maxExpiresAt > expiresAt,
  };
}

/** `1_805_000` → `"30:05"`; always mm:ss (or h:mm:ss past an hour). */
export function formatRemaining(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Screen-reader / visible label for the remaining-lease indicator. */
export function remainingLabel(status: LeaseStatus): string {
  if (status.expired) {
    return "Lease expired";
  }
  return `Lease expires in ${formatRemaining(status.remainingMs)}`;
}

// ---- submit state machine ---------------------------------------------------

export type SubmitPhase =
  | "editing"
  | "submitting"
  | "syncing"
  | "completed"
  | "conflict"
  | "failed"
  | "stale";

export interface SubmitState {
  phase: SubmitPhase;
  /** Honest, user-facing message for `failed` / `stale` / `conflict`. */
  message: string | null;
  operationId: string | null;
  submissionId: string | null;
  /** The `resolve_conflict` work item the pipeline created, when known. */
  conflictWorkItemId: string | null;
  polls: number;
}

export const SUBMIT_IDLE: SubmitState = {
  phase: "editing",
  message: null,
  operationId: null,
  submissionId: null,
  conflictWorkItemId: null,
  polls: 0,
};

export type SubmitEvent =
  | { type: "submit" }
  | { type: "rejected"; message: string }
  | { type: "accepted"; operationId: string; submissionId: string }
  | { type: "poll-pending" }
  | { type: "poll-committed" }
  | { type: "poll-conflict"; conflictWorkItemId: string | null; reason?: string | null }
  | { type: "poll-failed"; message: string }
  | { type: "reset" };

export const STALE_HINT =
  "Still syncing — refresh the page to see the final result of this submission.";

/**
 * The honest status ladder of contract §7: `submit → syncing →
 * completed | conflict`. A conflict is NOT an error state: the pipeline
 * committed a conflict record and opened a resolution work item, and the
 * chapter was left untouched — the view says exactly that.
 */
export function submitReduce(state: SubmitState, event: SubmitEvent): SubmitState {
  switch (event.type) {
    case "submit":
      if (state.phase !== "editing" && state.phase !== "failed") {
        return state;
      }
      return { ...state, phase: "submitting", message: null };
    case "rejected":
      if (state.phase !== "submitting") {
        return state;
      }
      return { ...state, phase: "failed", message: event.message };
    case "accepted":
      if (state.phase !== "submitting") {
        return state;
      }
      return {
        ...state,
        phase: "syncing",
        message: null,
        operationId: event.operationId,
        submissionId: event.submissionId,
        polls: 0,
      };
    case "poll-pending": {
      if (state.phase !== "syncing") {
        return state;
      }
      const polls = state.polls + 1;
      if (polls >= MAX_SUBMIT_POLLS) {
        return { ...state, phase: "stale", message: STALE_HINT, polls };
      }
      return { ...state, polls };
    }
    case "poll-committed":
      if (state.phase !== "syncing") {
        return state;
      }
      return { ...state, phase: "completed", message: null, polls: state.polls + 1 };
    case "poll-conflict":
      if (state.phase !== "syncing") {
        return state;
      }
      return {
        ...state,
        phase: "conflict",
        // Never assert WHY without knowing. "The chapter changed underneath
        // it" was printed unconditionally, so a payload the patch engine
        // simply refused (contract §5 reserves the conflict path for a moved
        // base) was reported to the writer as someone else's concurrent edit.
        message: conflictMessage(event.reason ?? null),
        conflictWorkItemId: event.conflictWorkItemId,
        polls: state.polls + 1,
      };
    case "poll-failed":
      if (state.phase !== "syncing") {
        return state;
      }
      return { ...state, phase: "failed", message: event.message, polls: state.polls + 1 };
    case "reset":
      return { ...SUBMIT_IDLE };
    default:
      return state;
  }
}

/**
 * User-facing conflict copy. The pipeline's own reason is authoritative when
 * it reached us; otherwise say only what is certainly true — the chapter was
 * not changed and a resolution item exists — without inventing a cause.
 */
export function conflictMessage(reason: string | null): string {
  const tail =
    "The chapter was left untouched and a conflict-resolution work item was created.";
  return reason === null || reason.trim() === ""
    ? `Your edit could not be applied. ${tail}`
    : `Your edit could not be applied: ${reason.trim()} ${tail}`;
}

// ---- refresh-surviving session state ---------------------------------------

/**
 * What the edit view needs to come back after a refresh (Phase 2b rule:
 * drafts and focus survive a reload).
 *
 * SECURITY: this includes the lease token, which the API returns exactly once
 * and which is the only way the holder can renew or submit. It is kept in
 * **sessionStorage** — same-origin, per-tab, dropped when the tab closes — and
 * is deleted the moment the lease is released, submitted, or expires. It is
 * never written to localStorage (which would outlive the session), never put
 * in the URL, never sent anywhere but the API, and never logged. An attacker
 * able to read it already holds the page's session cookie.
 */
export interface StoredClaim {
  workItemId: string;
  lease: LeaseHandle;
  workItem: TaskBundle["workItem"];
  document: TaskBundle["document"];
  target: BundleTarget | null;
  context: TaskBundle["context"];
  submissionSchema: string | null;
  /** The in-progress replacement text. */
  draft: string;
  /** Caret position, so a refresh returns the writer where they were. */
  caret: number | null;
}

export function claimStorageKey(project: string): string {
  return `authorbot.claim.${project}`;
}

export function toStoredClaim(bundle: TaskBundle, draft: string): StoredClaim {
  return {
    workItemId: bundle.workItem.id,
    lease: { ...bundle.lease },
    workItem: bundle.workItem,
    document: bundle.document,
    target: bundle.target ?? null,
    context: bundle.context,
    submissionSchema: bundle.submissionSchema,
    draft,
    caret: null,
  };
}

/** Persist the claim; storage failures (quota, private mode) are non-fatal. */
export function saveClaim(storage: Storage | null, project: string, claim: StoredClaim): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(claimStorageKey(project), JSON.stringify(claim));
  } catch {
    // Over quota (a very large chapter): keep the claim usable by dropping the
    // chapter source, which the edit view only needs for non-range prefills.
    try {
      const lean: StoredClaim = { ...claim, document: { ...claim.document, source: "" } };
      storage.setItem(claimStorageKey(project), JSON.stringify(lean));
    } catch {
      /* give up: the in-memory claim still works until the page unloads */
    }
  }
}

export function clearClaim(storage: Storage | null, project: string): void {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(claimStorageKey(project));
  } catch {
    /* nothing to do */
  }
}

/** Read back a stored claim, tolerating any shape drift (returns null). */
export function loadClaim(storage: Storage | null, project: string): StoredClaim | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(claimStorageKey(project));
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredClaim>;
    const lease = parsed.lease;
    if (
      typeof parsed.workItemId !== "string" ||
      typeof lease?.id !== "string" ||
      typeof lease.token !== "string" ||
      typeof lease.expiresAt !== "string" ||
      typeof lease.maxExpiresAt !== "string" ||
      typeof parsed.document?.contentHash !== "string" ||
      typeof parsed.document.revision !== "number"
    ) {
      return null;
    }
    return {
      workItemId: parsed.workItemId,
      lease: {
        id: lease.id,
        token: lease.token,
        expiresAt: lease.expiresAt,
        maxExpiresAt: lease.maxExpiresAt,
        // Carried across a refresh so the countdown keeps honouring the
        // operator's configured prompt lead time rather than silently
        // reverting to the §7 default.
        ...(typeof lease.renewalPromptAt === "string"
          ? { renewalPromptAt: lease.renewalPromptAt }
          : {}),
      },
      workItem: parsed.workItem ?? { id: parsed.workItemId, type: "", acceptanceCriteria: [], priority: "" },
      document: {
        chapterId: parsed.document.chapterId ?? "",
        revision: parsed.document.revision,
        contentHash: parsed.document.contentHash,
        source: typeof parsed.document.source === "string" ? parsed.document.source : "",
      },
      target: parsed.target ?? null,
      context: parsed.context ?? { annotationBody: "", chapterSummary: "", storyRefs: [] },
      submissionSchema: parsed.submissionSchema ?? null,
      draft: typeof parsed.draft === "string" ? parsed.draft : "",
      caret: typeof parsed.caret === "number" ? parsed.caret : null,
    };
  } catch {
    return null;
  }
}

// ---- submission shaping -----------------------------------------------------

/** Work-item type → required submission type (Phase 4 contract §4). */
export const SUBMISSION_TYPE_FOR_WORK_ITEM: Readonly<Record<string, string | null>> = Object.freeze({
  revise_range: "range_replacement",
  revise_block: "block_replacement",
  revise_chapter: "chapter_replacement",
  resolve_conflict: "chapter_replacement",
  write_chapter: null,
  planning: null,
});

export function submissionTypeFor(workItemType: string): string | null {
  return SUBMISSION_TYPE_FOR_WORK_ITEM[workItemType] ?? null;
}

const MARKER_LINE = /^[ \t]*<!--[ \t]*authorbot:block[ \t]+id="([^"]*)"[ \t]*-->[ \t]*$/;

/**
 * The source text of one block inside a chapter — the lines after its
 * `<!-- authorbot:block id="…" -->` marker up to the next marker. Used to
 * prefill a `block_replacement` textarea; the marker itself is never included
 * (the API rejects `authorbot:` comments inside submission content).
 */
export function blockSource(chapterSource: string, blockId: string): string | null {
  const lines = chapterSource.split("\n");
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = MARKER_LINE.exec(lines[index] ?? "");
    if (match === null) {
      continue;
    }
    if (start !== -1) {
      return lines.slice(start, index).join("\n").replace(/^\n+|\n+$/g, "");
    }
    if (match[1] === blockId) {
      start = index + 1;
    }
  }
  if (start === -1) {
    return null;
  }
  return lines.slice(start).join("\n").replace(/^\n+|\n+$/g, "");
}

/**
 * What the textarea starts with (contract §7 "prefilled with the target"):
 * the quoted span for a range item, the block's source for a block item, and
 * the chapter body for a chapter item.
 */
export function prefillFor(claim: Pick<StoredClaim, "workItem" | "document" | "target">): string {
  const type = submissionTypeFor(claim.workItem.type);
  if (type === "range_replacement") {
    return claim.target?.exact ?? "";
  }
  if (type === "block_replacement" && claim.target !== null) {
    return blockSource(claim.document.source, claim.target.blockId) ?? "";
  }
  if (type === "chapter_replacement") {
    // Markers are stripped: the API refuses `authorbot:` comments inside
    // submission content and the patch engine re-marks the result itself
    // (reusing ids for textually identical blocks, contract §5).
    return stripBlockMarkers(chapterBody(claim.document.source));
  }
  return "";
}

/** Drop `<!-- authorbot:block … -->` lines (and the blank line they leave). */
export function stripBlockMarkers(source: string): string {
  return source
    .split("\n")
    .filter((line) => MARKER_LINE.exec(line) === null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
}

/** The chapter body: everything after the closing frontmatter fence. */
export function chapterBody(source: string): string {
  if (!source.startsWith("---")) {
    return source;
  }
  const end = source.indexOf("\n---", 3);
  if (end === -1) {
    return source;
  }
  const newline = source.indexOf("\n", end + 1);
  return newline === -1 ? "" : source.slice(newline + 1).replace(/^\n+/, "");
}
