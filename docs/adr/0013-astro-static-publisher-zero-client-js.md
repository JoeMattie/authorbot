# ADR 0013: Astro static publisher, programmatic build, zero client JavaScript in Phase 1

## Status

Accepted (2026-07-19)

## Context

Phase 1 delivers a read-only public reading site (design §23 Phase 1,
`docs/contracts/phase1-contract.md`). Design §1.1 selects "Static Astro output, with
small interactive islands for collaboration features"; design §16.1 requires
reading pages that are fully usable without JavaScript — "the prose is the
product". The publisher must render untrusted book content safely
(phase1-contract §4) and be invocable from both the CLI and CI
(phase1-contract §1, §5), without coupling book repositories to a frontend
toolchain.

## Decision

- The publisher is `@authorbot/publisher`, generating **static Astro 5
  output** (design §1.1; phase1-contract §1).
- Astro is invoked **programmatically** via its `build()` API from
  `buildSite(...)`; the loaded, validated site model is injected through a
  virtual module. Consumers (CLI `authorbot build`, CI) never run `astro`
  directly and book repositories carry no Astro project or Node toolchain of
  their own.
- **Zero client JavaScript in Phase 1**: no islands, no framework
  integrations, no `<script>` tags in output (enforced by e2e tests). Pages
  are semantic HTML plus one stylesheet, satisfying design §16.1
  no-JavaScript readability by construction.
- **Interactive islands are deferred to collaboration mode** (Phase 2+,
  design §16.2, §23): annotation gutters, selection capture, and filters
  arrive as Astro islands on top of the same static pages, which is why Astro
  is chosen now rather than a plain template engine.
- Rendering goes through the `@authorbot/markdown` AST with escaping at the
  template boundary; raw HTML is never emitted and non-allow-listed URL
  schemes are not rendered as links (phase1-contract §4).

## Consequences

- Published sites are host-agnostic static files; GitHub Pages deployment is
  a plain artifact upload (phase1-contract §5).
- Reading pages cannot regress into requiring JavaScript without failing the
  zero-`<script>` e2e assertion.
- The publisher owns HTML generation end to end, so sanitization guarantees
  do not depend on Astro content-pipeline defaults.
- Phase 2 collaboration UI must be added as islands within this Astro
  project rather than a separate frontend, keeping one publisher.
