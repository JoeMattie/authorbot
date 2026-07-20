/**
 * Server-Sent Events stream over the `events` table (Phase 3 contract §5,
 * design §15.5). Workers-compatible: a plain `ReadableStream<Uint8Array>`
 * driven by `setInterval` polling of the cursor-ordered table — no Node
 * stream APIs. Heartbeat comments every 15s (configurable for tests); the
 * client resumes with `Last-Event-ID` (or `?after=`), and must refetch
 * authoritative resources after reconnecting (events are notifications, not
 * state).
 */
import type { EventRecord } from "@authorbot/database";

export const DEFAULT_SSE_POLL_MS = 1_000;
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
/** Rows fetched per poll; the pump keeps reading while pages are full. */
const PAGE_LIMIT = 100;

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

export interface SseStreamOptions {
  /** Rows strictly after the cursor, id-ordered (EventsRepository.listAfter). */
  listAfter(afterId: number, limit: number): Promise<EventRecord[]>;
  /** Resume cursor: stream starts strictly after this id. */
  initialCursor: number;
  pollMs?: number;
  heartbeatMs?: number;
}

/**
 * Build the `text/event-stream` response. The stream polls for new rows,
 * frames them in id order, and emits `: heartbeat` comments between events;
 * `cancel` (client disconnect) tears both timers down.
 */
export function sseResponse(options: SseStreamOptions, headers: Headers = new Headers()): Response {
  const pollMs = options.pollMs ?? DEFAULT_SSE_POLL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const encoder = new TextEncoder();

  let cursor = options.initialCursor;
  let closed = false;
  let pumping = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    closed = true;
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
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
            for (const row of rows) {
              send(sseFrame(row));
              cursor = row.id;
            }
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
    },
    cancel(): void {
      stop();
    },
  });

  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  return new Response(stream, { status: 200, headers });
}
