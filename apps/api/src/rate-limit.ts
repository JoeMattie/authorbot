/**
 * Per-actor and per-token rate limits on every mutation (Phase 7 contract
 * Scope, exit criterion 1).
 *
 * ## The shape of the threat
 *
 * "Voting, claiming, and submission endpoints first — they are the ones a fleet
 * hits hardest." A fleet is not a browser: it retries on a tight loop, it runs
 * N copies, and its failure mode is a thousand identical requests a second
 * rather than one user clicking twice. The ceilings below are therefore set to
 * a generous multiple of what a well-behaved agent needs and a small fraction
 * of what a runaway produces — the goal is to blunt a loop, not to meter usage.
 *
 * ## Per actor AND per token
 *
 * Both, checked together, because they answer different questions. The ACTOR
 * limit bounds what one identity can do however many credentials it holds; the
 * TOKEN limit bounds one credential, so a single leaked or looping token cannot
 * consume its owner's entire allowance and starve their other agents. A request
 * must pass both. Human sessions have only the actor limit — a person holds one
 * session per browser and the session id is not a durable identity worth
 * counting separately.
 *
 * ## Reads are never counted
 *
 * Exit criterion: limits "do not fire on reads". The limiter is invoked from
 * `requireProjectScope` only for unsafe methods, so a GET neither consumes
 * quota nor can be refused by this module — which is also what keeps a frozen
 * or rate-limited book readable, the property the whole phase is organised
 * around.
 *
 * ## Fixed windows
 *
 * A fixed window per (subject, class) rather than a sliding log or a token
 * bucket: a log needs a row per request, which is the thing being prevented,
 * and a bucket needs a read-modify-write of a float. A counter row per minute
 * is one upsert, survives an isolate restart, and is shared across isolates
 * because it lives in the database rather than in memory — which matters, since
 * Workers scale by running more isolates and an in-memory limiter would divide
 * the ceiling by however many happened to be warm.
 *
 * The known cost of a fixed window is the boundary burst: a caller can spend
 * its whole allowance at the end of one window and again at the start of the
 * next. For a control whose job is to stop a runaway loop — which will exhaust
 * a window in its first second and then be refused for the remaining fifty-nine
 * — that is an acceptable trade for the operational simplicity.
 */
import type { Context } from "hono";
import type { Repositories } from "@authorbot/database";
import type { AppEnv, AuthContext, Clock } from "./deps.js";
import { problem } from "./problems.js";

/**
 * The documented ceilings (exit criterion 1: "documented rate limits enforced
 * and tested"). This table IS the documentation — the runbook and the OpenAPI
 * description both quote it, and `GET /v1/projects/{id}/rate-limits` serves it
 * so an agent author can read the ceilings they are writing against rather than
 * discovering them through 429s.
 *
 * `perActor` and `perToken` are requests per `windowSeconds`. `perToken` is
 * deliberately at or below `perActor`: one token may not outrun its owner.
 */
export interface RateLimitCeiling {
  /** Requests per window from one actor, across all of their credentials. */
  perActor: number;
  /** Requests per window from one agent token. Ignored for session auth. */
  perToken: number;
  windowSeconds: number;
  /** Plain-language description, served by the rate-limits endpoint. */
  description: string;
}

export const RATE_LIMIT_CLASSES = [
  "vote",
  "claim",
  "submission",
  "annotation",
  "control",
  "mutation",
] as const;
export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

