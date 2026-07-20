/**
 * RFC 9457 `application/problem+json` responses with stable type slugs
 * (Phase 2 contract §4, design §15.1; shape matches openapi Problem schema:
 * `type`, `title`, `status`, `detail`, `code`, `correlationId`).
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./deps.js";

/** Stable problem type slugs. `code` carries the slug; `type` is a URI of it. */
export const PROBLEM_TYPES = {
  "validation-failed": { status: 400, title: "Request validation failed" },
  "idempotency-key-required": { status: 400, title: "Idempotency-Key header is required" },
  "bad-request": { status: 400, title: "Malformed request" },
  unauthorized: { status: 401, title: "Missing or invalid credential" },
  forbidden: { status: 403, title: "Actor lacks required scope or role" },
  "not-found": { status: 404, title: "Resource not found" },
  "revision-conflict": { status: 409, title: "Stale chapter revision" },
  "idempotency-key-mismatch": {
    status: 409,
    title: "Idempotency key was used with a different request",
  },
  "idempotency-key-in-flight": {
    status: 409,
    title: "A request with this idempotency key is still in flight",
  },
  "state-conflict": { status: 409, title: "Resource state forbids this operation" },
  "unsafe-content": { status: 422, title: "Body fails markdown safety rules" },
  "unknown-block": { status: 422, title: "Target block does not exist in this chapter revision" },
  "domain-rule-failed": { status: 422, title: "Domain rule failed" },
  internal: { status: 500, title: "Internal error" },
} as const;

export type ProblemSlug = keyof typeof PROBLEM_TYPES;

const TYPE_PREFIX = "https://authorbot.dev/problems/";

export interface ProblemExtras {
  detail?: string;
  /** Safe, structured extras (e.g. zod issues). Never credential material. */
  [key: string]: unknown;
}

/** Build a problem+json response on the Hono context. */
export function problem(
  c: Context<AppEnv>,
  slug: ProblemSlug,
  extras: ProblemExtras = {},
): Response {
  const { status, title } = PROBLEM_TYPES[slug];
  const correlationId = c.get("correlationId");
  const body: Record<string, unknown> = {
    type: `${TYPE_PREFIX}${slug}`,
    title,
    status,
    code: slug,
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...extras,
  };
  c.header("Content-Type", "application/problem+json; charset=utf-8");
  return c.body(JSON.stringify(body), status as ContentfulStatusCode);
}
