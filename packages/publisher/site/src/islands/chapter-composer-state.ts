/**
 * Chapter composer state (Phase 6 contract §3.5): a pure reducer plus the
 * sessionStorage persistence for an in-progress chapter draft. No DOM, no
 * network - every transition below is unit tested directly, exactly as the
 * Phase 2b composer's state machine is (`composer-state.ts`).
 *
 * The operation polling budget is NOT redefined here: a chapter submission is
 * accepted with the same 202 + operation contract as every other write, so it
 * reuses `MAX_OPERATION_POLLS` / `pollDelayMs`.
 */
import type { ChapterAccepted, ChapterSource } from "./api.js";
import { MAX_OPERATION_POLLS } from "./composer-state.js";

/** Re-exported so the composer has one import for its whole vocabulary. */
export type { ChapterAccepted, ChapterSource };

/**
 * What the author is writing. `chapterId === null` is CREATE mode: the server
 * generates the id, the slug, the order and every block marker, so nothing in
 * this draft is a UUID the author had to know or type.
 */
export interface ChapterDraft {
  chapterId: string | null;
  title: string;
  body: string;
  /** The revision `chapterSource` returned; null in create mode. */
  baseRevision: number | null;
}

export type ChapterComposerPhase =
  /** Nothing rendered yet. */
  | "idle"
  /** Edit mode: reading the chapter's current text before opening the box. */
  | "loading"
  /** Form visible, both fields editable. */
  | "editing"
  /** POST in flight. */
  | "saving"
  /** 202 accepted; polling the operation endpoint. */
  | "syncing"
  /** Operation committed. */
  | "saved"
  /** Publish (or unpublish) POST in flight. */
  | "publishing"
  /** Poll budget spent while still pending: leave a refresh hint. */
  | "stale"
  /**
   * Terminal for this mount: the chapter's text could not be read, so there is
   * nothing safe to edit. A revise sends a COMPLETE replacement body, so an
   * empty box here would silently destroy the chapter.
   */
  | "error";

/** Which mutation the in-flight operation belongs to. */
export type ChapterPending = "save" | "publish" | "unpublish";

export interface ChapterComposerState {
  phase: ChapterComposerPhase;
  draft: ChapterDraft | null;
  /** Validation or API failure, in the author's words. */
  error: string | null;
  operationId: string | null;
  pending: ChapterPending | null;
  /** Completed polls of the operation endpoint. */
  polls: number;
  /** True once a save has committed - this is what unlocks Publish. */
  saved: boolean;
}

export type ChapterComposerEvent =
  | { type: "open"; draft: ChapterDraft }
  | { type: "load" }
  | { type: "loaded"; draft: ChapterDraft }
  | { type: "load-failed"; message: string }
  | { type: "set-title"; title: string }
  | { type: "set-body"; body: string }
  | { type: "save" }
  | { type: "rejected"; message: string }
  | { type: "accepted"; operationId: string; chapterId: string }
  | { type: "publish"; action: "publish" | "unpublish" }
  | { type: "publish-accepted"; operationId: string }
  | { type: "poll-pending" }
  | { type: "poll-committed" }
  | { type: "poll-failed"; message: string }
  /** A fresh `revision` read back after a commit, so the next save is clean. */
  | { type: "rebased"; baseRevision: number };

export const CHAPTER_IDLE: ChapterComposerState = {
  phase: "idle",
  draft: null,
  error: null,
  operationId: null,
  pending: null,
  polls: 0,
  saved: false,
};

/** Phases in which the two fields accept typing. */
function isEditable(phase: ChapterComposerPhase): boolean {
  return phase === "editing" || phase === "saved" || phase === "stale";
}

/**
 * Both fields are required. Surfaced as state, never thrown: an empty title is
 * an ordinary thing for a human to do and deserves a sentence, not a crash.
 */
