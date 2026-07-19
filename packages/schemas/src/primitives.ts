import { z } from "zod";

/**
 * Shared identifier and reference primitives (Phase 0 contract section 2).
 */

/** Story node / timeline / bible ID kinds (contract section 2). */
export const NODE_KINDS = [
  "premise",
  "arc",
  "part",
  "chapter",
  "scene",
  "beat",
  "event",
  "character",
  "location",
  "concept",
  "rule",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Actor reference namespaces (contract section 2). */
export const ACTOR_NAMESPACES = ["github", "agent", "system"] as const;
export type ActorNamespace = (typeof ACTOR_NAMESPACES)[number];

/** Slug source pattern: `[a-z0-9][a-z0-9-]*` (contract section 2). */
export const SLUG_PATTERN = "[a-z0-9][a-z0-9-]*";

/**
 * Lowercase UUIDv7 (contract section 2): version nibble must be `7`, variant
 * nibble must be RFC 4122 (`8`, `9`, `a`, or `b`).
 */
export const UUIDV7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const uuidv7Schema = z
  .string()
  .regex(UUIDV7_REGEX, "must be a lowercase UUIDv7 (version nibble 7)");
export type UuidV7 = z.infer<typeof uuidv7Schema>;

/** Path-traversal-safe slug (contract section 2). */
export const slugSchema = z
  .string()
  .regex(new RegExp(`^${SLUG_PATTERN}$`), "must match [a-z0-9][a-z0-9-]*");
export type Slug = z.infer<typeof slugSchema>;

/** `<kind>:<slug>` node ID for any known kind (contract section 2). */
export const nodeIdSchema = z
  .string()
  .regex(
    new RegExp(`^(?:${NODE_KINDS.join("|")}):${SLUG_PATTERN}$`),
    `must be <kind>:<slug> with kind one of ${NODE_KINDS.join("|")}`,
  );
export type NodeId = z.infer<typeof nodeIdSchema>;

/** `<kind>:<slug>` node ID restricted to one specific kind. */
export function nodeIdOf<K extends NodeKind>(kind: K): z.ZodString {
  return z
    .string()
    .regex(
      new RegExp(`^${kind}:${SLUG_PATTERN}$`),
      `must be a "${kind}:<slug>" id`,
    );
}

/**
 * Actor reference `<namespace>:<identifier>` (contract section 2).
 * The identifier charset is not pinned by the contract; this package accepts
 * `[A-Za-z0-9][A-Za-z0-9._-]*` (covers GitHub logins, agent names, and system
 * components) and rejects whitespace, colons, and leading punctuation.
 */
export const actorRefSchema = z
  .string()
  .regex(
    new RegExp(`^(?:${ACTOR_NAMESPACES.join("|")}):[A-Za-z0-9][A-Za-z0-9._-]*$`),
    `must be <namespace>:<identifier> with namespace one of ${ACTOR_NAMESPACES.join("|")}`,
  );
export type ActorRef = z.infer<typeof actorRefSchema>;

/**
 * RFC 3339 UTC timestamp (contract section 2), e.g. `2026-07-19T18:00:00Z`.
 * Seconds are mandatory, fractional seconds optional, offset must be `Z`.
 * Field ranges (month 01-12, day 01-31, hour 00-23, leap second 60) are
 * enforced by the pattern so the schema stays fully JSON-Schema representable.
 */
export const RFC3339_UTC_REGEX =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d{1,9})?Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Calendar rules the pattern cannot express (RFC 3339 section 5.7): the
 * day-of-month must exist for the month/year, and second `60` is only legal
 * at a leap-second instant (`23:59:60` UTC). Assumes the pattern already
 * matched; safe on arbitrary strings.
 */
function isCalendarValid(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay =
    month === 2 && isLeapYear ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  if (day > maxDay) {
    return false;
  }
  if (value.slice(17, 19) === "60" && value.slice(11, 16) !== "23:59") {
    return false;
  }
  return true;
}

/**
 * Stricter than the generated JSON Schema: the `.refine` below rejects
 * calendar-invalid dates (e.g. `2026-02-30`) and misplaced leap seconds,
 * while `z.toJSONSchema` emits only the pattern (refinements are not
 * JSON-Schema representable).
 */
export const timestampSchema = z
  .string()
  .regex(
    RFC3339_UTC_REGEX,
    "must be an RFC 3339 UTC timestamp like 2026-07-19T18:00:00Z",
  )
  .refine(isCalendarValid, "must be a real calendar date/time (RFC 3339)");
export type Timestamp = z.infer<typeof timestampSchema>;

/** ISO 8601 duration, e.g. `PT30M` (design section 25 lease settings). */
export const ISO8601_DURATION_REGEX =
  /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;

export const isoDurationSchema = z
  .string()
  .regex(ISO8601_DURATION_REGEX, "must be an ISO 8601 duration like PT30M");
export type IsoDuration = z.infer<typeof isoDurationSchema>;

/** Git commit SHA (abbreviated 7 chars up to SHA-256 64 chars). */
export const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, "must be a lowercase hex commit SHA");
export type CommitSha = z.infer<typeof commitShaSchema>;
