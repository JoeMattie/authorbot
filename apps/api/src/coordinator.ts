/**
 * The ProjectCoordinator (Phase 5 contract §5, design §6.2): one serialized
 * owner per project for everything that touches Git, plus the periodic
 * maintenance the deployed Worker has no other place to run.
 *
 * This module is the runtime-agnostic core. `coordinator-do.ts` wraps it in
 * the actual Cloudflare Durable Object; tests drive this class directly over
 * better-sqlite3 and the in-process fake GitHub, so the DO's behaviour is
 * covered without workerd in the default suite.
 *
 * WORKER-SAFE: WebCrypto and `fetch` only. No `node:` import may reach this
 * file or anything it pulls in - notably not mirror.ts, which constructs
 * `LocalGitAdapter` (`node:child_process`). The shared drain lives in
 * drain.ts precisely so this file can reuse it without that edge.
 *
 * Degraded, not broken (contract §2): with no GitHub App credentials the
 * coordinator still sweeps leases and still reschedules its alarm, but
 * performs no Git work at all - no outbox row is claimed, no projection is
 * rebuilt. That is exactly the state the live deployment runs in today, and
 * `gitIntegration` reports it rather than pretending.
 *
 * Serialization: EVERY action - drain, projection refresh, lease sweep - runs
 * on one per-project promise chain (`serialize` below), not just the drain.
 * A Durable Object serializes storage operations, not `fetch` invocations
 * across arbitrary awaits, and these actions await dozens of outbound GitHub
 * requests apiece. Chaining only the drain (as this once did) let a webhook
 * `/refresh` and a mutation `/drain` interleave, which is how a projection
 * refresh could conclude "the revision went backwards" from a snapshot a
 * concurrent commit had already superseded, and block prose writes
 * project-wide until a maintainer intervened.
 *
 * Idempotency: `drainOutbox()` is safe to call any number of times. Duplicate
 * or overlapping calls queue on the chain, and the outbox claim
 * (`pending → processing`, compare-and-swap) plus the git_operations state
 * machine mean a row already committed replays its completion instead of
 * producing a second commit. The alarm relies on this rather than on any
 * "already running" flag, which a DO reset would lose.
 */
import { createRepositories, type SqlDatabase } from "@authorbot/database";
import { toTimestamp } from "@authorbot/domain";
import {
  GitHubBookRepoReader,
  GitHubBookRepoWriter,
  getGitHubAppAuth,
  readGitHubAppCredentialResult,
  type GitHubAppCredentials,
} from "@authorbot/git-github";
import type { BookRepoWriter, DrainRowOutcome } from "@authorbot/repo-coordinator";
import type { Clock } from "./deps.js";
import { createDrainRunner, type DrainRunner } from "./drain.js";
import { uuidv7 } from "./ids.js";
import { sweepExpiredLeases, type SweepResult } from "./leases.js";
import type { BookRepoReader } from "./projection/reader.js";
import type { RebuildResult } from "./projection/rebuild.js";
import { reconcileProjection, type ReconcileResult } from "./reconcile.js";

/** Contract §5: periodic alarm cadence, `COORDINATOR_ALARM_SECONDS`. */
export const DEFAULT_COORDINATOR_ALARM_SECONDS = 60;
/** A day: beyond this the value is certainly a mistake (ms/seconds mixup). */
export const MAX_COORDINATOR_ALARM_SECONDS = 86_400;

/**
 * Whether this deployment can talk to GitHub. `unconfigured` is the live
 * deployment's state and is reported by `GET /v1/projects/{id}`;
 * `incomplete` means some but not all of the three credential variables are
 * set - a half-configured app must never half-work, so it is not
 * `configured` (contract §2).
 */
export type GitIntegrationStatus =
  | "configured"
  | "unconfigured"
  | "incomplete"
  | "invalid";

/**
 * Parse `COORDINATOR_ALARM_SECONDS` into milliseconds. Throws on anything
 * malformed: like the `LEASE_*` variables this is validated at boot, never
 * silently defaulted, so a typo fails a deploy instead of quietly disabling
 * the backlog drain.
 */
export function coordinatorAlarmMsFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_COORDINATOR_ALARM_SECONDS * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_COORDINATOR_ALARM_SECONDS) {
    throw new Error(
      `COORDINATOR_ALARM_SECONDS must be an integer in 1..${MAX_COORDINATOR_ALARM_SECONDS} seconds`,
    );
  }
  return seconds * 1000;
}

