# Cutting a release

Authorbot ships to npm as prebuilt packages (ADR-0022). An author's CI installs
them and runs the binary; it never clones this repository and never compiles
TypeScript. This document is how a release gets made and what the version
number promises to the people who pinned it.

---

## What gets published

| Package | What it is | Who consumes it |
|---|---|---|
| `@authorbot/cli` | the `authorbot` binary - `validate`, `build`, `upgrade` | author CI, local use |
| `@authorbot/api` | prebuilt Worker entry, Durable Object, and D1 migrations | `wrangler.jsonc` `main` |
| `@authorbot/create` | the setup wizard | `npx @authorbot/create` |
| `authorbot` | the unscoped alias forwarding to `@authorbot/cli` | `npx authorbot` |

Eight supporting packages - `schemas`, `markdown`, `domain`, `rule-engine`,
`database`, `repo-coordinator`, `git-github`, `publisher` - are published
because the public entry packages depend on them. **They are not a public
contract.** Their exports may change in any release, including a patch. Do not
import them directly; if you need something they hold, ask for it to be
re-exported from `@authorbot/cli` or `@authorbot/api`, where it will be covered
by the promises below.

The publishable set lives in one place, `scripts/publishable.mjs`, which the
packaging check, the version check, and the packer all read.

`@authorbot/test-fixtures` is deliberately private. It is reached only through
`devDependencies` and would be dead weight in an author's install.

---

## What the version number promises

These are ADR-0021 §2, restated as what a reader of the number can rely on.

**Within a major version:**

- **A book valid under `v1.x` stays valid under `v1.y`.** Validation may add
  *warnings* within a major; it never adds an *error* to content that was
  previously valid. An author who bumps a minor version and finds their book
  suddenly failing CI has found a bug in this project, not in their book.
- **Artifact schema changes ship additively.** `authorbot.chapter/v2` is
  accepted *alongside* `v1`, and the validator reads both through the
  transition. There is no flag day and no coordinated upgrade.
- **Every format change ships with an automated migration.** If we cannot
  write the migration, we do not make the change. This constrains us on
  purpose: it is what makes `authorbot upgrade` able to promise a pull request
  rather than a manual rewrite. Migrations are declared in
  `apps/cli/src/upgrade/migrations.ts`, which documents what one must do: be
  idempotent, leave a repository that validates, and report every path it
  touched. `authorbot upgrade` checks the first two rather than trusting them.
- **`@authorbot/cli` and `@authorbot/api` keep their CLI flags, exports, and
  HTTP surface.** Additions are minor; removals wait for a major.

**Across a major version:** breaking changes are permitted, and each arrives
with a migration and a documented window in which both formats are read.

**Database migrations are expand/contract** (ADR-0021 §4). Any migration that
ships alongside a Worker change must be compatible with the Worker *already
running*, because author CI applies migrations before deploying and the old
code keeps serving in between. Dropping a column or tightening a constraint
therefore takes two releases: expand in one, contract in the next. There is no
way to shortcut this without giving some author a broken deploy window.

Release tags are skippable too. A one-shot backfill must be safe when a book
upgrades from an older supported Worker straight to the new tag. If that old
Worker can write rows the backfill would miss, install a compatible database
guard before transforming existing rows and retain it through the rollback
window. Documentation that merely asks every author to deploy an intermediate
tag is not a sufficient release gate.

**Pre-1 release train.** While Authorbot remains on the `0.1.x` line, the
patch component is the next ordered release, and may contain backward-compatible
features or expand-phase migrations. The compatibility classes below still
govern what may ship and how it rolls out, but they map to SemVer components
only after the 1.0 contract is declared. This records the existing pre-1
practice explicitly instead of making a `0.1.x` migration look like an
accidental exception.

**Choosing a number**, in the terms above:

- **patch** - bug fixes; no new validation errors, no schema change.
- **minor** - new commands, flags, endpoints, or artifact schema versions
  accepted alongside the old; new validation *warnings*; expand-phase
  migrations.
- **major** - anything that can make a previously-valid book invalid, remove
  a flag or export, or contract the database schema.

