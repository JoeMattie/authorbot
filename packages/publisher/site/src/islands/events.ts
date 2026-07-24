/**
 * Live event-feed client (Phase 3 contract section 5): an SSE subscription
 * with a poll fallback and reconnect-refetch semantics. Framework-free and
 * dependency-injected so the whole state machine is unit tested with a fake
 * `EventSource` and a fake poll transport.
 *
 * Transport selection:
 * - When a usable `EventSource` exists, subscribe to the named events. The
 *   browser resumes with `Last-Event-ID` automatically; each successful
 *   reopen after an error fires `onReconnect`, because events are
 *   notifications and the client must refetch authoritative state after a
 *   gap.
 * - If the stream never opens within `openTimeoutMs` (for example, a dev
 *   bridge that buffers the response) or errors before ever opening, fall
 *   back to polling `?poll=1`, which carries a cursor and cannot lose rows.
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

export interface PollFailure {
  ok: false;
  /** HTTP status when the transport reached the API; absent on network loss. */
  status?: number;
  message?: string;
}

/** Poll transport: one `?poll=1` page strictly after `after`. */
export type PollTransport = (
  after: number,
) => Promise<{ ok: true; items: FeedEvent[]; latestId: number } | PollFailure>;

/**
 * Safe, currently emitted event types consumed by the public book client.
 *
 * This list is intentionally an allowlist. The event endpoint can be
 * anonymous-readable for a public book, so a newly added server event must be
 * reviewed before the browser starts consuming its payload. The current
 * emitters for `work_item_conflict`, `revision_proposal_conflicted`, and
 * `project_divergence_cleared` include a free-form `reason`; those are
 * deliberately omitted. Operation completion still causes the store to
 * refetch authoritative state. Project divergence is outside the editorial
 * store.
 */
export const FEED_EVENT_TYPES = [
  "annotation_created",
  "vote_aggregate",
  "decision_created",
  "decision_support_changed",
  "work_item_created",
  "work_item_leased",
  "lease_recovered",
  "lease_renewed",
  "lease_released",
  "lease_expired",
  "lease_revoked",
  "submission_received",
  "work_item_completed",
  "operation_completed",
  "chapter_created",
  "chapter_revised",
  "chapter_published",
  "chapter_unpublished",
  "revision_proposal_created",
  "revision_proposal_approved",
  "revision_proposal_rejected",
  "revision_proposal_applied",
  "publication_updated",
  "project_diverged",
  "annotation_needs_reanchor",
  "project_frozen",
  "project_unfrozen",
  "agents_paused",
  "agents_resumed",
] as const;

const FEED_EVENT_TYPE_SET: ReadonlySet<string> = new Set(FEED_EVENT_TYPES);

export type CollabEventsStatus =
  | {
      state: "connecting" | "connected";
      transport: "sse" | "poll";
      cursor: number;
    }
  | {
      state: "retrying";
      transport: "sse" | "poll";
      cursor: number;
      attempt: number;
      /** Present for scheduled poll retries; native EventSource owns SSE timing. */
      retryInMs?: number;
      /** Present when the failed poll received an HTTP response. */
      status?: number;
    }
  | {
      state: "unsupported";
      transport: "poll";
      cursor: number;
      /** 404/405 are permanent; absent means no poll transport was supplied. */
      status?: 404 | 405;
    }
  | {
      state: "stopped";
      transport: null;
      cursor: number;
    };

