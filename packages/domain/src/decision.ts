/**
 * Typed authorization/transition decisions (Phase 2 contract section 3).
 * Every domain rule that can refuse returns `allowed | denied(reason)` so the
 * API layer can map reasons to problem+json types without string matching.
 */

export interface Allowed {
  readonly allowed: true;
}

export interface Denied<TReason extends string = string> {
  readonly allowed: false;
  readonly reason: TReason;
  /** Human-readable explanation; safe to surface (never contains secrets). */
  readonly message: string;
}

export type Decision<TReason extends string = string> = Allowed | Denied<TReason>;

export const ALLOWED: Allowed = Object.freeze({ allowed: true });

export function denied<TReason extends string>(
  reason: TReason,
  message: string,
): Denied<TReason> {
  return { allowed: false, reason, message };
}
