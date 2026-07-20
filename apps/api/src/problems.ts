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
  "csrf-origin-mismatch": {
    status: 403,
    title: "Cookie-authenticated mutation from a disallowed origin",
  },
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
  // ---- Phase 4 lease/submission problems (contract §2, §4) ------------------
  "lease-held": { status: 409, title: "Work item is already leased" },
  "lease-expired": { status: 409, title: "Lease has expired" },
  "lease-inactive": { status: 409, title: "Lease has been released or revoked" },
  "lease-max-total-exceeded": {
    status: 409,
    title: "Lease has reached its maximum total duration",
  },
  "lease-token-invalid": { status: 403, title: "Lease token does not match" },
  "submission-base-mismatch": {
    status: 409,
    title: "Submission base does not match the lease's task bundle",
  },
  "submission-type-mismatch": {
    status: 422,
    title: "Submission type does not match the work item type",
  },
  "submission-not-supported": {
    status: 422,
    title: "Work item type has no submission flow in this phase",
  },
  "unsafe-content": { status: 422, title: "Body fails markdown safety rules" },
  "unknown-block": { status: 422, title: "Target block does not exist in this chapter revision" },
  "domain-rule-failed": { status: 422, title: "Domain rule failed" },
  // ---- Phase 5 reconciliation / publication problems (contract §6) ---------
  "project-diverged": {
    status: 409,
    title: "Book repository diverged from the projection",
  },
  "signature-invalid": { status: 401, title: "Missing or invalid callback signature" },
  // ---- Phase 6 settings problems (contract §3.6) ---------------------------
  /**
   * A never-editable field appeared in a settings patch. 422 rather than 403:
   * the actor is permitted to change settings, but this field is not a setting
   * anyone can change through the API. The response names each field and why.
   */
  "settings-field-immutable": {
    status: 422,
    title: "Field cannot be changed through the API",
  },
  /**
   * A guarded field (`slug`, `publication.chapter_url`) would change without
   * the request confirming it. The response states what breaks and echoes the
   * exact `confirm` value that would let the change proceed.
   */
  "settings-confirmation-required": {
    status: 409,
    title: "Change requires explicit confirmation",
  },
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
