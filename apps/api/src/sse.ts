/**
 * Server-Sent Events stream over the `events` table (Phase 3 contract §5,
 * design §15.5). Workers-compatible: a plain `ReadableStream<Uint8Array>`
 * driven by `setInterval` polling of the cursor-ordered table - no Node
 * stream APIs. Heartbeat comments every 15s (configurable for tests); the
 * client resumes with `Last-Event-ID` (or `?after=`), and must refetch
 * authoritative resources after reconnecting (events are notifications, not
 * state).
 */
import type { EventRecord } from "@authorbot/database";
import type { AuthContext } from "./deps.js";

export const DEFAULT_SSE_POLL_MS = 1_000;
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
/**
 * How long one stream may live before the server closes it (contract §5: the
 * client resumes with `Last-Event-ID`).
 *
 * An SSE connection is the cheapest thing an unauthenticated caller can ask
 * this API for and the most expensive thing to hold: a timer pair and a
 * database poll every second, for as long as the socket stays open. With no
 * ceiling, "open a stream and walk away" was an unbounded, uncounted, and -
 * on a book with `PUBLIC_ANNOTATIONS=true` - unauthenticated commitment; the
 * rate limiter cannot help, because it runs only on mutations.
 *
 * Five minutes is chosen because the cost of being wrong is nil: every client
 * already reconnects with its resume cursor and receives every row it missed,
 * so a periodic close is invisible except as a fresh connection. Bounded
 * lifetimes also mean a deploy drains rather than lingers.
 */
export const DEFAULT_SSE_MAX_LIFETIME_MS = 5 * 60_000;
/**
 * Distinct streams one authenticated credential may hold (per isolate).
 *
 * Generous for the honest case - a reader with several tabs open on the book -
 * and a hard stop for a loop that opens sockets without closing them. Per
 * isolate rather than globally because Workers scale by
 * running more isolates and there is no shared cheap counter for a read path;
 * an approximate cap that costs nothing is worth more here than an exact one
 * that costs a database round trip on every connect.
 */
export const DEFAULT_SSE_MAX_STREAMS_PER_CLIENT = 8;
/** Rows fetched per poll; the pump keeps reading while pages are full. */
const PAGE_LIMIT = 100;

/** A held stream slot; `release` is idempotent. */
export interface StreamSlot {
  /**
   * Register how to close the stream when a newer connection from the same
   * browser tab supersedes it. This is deliberately separate from `release`:
   * replacement actively drains a stale Worker stream instead of merely
   * forgetting it for accounting purposes.
   */
  onSuperseded(close: () => void): void;
  release(): void;
}

export interface StreamLimiter {
  /**
   * Take a slot for one credential and browser client, or `null` when that
   * credential already has the maximum number of distinct clients.
   */
  acquire(ownerKey: string, clientId?: string): StreamSlot | null;
  /** Distinct client slots currently held for an owner (tests/diagnostics). */
  active(ownerKey: string): number;
  readonly max: number;
}

/**
 * Per-credential, per-browser-client concurrent-stream accounting.
 *
 * The earlier limiter counted only `CF-Connecting-IP`. That pooled unrelated
 * people behind a NAT, and a browser navigating quickly could leave enough
 * not-yet-cancelled Worker streams behind to reject its next page with 429.
 * A stable browser client id now replaces its own prior stream. Replacement
 * actively closes that prior stream, while distinct tabs/agents still count
 * against the credential's hard ceiling.
 */
export function createStreamLimiter(
  max: number = DEFAULT_SSE_MAX_STREAMS_PER_CLIENT,
): StreamLimiter {
  interface HeldStream {
    close: (() => void) | null;
  }

  const streams = new Map<string, Map<string | symbol, HeldStream>>();
  return {
    max,
    active: (ownerKey) => streams.get(ownerKey)?.size ?? 0,
    acquire(ownerKey, clientId) {
      const held = streams.get(ownerKey) ?? new Map<string | symbol, HeldStream>();
      const slotKey = clientId ?? Symbol("legacy-event-stream");
      const superseded = held.get(slotKey);
      if (superseded === undefined && held.size >= max) return null;

      const entry: HeldStream = { close: null };
      held.set(slotKey, entry);
      streams.set(ownerKey, held);

      // Store the replacement before closing the old stream. Its synchronous
      // `release()` then sees that it no longer owns this key and cannot remove
      // the new connection's slot.
      superseded?.close?.();

      let released = false;
      return {
        onSuperseded(close) {
          if (!released) entry.close = close;
        },
        release() {
          if (released) return;
          released = true;
          entry.close = null;
          const current = streams.get(ownerKey);
          if (current?.get(slotKey) !== entry) return;
          current.delete(slotKey);
          if (current.size === 0) streams.delete(ownerKey);
        },
      };
    },
  };
}

