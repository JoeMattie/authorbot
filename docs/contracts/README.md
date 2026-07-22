# Implementation contracts

These are the phase-by-phase build specs Authorbot was implemented against.
Each one pinned the decisions a phase's packages had to agree on before the
code was written; each is subordinate to
[`AUTHORBOT_PROJECT_DESIGN.md`](../../AUTHORBOT_PROJECT_DESIGN.md), which they
cite as "design §N".

They are kept as the design record, not as live documentation. The code they
describe is the current source of truth; the ADRs in [`../adr`](../adr) cite
these contracts section-by-section for the rationale behind specific decisions.
If a contract and the code disagree, the code is right and the contract is
history.

| Contract | Phase | Describes |
| --- | --- | --- |
| `phase0-contract.md` | 0 | Schemas, block IDs, the validator |
| `phase1-contract.md` | 1 | The read-only static publisher |
| `phase2-contract.md` | 2 | Identity and collaboration records (the API) |
| `phase2b-contract.md` | 2b | The inline annotation UI |
| `phase3-contract.md` | 3 | Votes, rules, and work generation |
| `phase4-contract.md` | 4 | Leases and submissions |
| `phase5-contract.md` | 5 | GitHub integration and publication tracking |
| `phase6-contract.md` | 6 | The guided onboarding wizard |
| `phase7-contract.md` | 7 | Hardening: rate limits, restore drills, reviews |
| `phase8-contract.md` | 8 | The collaborator skill for agent fleets |
| `phase9-contract.md` | 9 | Documentation and the project site |
| `phase10-contract.md` | 10 | Reading presentation settings |
| `phase11-contract.md` | 11 | Editorial revisions, chapter activity, granular agent permissions, history, and threads |
