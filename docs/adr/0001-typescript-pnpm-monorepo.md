# ADR 0001: TypeScript pnpm monorepo

## Status

Accepted (2026-07-19)

## Context

Authorbot spans an HTTP API, a static publisher, a web UI, a Git adapter, and
several shared libraries (design §6.1). These pieces share domain types,
schemas, and Markdown tooling, and must evolve in lockstep during early phases.
Design §1.1 recommends a TypeScript monorepo with separable packages.

## Decision

One pnpm workspace (`apps/*`, `packages/*`) per design §6.1 and contract §1:

- Node >= 22, ESM only (`"type": "module"`), TypeScript strict.
- Each package compiles `src/` to `dist/` with `tsc`; `tsconfig.json` extends
  the root `tsconfig.base.json`; `exports` maps carry a `types` condition.
- Uniform scripts: `build`, `test` (vitest), `typecheck` (`tsc --noEmit`).
- Phase 0 packages: `@authorbot/schemas`, `@authorbot/markdown`,
  `@authorbot/cli` (in `apps/cli`, bin `authorbot`),
  `@authorbot/test-fixtures`. Later phases add the remaining §6.1 packages
  (`domain`, `database`, `git-github`, `repo-coordinator`, `publisher`,
  `rule-engine`, `api-client`, `apps/api`, `apps/web`).

## Consequences

- Shared types and schemas are imported directly; no version skew between
  packages in a single change.
- ESM-only excludes CommonJS-only dependencies; acceptable for a greenfield
  project targeting Node 22 and Cloudflare Workers.
- Cross-package changes land atomically in one commit, matching the contract's
  "update every affected package in the same change" rule.