export const RATE_LIMITS: Readonly<Record<RateLimitClass, RateLimitCeiling>> = Object.freeze({
  /**
   * Voting is the cheapest way for a fleet to manufacture work: every vote
   * re-evaluates the governance rules and may create a decision, a work item,
   * and two Git artifacts. It gets the tightest per-token ceiling of the three
   * hot paths.
   */
  vote: {
    perActor: 60,
    perToken: 30,
    windowSeconds: 60,
    description:
      "Casting or clearing a vote. Each vote re-evaluates the book's governance rules, so this is the tightest per-token ceiling.",
  },
  /**
   * Claiming is a contended write on a partial unique index. A fleet racing for
   * the same work item is EXPECTED — that is what Phase 4's claim race is — so
   * the ceiling has to leave room for honest contention while still stopping a
   * client that retries a 409 in a tight loop.
   */
  claim: {
    perActor: 60,
    perToken: 30,
    windowSeconds: 60,
    description:
      "Claiming, renewing, or releasing a lease. Sized to leave room for honest contention between agents racing for the same work item.",
  },
  /**
   * Submissions are the most expensive mutation in the system: each one queues
   * a patch, a rebase check, and a commit. The ceiling is correspondingly low —
   * an agent that legitimately needs more than this per minute is not editing
   * prose, it is looping.
   */
  submission: {
    perActor: 30,
    perToken: 20,
    windowSeconds: 60,
    description:
      "Submitting work against a lease, or a direct chapter submission. Each one queues a patch and a commit, so this is the lowest ceiling.",
  },
  /**
   * Annotations and replies are the surface a permissive policy opens to
   * strangers, so this ceiling is also the spam control the contract's
   * "moderation, spam controls, privacy, and a deletion policy" list names
   * second — Phase 7 supplies the first, and this is a down payment on the
   * second.
   */
  annotation: {
    perActor: 60,
    perToken: 30,
    windowSeconds: 60,
    description:
      "Creating an annotation or a reply, or withdrawing one. Applies to every mode including `open`, where it is the first line of spam control.",
  },
  /**
   * The maintainer control plane: settings, freeze, pause, role changes,
   * revocations, moderation. Human-paced by nature, but limited anyway — a
   * stolen maintainer session should not be able to enumerate and revoke a
   * thousand things before anyone notices.
   */
  control: {
    perActor: 120,
    perToken: 60,
    windowSeconds: 60,
    description:
      "Maintainer controls: settings, freeze, pause agents, role changes, revocations, and moderation decisions.",
  },
  /** Everything else that mutates. */
  mutation: {
    perActor: 120,
    perToken: 60,
    windowSeconds: 60,
    description: "Any other mutating request.",
  },
});

/** The limit class a route falls into, from the class its guard declared. */
export function rateLimitClassFor(input: {
  capability: "annotate" | "vote" | "claim" | "submit" | null;
  surface: "collaboration" | "control";
}): RateLimitClass {
  switch (input.capability) {
    case "annotate":
      return "annotation";
    case "vote":
      return "vote";
    case "claim":
      return "claim";
    case "submit":
      return "submission";
    default:
      return input.surface === "control" ? "control" : "mutation";
  }
}