Every package is released at the same version, including the internal ones.
They are built and tested as one workspace, `pnpm pack` rewrites each
`workspace:*` dependency to that exact version, and a mixed set was never
tested together. The upside for an author is that `@authorbot/cli@1.5.0`
resolves precisely the tree that CI proved green.

---

## Cutting a release

Everything below runs on a clean checkout of `main` with a green workspace.

### 1. Set the version

```bash
node scripts/bump-version.mjs 1.5.0
```

This updates every publishable package, the create wizard's toolchain version,
and the generated book template pin as one operation.

Then commit it on its own:

```bash
git commit -am "release: v1.5.0"
```

### 2. Rehearse

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm check:packaging     # npm pack --dry-run over every package; publishes nothing
pnpm check:author-ci     # installs the packed CLI with npm ci and runs it
pnpm check:api-tarball   # installs and imports the packed API Worker
```

`check:packaging` asserts each tarball carries `dist/` and a licence and leaks
no tests, sources, tsconfigs, or source maps. `check:author-ci` is the one that
catches the errors a workspace cannot: it packs the tarballs, copies
`templates/book-repo` into a temp directory, installs with plain `npm ci`, and
runs `npx authorbot validate` and `npx authorbot build`. It needs the network
and takes a couple of minutes. Run it before every release; it is the closest
thing to being an author that exists in this repository.

`check:author-ci` covers `@authorbot/cli` and derives its complete workspace
dependency closure from the package manifests. Local authoring makes
`@authorbot/api` a lazy CLI dependency, so the rehearsal packs that API and
its dependencies too. It does not start the API during the static validation
and build check.

`check:api-tarball` covers the collaborative path. It packs every publishable
package into a temporary release set, installs the API and its declared
dependency closure from those local tarballs into a scratch project with
lifecycle scripts disabled, and imports
`./node_modules/@authorbot/api/dist/worker.js` through its real filesystem path.
It asserts the default Worker and `ProjectCoordinator` exports that Wrangler
loads, then compares every packaged D1 migration byte-for-byte with the root
migration sources and checks the release boundary. The scratch directory is
removed on success or failure; use `pnpm check:api-tarball --keep` to retain
it for inspection.

### 3. Tag and push

```bash
git tag v1.5.0
git push origin main v1.5.0
```

The tag is the trigger. `.github/workflows/release.yml` then, in one job on one
checkout:

1. verifies every publishable package's version equals the tag;
2. builds the workspace once;
3. typechecks and runs the full suite **against those build outputs**;
4. runs the packaging check;
5. packs with `pnpm` (rewriting `workspace:*` to the exact version);
6. installs and imports that exact packed API Worker and verifies its
   migrations;
7. publishes each tarball with `npm publish --provenance`, in dependency
   order, so nothing on the registry ever points at a package that is not
   there yet.

A tag ending in a prerelease suffix (`v1.5.0-rc.1`) publishes under the `next`
dist-tag instead of `latest`, so it never becomes what a bare
`npm install @authorbot/cli` gets.

The workflow will not run on a fork: `if: github.repository ==
'JoeMattie/authorbot'` fails it immediately rather than at the last step with a
confusing authentication error.

### 4. Write the release notes

Tag the GitHub release with what changed and - critically - whether it carries
a book-format migration or a database migration. That is what an author reads
before deciding when to run `authorbot upgrade`.

---

## First publish: the chicken and egg

**npm trusted publishing is configured per package, on a package that already
exists.** So the very first release cannot use it: there is nothing yet to
attach the trust policy to.

Two ways through, in order of preference.

### Option A - publish the first version from a laptop

Claim the scope and push an initial version by hand, then never do it again:

```bash
npm login
pnpm -r build
node scripts/pack-release.mjs --out /tmp/authorbot-release
for t in $(node scripts/pack-release.mjs --list --out /tmp/authorbot-release); do
  npm publish "$t" --access public