export interface CollabEventsOptions {
  /** SSE endpoint (no query); the `?poll=1` fallback appends its own params. */
  url: string;
  /** Delivered for every valid, allowlisted, previously unseen event. */
  onEvent: (event: FeedEvent) => void;
  /** Fired after a reconnection or poll recovery: refetch authoritative state. */
  onReconnect?: () => void;
  /** Connection status for a project-scoped store or UI indicator. */
  onStatus?: (status: CollabEventsStatus) => void;
  /**
   * Cursor both transports start strictly after. For SSE it is added as the
   * initial `after` query; on a native reconnect the server gives the
   * browser's `Last-Event-ID` header precedence over that query.
   */
  initialCursor?: number;
  /**
   * Stable id for this browser tab. Reconnects and same-tab navigations replace
   * their prior Worker stream instead of consuming another concurrency slot.
   * `null` keeps the legacy URL for non-browser clients and focused tests.
   */
  streamClientId?: string | null;
  eventSourceFactory?: EventSourceFactory | null;
  poll?: PollTransport;
  pollMs?: number;
  /** Maximum exponential-backoff delay for transient poll failures. */
  maxPollBackoffMs?: number;
  /** Give the stream this long to open before falling back to poll. */
  openTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_POLL_BACKOFF_MS = 30_000;
const DEFAULT_OPEN_TIMEOUT_MS = 3_000;
const STREAM_CLIENT_STORAGE_KEY = "authorbot:event-stream-client:v1";
let pageStreamClientId: string | null = null;

function browserStreamClientId(): string | null {
  if (pageStreamClientId !== null) return pageStreamClientId;
  try {
    const stored = globalThis.sessionStorage.getItem(STREAM_CLIENT_STORAGE_KEY);
    if (stored !== null && /^[A-Za-z0-9._~-]{1,128}$/u.test(stored)) {
      pageStreamClientId = stored;
      return stored;
    }
    const created = globalThis.crypto.randomUUID();
    globalThis.sessionStorage.setItem(STREAM_CLIENT_STORAGE_KEY, created);
    pageStreamClientId = created;
    return created;
  } catch {
    // Restricted storage or a non-browser runtime: the server retains its
    // legacy bounded behavior, and native EventSource still reconnects.
    return null;
  }
}

export class CollabEvents {
  private readonly url: string;
  private readonly onEvent: (event: FeedEvent) => void;
  private readonly onReconnect: (() => void) | undefined;
  private readonly onStatus: ((status: CollabEventsStatus) => void) | undefined;
  private readonly eventSourceFactory: EventSourceFactory | null | undefined;
  private readonly poll: PollTransport | undefined;
  private readonly pollMs: number;
  private readonly maxPollBackoffMs: number;
  private readonly openTimeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;
  private readonly hasInitialCursor: boolean;
  private readonly streamClientId: string | null;

  private source: EventSourceLike | null = null;
  private started = false;
  private opened = false;
  private stopped = false;
  private cursor: number;
  private openTimer: number | undefined;
  private pollTimer: number | undefined;
  private polling = false;
  private pollFailures = 0;
  private sseFailures = 0;
  private recoveryPending = false;

  constructor(options: CollabEventsOptions) {
    this.url = options.url;
    this.onEvent = options.onEvent;
    this.onReconnect = options.onReconnect;
    this.onStatus = options.onStatus;
    this.eventSourceFactory = options.eventSourceFactory;
    this.poll = options.poll;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.maxPollBackoffMs = options.maxPollBackoffMs ?? DEFAULT_MAX_POLL_BACKOFF_MS;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.setTimer =
      options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.clearTimer = options.clearTimer ?? ((id) => globalThis.clearTimeout(id));
    this.hasInitialCursor = options.initialCursor !== undefined;
    this.streamClientId =
      options.streamClientId === undefined ? browserStreamClientId() : options.streamClientId;
    this.cursor = isCursor(options.initialCursor) ? options.initialCursor : 0;
  }

  /** Begin streaming (or polling). Calling it more than once is a no-op. */
  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    const factory = this.resolveFactory();
    if (factory === null) {
      this.startPolling(false);
      return;
    }
    this.report({ state: "connecting", transport: "sse", cursor: this.cursor });
    let source: EventSourceLike;
    try {
      source = factory(this.streamUrl());
    } catch {
      this.startPolling(false);
      return;
    }
    this.source = source;
    for (const type of FEED_EVENT_TYPES) {
      source.addEventListener(type, (event) => this.onFrame(type, event.data));
    }
    source.onopen = (): void => {
      const reconnecting = this.opened || this.sseFailures > 0;
      this.opened = true;
      this.sseFailures = 0;
      this.clearOpenTimer();
      this.report({ state: "connected", transport: "sse", cursor: this.cursor });
      if (reconnecting) {
        this.onReconnect?.();
      }
    };
    source.onerror = (): void => {
      if (!this.opened) {
        // Never came up: fall back to polling (which cannot lose rows).
        this.fallBackToPolling();
        return;
      }
      // Once opened, the browser auto-reconnects; the next `onopen` refetches.
      this.sseFailures += 1;
      this.report({
        state: "retrying",
        transport: "sse",
        cursor: this.cursor,
        attempt: this.sseFailures,
      });
    };
    this.openTimer = this.setTimer(() => {
      if (!this.opened && !this.stopped) {
        this.fallBackToPolling();
      }
    }, this.openTimeoutMs);
  }

