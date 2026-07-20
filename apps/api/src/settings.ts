/**
 * Book settings and in-book governance (Phase 6 contract §3.6).
 *
 * "A Settings view, visible only to maintainers, editing the same `book.yml`
 * that lives in Git — through the same outbox, coordinator, validation, and
 * attribution path as any other write. Settings changes are commits: diffable,
 * revertable, audited. There is no second configuration store."
 *
 * That sentence dictates the whole design. A PATCH is not a config update; it
 * is a read-modify-write of `book.yml` that lands as a commit, so it uses
 * exactly the machinery an annotation write uses: one `db.batch` carrying the
 * git operation, the outbox row, the audit event, and the projection row, and a
 * `202 queued` response naming the operation.
 *
 * ## The three field classes
 *
 * **Editable** — title, language, license, the three `publication.show_*`
 * flags, and `governance.rules`. Ordinary edits.
 *
 * **Guarded** — `slug` and `publication.chapter_url`. Both are inputs to every
 * published chapter URL, so changing either breaks links people have already
 * shared. The API refuses them unless the request names the field in
 * `confirm`, and the refusal *states what breaks* rather than just saying no:
 * the confirmation is worth having only if the maintainer learns something from
 * being asked.
 *
 * **Never editable** — `id`, `repository.default_branch`, `content.*`, and
 * `publication.api_url`. These are rejected with a problem that explains *why*
 * for each field individually, because "forbidden" alone would read as a bug.
 * `content.raw_html` is the important one: enabling raw HTML in a book that
 * renders reader-submitted prose is a decision about the site's XSS surface,
 * and it belongs in a reviewed commit rather than behind a toggle a session
 * hijack could flip.
 *
 * ## Rule versions
 *
 * Phase 3 keys decisions on `(source_annotation_id, action_type, rule_version)`
 * and Phase 6 makes rules editable, so the two must be reconciled: if an edited
 * rule kept its version, two materially different rules would be recorded
 * identically and a decision could no longer be read back to the rule that
 * produced it.
 *
 * So **the server owns `version`, and the client may not send it.** On each
 * PATCH, every rule whose `when`/`action`/`trigger` differs from the currently
 * *effective* rule of the same name gets `version = effective.version + 1`;
 * rules that did not change keep theirs, so a PATCH that touches only the title
 * does not churn governance. Comparing against the *effective* rule (which may
 * come from `RULES_JSON` or the built-in default, not from `book.yml`) is what
 * keeps versions monotonic across a book's first move from the environment
 * default into its own `book.yml`.
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ProjectRecord, Repositories, SqlStatement } from "@authorbot/database";
import { toTimestamp } from "@authorbot/domain";
import { METRIC_NAMES, RULE_OPERATORS } from "@authorbot/rule-engine";
import {
  bookConfigSchema,
  ruleActionSchema,
  ruleNameSchema,
  ruleWhenSchema,
  slugSchema,
  type BookConfig,
  type DeclarativeRule,
} from "@authorbot/schemas";
import { z } from "zod";
import { authOf, type AuthServices } from "./auth.js";
import type { AppDeps, AppEnv, Clock } from "./deps.js";
import { problem } from "./problems.js";
import { proseWriteBlocked } from "./reconcile.js";
import type { RuleEntry } from "./rules.js";
import { resolveRuleEntries } from "./rules.js";
import type { ProjectSerializer } from "./serializer.js";

/** Outbox kind this module emits (the repo-coordinator processor renders it). */
export const SETTINGS_OUTBOX_KIND = "book_config.update";

// ---------------------------------------------------------------------------
// Field taxonomy (contract §3.6)
// ---------------------------------------------------------------------------

/** Dotted paths a maintainer may change freely. */
export const EDITABLE_FIELDS = [
  "title",
  "language",
  "license",
  "publication.show_revision",
  "publication.show_attribution",
  "publication.show_public_annotations",
  "governance.rules",
] as const;

/**
 * Dotted paths that require explicit confirmation, each with the consequence
 * the maintainer must be told *before* the change is accepted.
 */
export const GUARDED_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  slug: "The slug appears in every published chapter URL. Changing it breaks every existing link to this book — bookmarks, citations, and links shared by readers will 404 until they are updated.",
  "publication.chapter_url":
    "chapter_url is the URL template for published chapters. Changing it moves every chapter to a new address, breaking every existing link to a chapter, including any a reader has cited.",
});

