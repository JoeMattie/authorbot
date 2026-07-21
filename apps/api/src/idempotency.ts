/**
 * Idempotency-Key middleware (Phase 2 contract §4, design §15.1): required on
 * every authenticated mutation.
 *
 * Atomic claim design: the `(project, actor, key)` claim row is inserted
 * TOGETHER WITH its stored response in the same `db.batch` as the command's
 * own statements (the handler pushes `claim(status, body)` into its batch).
 * Consequences:
 *   - same key + same request hash + stored response → replay it;
 *   - same key + different request hash → 409 `idempotency-key-mismatch`;
 *   - two concurrent requests with the same key: both may run their handlers,
 *     but only one batch commits - the loser's batch fails on the unique
 *     index, is rolled back atomically (no duplicate annotation/operation/
 *     outbox/token rows), and the loser replays the winner's stored response;
 *   - a crash before the batch leaves nothing behind (a retry re-executes);
 *     a crash after the batch left the response stored (a retry replays).
 * There is no window in which a claim exists without a response, so a retry
 * can never re-execute an already-persisted mutation (previously the claim
 * was inserted before the handler and the response stored after it, letting
 * a same-key retry duplicate the whole command).
 *
 * Failed (non-2xx) attempts insert nothing: they re-execute under the same
 * key, and a corrected body is not blocked by a stale hash.
 *
 * The optional `redactStored` hook lets a handler keep return-once secrets
 * (the agent-token plaintext) out of the stored replay body: replays of a
 * mint never contain the token again (contract §3: "the plaintext appears
 * exactly once in the mint response").
 */
import type { MiddlewareHandler } from "hono";
import {
  isUniqueConstraintError,
  type Repositories,
  type SqlStatement,
} from "@authorbot/database";
import { toTimestamp } from "@authorbot/domain";
import { sha256Hex } from "./crypto.js";
import type { AppEnv, Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";
import { problem } from "./problems.js";
import { authOf } from "./auth.js";
import type { ProjectRecord } from "@authorbot/database";

const MAX_KEY_LENGTH = 200;

export interface IdempotencyServices {
  repos: Repositories;
  clock: Clock;
  getProject(): Promise<ProjectRecord | null>;
}

export interface IdempotencyOptions {
  /** Transform the 2xx JSON body before storing it for replays. */
  redactStored?: (body: unknown) => unknown;
}

/** Per-request claim handle the middleware exposes to mutation handlers. */
export interface IdempotencyClaim {
  /**
   * Statement that atomically claims the key AND stores the response; the
   * handler MUST include it in the same `db.batch` as the command statements.
   * `body` is the exact JSON value the handler responds with (`null` for an
   * empty body); redaction (if configured) is applied before storage.
   */
  claim(status: number, body: unknown): SqlStatement;
  /** Set by the handler once the claim statement was batched. */
  claimed: boolean;
}

export function idempotency(
  services: IdempotencyServices,
  options: IdempotencyOptions = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (key === undefined || key.length === 0) {
      return problem(c, "idempotency-key-required");
    }
    if (key.length > MAX_KEY_LENGTH) {
      return problem(c, "validation-failed", {
        detail: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`,
      });
    }
    const project = await services.getProject();
    if (project === null) {
      return problem(c, "not-found", { detail: "unknown project" });
    }
    const auth = authOf(c);

    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(
      `${c.req.method}\n${new URL(c.req.url).pathname}\n${rawBody}`,
    );

    const existing = await services.repos.idempotencyKeys.get(project.id, auth.actor.id, key);
    if (existing !== null) {
      return (
        replayOrConflict(c, existing, requestHash) ?? problem(c, "idempotency-key-in-flight")
      );
    }

    const serializeStored = (body: unknown): string => {
      if (body === null || body === undefined) {
        return "";
      }
      const redacted = options.redactStored !== undefined ? options.redactStored(body) : body;
      return JSON.stringify(redacted);
    };

    const handle: IdempotencyClaim = {
      claimed: false,
      claim: (status: number, body: unknown): SqlStatement =>
        services.repos.idempotencyKeys.insertStatement({
          id: uuidv7(services.clock.now()),
          projectId: project.id,
          actorId: auth.actor.id,
          key,
          requestHash,
          responseStatus: status,
          responseBody: serializeStored(body),
          createdAt: toTimestamp(services.clock.now()),
        }),
    };
    c.set("idempotency", handle);

    await next();

    // Lost claim race: Hono routes handler exceptions to `onError` at the
    // innermost dispatch level - they do NOT propagate through `next()` - so
    // a batch that failed on the unique (project, actor, key) index surfaces
    // here as `c.error` plus the onError 500 response. The batch is atomic:
    // nothing of this attempt persisted, so replaying the winner's stored
    // response is always safe.
    if (handle.claimed && c.error !== undefined && isUniqueConstraintError(c.error)) {
      const raced = await services.repos.idempotencyKeys.get(project.id, auth.actor.id, key);
      if (raced !== null) {
        // Replace the onError 500 with the replay (or the mismatch/in-flight
        // problem). Assigning c.res swaps the response body/status.
        c.res = replayOrConflict(c, raced, requestHash) ?? problem(c, "idempotency-key-in-flight");
        return;
      }
      // Some other unique index fired and no stored response exists: keep
      // the onError 500 - the mutation did not persist.
    }

    // Fallback for 2xx handlers that did not batch a claim (none today, but
    // the contract must hold even if a future handler forgets): store the
    // response post-hoc. Losing this insert race is fine - a stored response
    // already exists and our own response was produced normally.
    const status = c.res.status;
    if (status >= 200 && status < 300 && !handle.claimed) {
      const text = await c.res.clone().text();
      try {
        await services.repos.idempotencyKeys.insert({
          id: uuidv7(services.clock.now()),
          projectId: project.id,
          actorId: auth.actor.id,
          key,
          requestHash,
          responseStatus: status,
          responseBody: text.length > 0 ? serializeStored(JSON.parse(text)) : "",
          createdAt: toTimestamp(services.clock.now()),
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
      }
    }
  };
}

function replayOrConflict(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  record: { requestHash: string; responseStatus: number | null; responseBody: string | null },
  requestHash: string,
): Response | null {
  if (record.requestHash !== requestHash) {
    return problem(c, "idempotency-key-mismatch");
  }
  if (record.responseStatus === null) {
    // Unreachable with atomic claims (claim and response are stored
    // together); kept as a conservative in-flight signal for legacy rows.
    return null;
  }
  const headers = new Headers({ "X-Idempotency-Replayed": "true" });
  const correlationId = c.get("correlationId");
  if (correlationId !== undefined) {
    headers.set("X-Correlation-Id", correlationId);
  }
  const body = record.responseBody ?? "";
  if (body.length > 0) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(body.length > 0 ? body : null, {
    status: record.responseStatus,
    headers,
  });
}