/** The `DurableObjectStorage` subset the coordinator schedules alarms with. */
export interface AlarmScheduler {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/**
 * The `DurableObjectStorage` subset used for *scheduling bookkeeping only*
 * (contract §5: "The DO holds no durable state beyond scheduling
 * bookkeeping; D1 remains the source of operational truth"). Today that is
 * just the project id the instance owns, recorded by coordinator-do.ts so an
 * alarm firing after an eviction knows what to work on - `idFromName` is
 * one-way.
 *
 * The coordinator itself deliberately takes no store: the one piece of state
 * it once kept here, the projection-stale flag, belongs in D1
 * (`projects.projection_stale`, reconcile.ts). It is a durable claim about
 * owed work that must survive a DO reset and must be visible to the webhook
 * handler that sets it, so keeping a second copy here would only create two
 * sources of truth that drift.
 */
export interface CoordinatorStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** The GitHub pair the coordinator drives; absent when credentials are absent. */
export interface CoordinatorGit {
  reader: BookRepoReader;
  writer: BookRepoWriter;
  /**
   * A reader pinned to `branch`, when the implementation can build one.
   *
   * The writer takes no branch: every commit targets `projects.default_branch`
   * read from D1 (processor.ts). The reader used to take its branch from the
   * `DEFAULT_BRANCH` binding instead, and nothing reconciled the two after the
   * first-boot seed - `seedProject` only INSERTs, and no repository exposes an
   * UPDATE touching `default_branch`. So an operator migrating the repository's
   * default branch and updating the binding (which
   * `docs/github-app-setup.md` tells them to do) moved the reader while the
   * writer stayed pinned to the stale row: commits on one branch, projection
   * built from another, `revision-regressed` findings and a diverged project
   * with nothing actually wrong.
   *
   * Deriving the reader's branch from the project row at refresh time makes
   * one source authoritative. Optional so tests that inject a fixed
   * reader/writer pair are unaffected.
   */
  readerFor?(branch: string): BookRepoReader;
}

export interface ProjectCoordinatorOptions {
  /** The project this coordinator owns - the DO's `idFromName` key. */
  projectId: string;
  db: SqlDatabase;
  clock?: Clock;
  /**
   * Reader/writer pair, or `null` when GitHub credentials are absent. Built
   * by {@link createCoordinatorGit} in the Worker; injected directly (fake
   * GitHub) in tests.
   */
  git?: CoordinatorGit | null;
  /** Reported by `GET /v1/projects/{id}`; defaults from whether `git` is set. */
  gitIntegration?: GitIntegrationStatus;
  /** DO alarm seam. Absent (tests, dev) means alarms are simply not scheduled. */
  alarms?: AlarmScheduler | null;
  alarmIntervalMs?: number;
  /** Maximum commit attempts per git operation (default 3). */
  maxAttempts?: number;
  /** Ceiling on availability deferral before an operation is failed. */
  maxDeferralMs?: number;
  /** Leases examined per sweep (default 100). */
  leaseSweepLimit?: number;
}

export interface DrainOutboxResult {
  /** Rows this drain took to a terminal state. */
  drained: number;
  committed: number;
  failed: number;
  outcomes: DrainRowOutcome[];
  /** Set when no drain was attempted; `drained` is then 0. */
  skipped?: "git-unconfigured";
  /**
   * The project is `diverged`, so `submission.apply` rows were left `pending`
   * rather than committed. Non-prose rows still drained.
   */
  prosePaused?: true;
}

export interface RefreshProjectionResult {
  /** `null` when the pass was skipped; otherwise the reconcile outcome. */
  outcome: ReconcileResult["outcome"] | null;
  rebuild: RebuildResult | null;
  /** Full reconcile detail (divergence findings, re-anchor tallies). */
  reconcile?: ReconcileResult;
  /** Set when no reconciliation was attempted. */
  skipped?: "git-unconfigured" | "unknown-project" | "not-stale";
}

/**
 * Kinds of outbox row that carry a PROSE write and must therefore stop while
 * the project is `diverged` (contract §6, design §14.5).
 *
 * Deliberately not "every kind": annotations, replies, votes and work-item
 * lifecycle record *intent about* prose rather than rewriting it, their
 * intake keeps working while diverged, and halting their mirroring would turn
 * a repository problem into an unbounded backlog for collaborators who cannot
 * fix it. Only `submission.apply` and `chapter.write` rewrite a chapter.
 *
 * `chapter.write` (Phase 6 §3.5) belongs here for the same reason its request
 * path is gated: it composes the chapter against the branch head and commits
 * it, so a row queued moments before a webhook reconciliation found the
 * repository diverged would otherwise still write prose into a repository
 * Authorbot knows it mis-models.
 */
export const PROSE_OUTBOX_KINDS: readonly string[] = ["submission.apply", "chapter.write"];

export interface CoordinatorAlarmResult {
  sweep: SweepResult;
  drain: DrainOutboxResult;
  refresh: RefreshProjectionResult;
  /** Epoch ms the next alarm was set for, or null when no scheduler is wired. */
  rescheduledFor: number | null;
  /**
   * Step failures, as short messages. A failing step never aborts the alarm
   * and never prevents rescheduling: a transient GitHub outage must not stop
   * lease sweeping or leave the project with no future alarm at all.
   */
  errors: string[];
}

export interface ProjectCoordinator {
  readonly projectId: string;
  readonly gitIntegration: GitIntegrationStatus;
  /** Drain the outbox through the GitHub writer. No-op without credentials. */
  drainOutbox(): Promise<DrainOutboxResult>;
  /**
   * Run one reconciliation pass (reconcile.ts, contract §6): re-read the
   * snapshot, classify it, then project + re-anchor or mark the project
   * diverged. `{ onlyIfStale: true }` (what the alarm uses) skips unless
   * `projects.projection_stale` is set.
   */
  refreshProjection(options?: { onlyIfStale?: boolean }): Promise<RefreshProjectionResult>;
  /** Eager lease expiry (Phase 4 §2) - runs with or without credentials. */
  sweepLeases(): Promise<SweepResult>;
  /** Flag the projection as owing a refresh; the next alarm performs it. */
  markProjectionStale(): Promise<void>;
  /** The periodic alarm body: sweep, drain, conditional refresh, reschedule. */
  alarm(): Promise<CoordinatorAlarmResult>;
  /** Schedule the first alarm if none is pending. Idempotent. */
  ensureAlarm(): Promise<number | null>;
}

export function createProjectCoordinator(
  options: ProjectCoordinatorOptions,
): ProjectCoordinator {
  const { projectId, db } = options;
  const clock: Clock = options.clock ?? { now: (): Date => new Date() };
  const git = options.git ?? null;
  const gitIntegration: GitIntegrationStatus =
    options.gitIntegration ?? (git === null ? "unconfigured" : "configured");
  const alarms = options.alarms ?? null;
  const alarmIntervalMs = options.alarmIntervalMs ?? DEFAULT_COORDINATOR_ALARM_SECONDS * 1000;
  const leaseSweepLimit = options.leaseSweepLimit ?? 100;
  const repos = createRepositories(db);

  /**
   * The project-wide serialization chain (contract §5: "All Git-touching work
   * goes through it, so commits for a project are serialized").
   *
   * A Durable Object does NOT serialize concurrent `fetch` invocations across
   * awaits that are not storage operations, and every Git-touching action here
   * awaits dozens of outbound requests. Only the drain was chained (drain.ts),
   * so `/refresh` (webhook) and `/drain` (mutation) interleaved freely: a
   * refresh pinned at head H1 could resume after a drain committed H2 and
   * bumped a chapter to revision N+1, see `snapshotRevision (N) <
   * current.revision (N+1)`, and mark the whole project `diverged` - 403ing
   * every submission until a maintainer cleared it, with nothing actually
   * wrong in the repository. In the other order the refresh's rebuild wrote
   * H1's revision/contentHash/blockIds back over the freshly committed N+1.
   *
   * One chain for every action closes both directions, and costs nothing when
   * only one caller is active.
   */
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  };