/**
 * Dotted paths that are never editable through the API, each with the reason.
 * The reason is returned to the client: a bare "forbidden" on a field the UI
 * offered would read as a bug rather than as a deliberate boundary.
 */
export const IMMUTABLE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  schema: "The schema identifier names the format of book.yml itself; it changes only when a migration changes the format.",
  id: "The book id is its permanent identity. Every annotation, decision, work item, and attribution entry ever recorded references it, so it cannot be reassigned.",
  "repository.default_branch":
    "The default branch is a deployment invariant: the coordinator commits to it and the projection reads from it. Changing it from the API would point the writer at one branch while the reader still watches another.",
  "content.chapters_glob":
    "The chapters glob is a repository layout invariant. Changing it re-scopes which files are chapters, which is a repository reorganisation — it belongs in a commit alongside the file moves it implies.",
  "content.raw_html":
    "Enabling raw HTML is a security decision, not a display preference: it widens this site's XSS surface to whatever any contributor can get into a chapter. It belongs in a reviewed commit, where a second person sees it, rather than behind a toggle that a stolen session could flip.",
  "publication.api_url":
    "api_url must match the Worker's API_BASE_PATH (ADR-0019, same-origin only). Changing one without the other breaks sign-in and the collaboration islands, so the pair is changed together at deploy time.",
});

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * A rule as a maintainer supplies it. Deliberately WITHOUT `version`: the
 * server assigns it (see the module doc), and silently ignoring a client's
 * version would be worse than refusing it — a client that thought it was
 * pinning a version would be wrong without being told.
 */
const ruleInputSchema = z.strictObject({
  trigger: z.enum(["vote_changed"]).optional(),
  when: ruleWhenSchema,
  action: ruleActionSchema,
});

/**
 * `null` clears an optional field; omitting it leaves the field alone. The two
 * must be distinguishable, which is why every optional is `.nullable()` rather
 * than the field simply being absent from the body.
 */
