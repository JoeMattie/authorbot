/**
 * Composer state machine (Phase 2b contract §2.2, §2.5): pure reducer so the
 * transitions - including the bounded operation polling - are unit tested
 * without DOM or network.
 */
import type { RangeSelector } from "./selection.js";

export type ComposerKind = "comment" | "suggestion";
export type ComposerScope = "range" | "block";

export interface ComposerDraft {
  kind: ComposerKind;
  scope: ComposerScope;
  /** Range selector for `range` scope; block id alone for `block` scope. */
  blockId: string;
  selector: RangeSelector | null;
  body: string;
}

export type ComposerPhase =
  | "closed"
  /** Form visible, body editable. */
  | "editing"
  /** POST in flight. */
  | "submitting"
  /** 202 accepted; polling the operation endpoint. */
  | "syncing"
  /** Operation committed. */
  | "synced"
  /** Poll budget spent while still pending: leave a refresh hint (§2.5). */
  | "stale";

export interface ComposerState {
  phase: ComposerPhase;
  draft: ComposerDraft | null;
  error: string | null;
  operationId: string | null;
  annotationId: string | null;
  /** Completed polls of the operation endpoint. */
  polls: number;
}

export type ComposerEvent =
  | { type: "open"; draft: ComposerDraft }
  | { type: "set-kind"; kind: ComposerKind }
  | { type: "set-body"; body: string }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "rejected"; message: string }
  | { type: "accepted"; operationId: string; annotationId: string }
  | { type: "poll-pending" }
  | { type: "poll-committed" }
  | { type: "poll-failed"; message: string };

/** Contract §2.5: at most 5 polls, then leave a refresh hint. */
export const MAX_OPERATION_POLLS = 5;

/** Backoff before poll n (0-based): 500ms, 1s, 2s, 4s, 8s. */
export function pollDelayMs(poll: number): number {
  return 500 * 2 ** Math.min(poll, 4);
}

export const CLOSED: ComposerState = {
  phase: "closed",
  draft: null,
  error: null,
  operationId: null,
  annotationId: null,
  polls: 0,
};

export function composerReduce(state: ComposerState, event: ComposerEvent): ComposerState {
  switch (event.type) {
    case "open":
      return { ...CLOSED, phase: "editing", draft: event.draft };
    case "cancel":
      return CLOSED;
    case "set-kind":
      if (state.phase !== "editing" || state.draft === null) {
        return state;
      }
      return { ...state, draft: { ...state.draft, kind: event.kind } };
    case "set-body":
      if (state.phase !== "editing" || state.draft === null) {
        return state;
      }
      return { ...state, error: null, draft: { ...state.draft, body: event.body } };
    case "submit": {
      if (state.phase !== "editing" || state.draft === null) {
        return state;
      }
      if (state.draft.body.trim() === "") {
        return { ...state, error: "Write something first." };
      }
      return { ...state, phase: "submitting", error: null };
    }
    case "rejected":
      if (state.phase !== "submitting") {
        return state;
      }
      return { ...state, phase: "editing", error: event.message };
    case "accepted":
      if (state.phase !== "submitting") {
        return state;
      }
      return {
        ...state,
        phase: "syncing",
        error: null,
        operationId: event.operationId,
        annotationId: event.annotationId,
        polls: 0,
      };
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
      return { ...state, phase: "synced", polls: state.polls + 1 };
    case "poll-failed":
      if (state.phase !== "syncing") {
        return state;
      }
      return { ...state, phase: "editing", error: event.message };
    default:
      return state;
  }
}
