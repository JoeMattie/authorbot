/**
 * Author-facing access control (Phase 7 contract, "Author-facing access
 * control"): the annotation policy, the freeze, and the agent pause — resolved
 * per request and enforced server-side.
 *
 * ## Where each control lives, and why they differ
 *
 * The **annotation policy** lives in `book.yml`, projected into `book_configs`
 * like every other setting. It is an editorial decision about the book, so it
 * belongs in the repository: versioned, diffable, reviewable, and changed
 * through the same Phase 6 settings PATCH that changes the title.
 *
 * **Freeze** and **pause agents** live in `project_access_controls`, in the
 * operational database. Migration 0007 argues the case at length; the short
 * version is that an emergency stop must take effect on the next request rather
 * than the next commit, and must keep working when the repository does not. A
 * settings PATCH is a 202 and refuses a diverged project — correct for a
 * policy, useless for a stop button.
 *
 * ## Where enforcement happens
 *
 * All three gates are applied inside `requireProjectScope` (auth.ts), which is
 * the one function every project-scoped route already calls. Putting them there
 * rather than in each handler is deliberate: exit criterion 8 requires the
 * freeze to refuse *every* write path, and a list of routes that must each
 * remember to call a helper is a list that grows a hole the first time someone
 * adds a route. A choke point cannot be forgotten.
 *
 * Reads are exempt by HTTP method, which is what makes "reads and the published
 * site are provably unaffected" true by construction rather than by audit.
 */
import type { Context } from "hono";
import type { ProjectAccessControlRecord, Repositories } from "@authorbot/database";
import {
  DEFAULT_ANNOTATION_POLICY,
  checkAnnotationPolicy,
  isAnnotationPolicy,
  policyRequiresApproval,
  type AnnotationPolicy,
  type PolicyCapability,
  type Role,
} from "@authorbot/domain";
import type { ApiScope } from "./api-scopes.js";
import type { AppEnv, AuthContext } from "./deps.js";
import { problem } from "./problems.js";

/** HTTP methods that change nothing, and are therefore never gated. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The access-control state in force for a project right now.
 *
 * Resolved per request rather than cached, for the same reason Phase 6 resolves
 * governance rules per request: "the freeze takes effect on the next request"
 * is the requirement, and a cache would make it take effect on the next deploy.
 * The cost is two indexed primary-key lookups on tables with one row per
 * project, paid only on mutations.
 */
export interface AccessState {
  policy: AnnotationPolicy;
  /** True when the policy queues writes for review instead of publishing them. */
  requiresApproval: boolean;
  frozen: boolean;
  frozenAt: string | null;
  frozenByActorId: string | null;
  freezeReason: string | null;
  agentsPaused: boolean;
  agentsPausedAt: string | null;
  agentsPausedByActorId: string | null;
  agentsPauseReason: string | null;
}

/** The policy a projected `book.yml` declares, or the default. */
export function annotationPolicyOf(config: unknown): AnnotationPolicy {
  if (config === null || typeof config !== "object") return DEFAULT_ANNOTATION_POLICY;
  const collaboration = (config as { collaboration?: unknown }).collaboration;
  if (collaboration === null || typeof collaboration !== "object") {
    return DEFAULT_ANNOTATION_POLICY;
  }
  const value = (collaboration as { annotation_policy?: unknown }).annotation_policy;
  return isAnnotationPolicy(value) ? value : DEFAULT_ANNOTATION_POLICY;
}

function stateFromRow(
  policy: AnnotationPolicy,
  row: ProjectAccessControlRecord | null,
): AccessState {
  return {
    policy,
    requiresApproval: policyRequiresApproval(policy),
    frozen: row?.frozenAt != null,
    frozenAt: row?.frozenAt ?? null,
    frozenByActorId: row?.frozenByActorId ?? null,
    freezeReason: row?.freezeReason ?? null,
    agentsPaused: row?.agentsPausedAt != null,
    agentsPausedAt: row?.agentsPausedAt ?? null,
    agentsPausedByActorId: row?.agentsPausedByActorId ?? null,
    agentsPauseReason: row?.agentsPauseReason ?? null,
  };
}

export async function loadAccessState(
  repos: Repositories,
  projectId: string,
): Promise<AccessState> {
  const [configRow, controlRow] = await Promise.all([
    repos.bookConfigs.get(projectId),
    repos.projectAccessControls.get(projectId),
  ]);
  return stateFromRow(annotationPolicyOf(configRow?.config ?? null), controlRow);
}

/**
 * The policy capability a route exercises, derived from the scope it requires.
 *
 * Derived rather than declared at each call site so that a new route inherits
 * the right gate from the scope it already had to choose. Routes whose scope
 * says nothing about the policy — reads, token management, member management —
 * map to `null` and are not policy-gated at all; they are gated by role, and by
 * the freeze when they write.
 */
export function capabilityForScope(scope: ApiScope | null): PolicyCapability | null {
  switch (scope) {
    case "annotations:write":
      return "annotate";
    case "votes:write":
      return "vote";
    case "work:claim":
      return "claim";
    case "submissions:write":
      return "submit";
    default:
      return null;
  }
}