  /**
   * Prose commits stop while the project is `diverged` (contract §6, design
   * §14.5). The intake guard (`proseWriteBlocked`) only refuses NEW
   * submissions; rows queued moments before a webhook reconciliation marked
   * the project diverged were still committed, because nothing on the drain
   * path read `projects.status`. Rows are left `pending`, never failed, so
   * clearing divergence resumes the backlog by itself.
   */
  const pausedKinds = async (): Promise<readonly string[]> => {
    const project = await repos.projects.getById(projectId);
    return project?.status === "diverged" ? PROSE_OUTBOX_KINDS : [];
  };

  const runner: DrainRunner | null =
    git === null
      ? null
      : createDrainRunner({
          db,
          writer: git.writer,
          clock,
          pausedKinds,
          ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
          ...(options.maxDeferralMs !== undefined
            ? { maxDeferralMs: options.maxDeferralMs }
            : {}),
        });

  const markProjectionStale = async (): Promise<void> => {
    await repos.projects.markProjectionStaleStatement(projectId, toTimestamp(clock.now())).run();
  };

  const drainOutbox = (): Promise<DrainOutboxResult> =>
    serialize(async () => {
      if (runner === null) {
        // No credentials: leave every row `pending`. Claiming rows we cannot
        // commit would burn attempts and eventually fail operations that are
        // perfectly valid once the app is installed.
        return { drained: 0, committed: 0, failed: 0, outcomes: [], skipped: "git-unconfigured" };
      }
      const project = await repos.projects.getById(projectId);
      const result = await runner.drain(projectId);
      let committed = 0;
      let failed = 0;
      for (const outcome of result.outcomes) {
        if (outcome.result === "committed") {
          committed += 1;
        } else {
          failed += 1;
        }
      }
      return {
        drained: result.outcomes.length,
        committed,
        failed,
        outcomes: result.outcomes,
        ...(project?.status === "diverged" ? { prosePaused: true as const } : {}),
      };
    });

