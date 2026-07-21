/**
 * Pure logic and author-facing language behind `<authorbot-access>` (Phase 7
 * contract, "Author-facing access control").
 *
 * No DOM, no network - the part of access control that can be reasoned about,
 * and unit-tested, without a browser. Almost all of it is *wording*, and the
 * wording is the feature: this whole surface exists so an author can vet,
 * restrict and revoke without a database console, and a control they cannot
 * read is not a control they have.
 *
 * Three rules govern everything here.
 *
 * **The server's words win.** Role consequences (`ROLE_CONSEQUENCES`) and
 * policy meanings (`ANNOTATION_POLICY_MEANS`) are served with the lists they
 * describe, precisely so the interface never keeps a second copy that can drift
 * from what the API actually grants. The maps below are FALLBACKS for a
 * deployment predating Phase 7, not the source of truth.
 *
 * **Revocation is never described as erasure.** The contract is explicit:
 * "leave their prior contributions intact - attribution and history are
 * permanent records, not access grants. Removing someone is not erasing them,
 * and the interface must not imply otherwise." Every destructive confirmation
 * below therefore states both halves - what stops working, and what stays.
 *
 * **`locked` is author-only, not off.** It is the mode an author is most
 * likely to misread as "turn collaboration off", so it gets the longest
 * explanation and a label that says whose book it still is.
 */
import type { AnnotationPolicy, Role } from "./api.js";
import type {
  AgentTokenMeta,
  AuditEvent,
  AuthorHistory,
  Collaborator,
  RemovalResult,
  RevokeAllResult,
} from "./access-api.js";

// ---------------------------------------------------------------------------
// Annotation policy
// ---------------------------------------------------------------------------

/**
 * The four modes in contract order: a progression from public to private
 * workspace, which an author "may move up and down freely". Rendered in this
 * order so the progression is visible rather than merely available.
 */
export const POLICY_ORDER: readonly AnnotationPolicy[] = Object.freeze([
  "open",
  "approval-gated",
  "collaborators-only",
  "locked",
]);

/**
 * Short labels. `locked` says "author only" rather than "locked" alone,
 * because the one-word version is the misreading the contract warns about.
 */
export const POLICY_LABEL: Readonly<Record<AnnotationPolicy, string>> = Object.freeze({
  open: "Open - anyone signed in may comment",
  "approval-gated": "Approval-gated - anyone signed in may comment, you approve it first",
  "collaborators-only": "Collaborators only - the people you have added",
  locked: "Author only - just you and your maintainers",
});

/**
 * Fallback wording, used only when the API does not send its own. Kept in step
 * with `ANNOTATION_POLICY_MEANS` in apps/api/src/settings.ts by intent rather
 * than by import: the packages do not depend on each other, and a stale copy
 * shown *instead of* the server's would be worse than none - which is why the
 * server's is preferred whenever it exists.
 */
export const POLICY_MEANS_FALLBACK: Readonly<Record<AnnotationPolicy, string>> = Object.freeze({
  open: "Any signed-in GitHub user may comment and suggest, and what they write appears immediately. They still cannot vote, claim work, or submit prose - those stay with your collaborators.",
  "approval-gated":
    "Any signed-in GitHub user may comment and suggest, but nothing appears - or reaches your repository - until you approve it. Queued comments are visible to their author and to you, and nothing else.",
  "collaborators-only":
    "Only people you have added to the book may comment and suggest. This is the default.",
  locked:
    "Only maintainers may write. The book stays fully yours to work in: you can annotate your own drafts and run your own agents against them, and an agent works here by holding a maintainer-role membership you granted it. Your existing collaborators keep their membership and everything they have already contributed - they simply cannot write until you reopen the policy.",
});

/** The server's account of a mode, falling back to the shipped wording. */
export function policyMeans(
  policy: AnnotationPolicy,
  fromServer?: Record<string, string>,
): string {
  const served = fromServer?.[policy];
  return typeof served === "string" && served.length > 0 ? served : POLICY_MEANS_FALLBACK[policy];
}

/**
 * Said once, above the picker: nobody writes anonymously in any mode, `open`
 * included. Design §19.7 defers anonymous writing until moderation, spam
 * controls, privacy and a deletion policy all exist; this phase supplies the
 * first of the four, so `open` still means "signed in".
 */