export function validateDraft(draft: ChapterDraft): string | null {
  if (draft.title.trim() === "") {
    return "Give the chapter a title before saving.";
  }
  if (draft.body.trim() === "") {
    return "Write some text before saving.";
  }
  return null;
}

export function chapterComposerReduce(
  state: ChapterComposerState,
  event: ChapterComposerEvent,
): ChapterComposerState {
  switch (event.type) {
    case "open":
      return { ...CHAPTER_IDLE, phase: "editing", draft: event.draft };
    case "load":
      return { ...CHAPTER_IDLE, phase: "loading" };
    case "loaded":
      if (state.phase !== "loading" && state.phase !== "idle") {
        return state;
      }
      return { ...CHAPTER_IDLE, phase: "editing", draft: event.draft };
    case "load-failed":
      return { ...CHAPTER_IDLE, phase: "error", error: event.message };
    case "set-title":
      if (!isEditable(state.phase) || state.draft === null) {
        return state;
      }
      return {
        ...state,
        phase: "editing",
        error: null,
        pending: null,
        draft: { ...state.draft, title: event.title },
      };
    case "set-body":
      if (!isEditable(state.phase) || state.draft === null) {
        return state;
      }
      return {
        ...state,
        phase: "editing",
        error: null,
        pending: null,
        draft: { ...state.draft, body: event.body },
      };
    case "save": {
      if (!isEditable(state.phase) || state.draft === null) {
        return state;
      }
      const problem = validateDraft(state.draft);
      if (problem !== null) {
        return { ...state, phase: "editing", error: problem };
      }
      return { ...state, phase: "saving", error: null, pending: "save", polls: 0 };
    }
    case "rejected":
      if (state.phase !== "saving" && state.phase !== "publishing") {
        return state;
      }
      return { ...state, phase: "editing", error: event.message, pending: null };
    case "accepted":
      if (state.phase !== "saving" || state.draft === null) {
        return state;
      }
      return {
        ...state,
        phase: "syncing",
        error: null,
        operationId: event.operationId,
        pending: "save",
        polls: 0,
        // The 202 carries the id the server generated, so the author never
        // sees or types one.
        draft: { ...state.draft, chapterId: event.chapterId },
      };
    case "publish":
      // Publishing is never a side effect of saving: it is only reachable
      // once a save has committed (or in edit mode, where the chapter exists).
      if (state.phase !== "saved" && state.phase !== "editing") {
        return state;
      }
      if (state.draft === null || state.draft.chapterId === null) {
        return state;
      }
      return { ...state, phase: "publishing", error: null, pending: event.action };
    case "publish-accepted":
      if (state.phase !== "publishing") {
        return state;
      }
      return { ...state, phase: "syncing", error: null, operationId: event.operationId, polls: 0 };
    case "poll-pending": {
      if (state.phase !== "syncing") {
        return state;
      }
      const polls = state.polls + 1;
      if (polls >= MAX_OPERATION_POLLS) {
        return { ...state, phase: "stale", polls };
      }
      return { ...state, polls };
    }
    case "poll-committed":
      if (state.phase !== "syncing") {
        return state;
      }
      return {
        ...state,
        phase: "saved",
        polls: state.polls + 1,
        saved: state.saved || state.pending === "save",
      };
    case "poll-failed":
      if (state.phase !== "syncing") {
        return state;
      }
      return { ...state, phase: "editing", error: event.message, pending: null };
    case "rebased":
      if (state.draft === null) {
        return state;
      }
      return { ...state, draft: { ...state.draft, baseRevision: event.baseRevision } };
    default:
      return state;
  }
}

// ---- refresh-surviving session state ---------------------------------------

/**
 * The draft as it survives a reload (Phase 2b rule: drafts and focus survive a
 * refresh). Kept in **sessionStorage** only - same-origin, per-tab, dropped
 * when the tab closes. Never localStorage: an unfinished chapter is the
 * author's private prose and has no business outliving the session.
 */