  /** Tear down all transports and timers (element disconnect). */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearOpenTimer();
    if (this.pollTimer !== undefined) {
      this.clearTimer(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.closeSource();
    this.polling = false;
    this.report({ state: "stopped", transport: null, cursor: this.cursor });
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

  private streamUrl(): string {
    const query = new URLSearchParams();
    if (this.hasInitialCursor) query.set("after", String(this.cursor));
    if (this.streamClientId !== null) query.set("stream", this.streamClientId);
    if (query.size === 0) return this.url;
    const separator = this.url.includes("?") ? "&" : "?";
    return `${this.url}${separator}${query.toString()}`;
  }

  private onFrame(registeredType: string, data: string | undefined): void {
    if (this.stopped || data === undefined) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    const event = parseFeedEvent(parsed);
    if (
      event === null ||
      event.type !== registeredType ||
      !FEED_EVENT_TYPE_SET.has(event.type) ||
      event.id <= this.cursor
    ) {
      return;
    }
    this.cursor = event.id;
    this.onEvent(event);
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
    // A stream that never opened lost nothing; the initial fetch is fresh.
    this.startPolling(this.opened);
  }

  private startPolling(recoverOnEstablish: boolean): void {
    if (this.stopped || this.polling) {
      return;
    }
    this.polling = true;
    this.recoveryPending ||= recoverOnEstablish;
    this.report({ state: "connecting", transport: "poll", cursor: this.cursor });
    void this.pollOnce();
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const poll = this.poll ?? null;
    if (poll === null) {
      this.polling = false;
      this.report({ state: "unsupported", transport: "poll", cursor: this.cursor });
      return;
    }

    let result: Awaited<ReturnType<PollTransport>>;
    try {
      result = await poll(this.cursor);
    } catch {
      this.handlePollFailure();
      return;
    }
    if (this.stopped) {
      return;
    }
    if (!result.ok) {
      if (result.status === 404 || result.status === 405) {
        this.polling = false;
        this.report({
          state: "unsupported",
          transport: "poll",
          cursor: this.cursor,
          status: result.status,
        });
        return;
      }
      this.handlePollFailure(result.status);
      return;
    }
    if (!Array.isArray(result.items) || !isCursor(result.latestId)) {
      this.handlePollFailure();
      return;
    }

    let everyEnvelopeValid = true;
    for (const candidate of result.items as unknown[]) {
      const event = parseFeedEvent(candidate);
      if (event === null) {
        everyEnvelopeValid = false;
        continue;
      }
      if (event.id <= this.cursor) {
        continue;
      }
      // Advance over valid but unreviewed event types so one unknown row does
      // not wedge polling. Only allowlisted events reach the project store.
      this.cursor = event.id;
      if (FEED_EVENT_TYPE_SET.has(event.type)) {
        this.onEvent(event);
      }
    }
    // Do not report a malformed page as connected or advance to its
    // `latestId`. Valid rows already delivered from the page are naturally
    // de-duplicated when the retry starts from the retained cursor.
    if (!everyEnvelopeValid) {
      this.handlePollFailure();
      return;
    }
    if (result.latestId >= this.cursor) {
      this.cursor = result.latestId;
    }

    const recovered = this.recoveryPending || this.pollFailures > 0;
    this.recoveryPending = false;
    this.pollFailures = 0;
    this.report({ state: "connected", transport: "poll", cursor: this.cursor });
    if (recovered) {
      this.onReconnect?.();
    }
    this.schedulePoll(this.pollMs);
  }

  private handlePollFailure(status?: number): void {
    if (this.stopped) {
      return;
    }
    this.pollFailures += 1;
    this.recoveryPending = true;
    const exponent = Math.min(this.pollFailures - 1, 20);
    const retryInMs = Math.min(this.pollMs * 2 ** exponent, this.maxPollBackoffMs);
    this.report({
      state: "retrying",
      transport: "poll",
      cursor: this.cursor,
      attempt: this.pollFailures,
      retryInMs,
      ...(status === undefined ? {} : { status }),
    });
    this.schedulePoll(retryInMs);
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = undefined;
      void this.pollOnce();
    }, delayMs);
  }

  private report(status: CollabEventsStatus): void {
    this.onStatus?.(status);
  }
}

function isCursor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Runtime boundary for both JSON polling and parsed SSE data. */
function parseFeedEvent(value: unknown): FeedEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const payload = record["payload"];
  if (
    !isCursor(record["id"]) ||
    typeof record["type"] !== "string" ||
    record["type"].length === 0 ||
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  return {
    id: record["id"],
    type: record["type"],
    payload: payload as Record<string, unknown>,
  };
}