const settingsPatchSchema = z.strictObject({
  title: z.string().min(1).optional(),
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/, "must be a language tag like en-US")
    .optional(),
  license: z.string().min(1).nullable().optional(),
  slug: slugSchema.optional(),
  publication: z
    .strictObject({
      chapter_url: z.string().min(1).nullable().optional(),
      show_revision: z.boolean().nullable().optional(),
      show_attribution: z.boolean().nullable().optional(),
      show_public_annotations: z.boolean().nullable().optional(),
    })
    .optional(),
  governance: z
    .strictObject({
      /**
       * REPLACES the rule map wholesale rather than merging it. Merge
       * semantics would make a rule impossible to delete, and §3.6 requires
       * the default human-maintainer clause to be removable — "an author
       * running a genuinely collaborative project may not want a personal veto
       * on every change, and that is their call to make."
       */
      rules: z.record(ruleNameSchema, ruleInputSchema),
    })
    .optional(),
  /** Dotted paths of guarded fields the maintainer has confirmed. */
  confirm: z.array(z.string()).optional(),
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface SettingsContext {
  app: Hono<AppEnv>;
  deps: AppDeps;
  repos: Repositories;
  clock: Clock;
  services: AuthServices;
  auth: MiddlewareHandler<AppEnv>;
  idem: MiddlewareHandler<AppEnv>;
  serialize: ProjectSerializer;
  /** Boot-time rules: `RULES_JSON`, else the built-in default. */
  bootstrapRules: readonly RuleEntry[];
  requireProject(
    c: Context<AppEnv>,
  ): Promise<{ project: ProjectRecord } | { response: Response }>;
  claimStatements(c: Context<AppEnv>, status: number, body: unknown): SqlStatement[];
  commandStatements(input: {
    project: ProjectRecord;
    correlationId: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    outboxKind: string;
    outboxPayload: unknown;
    metadata?: unknown;
  }): { operationId: string; statements: SqlStatement[] };
  readJson(c: Context<AppEnv>): Promise<unknown | Response>;
  notifyMutation(projectId: string): Promise<void>;
  now(): string;
}

export function registerSettingsRoutes(ctx: SettingsContext): void {
  const { app, auth, idem, repos, deps } = ctx;

  /**
   * Maintainer-only, for read as well as write. The Settings view exposes the
   * governance rule and the license in one place; there is no reason for a
   * contributor to read it through the API, and `GET /v1/projects/{id}` already
   * carries everything a reader needs.
   */
  const requireMaintainer = (c: Context<AppEnv>): Response | null => {
    const a = authOf(c);
    if (a.role !== "maintainer") {
      return problem(c, "forbidden", {
        detail: "only a maintainer may read or change book settings",
      });
    }
    return null;
  };

  /**
   * The project's current config, or a problem response explaining that it has
   * not been projected from the repository yet.
   *
   * A book with no projected `book.yml` is not an error state to paper over: it
   * means this deployment has never successfully read the repository (no Git
   * credentials, or the first projection has not run). Settings cannot be
   * edited from nothing — a PATCH is a read-modify-write, and inventing a
   * `book.yml` here would fabricate an `id` for a book that already has one.
   */
  const loadConfig = async (
    c: Context<AppEnv>,
    project: ProjectRecord,
  ): Promise<
    | { config: BookConfig; status: string; updatedAt: string; sourceCommit: string | null }
    | { response: Response }
  > => {
    const row = await repos.bookConfigs.get(project.id);
    if (row === null) {
      return {
        response: problem(c, "state-conflict", {
          detail:
            "this book's book.yml has not been projected from its repository yet, so settings cannot be read or changed. Configure the GitHub App credentials and let the projection run, then retry.",
        }),
      };
    }
    const parsed = bookConfigSchema.safeParse(row.config);
    if (!parsed.success) {
      return {
        response: problem(c, "internal", {
          detail: "the projected book config is not a valid authorbot.book/v1 document",
        }),
      };
    }
    return {
      config: parsed.data,
      status: row.status,
      updatedAt: row.updatedAt,
      sourceCommit: row.sourceCommit,
    };
  };

  // ---- GET ----------------------------------------------------------------

  app.get("/v1/projects/:projectId/settings", auth, async (c) => {
    const guard = await ctx.requireProject(c);
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;

    const loaded = await loadConfig(c, guard.project);
    if ("response" in loaded) return loaded.response;
    const { config } = loaded;

    const effective = resolveRuleEntries(config, ctx.bootstrapRules);
    return c.json({
      /** Freely editable values (contract §3.6 "Editable"). */
      settings: {
        title: config.title,
        language: config.language,
        license: config.license ?? null,
        publication: {
          show_revision: config.publication?.show_revision ?? null,
          show_attribution: config.publication?.show_attribution ?? null,
          show_public_annotations: config.publication?.show_public_annotations ?? null,
        },
      },
      /**
       * Guarded values, each shipped WITH the consequence of changing it, so
       * the UI shows the warning without hardcoding a copy of it.
       */
      guarded: {
        slug: { value: config.slug, consequence: GUARDED_FIELDS["slug"] },
        "publication.chapter_url": {
          value: config.publication?.chapter_url ?? null,
          consequence: GUARDED_FIELDS["publication.chapter_url"],
        },
      },
      governance: {
        /**
         * Where the effective rules come from — `book` once the book declares
         * its own, otherwise the deployment's bootstrap default. The Settings
         * view says so plainly: an author editing a rule they have not yet
         * adopted is about to *adopt* it, not modify it.
         */
        source: config.governance?.rules === undefined ? "bootstrap" : "book",
        rules: Object.fromEntries(effective.map((entry) => [entry.name, entry.rule])),
        /** The closed vocabulary a rule condition may name (fail-closed). */
        vocabulary: { metrics: [...METRIC_NAMES], operators: [...RULE_OPERATORS] },
      },
      /**
       * Values the API will never change, each with the reason. Present so the
       * view can explain the boundary if asked — NOT as form fields. Exit
       * criterion 10 requires never-editable fields to be absent from the
       * interface; they are absent from `settings`, which is what the form
       * binds to.
       */
      readOnly: {
        id: config.id,
        "repository.default_branch": config.repository?.default_branch ?? null,
        "content.chapters_glob": config.content?.chapters_glob ?? null,
        "content.raw_html": config.content?.raw_html ?? null,
        "publication.api_url": config.publication?.api_url ?? null,
        reasons: IMMUTABLE_FIELDS,
      },
      /** `pending_git` while a previous settings commit is still in flight. */
      status: loaded.status,
      updatedAt: loaded.updatedAt,
      correlationId: c.get("correlationId"),
    });
  });

  // ---- PATCH --------------------------------------------------------------

  app.patch("/v1/projects/:projectId/settings", auth, idem, async (c) => {
    const guard = await ctx.requireProject(c);
    if ("response" in guard) return guard.response;
    const denied = requireMaintainer(c);
    if (denied !== null) return denied;

    const body = await ctx.readJson(c);
    if (body instanceof Response) return body;

    // Immutable fields are checked against the RAW body, before schema
    // parsing. The schema is strict, so an immutable key would otherwise be
    // rejected as "unrecognized key" — technically correct and completely
    // unhelpful. A maintainer who tried to turn on raw HTML deserves to be
    // told why they cannot, not that they made a typo.
    const immutable = findImmutablePaths(body);
    if (immutable.length > 0) {
      return problem(c, "settings-field-immutable", {
        detail: `these fields cannot be changed through the API: ${immutable.join(", ")}`,
        fields: immutable.map((path) => ({ field: path, reason: IMMUTABLE_FIELDS[path] })),
      });
    }

    const parsed = settingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return problem(c, "validation-failed", {
        detail: "settings patch failed validation",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      });
    }
    const patch = parsed.data;

    // Rule conditions are checked against the closed vocabulary here rather
    // than left to fail closed at evaluation time. Both are safe, but a rule
    // that silently never fires would leave a maintainer unable to promote
    // anything and with nothing to read explaining why.
    const ruleIssues = validateRuleVocabulary(patch);
    if (ruleIssues.length > 0) {
      return problem(c, "validation-failed", {
        detail: "governance rule references an unknown metric or operator",
        issues: ruleIssues,
      });
    }

    // Serialized per project like every other write, so two maintainers saving
    // at once cannot interleave read-modify-write and lose one of the edits.
    return ctx.serialize(guard.project.id, async () => {
      // A PATCH is a read-modify-write of the `book_configs` projection, and a
      // diverged project is by definition one whose projection we know we
      // mis-model — so the document we would re-commit is one we know to be
      // wrong. Phase 5's gate belongs here for the same reason it is applied
      // to submissions: this route rewrites a file the author also edits in
      // Git. Re-read the project inside the serializer rather than trusting
      // the guard's row, which `getProject` caches for the isolate's lifetime
      // — divergence is set by a webhook reconciliation that can land between
      // the auth check and the command.
      const currentProject = await repos.projects.getById(guard.project.id);
      if (currentProject !== null) {
        const diverged = proseWriteBlocked(c, currentProject);
        if (diverged !== null) return diverged;
      }

      const loaded = await loadConfig(c, guard.project);
      if ("response" in loaded) return loaded.response;
      const current = loaded.config;

      if (loaded.status === "pending_git") {
        return problem(c, "state-conflict", {
          detail:
            "a previous settings change has not been committed yet; wait for it to land before making another",
        });
      }

      const effective = resolveRuleEntries(current, ctx.bootstrapRules);
      const next = applyPatch(
        current,
        patch,
        effective,
        // Only needed when the patch touches governance; a title edit must not
        // pay for an aggregate over the decisions table.
        patch.governance === undefined
          ? new Map()
          : await repos.decisions.maxRuleVersions(guard.project.id),
      );

      const changed = changedPaths(current, next.config);
      if (changed.length === 0) {
        // Nothing to commit. Returning 200 rather than queueing a no-op commit
        // keeps `git log` free of empty settings commits when a UI re-saves an
        // unmodified form.
        const responseBody = {
          status: "unchanged",
          changed: [],
          settings: settingsView(next.config),
          correlationId: c.get("correlationId"),
        };
        const claims = ctx.claimStatements(c, 200, responseBody);
        if (claims.length > 0) await deps.db.batch(claims);
        return c.json(responseBody, 200);
      }

      const needsConfirmation = changed.filter(
        (path) => path in GUARDED_FIELDS && !(patch.confirm ?? []).includes(path),
      );
      if (needsConfirmation.length > 0) {
        return problem(c, "settings-confirmation-required", {
          detail: `these changes break existing links and must be confirmed: ${needsConfirmation.join(", ")}`,
          fields: needsConfirmation.map((path) => ({
            field: path,
            breaks: GUARDED_FIELDS[path],
          })),
          /** Echo the exact value the client must send back to proceed. */
          confirmWith: needsConfirmation,
        });
      }

      // Final gate: the merged document must be a valid book.yml. The patch
      // schema already constrains each field, but only the whole-document
      // schema can catch a combination it does not like — and this is the
      // document that is about to be committed.
      const validated = bookConfigSchema.safeParse(next.config);
      if (!validated.success) {
        return problem(c, "validation-failed", {
          detail: "the resulting book.yml would not be a valid authorbot.book/v1 document",
          issues: validated.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        });
      }

      const a = authOf(c);
      const correlationId = c.get("correlationId") ?? "";
      const at = toTimestamp(ctx.clock.now());

      const command = ctx.commandStatements({
        project: guard.project,
        correlationId,
        actorId: a.actor.id,
        action: "book_config.update",
        targetType: "project",
        targetId: guard.project.id,
        outboxKind: SETTINGS_OUTBOX_KIND,
        outboxPayload: {
          actorId: a.actor.id,
          config: validated.data,
          changed,
          /**
           * The last committed config, restored if this operation
           * dead-letters. Otherwise a failed settings commit strands the row
           * in `pending_git` forever — unwritable through the route, un-
           * re-projectable from Git, and still enforcing its governance rules.
           */
          previousConfig: current,
          previousSourceCommit: loaded.sourceCommit,
        },
        metadata: {
          changed,
          confirmed: needsConfirmation,
          ruleVersions: next.ruleVersions,
        },
      });

      const existing = await repos.bookConfigs.get(guard.project.id);
      const responseBody = {
        operationId: command.operationId,
        status: "queued",
        changed,
        settings: settingsView(validated.data),
        correlationId: c.get("correlationId"),
      };

      await deps.db.batch([
        // Git operation first: the config row references it.
        command.statements[0] as SqlStatement,
        repos.bookConfigs.upsertStatement({
          projectId: guard.project.id,
          config: validated.data,
          status: "pending_git",
          gitOperationId: command.operationId,
          sourceCommit: null,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        }),
        ...command.statements.slice(1),
        ...ctx.claimStatements(c, 202, responseBody),
      ]);
      await ctx.notifyMutation(guard.project.id);
      return c.json(responseBody, 202);
    });
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct testing)
// ---------------------------------------------------------------------------

/** The editable subset, shaped as the PATCH response returns it. */
export function settingsView(config: BookConfig): Record<string, unknown> {
  return {
    title: config.title,
    language: config.language,
    license: config.license ?? null,
    slug: config.slug,
    publication: {
      chapter_url: config.publication?.chapter_url ?? null,
      show_revision: config.publication?.show_revision ?? null,
      show_attribution: config.publication?.show_attribution ?? null,
      show_public_annotations: config.publication?.show_public_annotations ?? null,
    },
    governance: config.governance ?? null,
  };
}

/**
 * Immutable dotted paths present in a raw request body. Presence is what
 * counts, not whether the value differs: a client that sends
 * `content.raw_html: false` when it is already false is still asking for a
 * field it may not have, and answering "fine, no change" would teach it that
 * the field is writable.
 */
export function findImmutablePaths(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  const found: string[] = [];
  for (const path of Object.keys(IMMUTABLE_FIELDS)) {
    const [head, tail] = path.split(".");
    if (head === undefined) continue;
    if (tail === undefined) {
      if (record[head] !== undefined) found.push(path);
      continue;
    }
    const section = record[head];
    if (section !== null && typeof section === "object" && !Array.isArray(section)) {
      if ((section as Record<string, unknown>)[tail] !== undefined) found.push(path);
    }
  }
  return found;
}

const METRIC_SET: ReadonlySet<string> = new Set(METRIC_NAMES);
const OPERATOR_SET: ReadonlySet<string> = new Set(RULE_OPERATORS);

/** Rule conditions naming a metric or operator outside the closed vocabulary. */
export function validateRuleVocabulary(
  patch: SettingsPatch,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const rules = patch.governance?.rules;
  if (rules === undefined) return issues;
  for (const [name, rule] of Object.entries(rules)) {
    const group = "all" in rule.when ? "all" : "any";
    const conditions = "all" in rule.when ? rule.when.all : rule.when.any;
    conditions.forEach((condition, index) => {
      const path = `governance.rules.${name}.when.${group}.${index}`;
      if (!METRIC_SET.has(condition.metric)) {
        issues.push({
          path: `${path}.metric`,
          message: `unknown metric "${condition.metric}"; known metrics are ${METRIC_NAMES.join(", ")}`,
        });
      }
      if (!OPERATOR_SET.has(condition.operator)) {
        issues.push({
          path: `${path}.operator`,
          message: `operator "${condition.operator}" is not evaluated; use one of ${RULE_OPERATORS.join(", ")}`,
        });
      }
    });
  }
  return issues;
}

/** Structural equality of the parts of a rule that decide what it means. */
function sameRuleSemantics(
  a: DeclarativeRule,
  b: { when: unknown; action: unknown; trigger?: string | undefined },
): boolean {
  return (
    JSON.stringify(a.when) === JSON.stringify(b.when) &&
    JSON.stringify(a.action) === JSON.stringify(b.action) &&
    (a.trigger ?? "vote_changed") === (b.trigger ?? "vote_changed")
  );
}

/**
 * Merge a patch into a config, assigning rule versions.
 *
 * Returns the new config plus the version decision for each rule, which the
 * audit event records — "which rules changed version, and from what" is the
 * question someone reading `git log` after a governance dispute will ask.
 */
export function applyPatch(
  current: BookConfig,
  patch: SettingsPatch,
  effectiveRules: readonly RuleEntry[],
  /**
   * Highest version ever *recorded on a decision* for each rule name, from
   * `decisions.maxRuleVersions`. Rule versions must be monotonic per name
   * across deletion and re-addition, and the effective rule set cannot say so:
   * `governance.rules` replaces the map wholesale, so a deleted name simply
   * vanishes from it and a later re-add saw `previous === undefined` and
   * restarted at 1 — colliding with decision rows written by a materially
   * different rule under the same identity.
   */
  historicalVersions: ReadonlyMap<string, number> = new Map(),
): { config: BookConfig; ruleVersions: Record<string, { from: number | null; to: number }> } {
  // Structured clone via JSON: the config is plain data by construction (it
  // round-trips through YAML and D1), and this guarantees no aliasing between
  // the stored row and the document about to be committed.
  const next = JSON.parse(JSON.stringify(current)) as BookConfig & Record<string, unknown>;

  if (patch.title !== undefined) next.title = patch.title;
  if (patch.language !== undefined) next.language = patch.language;
  if (patch.slug !== undefined) next.slug = patch.slug;
  if (patch.license !== undefined) {
    if (patch.license === null) delete next.license;
    else next.license = patch.license;
  }

  if (patch.publication !== undefined) {
    const publication: Record<string, unknown> = { ...(next.publication ?? {}) };
    for (const [key, value] of Object.entries(patch.publication)) {
      if (value === undefined) continue;
      if (value === null) delete publication[key];
      else publication[key] = value;
    }
    // An emptied section is removed rather than left as `publication: {}` —
    // the diff a maintainer reviews should not contain an empty mapping.
    if (Object.keys(publication).length === 0) delete next.publication;
    else next.publication = publication as BookConfig["publication"];
  }

  const ruleVersions: Record<string, { from: number | null; to: number }> = {};
  if (patch.governance !== undefined) {
    const byName = new Map(effectiveRules.map((entry) => [entry.name, entry.rule]));
    const rules: Record<string, DeclarativeRule> = {};
    for (const [name, input] of Object.entries(patch.governance.rules)) {
      const previous = byName.get(name);
      const unchanged = previous !== undefined && sameRuleSemantics(previous, input);
      // A rule that did not change keeps its version — a PATCH touching only
      // the title must not churn governance. Anything else advances past BOTH
      // the effective rule and every version this name has ever burned on a
      // decision, so a re-added or renamed rule can never reuse an identity
      // that historical decision rows already refer to.
      const floor = Math.max(previous?.version ?? 0, historicalVersions.get(name) ?? 0);
      const version = unchanged ? previous.version : floor + 1;
      rules[name] = {
        version,
        ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
        when: input.when,
        action: input.action,
      };
      if (!unchanged) {
        ruleVersions[name] = { from: previous?.version ?? null, to: version };
      }
    }
    next.governance = { rules };
  }

  return { config: next, ruleVersions };
}

/**
 * Dotted paths whose value differs between two configs, restricted to the
 * paths this API can change. Computed from the documents rather than from the
 * patch so a field set to the value it already had is correctly reported as
 * unchanged — that is what makes a guarded field's confirmation requirement
 * fire only on a real change.
 */
export function changedPaths(before: BookConfig, after: BookConfig): string[] {
  const paths = [
    ...EDITABLE_FIELDS.filter((path) => path !== "governance.rules"),
    ...Object.keys(GUARDED_FIELDS),
    "governance.rules",
  ];
  const changed: string[] = [];
  for (const path of paths) {
    if (JSON.stringify(readPath(before, path)) !== JSON.stringify(readPath(after, path))) {
      changed.push(path);
    }
  }
  return changed;
}

function readPath(config: BookConfig, path: string): unknown {
  let cursor: unknown = config;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
