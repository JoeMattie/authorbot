# Architecture decision records

Decisions binding for Phase 0+. Format: MADR-ish (Status / Context / Decision
/ Consequences). Section references cite `AUTHORBOT_PROJECT_DESIGN.md`
(design) and `docs/phase0-contract.md` (contract). These ADRs record the
design §26.1 defaults adopted by the Phase 0 contract (contract §6.5).

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

New ADRs: next number, same format, add a row here. Superseding an ADR: mark
the old one `Superseded by ADR NNNN` in its Status line.