export interface StoredChapterDraft {
  chapterId: string | null;
  title: string;
  body: string;
  baseRevision: number | null;
  /** Present for revision-proposal drafts that must stay bound to exact bytes. */
  baseContentHash?: string;
  /** Optional review context used by the in-place manuscript editor. */
  changeSummary?: string;
  notes?: string;
  /** Accepted direct-edit proposal retained until rejection recovery or deploy. */
  proposalId?: string;
  proposalOperationId?: string | null;
  proposalCorrelationId?: string | null;
  proposalCommitSha?: string | null;
  proposalPhase?: string;
  proposalError?: string | null;
  /** Caret offset within the focused field, so a refresh returns the writer
   * exactly where they were. */
  caret: number | null;
  focus: "title" | "body" | null;
}

/** `authorbot.chapter-draft.{project}.{chapterId ?? "new"}`. */
export function chapterDraftStorageKey(project: string, chapterId: string | null): string {
  return `authorbot.chapter-draft.${project}.${chapterId ?? "new"}`;
}

/** Persist the draft; storage failures (quota, private mode) are non-fatal. */
export function saveChapterDraft(
  storage: Storage | null,
  project: string,
  draft: StoredChapterDraft,
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(chapterDraftStorageKey(project, draft.chapterId), JSON.stringify(draft));
  } catch {
    // Over quota (a very long chapter): the in-memory draft still works until
    // the page unloads, and saving to the API is unaffected.
  }
}

export function clearChapterDraft(
  storage: Storage | null,
  project: string,
  chapterId: string | null,
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(chapterDraftStorageKey(project, chapterId));
  } catch {
    /* nothing to do */
  }
}

/** Read back a stored draft, tolerating any shape drift (returns null). */
export function loadChapterDraft(
  storage: Storage | null,
  project: string,
  chapterId: string | null,
): StoredChapterDraft | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(chapterDraftStorageKey(project, chapterId));
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredChapterDraft>;
    if (typeof parsed.title !== "string" || typeof parsed.body !== "string") {
      return null;
    }
    const storedId = parsed.chapterId;
    if (storedId !== null && typeof storedId !== "string") {
      return null;
    }
    // A draft filed under another chapter is not this chapter's draft.
    if ((storedId ?? null) !== chapterId) {
      return null;
    }
    const focus = parsed.focus;
    return {
      chapterId: storedId ?? null,
      title: parsed.title,
      body: parsed.body,
      baseRevision: typeof parsed.baseRevision === "number" ? parsed.baseRevision : null,
      ...(typeof parsed.baseContentHash === "string"
        ? { baseContentHash: parsed.baseContentHash }
        : {}),
      ...(typeof parsed.changeSummary === "string"
        ? { changeSummary: parsed.changeSummary }
        : {}),
      ...(typeof parsed.notes === "string" ? { notes: parsed.notes } : {}),
      ...(typeof parsed.proposalId === "string" ? { proposalId: parsed.proposalId } : {}),
      ...(typeof parsed.proposalOperationId === "string" || parsed.proposalOperationId === null
        ? { proposalOperationId: parsed.proposalOperationId }
        : {}),
      ...(typeof parsed.proposalCorrelationId === "string" ||
          parsed.proposalCorrelationId === null
        ? { proposalCorrelationId: parsed.proposalCorrelationId }
        : {}),
      ...(typeof parsed.proposalCommitSha === "string" || parsed.proposalCommitSha === null
        ? { proposalCommitSha: parsed.proposalCommitSha }
        : {}),
      ...(typeof parsed.proposalPhase === "string"
        ? { proposalPhase: parsed.proposalPhase }
        : {}),
      ...(typeof parsed.proposalError === "string" || parsed.proposalError === null
        ? { proposalError: parsed.proposalError }
        : {}),
      caret: typeof parsed.caret === "number" ? parsed.caret : null,
      focus: focus === "title" || focus === "body" ? focus : null,
    };
  } catch {
    return null;
  }
}
