import { describe, expect, it } from "vitest";
import {
  CLOSED,
  composerReduce,
  MAX_OPERATION_POLLS,
  pollDelayMs,
  type ComposerDraft,
  type ComposerState,
} from "../site/src/islands/composer-state.js";

/** Composer state machine (Phase 2b contract §2.2, §2.5). */

const draft: ComposerDraft = {
  kind: "suggestion",
  scope: "range",
  blockId: "0192aaaa-0000-7000-8000-000000000001",
  selector: {
    blockId: "0192aaaa-0000-7000-8000-000000000001",
    textPosition: { start: 4, end: 9 },
    textQuote: { exact: "drift", prefix: "The ", suffix: " appeared" },
  },
  body: "",
};

function editing(body = "Tighten this sentence."): ComposerState {
  let state = composerReduce(CLOSED, { type: "open", draft });
  state = composerReduce(state, { type: "set-body", body });
  return state;
}

describe("composerReduce", () => {
  it("opens with the draft and edits body and kind", () => {
    let state = composerReduce(CLOSED, { type: "open", draft });
    expect(state.phase).toBe("editing");
    state = composerReduce(state, { type: "set-kind", kind: "comment" });
    state = composerReduce(state, { type: "set-body", body: "hello" });
    expect(state.draft?.kind).toBe("comment");
    expect(state.draft?.body).toBe("hello");
  });

  it("refuses to submit an empty body", () => {
    const state = composerReduce(editing("   "), { type: "submit" });
    expect(state.phase).toBe("editing");
    expect(state.error).toBe("Write something first.");
  });

  it("walks the happy path editing → submitting → syncing → synced", () => {
    let state = composerReduce(editing(), { type: "submit" });
    expect(state.phase).toBe("submitting");
    state = composerReduce(state, {
      type: "accepted",
      operationId: "op-1",
      annotationId: "ann-1",
    });
    expect(state.phase).toBe("syncing");
    expect(state.operationId).toBe("op-1");
    expect(state.polls).toBe(0);
    state = composerReduce(state, { type: "poll-pending" });
    expect(state.phase).toBe("syncing");
    expect(state.polls).toBe(1);
    state = composerReduce(state, { type: "poll-committed" });
    expect(state.phase).toBe("synced");
    expect(state.annotationId).toBe("ann-1");
  });

  it("returns to editing with the message and the draft on rejection", () => {
    let state = composerReduce(editing("keep me"), { type: "submit" });
    state = composerReduce(state, { type: "rejected", message: "revision conflict" });
    expect(state.phase).toBe("editing");
    expect(state.error).toBe("revision conflict");
    expect(state.draft?.body).toBe("keep me");
  });

  it("bounds polling at MAX_OPERATION_POLLS and becomes stale (§2.5)", () => {
    let state = composerReduce(editing(), { type: "submit" });
    state = composerReduce(state, {
      type: "accepted",
      operationId: "op-2",
      annotationId: "ann-2",
    });
    for (let i = 0; i < MAX_OPERATION_POLLS - 1; i += 1) {
      state = composerReduce(state, { type: "poll-pending" });
      expect(state.phase).toBe("syncing");
    }
    state = composerReduce(state, { type: "poll-pending" });
    expect(state.phase).toBe("stale");
    expect(state.polls).toBe(MAX_OPERATION_POLLS);
    // Further poll events are ignored once stale.
    expect(composerReduce(state, { type: "poll-pending" })).toEqual(state);
  });

  it("surfaces a failed operation as an editing error (retry keeps the draft)", () => {
    let state = composerReduce(editing("try again"), { type: "submit" });
    state = composerReduce(state, {
      type: "accepted",
      operationId: "op-3",
      annotationId: "ann-3",
    });
    state = composerReduce(state, { type: "poll-failed", message: "git conflict" });
    expect(state.phase).toBe("editing");
    expect(state.error).toBe("git conflict");
    expect(state.draft?.body).toBe("try again");
  });

  it("cancel closes from any editing state", () => {
    expect(composerReduce(editing(), { type: "cancel" })).toEqual(CLOSED);
  });

  it("ignores stray events in closed state", () => {
    expect(composerReduce(CLOSED, { type: "submit" })).toEqual(CLOSED);
    expect(composerReduce(CLOSED, { type: "poll-committed" })).toEqual(CLOSED);
  });
});

describe("pollDelayMs", () => {
  it("backs off 500ms → 8s and caps there", () => {
    expect([0, 1, 2, 3, 4, 5].map(pollDelayMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
  });
});
