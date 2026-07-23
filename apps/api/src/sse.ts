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
 * Concurrent streams one client address may hold (per isolate).
 *
 * Generous for the honest case - a reader with several tabs open on the book,
 * plus an agent or two - and a hard stop for a loop that opens sockets without
 * closing them. Per isolate rather than globally because Workers scale by
 * running more isolates and there is no shared cheap counter for a read path;
 * an approximate cap that costs nothing is worth more here than an exact one
 * that costs a database round trip on every connect.
 */
export const DEFAULT_SSE_MAX_STREAMS_PER_CLIENT = 8;
/** Rows fetched per poll; the pump keeps reading while pages are full. */
const PAGE_LIMIT = 100;

/** A held stream slot; `release` is idempotent. */
export interface StreamSlot {
  release(): void;
}

export interface StreamLimiter {
  /** Take a slot for `key`, or `null` when that client is already at the cap. */
  acquire(key: string): StreamSlot | null;
  /** Slots currently held for `key` (tests and diagnostics). */
  active(key: string): number;
  readonly max: number;
}

/**
 * Per-client concurrent-stream accounting.
 *
 * Deliberately a plain `Map` with no expiry: a slot is released by the stream
 * that took it - on client disconnect, on the lifetime cap, or on a write
 * failure - and every one of those paths funnels through the same `stop()`, so
 * a key cannot leak while its stream is gone. Keys are removed as their count
 * reaches zero, which is what keeps the map bounded by live connections rather
 * than by every address ever seen.
 */
export function createStreamLimiter(
  max: number = DEFAULT_SSE_MAX_STREAMS_PER_CLIENT,
): StreamLimiter {
  const counts = new Map<string, number>();
  return {
    max,
    active: (key) => counts.get(key) ?? 0,
    acquire(key) {
      const held = counts.get(key) ?? 0;
      if (held >= max) return null;
      counts.set(key, held + 1);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          const next = (counts.get(key) ?? 1) - 1;
          if (next <= 0) counts.delete(key);
          else counts.set(key, next);
        },
      };
    },
  };
}

/**
 * The address a stream is counted against.
 *
 * `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by the client;
 * `X-Forwarded-For` is a fallback for other front ends and is read only for its
 * first entry. A request with neither - every in-process test, and any direct
 * connection - shares the `unknown` bucket, which is the conservative answer:
 * unattributable connections are pooled rather than each granted their own cap.
 */
export function streamClientKey(headers: Headers): string {
  const direct = headers.get("cf-connecting-ip");
  if (direct !== null && direct.length > 0) return direct;
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.length > 0) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return "unknown";
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

  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
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
