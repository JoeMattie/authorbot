/**
 * Live event-feed client (Phase 3 contract §5): an SSE subscription with a
 * poll fallback and reconnect-refetch semantics. Framework-free and
 * dependency-injected so the whole state machine is unit tested with a fake
 * `EventSource` and a fake poll transport.
 *
 * Transport selection:
 * - When a usable `EventSource` exists, subscribe to the named events. The
 *   browser resumes with `Last-Event-ID` automatically; each successful
 *   (re)open after an error fires `onReconnect`, because events are
 *   notifications — the client must refetch authoritative state after a gap.
 * - If the stream never opens within `openTimeoutMs` (e.g. a dev bridge that
 *   buffers the response) or errors before ever opening, fall back to polling
 *   `?poll=1`, which carries a cursor and cannot lose rows.
 */
import type { FeedEvent } from "./api.js";

/** The subset of `EventSource` this client uses (so tests can fake it). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** Poll transport: one `?poll=1` page strictly after `after`. */
export type PollTransport = (
  after: number,
) => Promise<{ ok: true; items: FeedEvent[]; latestId: number } | { ok: false }>;

/** Event types the feed emits (Phase 3 contract §5). */
export const FEED_EVENT_TYPES: readonly string[] = [
  "annotation_created",
  "vote_aggregate",
  "decision_created",
  "decision_support_changed",
  "work_item_created",
  "operation_completed",
];

export interface CollabEventsOptions {
  /** SSE endpoint (no query); the `?poll=1` fallback appends its own params. */
  url: string;
  /** Delivered every event, live. */
  onEvent: (event: FeedEvent) => void;
  /** Fired after a reconnection or poll-recovery: refetch authoritative state. */
  onReconnect?: () => void;
  /** Cursor the poll fallback starts strictly after (the current head). */
  initialCursor?: number;
  eventSourceFactory?: EventSourceFactory | null;
  poll?: PollTransport;
  pollMs?: number;
  /** Give the stream this long to open before falling back to poll. */
  openTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_OPEN_TIMEOUT_MS = 3_000;

export class CollabEvents {
  private readonly url: string;
  private readonly onEvent: (event: FeedEvent) => void;
  private readonly onReconnect: (() => void) | undefined;
  private readonly eventSourceFactory: EventSourceFactory | null | undefined;
  private readonly poll: PollTransport | undefined;
  private readonly pollMs: number;
  private readonly openTimeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  private source: EventSourceLike | null = null;
  private opened = false;
  private stopped = false;
  private cursor: number;
  private openTimer: number | undefined;
  private pollTimer: number | undefined;
  private polling = false;

  constructor(options: CollabEventsOptions) {
    this.url = options.url;
    this.onEvent = options.onEvent;
    this.onReconnect = options.onReconnect;
    this.eventSourceFactory = options.eventSourceFactory;
    this.poll = options.poll;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.setTimer =
      options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.clearTimer = options.clearTimer ?? ((id) => globalThis.clearTimeout(id));
    this.cursor = options.initialCursor ?? 0;
  }

  /** Begin streaming (or polling). Idempotent-ish: call once per instance. */
  start(): void {
    const factory = this.resolveFactory();
    if (factory === null) {
      this.startPolling(false);
      return;
    }
    let source: EventSourceLike;
    try {
      source = factory(this.url);
    } catch {
      this.startPolling(false);
      return;
    }
    this.source = source;
    for (const type of FEED_EVENT_TYPES) {
      source.addEventListener(type, (event) => this.onFrame(event.data));
    }
    source.onopen = (): void => {
      const reconnecting = this.opened;
      this.opened = true;
      this.clearOpenTimer();
      if (reconnecting) {
        this.onReconnect?.();
      }
    };
    source.onerror = (): void => {
      if (!this.opened) {
        // Never came up: fall back to polling (which cannot lose rows).
        this.fallBackToPolling();
      }
      // Once opened, the browser auto-reconnects; the next `onopen` refetches.
    };
    this.openTimer = this.setTimer(() => {
      if (!this.opened && !this.stopped) {
        this.fallBackToPolling();
      }
    }, this.openTimeoutMs);
  }

  /** Tear down all transports and timers (element disconnect). */
  stop(): void {
    this.stopped = true;
    this.clearOpenTimer();
    if (this.pollTimer !== undefined) {
      this.clearTimer(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.closeSource();
  }

  private resolveFactory(): EventSourceFactory | null {
    if (this.eventSourceFactory !== undefined) {
      return this.eventSourceFactory;
    }
    const ctor = (globalThis as { EventSource?: unknown }).EventSource;
    if (typeof ctor !== "function") {
      return null;
    }
    return (url) =>
      new (ctor as new (u: string, init?: { withCredentials?: boolean }) => EventSourceLike)(url, {
        withCredentials: true,
      });
  }

  private onFrame(data: string | undefined): void {
    if (this.stopped || data === undefined) {
      return;
    }
    let parsed: FeedEvent;
    try {
      parsed = JSON.parse(data) as FeedEvent;
    } catch {
      return;
    }
    if (typeof parsed.id === "number" && parsed.id > this.cursor) {
      this.cursor = parsed.id;
    }
    this.onEvent(parsed);
  }

  private closeSource(): void {
    if (this.source !== null) {
      this.source.onopen = null;
      this.source.onerror = null;
      try {
        this.source.close();
      } catch {
        // ignore
      }
      this.source = null;
    }
  }

  private clearOpenTimer(): void {
    if (this.openTimer !== undefined) {
      this.clearTimer(this.openTimer);
      this.openTimer = undefined;
    }
  }

  private fallBackToPolling(): void {
    this.clearOpenTimer();
    this.closeSource();
    // Falling back from a stream that opened then broke is a genuine gap; a
    // stream that never opened lost nothing (the initial fetch is still fresh).
    this.startPolling(this.opened);
  }

  private startPolling(recoverOnEstablish: boolean): void {
    if (this.stopped || this.polling) {
      return;
    }
    this.polling = true;
    void this.pollOnce(recoverOnEstablish);
  }

  private async pollOnce(recoverOnEstablish: boolean): Promise<void> {
    if (this.stopped) {
      return;
    }
    const poll = this.poll ?? null;
    if (poll === null) {
      this.polling = false;
      return; // no poll transport wired: nothing more we can do
    }
    const result = await poll(this.cursor);
    if (this.stopped) {
      return;
    }
    if (!result.ok) {
      // Endpoint absent/unsupported: stop cleanly rather than spin.
      this.polling = false;
      return;
    }
    for (const event of result.items) {
      if (typeof event.id === "number" && event.id > this.cursor) {
        this.cursor = event.id;
      }
      this.onEvent(event);
    }
    this.cursor = Math.max(this.cursor, result.latestId);
    // Recovering into a working poll after a live-stream gap must refetch.
    if (recoverOnEstablish) {
      this.onReconnect?.();
    }
    this.pollTimer = this.setTimer(() => {
      void this.pollOnce(false);
    }, this.pollMs);
  }
}