done
```

No provenance on this one release (a laptop has no OIDC identity to attest
with). Every release after it gets provenance from the workflow.

### Option B - one granular token, then delete it

Create a **granular access token** on npmjs.com scoped to the `@authorbot`
packages with read-and-write permission and the shortest expiry offered, and
store it as the `NPM_TOKEN` repository secret. The release workflow's publish
step reads it as `NODE_AUTH_TOKEN` and will use it when OIDC is unavailable.

**Then delete the secret.** Once each package exists, configure trusted
publishing for it - on npmjs.com, under the package's *Settings → Trusted
publisher*, naming this repository and `release.yml` - and remove `NPM_TOKEN`.
A long-lived registry credential sitting in repository secrets is the thing
trusted publishing exists to get rid of; leaving it there because it works
means the migration never finishes.

### After the first publish, do this

`templates/book-repo/package.json` pins `@authorbot/cli` by version but ships
**without a lockfile**, because a lockfile cannot be generated for a package
that does not exist yet. Once the first version is on the registry:

```bash
cd templates/book-repo && npm install
```

and commit the resulting `package-lock.json`. Until that is done, a repository
created straight from the template fails its first CI run with the message the
workflow prints - *"package-lock.json is missing. Run 'npm install' locally and
commit the lockfile"* - which is accurate, but the template should not ship
needing it.

(The wizard generates the lockfile itself when it creates a book, so this only
affects someone copying the template by hand.)

---

## What provenance gives you

`--provenance` has GitHub mint a signed attestation binding each tarball to
this repository, this workflow file, and the exact commit that produced it, and
records it in Sigstore's public transparency log. npm shows a "Built and signed
on GitHub Actions" badge on the package page, and anyone can verify it:

```bash
npm audit signatures
```

For an author, that plus the integrity hashes in their `package-lock.json`
means the toolchain building their book is provably the code at the tag they
pinned. It is a strictly stronger guarantee than the git ref this replaced -
a tag can be moved, a signed attestation cannot.

Provenance requires `id-token: write`, which is the only elevated permission
the release workflow holds.

---

## Rolling back

Rolling back the *toolchain* and rolling back a *format migration* are
different operations, and confusing them is how an author ends up with an old
toolchain reading files a newer one rewrote (ADR-0021 §5).

- **Toolchain:** `authorbot upgrade --rollback <version>` moves the pin back
  and opens a pull request for it, exactly as an upgrade does. (By hand: set
  the version in the book's `package.json` back, run `npm install`, commit the
  lockfile, push.) CI redeploys on the older release.
- **Format migration:** `git revert` the migration commit. Book-repo migrations
  are committed separately from content precisely so this is possible without
  touching prose. `--rollback` does **not** do this for you - it names the
  migrations that ran between the two versions and leaves the revert to you,
  because reverting prose is a decision, not a side effect of a pin change.
- **Database:** there is no automatic down-migration. Applied D1 migrations
  remain in place when the toolchain pin moves backward. Expand/contract makes
  this survivable: the previous Worker can run against the expanded schema.
  For v0.1.36, the persistent capability-projection triggers also remain. They
  project safe legacy writes made by an old Worker and reject a write that
  would still need scope sanitation, avoiding a successful response that
  disagrees with storage. They are the rollback guard, not state that the
  rollback removes.

Re-validate after any rollback. `authorbot upgrade` does this for you in both
directions.

**Do not unpublish.** npm forbids it after 72 hours anyway, and it breaks every
lockfile that already resolved the version. Publish a fixed patch instead, and
`npm deprecate` the bad one with a message pointing at it.

---

## Adding a package to the release

1. Add its directory to `scripts/publishable.mjs`, in dependency order.
2. Give its `package.json` a `description`, `license`, `repository.directory`,
   `files`, `publishConfig: { "access": "public", "provenance": true }`, and a
   `prepack` that runs `node ../../scripts/copy-license.mjs`.
3. Run `pnpm check:packaging`. It will tell you what is missing.

Scoped packages default to **restricted** - that is, private - so a package
without `publishConfig.access` either fails to publish or, worse, publishes
privately and is invisible to authors. The check refuses to pass without it.
