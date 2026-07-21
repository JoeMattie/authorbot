# Phase 10 implementation contract - reading presentation settings

Additive to Phase 0-9 contracts. Small, and deliberately scheduled **after an
author has read their own book in the tool for a while** - the point is to let
them fix what bothers them, and that list is not knowable in advance.

**Goal:** an author can change how their book reads - measure and typeface -
from the settings page, without touching CSS or a config file.

## 1. Scope

Two fields in `book.yml` under `publication`, edited through the Phase 6
settings view, committed through the same outbox and validated like any other
setting:

- `reading_width` - how wide the prose column runs
- `font` - the typeface family for prose

Both take effect on the next site build, which is a static rebuild, so the
change is visible as soon as CI publishes.

## 2. Fonts: curated stacks, not arbitrary faces

**The published site currently makes zero external requests.** No CDN, no
analytics, and a tight CSP. Arbitrary font selection breaks that: it means
hosting font files, resolving licensing, widening the CSP, and paying a
render-blocking download on every chapter page.

So `font` selects from a **curated set of system font stacks** - at least a
serif, a sans, and a monospace - each a plain CSS stack that resolves to a
font the reader already has. Free, instant, no privacy surface, no licensing
question. Unknown values fail validation rather than silently falling back, so
a typo is caught by `authorbot validate` and not discovered by a reader.

Bundling a specific licensed typeface is a **separate, deliberate decision**
with real weight, licensing, and CSP consequences. It is not a settings
toggle, and this phase must not make it look like one.

## 3. Width: a bounded choice, not a free number

`reading_width` is trivially a CSS variable, which is exactly why it needs a
floor and a ceiling. The current measure (~65 characters) sits near the
readability optimum; a field that accepts 200ch produces a page that is
technically configurable and materially worse to read.

Offer a small bounded set - narrow / default / wide, or a value clamped to
roughly 50-85 characters - and say in the interface what the trade-off is,
in reading terms rather than units.

## 4. Constraints inherited, not renegotiated

- The reading site stays script-free without an API URL; presentation settings
  are build-time, never client-side.
- Contrast and focus-visibility results from the accessibility review must
  still hold at every offered setting - a wider measure or a different family
  must not push any text under WCAG AA. Verify at the extremes, not just the
  default.
- `book.yml` remains the record: versioned, diffable, revertable.

## 5. Exit criteria

1. An author changes measure and typeface in the browser; both land as a
   validated commit to `book.yml` and appear on the published site after the
   rebuild.
2. Every offered combination passes the contrast checks in both colour
   schemes, asserted at the extreme settings rather than the default.
3. An unknown font key or an out-of-range width fails `authorbot validate`
   with a message naming the allowed values.
4. The api-url-less build remains script-free; no external request is added
   to any page.
5. Workspace green; prior phases intact.
