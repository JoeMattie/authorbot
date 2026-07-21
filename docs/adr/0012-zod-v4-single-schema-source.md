# ADR 0012: Zod v4 as the single schema source, JSON Schema generated

## Status

Accepted (2026-07-19)

## Context

Artifact shapes (contract §4) must be enforced identically by the TypeScript
CLI/API and be consumable by non-TypeScript tooling (CI validators, agents,
editors). Maintaining hand-written JSON Schemas alongside runtime validators
guarantees drift.

## Decision

- All artifact schemas are defined once in `@authorbot/schemas` as Zod v4
  schemas (`import { z } from "zod"`) - the single source of truth
  (contract §1).
- JSON Schemas are **generated** from Zod via `z.toJSONSchema` by a build
  step and written to `packages/schemas/json/`, checked in so consumers need
  no build (contract §1). Generated files are never edited by hand.
- Schema identity uses the `schema` discriminator field
  (`authorbot.<artifact>/v1`, contract §4); breaking changes bump the `/vN`
  suffix rather than mutating a published shape.
- TypeScript types are inferred (`z.infer`), so validators and static types
  cannot disagree.

## Consequences

- One edit point per artifact; runtime validation, static types, and JSON
  Schema stay in lockstep.
- Zod constructs must stay within what `z.toJSONSchema` can represent;
  refinements that do not translate belong in the CLI's semantic checks
  (contract §5 error codes) instead of the schema layer.
- Checked-in generated output requires a CI freshness check to catch stale
  regeneration.
