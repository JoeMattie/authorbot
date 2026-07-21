# Phase 7 implementation contract - hardening

Additive to Phase 0-6 contracts. This is design document §23 Phase 6,
renumbered when guided onboarding took that slot. It precedes Phase 8 (the
collaborator skill) deliberately: the service should survive a fleet before
one is invited.

## Scope

> **Descoped (2026-07-21).** The **restore drill** and **load/failure testing**
> below were cut. Backup and restore remain *documented* in the runbook but are
> not exercised by an automated test, and no load testing was run. Everything
> else in this phase shipped: rate limits, the security and accessibility
> reviews, author-facing access control, and the operator runbook.

- **Rate limits** per actor and per token on every mutation, with
  `429` + `Retry-After` and documented ceilings. Voting, claiming, and
  submission endpoints first - they are the ones a fleet hits hardest.
- ~~**Restore drill**, executed as an automated test.~~ *(Descoped; restore is
  documented in the runbook but not automated.)*
- **Security review** of the whole surface, with the Phase 0-6 review lenses
  applied to the system rather than to a single phase: auth, tokens, CSRF,
  webhooks, injection, path handling, and the agent-facing untrusted-content
  boundary.
- **Accessibility review** of the published site and collaboration islands
  against the design's §16.6 list, including a screen-reader pass.
- ~~**Load and failure testing** under sustained fleet-shaped traffic.~~
  *(Descoped.)*
- **Author-facing access control** (§ below) - the settings an author needs to
  vet, restrict, and revoke the people and agents working on their book.
- **Operator documentation**: runbook for the failure modes above, backup and
  restore, key rotation (session, webhook, GitHub App), and how to read the
  audit log.

## Author-facing access control

Phase 2 built memberships, roles, and revocable agent tokens; Phase 6 added a
settings view. Neither gave an author a way to *see* who can touch their book
or to stop them. Hardening a system that strangers and agent fleets can write
to means putting that control in the author's hands, not in a database
console.

All of the following live in the maintainer settings view, and every action is
recorded as an audit event.

### Seeing

- **Collaborators**: who has access, their role, when they joined, who added
  them, and when they last acted.
- **Agent tokens**: name, scopes, owning human, created and last-used times,
  expiry. Tokens are never re-displayable - only their metadata.
- **Recent activity**: a readable view of the audit log filtered by actor, so
  "who changed this and when" is answerable without a runbook. Vetting is
  guesswork without it, which is why it belongs here rather than in Phase 9.

### Restricting

- **Change a role** (reader / contributor / editor / maintainer), with the
  scope consequences stated in plain language rather than as scope names.

- **Annotation policy** - who may comment and suggest, and whether it appears
  immediately:

  | Mode | Who may write | Appears |
  |---|---|---|
  | `open` | any signed-in GitHub user | immediately |
  | `approval-gated` | any signed-in GitHub user | after a maintainer approves |
  | `collaborators-only` | members only | immediately *(default)* |
  | `locked` | maintainers only | immediately |

  These form a progression from private workspace to public, and an author may
  move up and down it freely.

  **`locked` is author-only, not off.** The book remains fully usable by its
  maintainers: annotating their own drafts, thinking out loud in the margins,
  and running their own agents against their own ideas. Existing collaborators
  keep their membership and their history - they simply cannot write until the
  policy opens again. A solo author who never leaves `locked` is using the
  system as intended, not a degraded version of it.

  An author's agents work in `locked` by holding a membership with the
  maintainer role, which is the ordinary scope-intersection rule (Phase 2 §3)
  and a deliberate grant rather than an implicit inheritance from their owner.

  **Anonymous writing remains unavailable** in every mode, including `open`.
  Design §19.7 defers it until moderation, spam controls, privacy, and a
  deletion policy all exist; this phase supplies the first, not the rest.

- **Freeze the book** - a separate emergency control, orthogonal to the policy
  above: no writes at all, from anyone, including maintainers, across
  annotations, votes, claims, and submissions. **Reads are unaffected** and
  the published site keeps serving. This is "something is wrong, stop
  everything while I look", not a moderation setting.

- **Pause agents**: suspend every agent token at once while leaving human
  collaborators working. Agents are the population most likely to misbehave
  at volume, and an author should be able to stop them without dismantling
  their human collaboration.

### Moderating (`approval-gated`)

An approval queue is the only feature here that adds state, and it carries one
non-obvious requirement:

- **Pending annotations are not mirrored to Git.** They live in the
  operational database until approved. Committing unreviewed submissions to
  the permanent record would put spam in the book's history forever, where
  removing it means rewriting history. Approval is what makes a comment
  durable; that is the whole point of gating.
- A pending annotation is visible to its author (badged as awaiting review)
  and to maintainers. It is invisible to everyone else, accrues **no votes**,
  and cannot trigger a governance rule - an unapproved suggestion must not be
  able to manufacture work.
- The queue shows the comment, its target passage, the author's history with
  this book, and approve / reject actions. Rejection takes an optional reason,
  notifies nobody, and retains the record in the database (never in Git) so a
  mistake is recoverable and a pattern of abuse is visible.
- Bulk approve and bulk reject, because a moderation queue nobody can clear is
  a moderation queue nobody uses.
- Switching a book from `approval-gated` to a permissive mode does **not**
  retroactively approve what is queued; the queue is drained deliberately.

### Revoking

- **Remove a collaborator** or **revoke a token**, taking effect on the *next
  request* - not on session expiry. Specifically, revocation must:
  - invalidate that actor's sessions, not merely their membership;
  - release any lease they hold, returning the work item to `ready` so their
    departure does not strand work for up to four hours;
  - reject in-flight submissions from the revoked actor;
  - leave their prior contributions intact - attribution and history are
    permanent records, not access grants. Removing someone is not erasing
    them, and the interface must not imply otherwise.
- **Revoke all agent tokens** in one action, for a suspected leak.

Nothing here deletes content. An author who wants a contribution reverted uses
the normal editorial path; access control governs who may act next, not what
already happened.

## Exit criteria

1. Documented rate limits enforced and tested.
2. ~~Restore drill passes as an automated test.~~ *(Descoped.)*
3. Security and accessibility reviews complete with findings fixed or
   explicitly accepted in writing. (Security: reviewed and fixed. Accessibility:
   reviewed, findings recorded and ACCEPTED in docs/accessibility-findings.md -
   deferred until the tool works end-to-end for its first real book, and to be
   revisited before it is recommended to anyone else.)
4. ~~Load tests hold under sustained fleet-shaped traffic.~~ *(Descoped.)*
5. Runbook sufficient for an operator who did not build the system.
6. An author, signed in as maintainer and without touching a database or CLI,
   can list collaborators and tokens, read who did what, change a role, set the
   annotation policy, freeze the book, pause all agents, and revoke a
   collaborator or token.
7. Revocation is effective on the next request, releases held leases, rejects
   the revoked actor's in-flight submissions, invalidates their sessions, and
   preserves their existing attribution - each asserted by test.
8. Freeze refuses every write path (including maintainer writes) while reads
   and the published site are provably unaffected.
9. Each annotation policy is enforced server-side, not merely reflected in the
   interface: `collaborators-only` rejects non-members and `open` still refuses
   anonymous writes, while `locked` still admits maintainers - including an
   author's agent tokens holding the maintainer role - so a solo author can
   annotate and run agents against a closed book.
10. Under `approval-gated`: a pending annotation reaches no Git commit, is
    invisible to other readers, accrues no votes, and cannot trigger a rule;
    approval mirrors it to Git as a normal annotation; rejection leaves no
    trace in the repository.