/**
 * Stable, non-secret owner for stream accounting.
 *
 * SSE is available only to authenticated project members, so credential ids
 * are both more precise and safer than a public IP. A session and token for the
 * same actor remain independent because they have independent revocation and
 * capability lifecycles.
 */
export function streamOwnerKey(auth: AuthContext): string {
  if (auth.kind === "session" && auth.sessionId !== undefined) {
    return `session:${auth.sessionId}`;
  }
  if (auth.kind === "token" && auth.tokenId !== undefined) {
    return `token:${auth.tokenId}`;
  }
  // Auth construction guarantees the credential-specific id. Retaining this
  // fail-closed fallback keeps out-of-band test contexts bounded by actor.
  return `${auth.kind}:actor:${auth.actor.id}`;
}

export function eventJson(event: EventRecord): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

/** One SSE frame: the event id doubles as the resume cursor. */
export function sseFrame(event: EventRecord): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(eventJson(event))}\n\n`;
}

/** Advance EventSource's reconnect cursor without dispatching a client event. */
function sseCursorCheckpoint(id: number): string {
  return `id: ${id}\n\n`;
}

export interface SseStreamOptions {
  /** Rows strictly after the cursor, id-ordered (EventsRepository.listAfter). */
  listAfter(afterId: number, limit: number): Promise<EventRecord[]>;
  /**
   * Optional per-request visibility boundary. A null result suppresses the
   * frame, but the raw row still advances the in-connection cursor.
   */
  projectEvent?: (event: EventRecord) => EventRecord | null;
  /** Resume cursor: stream starts strictly after this id. */
  initialCursor: number;
  pollMs?: number;
  heartbeatMs?: number;
  /** Server-side lifetime cap; the client reconnects with its cursor. */
  maxLifetimeMs?: number;
  /** Abort a superseded stream from the same browser client immediately. */
  signal?: AbortSignal;
  /** Run when the stream ends, however it ends (release the client's slot). */
  onClose?: () => void;
}

/**
 * Build the `text/event-stream` response. The stream polls for new rows,
 * frames them in id order, and emits `: heartbeat` comments between events;
 * `cancel` (client disconnect) tears both timers down.
 */
export function sseResponse(options: SseStreamOptions, headers: Headers = new Headers()): Response {
  const pollMs = options.pollMs ?? DEFAULT_SSE_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_SSE_MAX_LIFETIME_MS;
  const encoder = new TextEncoder();

  let cursor = options.initialCursor;
  let closed = false;
  let pumping = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let abortStream: (() => void) | undefined;

  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
    if (abortStream !== undefined) options.signal?.removeEventListener("abort", abortStream);
    options.onClose?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const send = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      abortStream = (): void => {
        stop();
        try {
          controller.close();
        } catch {
          // Already closed by the peer.
        }
      };
      if (options.signal?.aborted === true) {
        abortStream();
        return;
      }
      options.signal?.addEventListener("abort", abortStream, { once: true });
      const pump = async (): Promise<void> => {
        if (pumping || closed) return;
        pumping = true;
        try {
          for (;;) {
            const rows = await options.listAfter(cursor, PAGE_LIMIT);
            let suppressedThrough: number | null = null;
            for (const row of rows) {
              cursor = row.id;
              const visible = options.projectEvent === undefined
                ? row
                : options.projectEvent(row);
              if (visible === null) {
                suppressedThrough = row.id;
              } else {
                send(sseFrame(visible));
                suppressedThrough = null;
              }
            }
            // An id-only SSE block updates the browser's Last-Event-ID but
            // dispatches no MessageEvent. Without it, a token whose tail is
            // entirely filtered reconnects from its old cursor and rescans
            // the same hidden history after every stream lifetime.
            if (suppressedThrough !== null) send(sseCursorCheckpoint(suppressedThrough));
            if (rows.length < PAGE_LIMIT || closed) break;
          }
        } catch {
          // A transient read failure must not kill the stream; the next tick
          // retries from the same cursor (at-least-once within a connection).
        } finally {
          pumping = false;
        }
      };
      // Reconnection hint, then the replay of rows after the resume cursor.
      send(`retry: ${Math.max(pollMs, 1_000)}\n\n`);
      void pump();
      pollTimer = setInterval(() => {
        void pump();
      }, pollMs);
      heartbeatTimer = setInterval(() => {
        send(`: heartbeat\n\n`);
      }, heartbeatMs);
      if (maxLifetimeMs > 0 && Number.isFinite(maxLifetimeMs)) {
        lifetimeTimer = setTimeout(() => {
          // One last pump so the cursor the client resumes from is as fresh as
          // it can be, then a clean close. `retry:` was already sent, so the
          // client reconnects on its own and replays from `Last-Event-ID`.
          void pump().finally(() => {
            stop();
            try {
              controller.close();
            } catch {
              // Already closed by the peer; nothing left to do.
            }
          });
        }, maxLifetimeMs);
      }
    },
    cancel(): void {
      stop();
    },
  });

  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  return new Response(stream, { status: 200, headers });
}