export const ANONYMOUS_NOTE =
  "In every mode, including Open, a person must be signed in with GitHub to write anything. Anonymous comments are not available.";

/** Switching away from approval-gated does not drain the queue for you. */
export const QUEUE_NOT_DRAINED_NOTE =
  "Changing the policy does not approve what is already queued. Anything waiting stays waiting until you approve or reject it.";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLE_ORDER: readonly Role[] = Object.freeze([
  "reader",
  "contributor",
  "editor",
  "maintainer",
]);

/**
 * Fallback role consequences, in the plain language the contract asks for
 * ("with the scope consequences stated in plain language rather than as scope
 * names"). The API sends its own with every collaborator list; this is what a
 * pre-Phase-7 deployment gets.
 */
export const ROLE_MEANS_FALLBACK: Readonly<Record<Role, string>> = Object.freeze({
  reader:
    "Can read chapters and annotations. Cannot comment, suggest, vote, or edit anything.",
  contributor:
    "Everything a reader can do, plus writing comments and suggestions and voting on other people's suggestions. Cannot claim work items or submit prose.",
  editor:
    "Everything a contributor can do, plus claiming work items from the queue and submitting rewritten prose. This is the role an author's working agents normally hold.",
  maintainer:
    "Everything an editor can do, plus changing book settings and governance rules, minting and revoking agent tokens, changing other people's roles, removing collaborators, freezing the book, and approving queued annotations. Give this only to people you would trust with the repository itself.",
});

export function roleMeans(role: Role, fromServer?: Record<string, string>): string {
  const served = fromServer?.[role];
  return typeof served === "string" && served.length > 0 ? served : ROLE_MEANS_FALLBACK[role];
}

/** Short label for a role in a picker. */
export function roleLabel(role: Role): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

// ---------------------------------------------------------------------------
// Emergency controls
// ---------------------------------------------------------------------------

/**
 * Freeze, described as what it is. Two facts do the work: it stops the author
 * too (so nobody reaches for it expecting a moderation setting), and it leaves
 * readers alone (so nobody avoids it fearing the site goes dark).
 */
export const FREEZE_MEANS =
  "Stops every write to this book - from everyone, including you: no comments, suggestions, votes, claims, or submissions. Readers are unaffected and the published site keeps serving exactly as it does now. This is “something is wrong, stop everything while I look”, not a moderation setting.";

export const UNFREEZE_MEANS =
  "Lifts the freeze. Writing resumes for everyone your annotation policy already allows - the policy itself is untouched by freezing.";

/**
 * Pause agents - deliberately a separate control from freeze, described in
 * terms of what it does NOT do, since that is the reason it exists.
 */
export const PAUSE_AGENTS_MEANS =
  "Suspends every agent token at once while your human collaborators keep working. Nothing is revoked: each token keeps its name, scopes, expiry and history, and resuming restores all of it.";

export const RESUME_AGENTS_MEANS = "Lets every agent token work again. Nothing was lost while paused.";

// ---------------------------------------------------------------------------
// Destructive actions - what actually happens
// ---------------------------------------------------------------------------

/**
 * The sentence every revocation confirmation must contain, and the reason this
 * module exists at all. Both halves are load-bearing: what stops (access, on
 * the next request, not at session expiry) and what does not (their work).
 */
export const CONTRIBUTIONS_RETAINED =
  "Their existing comments, suggestions, votes and attribution stay exactly as they are. Removing someone is not erasing them.";

/** Consequence text for removing a person, named. */
export function removalConsequence(name: string): string[] {
  return [
    `${name} loses access to this book on their very next request - not when their session expires.`,
    "Any work item they had claimed is released and returns to the queue, so nothing sits stranded waiting for someone who has gone.",
    "Anything they had submitted but not yet applied is rejected.",
    "Any agent tokens they own are revoked with them.",
    CONTRIBUTIONS_RETAINED,
  ];
}

