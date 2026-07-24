import { describe, expect, it, vi } from "vitest";
import {
  CollabEvents,
  FEED_EVENT_TYPES,
  type CollabEventsStatus,
  type EventSourceLike,
} from "../site/src/islands/events.js";
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
  emitRaw(type: string, value: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(value) });
  }
}

/** Manual timer harness: fire the scheduled callbacks on demand. */
function timers() {
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  return {
    setTimer: (fn: () => void, ms = 0): number => {
      const id = nextId++;
      scheduled.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: number): void => {
      scheduled.delete(id);
    },
    fireAll(): void {
      const batch = [...scheduled.entries()];
      scheduled.clear();
      for (const [, entry] of batch) {
        entry.fn();
      }
    },
    size: (): number => scheduled.size,
    delays: (): number[] => [...scheduled.values()].map((entry) => entry.ms),
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
  it("registers every reviewed runtime event and omits reason-bearing events", () => {
    const received: FeedEvent[] = [];
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: (event) => received.push(event),
      eventSourceFactory: factory(),
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    const es = FakeEventSource.instances[0]!;
    expect([...es.listeners.keys()]).toEqual(FEED_EVENT_TYPES);
    expect(es.listeners.has("work_item_conflict")).toBe(false);
    expect(es.listeners.has("project_divergence_cleared")).toBe(false);
    FEED_EVENT_TYPES.forEach((type, index) => es.emit(evt(index + 1, type)));
    expect(received.map((event) => event.type)).toEqual(FEED_EVENT_TYPES);
  });

  it("uses the initial cursor in the SSE URL and suppresses duplicate or older IDs", () => {
    const received: FeedEvent[] = [];
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: (e) => received.push(e),
      initialCursor: 4,
      streamClientId: "test-client",
      eventSourceFactory: factory(),
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("http://api.test/events?after=4&stream=test-client");
    es.open();
    es.emit(evt(5, "vote_aggregate", { annotationId: "a", votes: { approvals: 1 } }));
    es.emit(evt(5, "vote_aggregate", { annotationId: "duplicate" }));
    es.emit(evt(3, "annotation_created", { annotationId: "older" }));
    es.emit(evt(6, "work_item_created", { annotationId: "a" }));
    expect(received.map((e) => e.type)).toEqual(["vote_aggregate", "work_item_created"]);
    expect(received[0]?.payload["annotationId"]).toBe("a");
  });

  it("validates a frame before advancing the cursor", () => {
    const received: FeedEvent[] = [];
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      initialCursor: 5,
      onEvent: (event) => received.push(event),
      eventSourceFactory: factory(),
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    const es = FakeEventSource.instances[0]!;
    es.emitRaw("vote_aggregate", { id: 6, type: "vote_aggregate", payload: null });
    es.emitRaw("vote_aggregate", { id: 6, type: "decision_created", payload: {} });
    es.emit(evt(6, "vote_aggregate", { annotationId: "valid" }));
    expect(received).toEqual([evt(6, "vote_aggregate", { annotationId: "valid" })]);
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
        return {
          ok: true as const,
          items: [
            evt(10, "vote_aggregate", { annotationId: "a" }),
            evt(10, "vote_aggregate", { annotationId: "duplicate" }),
            evt(9, "annotation_created", { annotationId: "older" }),
            evt(11, "project_divergence_cleared", { reason: "private" }),
          ],
          latestId: 11,
        };
      }
      return { ok: true as const, items: [], latestId: after };
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
    // The private event is not delivered, but its valid envelope still moves
    // the cursor so polling does not wedge on it.
    t.fireAll();
    await tick();
    expect(seen[1]).toBe(11);
  });

  it.each([404, 405] as const)(
    "stops cleanly when the poll endpoint is permanently unsupported (%s)",
    async (httpStatus) => {
      const poll = vi.fn(async () => ({ ok: false as const, status: httpStatus }));
      const statuses: CollabEventsStatus[] = [];
      const t = timers();
      const client = new CollabEvents({
        url: "http://api.test/events",
        onEvent: () => {},
        onStatus: (status) => statuses.push(status),
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
      expect(statuses.at(-1)).toMatchObject({ state: "unsupported", status: httpStatus });
    },
  );

  it("retries rejected and thrown polls with backoff, then refetches on recovery", async () => {
    const seen: number[] = [];
    let attempt = 0;
    const poll = vi.fn(async (after: number) => {
      seen.push(after);
      attempt += 1;
      if (attempt === 1) {
        return { ok: false as const, status: 503 };
      }
      if (attempt === 2) {
        throw new Error("network down");
      }
      return {
        ok: true as const,
        items: [evt(8, "work_item_completed", { workItemId: "w" })],
        latestId: 8,
      };
    });
    const statuses: CollabEventsStatus[] = [];
    const reconnects: number[] = [];
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: () => {},
      onReconnect: () => reconnects.push(1),
      onStatus: (status) => statuses.push(status),
      eventSourceFactory: null,
      poll,
      initialCursor: 4,
      pollMs: 100,
      maxPollBackoffMs: 250,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    await tick();
    expect(t.delays()).toEqual([100]);
    t.fireAll();
    await tick();
    expect(t.delays()).toEqual([200]);
    t.fireAll();
    await tick();
    expect(seen).toEqual([4, 4, 4]);
    expect(reconnects).toHaveLength(1);
    expect(statuses.filter((status) => status.state === "retrying")).toMatchObject([
      { state: "retrying", attempt: 1, retryInMs: 100, status: 503 },
      { state: "retrying", attempt: 2, retryInMs: 200 },
    ]);
    expect(statuses.at(-1)).toMatchObject({ state: "connected", transport: "poll", cursor: 8 });
  });

  it("does not advance past a malformed polled envelope", async () => {
    const seen: number[] = [];
    let attempt = 0;
    const received: FeedEvent[] = [];
    const poll = vi.fn(async (after: number) => {
      seen.push(after);
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: true as const,
          items: [{ id: 9, type: "annotation_created", payload: null } as unknown as FeedEvent],
          latestId: 9,
        };
      }
      return {
        ok: true as const,
        items: [evt(9, "annotation_created", { annotationId: "a" })],
        latestId: 9,
      };
    });
    const t = timers();
    const client = new CollabEvents({
      url: "http://api.test/events",
      onEvent: (event) => received.push(event),
      eventSourceFactory: null,
      poll,
      initialCursor: 3,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    client.start();
    await tick();
    t.fireAll();
    await tick();
    expect(seen).toEqual([3, 3]);
    expect(received.map((event) => event.id)).toEqual([9]);
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
