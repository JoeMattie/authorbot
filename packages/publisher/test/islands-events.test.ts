import { describe, expect, it, vi } from "vitest";
import { CollabEvents, type EventSourceLike } from "../site/src/islands/events.js";
import type { FeedEvent } from "../site/src/islands/api.js";

/**
 * Live event-feed client (Phase 3 contract §5): SSE with a poll fallback and
 * reconnect-refetch. Driven with a fake `EventSource`, a fake poll transport,
 * and an injected timer harness - no real network, no real clock.
 */

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, (event: { data?: string }) => void>();
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  fail(): void {
    this.onerror?.({});
  }
  emit(event: FeedEvent): void {
    this.listeners.get(event.type)?.({ data: JSON.stringify(event) });
  }
}

/** Manual timer harness: fire the scheduled callbacks on demand. */
function timers() {
  const scheduled = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimer: (fn: () => void): number => {
      const id = nextId++;
      scheduled.set(id, fn);
      return id;
    },
    clearTimer: (id: number): void => {
      scheduled.delete(id);
    },
    fireAll(): void {
      const batch = [...scheduled.entries()];
      scheduled.clear();
      for (const [, fn] of batch) {
        fn();
      }
    },
    size: (): number => scheduled.size,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const evt = (id: number, type: string, payload: Record<string, unknown> = {}): FeedEvent => ({
  id,
  type,
  payload,
});

function factory() {
  FakeEventSource.instances = [];
  return (url: string): FakeEventSource => new FakeEventSource(url);
}

describe("CollabEvents - SSE transport", () => {
  it("delivers named stream events and tracks the cursor", () => {
    const received: FeedEvent[] = [];
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: (e) => received.push(e),
      eventSourceFactory: factory(),
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    const es = FakeEventSource.instances[0]!;
    es.open();
    es.emit(evt(5, "vote_aggregate", { annotationId: "a", votes: { approvals: 1 } }));
    es.emit(evt(6, "work_item_created", { annotationId: "a" }));
    expect(received.map((e) => e.type)).toEqual(["vote_aggregate", "work_item_created"]);
    expect(received[0]?.payload["annotationId"]).toBe("a");
  });

  it("fires onReconnect on a reopen after an error, never on the first open", () => {
    const reconnects: number[] = [];
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: () => {},
      onReconnect: () => reconnects.push(1),
      eventSourceFactory: factory(),
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    const es = FakeEventSource.instances[0]!;
    es.open(); // first open: no reconnect
    expect(reconnects.length).toBe(0);
    es.fail(); // opened, so browser auto-reconnects (no poll fallback)
    expect(es.closed).toBe(false);
    es.open(); // reopen: refetch authoritative state
    expect(reconnects.length).toBe(1);
  });

  it("falls back to polling when the stream never opens within the timeout", async () => {
    const received: FeedEvent[] = [];
    const poll = vi.fn(async (after: number) => ({
      ok: true as const,
      items: after < 7 ? [evt(7, "decision_created", { annotationId: "a" })] : [],
      latestId: 7,
    }));
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: (e) => received.push(e),
      eventSourceFactory: factory(),
      poll,
      initialCursor: 3,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    const es = FakeEventSource.instances[0]!;
    // Open timeout elapses with no open → close the stream, start polling.
    t.fireAll();
    await tick();
    expect(es.closed).toBe(true);
    expect(poll).toHaveBeenCalledWith(3);
    expect(received.map((e) => e.id)).toEqual([7]);
  });

  it("falls back to polling when the stream errors before it ever opens", async () => {
    const received: FeedEvent[] = [];
    const poll = vi.fn(async () => ({
      ok: true as const,
      items: [evt(2, "vote_aggregate", { annotationId: "z" })],
      latestId: 2,
    }));
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: (e) => received.push(e),
      eventSourceFactory: factory(),
      poll,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    FakeEventSource.instances[0]!.fail();
    await tick();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(received[0]?.payload["annotationId"]).toBe("z");
  });
});

describe("CollabEvents - poll transport", () => {
  it("uses poll directly when no EventSource is available, advancing the cursor", async () => {
    const received: FeedEvent[] = [];
    const seen: number[] = [];
    const poll = vi.fn(async (after: number) => {
      seen.push(after);
      if (after < 10) {
        return { ok: true as const, items: [evt(10, "vote_aggregate", { annotationId: "a" })], latestId: 10 };
      }
      return { ok: true as const, items: [], latestId: 10 };
    });
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: (e) => received.push(e),
      eventSourceFactory: null, // no stream transport
      poll,
      initialCursor: 4,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    await tick();
    expect(seen[0]).toBe(4);
    expect(received.map((e) => e.id)).toEqual([10]);
    // Next scheduled poll resumes strictly after the delivered id.
    t.fireAll();
    await tick();
    expect(seen[1]).toBe(10);
  });

  it("stops cleanly when the poll endpoint is unsupported (no busy loop)", async () => {
    const poll = vi.fn(async () => ({ ok: false as const }));
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: () => {},
      eventSourceFactory: null,
      poll,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    await tick();
    expect(poll).toHaveBeenCalledTimes(1);
    // No follow-up poll was scheduled.
    expect(t.size()).toBe(0);
  });

  it("stop() closes the stream and cancels pending timers", async () => {
    const poll = vi.fn(async () => ({ ok: true as const, items: [], latestId: 0 }));
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: () => {},
      eventSourceFactory: factory(),
      poll,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    const es = FakeEventSource.instances[0]!;
    client.stop();
    expect(es.closed).toBe(true);
    // A late open-timeout firing after stop must not start polling.
    t.fireAll();
    await tick();
    expect(poll).not.toHaveBeenCalled();
  });
});