/** Consequence text for revoking one agent token, named. */
export function tokenRevocationConsequence(name: string): string[] {
  return [
    `The token “${name}” stops working on its very next request.`,
    "Any work item that agent had claimed is released and returns to the queue.",
    "Anything it had submitted but not yet applied is rejected.",
    "The token value cannot be recovered or re-issued - mint a new one if the agent should keep working.",
    CONTRIBUTIONS_RETAINED,
  ];
}

/** Consequence text for revoking every token at once. */
export function revokeAllConsequence(count: number): string[] {
  return [
    count === 1
      ? "The book's one active agent token stops working on its next request."
      : `All ${count} active agent tokens stop working on their next request.`,
    "Every work item any of them had claimed is released and returns to the queue.",
    "Anything any of them had submitted but not yet applied is rejected.",
    "No token value can be recovered. Every agent that should keep working needs a newly minted token.",
    "Your human collaborators are unaffected.",
    CONTRIBUTIONS_RETAINED,
  ];
}

/**
 * The phrase a destructive button must NOT be. Confirmations here are
 * never-default-yes: the confirm control starts unchosen, the confirm button
 * starts disabled, and the safe action is the one that is easy to reach.
 */
export const CANCEL_LABEL = "Keep access";

// ---------------------------------------------------------------------------
// Reporting what a destructive action actually did
// ---------------------------------------------------------------------------

/**
 * Turn a removal response into sentences. The API reports exactly what it did;
 * echoing that back - rather than a generic "done" - is what lets an author
 * notice that removing someone released three work items they cared about.
 */
export function describeRemoval(name: string, result: RemovalResult): string[] {
  const lines = [`${name} no longer has access to this book.`];
  if (result.sessionsInvalidated) {
    lines.push("Their sessions were invalidated, so the change is already in force.");
  }
  const leases = result.leasesReleased?.length ?? 0;
  if (leases > 0) {
    lines.push(
      leases === 1
        ? "One work item they had claimed was released back to the queue."
        : `${leases} work items they had claimed were released back to the queue.`,
    );
  }
  const submissions = result.submissionsRejected?.length ?? 0;
  if (submissions > 0) {
    lines.push(
      submissions === 1
        ? "One in-flight submission was rejected."
        : `${submissions} in-flight submissions were rejected.`,
    );
  }
  const tokens = result.agentTokensRevoked?.length ?? 0;
  if (tokens > 0) {
    lines.push(
      tokens === 1
        ? "One agent token they owned was revoked with them."
        : `${tokens} agent tokens they owned were revoked with them.`,
    );
  }
  lines.push(CONTRIBUTIONS_RETAINED);
  return lines;
}

