# Architecture decision records

Decisions binding for Phase 0+. Format: MADR-ish (Status / Context / Decision
/ Consequences). Section references cite `AUTHORBOT_PROJECT_DESIGN.md`
(design), `docs/contracts/phase0-contract.md` (contract), `docs/contracts/phase1-contract.md`
(phase1-contract), `docs/contracts/phase2-contract.md` (phase2-contract), and
`docs/contracts/phase2b-contract.md` (phase2b-contract). ADRs
0001–0012 record the
design §26.1 defaults adopted by the Phase 0 contract (contract §6.5);
later ADRs record per-phase decisions.

| ADR | Title | Resolves |
|---|---|---|
| [0001](0001-typescript-pnpm-monorepo.md) | TypeScript pnpm monorepo | design §1.1, §6.1; contract §1 |
| [0002](0002-git-literary-truth-operational-db.md) | Git as literary source of truth, operational DB for the rest | design §3.2, §7 |
| [0003](0003-markdown-frontmatter-mandatory-block-ids.md) | Markdown + frontmatter + mandatory HTML-comment block IDs | design §8.3, §26.1(6); contract §3 |
| [0004](0004-stable-work-item-paths.md) | Work items at stable paths with status frontmatter | design §26.1(8), supersedes §8.1 dirs; contract §4 |
| [0005](0005-declarative-deterministic-rules.md) | Deterministic declarative rules, no user-supplied code | design §11.1 |
| [0006](0006-server-enforced-renewable-leases.md) | Server-enforced renewable leases, 30-minute default | design §12 |
| [0007](0007-github-app-git-data-api-atomic-commits.md) | GitHub App + Git Data API atomic commits, no force pushes | design §14.1–14.3 |
| [0008](0008-cloudflare-worker-d1-durable-object.md) | Cloudflare Worker + D1 + Durable Object per project | design §18.1, §26.1(1) |
| [0009](0009-direct-to-main-v01.md) | Direct-to-main in v0.1, PR mode later | design §14.4, §26.1(4) |
| [0010](0010-membership-authority-database.md) | Membership authority in database, manifest export to Git | design §26.1(3) |
| [0011](0011-aggregate-vote-export.md) | Aggregate-only vote export by default | design §26.1(5) |
| [0012](0012-zod-v4-single-schema-source.md) | Zod v4 single schema source, generated JSON Schema | contract §1 |
| [0013](0013-astro-static-publisher-zero-client-js.md) | Astro static publisher, programmatic build, zero client JS in Phase 1 | design §1.1, §16.1, §23; phase1-contract §1, §4 |
| [0014](0014-database-portability-layer.md) | Database portability layer: `SqlDatabase` with D1 + better-sqlite3 adapters, plain-SQL migrations | design §9.2, §18.3, §21.3; phase2-contract §2 |
| [0015](0015-identity-provider-interface-dev-login.md) | `IdentityProvider` interface with dev-mode login, never mounted in github mode | design §19.1, §19.3; phase2-contract §3, §7.2 |
| [0016](0016-transactional-outbox-inline-processor.md) | Transactional outbox + inline processor for Phase 2 Git mirroring, Durable Object wiring in Phase 5 | design §7.3, §14.3, §20.1–20.2; phase2-contract §5 |
| [0017](0017-agent-token-format-hash-only-storage.md) | Agent-token format `authorbot_<base64url>` with hash-only storage | design §19.2, §19.3; phase2-contract §3, §7.5 |
| [0018](0018-framework-free-islands-cors-csrf.md) | Framework-free collaboration islands, plain-text bodies, explicit CORS/CSRF model | design §16.1–16.2, §16.6, §19.4; phase2b-contract §1, §3 |
| [0019](0019-same-origin-only.md) | The API is same-origin with the site; no cross-origin deployment | design §16.2, §19.4; contracts/phase2b-contract §3 |
| [0020](0020-cloudflare-only-host.md) | GitHub for the repository, Cloudflare for hosting — no other host | design §14, §18 |
| [0021](0021-versioning-and-upgrades.md) | Versioning and the author upgrade path | design §26 |
| [0022](0022-npm-distribution.md) | Distribute prebuilt packages on npm | design §21 |

New ADRs: next number, same format, add a row here. Superseding an ADR: mark
the old one `Superseded by ADR NNNN` in its Status line.