  const refreshProjection = (
    refreshOptions: { onlyIfStale?: boolean } = {},
  ): Promise<RefreshProjectionResult> =>
    serialize(async () => {
      if (git === null) {
        return { outcome: null, rebuild: null, skipped: "git-unconfigured" };
      }
      const project = await repos.projects.getById(projectId);
      if (project === null) {
        return { outcome: null, rebuild: null, skipped: "unknown-project" };
      }
      // Staleness is read from D1, not from DO memory or DO storage: the
      // webhook that marks it and this alarm that clears it are in different
      // objects, and the flag has to survive a DO reset.
      if (refreshOptions.onlyIfStale === true && !project.projectionStale) {
        return { outcome: null, rebuild: null, skipped: "not-stale" };
      }
      // Read the branch the WRITER commits to, not a binding: one source of
      // truth for "which branch is this book" (see CoordinatorGit.readerFor).
      const reader = git.readerFor?.(project.defaultBranch) ?? git.reader;
      // reconcileProjection owns clearing the flag - and clears it only if
      // nothing bumped the row mid-pass, so a push arriving during a refresh is
      // not swallowed.
      const result = await reconcileProjection({ db, repos, clock }, project, reader, {
        correlationId: uuidv7(clock.now()),
      });
      return { outcome: result.outcome, rebuild: result.rebuild, reconcile: result };
    });

  const sweepLeases = (): Promise<SweepResult> =>
    serialize(() => sweepExpiredLeases(db, clock, leaseSweepLimit));

  const scheduleNext = async (): Promise<number | null> => {
    if (alarms === null) {
      return null;
    }
    const at = clock.now().getTime() + alarmIntervalMs;
    await alarms.setAlarm(at);
    return at;
  };

  const ensureAlarm = async (): Promise<number | null> => {
    if (alarms === null) {
      return null;
    }
    const pending = await alarms.getAlarm();
    if (pending !== null) {
      return pending;
    }
    return scheduleNext();
  };

  const alarm = async (): Promise<CoordinatorAlarmResult> => {
    const errors: string[] = [];
    let sweep: SweepResult = { expired: 0 };
    let drain: DrainOutboxResult = {
      drained: 0,
      committed: 0,
      failed: 0,
      outcomes: [],
      skipped: "git-unconfigured",
    };
    let refresh: RefreshProjectionResult = {
      outcome: null,
      rebuild: null,
      skipped: "git-unconfigured",
    };

    // Lease sweeping first and unconditionally: it is the one maintenance
    // task that must keep working with Git integration switched off (Phase 4
    // §2 requires it in production, and a stranded work item is unclaimable
    // until it runs).
    try {
      sweep = await sweepLeases();
    } catch (error) {
      errors.push(`sweepLeases: ${messageOf(error)}`);
    }
    try {
      drain = await drainOutbox();
    } catch (error) {
      errors.push(`drainOutbox: ${messageOf(error)}`);
    }
    try {
      refresh = await refreshProjection({ onlyIfStale: true });
    } catch (error) {
      errors.push(`refreshProjection: ${messageOf(error)}`);
    }

    let rescheduledFor: number | null = null;
    try {
      rescheduledFor = await scheduleNext();
    } catch (error) {
      errors.push(`setAlarm: ${messageOf(error)}`);
    }
    return { sweep, drain, refresh, rescheduledFor, errors };
  };

