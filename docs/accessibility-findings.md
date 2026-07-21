# Accessibility review - findings and deferral

Phase 7 contract, exit criterion 3: findings are "fixed or explicitly accepted
in writing." These are **accepted, not fixed**, deliberately.

**Reviewed 2026-07-21** by driving the real pages in Chromium: 21 checks across
the reading site, annotation gutter, mobile drawer, composer, votes, `/work/`,
`/write/`, and `/settings/`, in light and dark, with and without JavaScript,
and under `pointer: coarse`.

## The decision

Authorbot has one user and one book. Nothing below blocks that user, and the
tool does not yet do the job it exists for. Spending on these before the
system works end-to-end for its first real project would be optimising a
surface nobody has reached yet.

Revisit when the tool works for its first book - and certainly before it is
recommended to anyone else, because a collaborative writing tool that only
some contributors can use is a worse failure than a slow one.

Nothing here is unknown or unmeasured. The cost of deferring is that it stays
that way until someone decides otherwise.

## Errors (deferred)

| # | Where | What a user experiences |
|---|---|---|
| E1 | vote buttons | Casting a vote throws keyboard focus to `<body>`; the next vote needs a full Tab traversal. `setBusy` sets `disabled` on the focused element. A `FocusRestore` path for votes exists but never runs, because the control mutates in place instead of re-rendering. |
| E2 | moderation queue | Approve/reject throws focus to `<body>`. On a 30-item queue a keyboard moderator restarts from the top after every decision - the "queue nobody can clear" the contract warns about. |
| E3 | audit filter | Changing the actor filter loses focus and announces nothing; the list empties with no signal whether it worked, matched nothing, or failed. |
| E4 | live feed | Annotations arriving from other collaborators are never announced. Every `announce()` is on a local action; the SSE handler has none. A blind user cannot tell that anyone else is writing in the margin. |

## Warnings (deferred)

W5 composer never states what it is annotating (the *card* does this well -
copy its label formula). W6 block marker's accessible name duplicates its
count. W7 vote buttons repeat their own label. W8 Escape does not close the
mobile drawer (not a trap; Tab exits). W9 disabled primary/destructive buttons
leave the tab order with no explanation, so a keyboard user never learns the
control exists. W10 two reading-site links stay under 44px on touch
(`.book-link` 227×28, chapter prev/next 103×20) - every island control passes.
W11 `/write/` announces its title twice (h1 and h2 identical).

## W12 - the one that is a design decision, not a defect

The block-level "Annotate this block" button is a genuine keyboard path,
verified end to end, so §16.6 is met in letter. But the selection toolbar only
appears from a real DOM selection, so **a keyboard-only user cannot create a
range-scoped suggestion** - the annotation shape that votes into a
`revise_range` work item.

The consequence: mouse users can generate work, keyboard users can only
comment on whole blocks. That is a two-tier contributor model, and it is worth
deciding on purpose rather than inheriting by accident. The likely fix is a
"quote a phrase from this block" affordance in the block composer.

## Verified correct - measured, not assumed

Zero WCAG AA contrast failures across 7 reading pages and every collaboration
surface, in both schemes (lowest passing 4.72:1 light, 5.87:1 dark). No focus
traps anywhere, including the drawer and confirmation panels. Exactly one `h1`
on all 11 pages; `lang` sourced from `book.yml`; landmarks everywhere; heading
order sane; zero div-as-button; zero unlabelled controls on any surface.
Annotation cards are labelled regions announcing quote, author, and status.
Highlights use outline plus background, never colour alone. Reduced motion is
respected by every animation in the codebase. Reading width and typography are
byte-identical with the gutter mounted and with JavaScript disabled. All 7
reading pages are fully readable with JavaScript off. Destructive confirmations
are keyboard-operable, never default-yes, and restore focus on cancel.
`/write/` moves focus to the offending field on validation failure. Signed-out
users get "Sign in to annotate" with focus moved to the sign-in control, not a
dead end.
