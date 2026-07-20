/**
 * CORS middleware (Phase 2b contract §3): explicit exact-origin allow-list
 * (ALLOWED_ORIGINS), credentialed responses, preflight handling. No wildcard
 * ever — an unlisted Origin gets no CORS headers at all. Inactive (pure
 * pass-through) when no origins are configured: the same-origin deployment
 * needs no CORS.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./deps.js";

const ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
/** Headers the islands send: JSON bodies, bearer tokens, idempotent commands. */
const ALLOW_HEADERS = "Authorization, Content-Type, Idempotency-Key, X-Correlation-Id";
const EXPOSE_HEADERS = "X-Correlation-Id";
const MAX_AGE_SECONDS = "600";

export function cors(allowedOrigins: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (allowedOrigins.length === 0) {
      await next();
      return;
    }
    const origin = c.req.header("origin");
    const allowed = origin !== undefined && allowedOrigins.includes(origin);

    const isPreflight =
      c.req.method === "OPTIONS" &&
      c.req.header("access-control-request-method") !== undefined;
    if (isPreflight) {
      // Short-circuit before auth/routing: preflights carry no credentials.
      if (allowed) {
        c.header("Access-Control-Allow-Origin", origin);
        c.header("Access-Control-Allow-Credentials", "true");
        c.header("Access-Control-Allow-Methods", ALLOW_METHODS);
        c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
        c.header("Access-Control-Max-Age", MAX_AGE_SECONDS);
      }
      c.header("Vary", "Origin");
      return c.body(null, 204);
    }

    await next();
    c.res.headers.append("Vary", "Origin");
    if (allowed) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.set("Access-Control-Allow-Credentials", "true");
      c.res.headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    }
  };
}