/**
 * Does this policy admit a signed-in NON-member to this request?
 *
 * Only `open` and `approval-gated` widen anything, and only to a human session.
 * An agent token belonging to no membership stays out in every mode — the
 * contract is explicit that an agent's access is "a deliberate grant rather
 * than an implicit inheritance from their owner", and admitting unenrolled
 * tokens under `open` would be exactly that inheritance.
 *
 * For WRITES the widening is `annotate` and nothing else: a book that welcomes
 * comments from the internet is not thereby handing the internet its governance
 * votes or its work queue.
 *
 * For READS the widening covers chapters and annotations, because the
 * alternative is incoherent — a book that invites any signed-in user to comment
 * must let them read what they are commenting on, and under `approval-gated` an
 * author must be able to see their own queued comment, which the contract
 * requires ("visible to its author, badged as awaiting review"). Note that this
 * is about SIGNED-IN non-members only; anonymous reads remain governed by the
 * separate `PUBLIC_ANNOTATIONS` gate, which this does not touch.
 */
export function policyAdmitsNonMember(input: {
  state: AccessState;
  auth: AuthContext;
  capability: PolicyCapability | null;
  mutating: boolean;
  scope: ApiScope | null;
}): boolean {
  if (input.auth.kind !== "session") return false;
  if (input.state.policy !== "open" && input.state.policy !== "approval-gated") return false;
  if (input.mutating) return input.capability === "annotate";
  return (
    input.scope === null ||
    input.scope === "chapters:read" ||
    input.scope === "annotations:read"
  );
}

/**
 * The maintainer control plane: routes a freeze must NOT refuse.
 *
 * The contract scopes the freeze to writes "across annotations, votes, claims,
 * and submissions" — the collaboration surface. It cannot also cover the
 * author's own controls, because a freeze that blocked its own reversal would
 * be a one-way door, and "stop everything while I look" is precisely the
 * moment an author needs to change a role, revoke a token, or drain the queue.
 *
 * Approving a queued annotation is NOT on this list: approval commits new
 * content to the book, which is the thing the freeze exists to stop. Rejecting
 * one IS, because rejection is database-only and is part of looking.
 */
export type WriteSurface = "collaboration" | "control";

export interface WriteGateInput {
  state: AccessState;
  auth: AuthContext;
  method: string;
  surface: WriteSurface;
  capability: PolicyCapability | null;
  role: Role | null;
}

export type WriteGateDenial =
  | { kind: "frozen" }
  | { kind: "agents-paused" }
  | { kind: "policy"; reason: string; message: string };

/**
 * Apply the freeze, the agent pause, and the annotation policy to one request.
 *
 * Returns `null` when the write may proceed. Order matters and is not
 * arbitrary: the freeze is the broadest and most urgent statement about the
 * book, the agent pause is the next broadest, and the policy is the ordinary
 * standing rule. Reporting the broadest true reason first is what makes the
 * refusal legible — an author who froze the book wants to be told the book is
 * frozen, not that their agent's role is insufficient.
 */
export function checkWriteGate(input: WriteGateInput): WriteGateDenial | null {
  if (SAFE_METHODS.has(input.method)) return null;

  if (input.state.frozen && input.surface === "collaboration") {
    return { kind: "frozen" };
  }

  // The pause applies to control routes too. An agent holding a maintainer-role
  // membership is a supported (and, under `locked`, necessary) configuration —
  // so if the pause exempted the control plane, a paused agent could unpause
  // itself, and the one population the control exists to stop would be the one
  // population able to lift it.
  if (input.state.agentsPaused && input.auth.kind === "token") {
    return { kind: "agents-paused" };
  }

  if (input.capability === null) return null;

  const decision = checkAnnotationPolicy({
    policy: input.state.policy,
    credential: input.auth.kind,
    role: input.role,
    capability: input.capability,
  });
  if (decision.allowed) return null;
  return { kind: "policy", reason: decision.reason, message: decision.message };
}

/** Render a gate denial as the contract's problem response. */
export function writeGateProblem(
  c: Context<AppEnv>,
  state: AccessState,
  denial: WriteGateDenial,
): Response {
  if (denial.kind === "frozen") {
    return problem(c, "book-frozen", {
      detail:
        "this book is frozen: no writes are accepted from anyone, including maintainers. Reads and the published site are unaffected.",
      frozenAt: state.frozenAt,
      ...(state.freezeReason !== null ? { reason: state.freezeReason } : {}),
    });
  }
  if (denial.kind === "agents-paused") {
    return problem(c, "agents-paused", {
      detail:
        "agent tokens are paused for this book. Human collaborators are unaffected; a maintainer can resume agents from the settings view.",
      pausedAt: state.agentsPausedAt,
      ...(state.agentsPauseReason !== null ? { reason: state.agentsPauseReason } : {}),
    });
  }
  if (denial.reason === "anonymous") {
    return problem(c, "unauthorized", { detail: denial.message });
  }
  if (denial.reason === "locked") {
    return problem(c, "book-locked", { detail: denial.message, policy: state.policy });
  }
  return problem(c, "forbidden", { detail: denial.message, policy: state.policy });
}

/** The access-control block `GET /v1/projects/{id}/access` and settings return. */
export function accessStateJson(state: AccessState): Record<string, unknown> {
  return {
    annotationPolicy: state.policy,
    requiresApproval: state.requiresApproval,
    freeze: state.frozen
      ? { state: "frozen", since: state.frozenAt, reason: state.freezeReason }
      : { state: "open" },
    agents: state.agentsPaused
      ? { state: "paused", since: state.agentsPausedAt, reason: state.agentsPauseReason }
      : { state: "active" },
  };
}