/** Start of the fixed window containing `now`, as an RFC 3339 UTC timestamp. */
export function windowStartOf(now: Date, windowSeconds: number): string {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Whole seconds until the window containing `now` closes (never below 1). */
export function retryAfterSeconds(now: Date, windowSeconds: number): number {
  const ms = windowSeconds * 1000;
  const elapsed = now.getTime() % ms;
  return Math.max(1, Math.ceil((ms - elapsed) / 1000));
}

export interface RateLimitOutcome {
  allowed: boolean;
  /** Which subject tripped: the actor's ceiling or the token's. */
  scope: "actor" | "token" | null;
  limit: number;
  remaining: number;
  retryAfter: number;
  className: RateLimitClass;
}

export interface RateLimitDeps {
  repos: Repositories;
  clock: Clock;
}

/**
 * Count one mutation against the actor's ceiling and, for token auth, the
 * token's as well.
 *
 * BOTH subjects are incremented before either is judged. Short-circuiting on
 * the first failure would make the two counters drift apart under load — an
 * actor limited on Monday would carry an artificially low token count into
 * Tuesday — and the arithmetic that the endpoint reports back to clients would
 * stop describing anything real.
 */
export async function consumeRateLimit(
  deps: RateLimitDeps,
  auth: AuthContext,
  className: RateLimitClass,
): Promise<RateLimitOutcome> {
  const ceiling = RATE_LIMITS[className];
  const now = deps.clock.now();
  const windowStart = windowStartOf(now, ceiling.windowSeconds);
  const expiresAt = new Date(
    Date.parse(windowStart) + ceiling.windowSeconds * 1000,
  ).toISOString().replace(/\.\d{3}Z$/, "Z");
  const retryAfter = retryAfterSeconds(now, ceiling.windowSeconds);

  const actorCount = await deps.repos.rateLimitCounters.increment({
    subject: `actor:${auth.actor.id}`,
    class: className,
    windowStart,
    expiresAt,
  });

  /**
   * An agent also spends its OWNER's allowance.
   *
   * The module's own guarantee above is that "the ACTOR limit bounds what one
   * identity can do however many credentials it holds" — and minting is what
   * broke it: every token gets a brand-new agent actor of its own, so ten
   * tokens are ten actors, ten separate `actor:` counters, and ten times the
   * ceiling. A fleet then scales linearly with token count, which is exactly
   * the runaway the limits exist to blunt.
   *
   * Charging the owning human as well restores the guarantee at the level the
   * guarantee was always about: the person. Their agents share one allowance
   * between them, and their own session shares it too — which is the honest
   * reading of "one identity, however many credentials it holds".
   */
  const ownerActorId = auth.kind === "token" ? auth.actor.ownerActorId : null;
  let ownerCount: number | null = null;
  if (ownerActorId !== null && ownerActorId !== auth.actor.id) {
    ownerCount = await deps.repos.rateLimitCounters.increment({
      subject: `actor:${ownerActorId}`,
      class: className,
      windowStart,
      expiresAt,
    });
  }

  let tokenCount: number | null = null;
  if (auth.kind === "token" && auth.tokenId !== undefined) {
    tokenCount = await deps.repos.rateLimitCounters.increment({
      subject: `token:${auth.tokenId}`,
      class: className,
      windowStart,
      expiresAt,
    });
  }

  if (tokenCount !== null && tokenCount > ceiling.perToken) {
    return {
      allowed: false,
      scope: "token",
      limit: ceiling.perToken,
      remaining: 0,
      retryAfter,
      className,
    };
  }
  if (actorCount > ceiling.perActor || (ownerCount !== null && ownerCount > ceiling.perActor)) {
    return {
      allowed: false,
      scope: "actor",
      limit: ceiling.perActor,
      remaining: 0,
      retryAfter,
      className,
    };
  }
  return {
    allowed: true,
    scope: null,
    limit: ceiling.perActor,
    remaining: Math.max(0, ceiling.perActor - Math.max(actorCount, ownerCount ?? 0)),
    retryAfter,
    className,
  };
}

/**
 * The 429 (contract: "`429` + `Retry-After`").
 *
 * `Retry-After` is the seconds remaining in the current window, which is
 * exactly when the caller's next request can succeed — a well-behaved agent
 * that honours it stops hammering immediately, which is the entire point of
 * sending it rather than a bare 429.
 */
export function rateLimitedProblem(
  c: Context<AppEnv>,
  outcome: RateLimitOutcome,
): Response {
  const response = problem(c, "rate-limited", {
    detail:
      outcome.scope === "token"
        ? `this agent token exceeded its ceiling of ${outcome.limit} ${outcome.className} requests per ${RATE_LIMITS[outcome.className].windowSeconds}s`
        : `this actor exceeded its ceiling of ${outcome.limit} ${outcome.className} requests per ${RATE_LIMITS[outcome.className].windowSeconds}s`,
    limitClass: outcome.className,
    limit: outcome.limit,
    scope: outcome.scope,
    retryAfterSeconds: outcome.retryAfter,
  });
  response.headers.set("Retry-After", String(outcome.retryAfter));
  response.headers.set("X-RateLimit-Limit", String(outcome.limit));
  response.headers.set("X-RateLimit-Remaining", "0");
  return response;
}

/** The documented ceiling table, as the rate-limits endpoint serves it. */
export function rateLimitsJson(): Record<string, unknown> {
  return {
    classes: Object.fromEntries(
      RATE_LIMIT_CLASSES.map((name) => [
        name,
        {
          perActor: RATE_LIMITS[name].perActor,
          perToken: RATE_LIMITS[name].perToken,
          windowSeconds: RATE_LIMITS[name].windowSeconds,
          description: RATE_LIMITS[name].description,
        },
      ]),
    ),
    notes: [
      "Limits apply to mutations only; reads are never counted and never refused by a limit.",
      "Every mutation is counted against its actor; a request authenticated by an agent token is counted against the token, against the agent's own actor, and against the human who minted it, and must satisfy every ceiling. Minting more tokens therefore does not buy more throughput.",
      "Exceeding a ceiling returns 429 with a Retry-After header giving the seconds until the current window closes.",
    ],
  };
}