  return {
    projectId,
    gitIntegration,
    drainOutbox,
    refreshProjection,
    sweepLeases,
    markProjectionStale,
    alarm,
    ensureAlarm,
  };
}

/**
 * Error text with no credential material in it. The GitHub package already
 * scrubs tokens from its own messages; this is the second gate - anything the
 * coordinator records or returns passes through here, and a non-Error value
 * (which could be an arbitrary thrown object) is never stringified.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

// ---------------------------------------------------------------------------
// Binding → GitHub wiring
// ---------------------------------------------------------------------------

/** The bindings the coordinator reads. A subset of `WorkerBindings`. */
export interface CoordinatorBindings {
  PROJECT_REPO?: string;
  DEFAULT_BRANCH?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
}

/**
 * Credential status for `GET /v1/projects/{id}` (contract §2). Never returns
 * or logs any credential value - only which names are present.
 */
export function gitIntegrationStatus(bindings: CoordinatorBindings): GitIntegrationStatus {
  return readGitHubAppCredentialResult(asEnvRecord(bindings)).status;
}

/**
 * The credential reader takes an open env record; `CoordinatorBindings` is a
 * closed interface, so it needs a widening. Read-only and no value is copied
 * out - the reader only ever looks up the three `GITHUB_APP_*` names.
 */
function asEnvRecord(bindings: CoordinatorBindings): Readonly<Record<string, unknown>> {
  return bindings as unknown as Readonly<Record<string, unknown>>;
}

/** `owner/name` → `{ owner, repo }`; throws on anything else. */
export function parseRepoCoordinates(repo: string): { owner: string; repo: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error(`PROJECT_REPO must be "owner/name" (got ${parts.length} segments)`);
  }
  const [owner, name] = parts;
  if (owner.length === 0 || name.length === 0) {
    throw new Error(`PROJECT_REPO must be "owner/name"`);
  }
  return { owner, repo: name };
}

/**
 * Build the reader/writer pair from bindings, or `null` when the GitHub App
 * is not fully configured. Both sides share ONE `GitHubAppAuth` (the
 * per-isolate singleton), so they share its installation-token cache and a
 * refresh benefits both. The token never leaves that object: the reader gets
 * `authorizedFetch` and the writer gets the auth object as its token source -
 * neither is ever handed a token string to hold, log, or persist.
 */
export function createCoordinatorGit(
  bindings: CoordinatorBindings,
  overrides: { fetchImpl?: typeof fetch; credentials?: GitHubAppCredentials } = {},
): CoordinatorGit | null {
  const credentials =
    overrides.credentials ??
    (() => {
      const result = readGitHubAppCredentialResult(asEnvRecord(bindings));
      return result.status === "configured" ? result.credentials : null;
    })();
  if (credentials === null) {
    return null;
  }
  const repo = bindings.PROJECT_REPO;
  if (repo === undefined || repo.length === 0) {
    throw new Error("PROJECT_REPO is required when GitHub App credentials are configured");
  }
  const coordinates = parseRepoCoordinates(repo);
  const branch =
    bindings.DEFAULT_BRANCH !== undefined && bindings.DEFAULT_BRANCH.length > 0
      ? bindings.DEFAULT_BRANCH
      : "main";
  const auth = getGitHubAppAuth(credentials, {
    ...(overrides.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  // Readers are memoized per branch: a `GitHubBookRepoReader` carries a
  // commit-keyed tree cache, so rebuilding one per refresh would throw away a
  // cache that can never go stale (a commit is immutable).
  const readers = new Map<string, GitHubBookRepoReader>();
  const readerFor = (forBranch: string): GitHubBookRepoReader => {
    const existing = readers.get(forBranch);
    if (existing !== undefined) return existing;
    const created = new GitHubBookRepoReader({
      owner: coordinates.owner,
      repo: coordinates.repo,
      branch: forBranch,
      fetch: auth.authorizedFetch,
    });
    readers.set(forBranch, created);
    return created;
  };
  // The `DEFAULT_BRANCH` binding is only the fallback now: the refresh path
  // asks for `projects.default_branch`, the same value the writer commits to.
  const reader = readerFor(branch);
  // The writer owns its own Authorization header and its own 401 refresh, so
  // it takes the plain fetch - passing `auth.authorizedFetch` here would set
  // the header twice.
  const writer = new GitHubBookRepoWriter({
    repo,
    tokens: auth,
    ...(overrides.fetchImpl !== undefined ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  return { reader, writer, readerFor };
}
