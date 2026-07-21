/**
 * Typed fault injection for the fake GitHub (Phase 5 contract §7).
 *
 * Every fault is an explicit, named, typed option with a firing budget - no
 * magic paths, no magic header values, no "if the branch is called
 * `boom`" strings. A fault with `times: 1` fires exactly once and then the
 * fake behaves normally, which is what the writer's retry tests need: they
 * assert that the *second* attempt succeeds, not that failures repeat.
 *
 * Faults are consumed in the order requests reach them; `remaining()` and
 * `assertAllFired()` let a test prove a fault actually fired rather than
 * silently passing because the code path was never taken.
 */
import type { RepoFileMap } from "./repo-state.js";

/** A fault that fires a bounded number of times. `times` defaults to 1. */
export interface CountedFault {
  times?: number;
}

/**
 * Simulate a concurrent push landing between the writer's ref read and its
 * ref update. After `times` successful reads of `refs/heads/{branch}`, the
 * fake commits `files` onto that branch out of band. The writer's own commit
 * then has a stale parent, so its non-force `PATCH` is a genuine
 * non-fast-forward - a real race, not a synthesized status code.
 */
export interface MovedHeadFault extends CountedFault {
  /** Branch whose ref reads arm the fault. */
  branch: string;
  /** Files the out-of-band commit writes. */
  files: RepoFileMap;
  message?: string;
}

/**
 * `GET /git/trees/{sha}?recursive=1` answers with `truncated: true` and a
 * clipped entry list. The reader must treat this as an explicit error, never
 * as a silent partial snapshot (contract §3).
 */
export interface TruncatedTreeFault extends CountedFault {
  /** How many entries to keep before clipping. Default 1. */
  keepEntries?: number;
}

/**
 * Repository requests answer `401 Bad credentials` even with a valid token,
 * forcing the auth layer to discard its cached installation token and fetch a
 * new one (contract §2: "refreshed on 401").
 */
export type UnauthorizedFault = CountedFault;

/**
 * `PATCH /git/refs/heads/{branch}` answers `422 Update is not a fast forward`
 * regardless of real ancestry. Prefer `movedHead` when the test wants a true
 * race; use this to drive the retry bound to exhaustion.
 */
export interface NonFastForwardFault extends CountedFault {
  /** Restrict the fault to one branch. Default: every branch. */
  branch?: string;
}

/** `403` with the secondary-rate-limit headers GitHub sends. */
export interface RateLimitFault extends CountedFault {
  /** `retry-after` header, seconds. Omitted when unset. */
  retryAfterSeconds?: number;
  /** `x-ratelimit-reset` header, epoch seconds. Default: now + 60. */
  resetEpochSeconds?: number;
  /** Use the secondary-rate-limit message and documentation url. */
  secondary?: boolean;
}

/** `POST /app/installations/{id}/access_tokens` fails with `status`. */
export interface InstallationTokenFault extends CountedFault {
  /** Default 401. Use 404 to simulate a revoked installation. */
  status?: number;
  message?: string;
}

/**
 * The full fault surface. All optional; absent means "behave correctly".
 * Also accepted as `createFakeGitHub({ faults })` for setup-time injection.
 */
export interface FakeGitHubFaults {
  movedHead?: MovedHeadFault;
  truncatedTree?: TruncatedTreeFault;
  unauthorized?: UnauthorizedFault;
  nonFastForward?: NonFastForwardFault;
  rateLimited?: RateLimitFault;
  installationTokenFailure?: InstallationTokenFault;
}

export type FaultName = keyof FakeGitHubFaults;

export const FAULT_NAMES: readonly FaultName[] = [
  "movedHead",
  "truncatedTree",
  "unauthorized",
  "nonFastForward",
  "rateLimited",
  "installationTokenFailure",
];

interface ArmedFault<Name extends FaultName> {
  config: NonNullable<FakeGitHubFaults[Name]>;
  remaining: number;
}

/** Mutable fault budget shared by the fake's request handlers. */
export class FaultController {
  #armed = new Map<FaultName, ArmedFault<FaultName>>();

  constructor(faults: FakeGitHubFaults = {}) {
    this.setAll(faults);
  }

  /** Arm (or re-arm) one fault. Passing `undefined` disarms it. */
  set<Name extends FaultName>(name: Name, config: FakeGitHubFaults[Name] | undefined): void {
    if (config === undefined) {
      this.#armed.delete(name);
      return;
    }
    const times = config.times ?? 1;
    if (!Number.isInteger(times) || times < 0) {
      throw new Error(`fault ${name}: times must be a non-negative integer`);
    }
    this.#armed.set(name, { config, remaining: times });
  }

  setAll(faults: FakeGitHubFaults): void {
    for (const name of FAULT_NAMES) {
      if (name in faults) this.set(name, faults[name]);
    }
  }

  /** Remaining firings for a fault (0 when disarmed or spent). */
  remaining(name: FaultName): number {
    return this.#armed.get(name)?.remaining ?? 0;
  }

  /** Faults that were armed but still have firings left. */
  pending(): FaultName[] {
    return FAULT_NAMES.filter((name) => this.remaining(name) > 0);
  }

  /** Throw when any armed fault never fired - guards vacuously-passing tests. */
  assertAllFired(): void {
    const pending = this.pending();
    if (pending.length > 0) {
      throw new Error(`fake GitHub faults never fired: ${pending.join(", ")}`);
    }
  }

  /** Disarm everything. */
  clear(): void {
    this.#armed.clear();
  }

  /**
   * Inspect a fault's config without consuming a firing. `null` when the
   * fault is disarmed or spent.
   */
  peek<Name extends FaultName>(name: Name): NonNullable<FakeGitHubFaults[Name]> | null {
    const armed = this.#armed.get(name);
    if (!armed || armed.remaining <= 0) return null;
    return armed.config as NonNullable<FakeGitHubFaults[Name]>;
  }

  /**
   * Consume one firing of `name` if it is armed, returning its config; else
   * `null`. Callers branch on the return value, so a spent fault is
   * indistinguishable from an absent one.
   *
   * `applies` guards the budget: a fault scoped to one branch must not be
   * burned by a request touching a different branch, or a test that arms it
   * for `times: 1` would see it silently disappear.
   */
  take<Name extends FaultName>(
    name: Name,
    applies?: (config: NonNullable<FakeGitHubFaults[Name]>) => boolean,
  ): NonNullable<FakeGitHubFaults[Name]> | null {
    const config = this.peek(name);
    if (config === null) return null;
    if (applies && !applies(config)) return null;
    const armed = this.#armed.get(name);
    if (armed) armed.remaining -= 1;
    return config;
  }
}