/** The same, for revoke-all. */
export function describeRevokeAll(result: RevokeAllResult): string[] {
  const revoked = result.revoked?.length ?? 0;
  const lines = [
    revoked === 0
      ? "There were no active agent tokens to revoke."
      : revoked === 1
        ? "One agent token was revoked."
        : `${revoked} agent tokens were revoked.`,
  ];
  const leases = result.leasesReleased?.length ?? 0;
  if (leases > 0) {
    lines.push(
      leases === 1
        ? "One claimed work item was released back to the queue."
        : `${leases} claimed work items were released back to the queue.`,
    );
  }
  const submissions = result.submissionsRejected?.length ?? 0;
  if (submissions > 0) {
    lines.push(
      submissions === 1
        ? "One in-flight submission was rejected."
        : `${submissions} in-flight submissions were rejected.`,
    );
  }
  lines.push(CONTRIBUTIONS_RETAINED);
  return lines;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * An ISO timestamp as a readable date, or a stated absence.
 *
 * `null` becomes the caller's own phrase rather than a dash: "never" and
 * "not recorded" are different facts, and a view whose purpose is vetting must
 * not blur "this person has never acted" into "we did not write it down".
 */
export function formatWhen(iso: string | null | undefined, absent: string): string {
  if (iso === null || iso === undefined || iso === "") return absent;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return absent;
  const date = new Date(parsed);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** Whether a token is revoked, expired, or live - in that precedence. */
export function tokenStatus(token: AgentTokenMeta): "revoked" | "expired" | "active" {
  if (token.revokedAt !== null) return "revoked";
  return token.expired ? "expired" : "active";
}

export function tokenStatusLabel(token: AgentTokenMeta): string {
  switch (tokenStatus(token)) {
    case "revoked":
      return `Revoked ${formatWhen(token.revokedAt, "at an unrecorded time")}`;
    case "expired":
      return `Expired ${formatWhen(token.expiresAt, "at an unrecorded time")}`;
    default:
      return `Active until ${formatWhen(token.expiresAt, "an unrecorded time")}`;
  }
}

/** A collaborator's display name, or an honest stand-in. */
export function collaboratorName(row: Collaborator): string {
  const name = row.actor?.displayName;
  if (typeof name === "string" && name.length > 0) return name;
  const identity = row.actor?.externalIdentity;
  if (typeof identity === "string" && identity.length > 0) return identity;
  return "an account with no recorded name";
}

/**
 * "Approved 3, rejected 9, 1 still waiting" - the contract's "author's history
 * with this book". A moderator looking at their tenth spam comment should be
 * able to see that it is the tenth.
 */
export function authorHistorySentence(history: AuthorHistory | undefined): string {
  const approved = history?.approved ?? 0;
  const rejected = history?.rejected ?? 0;
  const pending = history?.pending ?? 0;
  if (approved === 0 && rejected === 0 && pending <= 1) {
    return "This is their first contribution to this book.";
  }
  const parts = [
    `${approved} approved`,
    `${rejected} rejected`,
    `${pending} waiting for review`,
  ];
  return `Their history with this book: ${parts.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// The audit log, in words
// ---------------------------------------------------------------------------

/**
 * Audit actions in plain language. Complete for everything this surface can
 * produce; anything else falls back to the raw action name, which is honest -
 * an unrecognised action is better shown as an identifier than described
 * wrongly in a view whose whole job is answering "who did this".
 */
const ACTION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  "project.freeze": "froze the book",
  "project.unfreeze": "lifted the freeze",
  "agents.pause": "paused all agents",
  "agents.resume": "resumed all agents",
  "member.add": "added a collaborator",
  "member.remove": "removed a collaborator",
  "member.role_change": "changed a collaborator's role",
  "agent_token.mint": "minted an agent token",
  "agent_token.revoke": "revoked an agent token",
  "agent_token.revoke_all": "revoked every agent token",
  "moderation.approve": "approved a queued comment",
  "moderation.reject": "rejected a queued comment",
  "moderation.bulk_approve": "approved queued comments in bulk",
  "moderation.bulk_reject": "rejected queued comments in bulk",
  "annotation.queued": "submitted a comment for review",
  "annotation.create": "wrote a comment",
  "annotation.approve": "approved a queued comment",
  "settings.update": "changed book settings",
  "operation.retry": "retried a failed git operation",
});

/** Who acted, named as a person would say it. */
export function auditActorName(event: AuditEvent): string {
  if (typeof event.actorName === "string" && event.actorName.length > 0) return event.actorName;
  if (typeof event.actorIdentity === "string" && event.actorIdentity.length > 0) {
    return event.actorIdentity;
  }
  return event.actorId === null ? "The system" : "An account with no recorded name";
}

/** What they did. */
export function auditActionText(event: AuditEvent): string {
  return ACTION_WORDS[event.action] ?? event.action;
}

/**
 * The reason a maintainer typed, when the event carries one. Read defensively:
 * `metadata` is opaque JSON on the wire and a malformed row must not take the
 * whole audit view down.
 */
export function auditReason(event: AuditEvent): string | null {
  const metadata = event.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const reason = (metadata as Record<string, unknown>)["reason"];
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

/** One audit row as a sentence: "Avery froze the book - 2026-07-19 14:02 UTC". */
export function describeAuditEvent(event: AuditEvent): string {
  return `${auditActorName(event)} ${auditActionText(event)}`;
}

/**
 * The distinct actors present in a page of audit events, for the actor filter.
 *
 * Built from what was actually returned rather than from the collaborator list,
 * because the answer to "who changed this" includes people who have since been
 * removed - and those are exactly the ones an author is vetting.
 */
export function auditActors(events: AuditEvent[]): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const event of events) {
    const value = event.actorIdentity ?? event.actorId;
    if (value === null || value === undefined || value === "") continue;
    if (!seen.has(value)) {
      seen.set(value, auditActorName(event));
    }
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label }));
}
