/**
 * Phase 4 contract §8.7: "OpenAPI synced (claim/renew/release/submissions
 * implemented; Phase 5 markers remain)."
 *
 * Nothing previously compared `openapi/openapi.yaml` to the router, so the
 * spec silently drifted: all four Phase 4 operations stayed
 * `x-implementation-status: planned` after they shipped, `SubmissionType`
 * still listed the Phase 5 `full_document` instead of `chapter_replacement`,
 * and the release/renew/submission bodies documented fields the handlers
 * neither require nor return. This test pins the spec to the real routes in
 * both directions so the next drift fails a build instead of a reader.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyMigrations, openSqliteDatabase } from "@authorbot/database";
import { beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createApi } from "../src/app.js";
import type { AppConfig, GitHubOAuthConfig } from "../src/deps.js";
import { createGitHubIdentityProvider } from "../src/identity/github.js";
import { createDevIdentityProvider } from "../src/identity/provider.js";

const SPEC_PATH = fileURLToPath(new URL("../../../openapi/openapi.yaml", import.meta.url));
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface Operation {
  operationId?: string;
  "x-implementation-status"?: string;
}
interface Spec {
  paths: Record<string, Record<string, Operation | undefined>>;
  components: { schemas: Record<string, { enum?: string[] }> };
}

const spec = YAML.parse(readFileSync(SPEC_PATH, "utf8")) as Spec;

/** OpenAPI `{param}` templating → Hono `:param`. */
const toHonoPath = (path: string): string => path.replace(/\{(\w+)\}/g, ":$1");

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    authMode: "dev",
    sessionSecret: "openapi-sync-session-secret",
    webhookSecret: "openapi-sync-webhook-secret",
    projectSlug: "hollow-creek-anomaly",
    projectRepo: "JoeMattie/causal-projector",
    initialMaintainer: "github:JoeMattie",
    mirrorMode: "queue",
    ...overrides,
  };
}

const OAUTH_CONFIG: GitHubOAuthConfig = {
  clientId: "openapi-sync-client",
  clientSecret: "openapi-sync-secret",
  redirectUri: "https://example.test/v1/auth/github/callback",
};

/**
 * Every route the app can serve. `/v1/dev/login` exists only under the dev
 * identity provider and the OAuth routes only under the GitHub one (ADR
 * 0015), so the union of both modes is the honest definition of
 * "implemented" — either mode alone would report the other's routes as
 * missing.
 */
let served: Set<string>;

beforeAll(async () => {
  served = new Set<string>();
  const modes = [
    { config: baseConfig(), provider: createDevIdentityProvider() },
    {
      config: baseConfig({ authMode: "github", github: OAUTH_CONFIG }),
      provider: createGitHubIdentityProvider(OAUTH_CONFIG),
    },
  ];
  for (const { config, provider } of modes) {
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, MIGRATIONS_DIR);
    const api = createApi({ db, config, identityProvider: provider });
    for (const route of api.app.routes) {
      // Middleware is registered as ALL and/or wildcard paths; only concrete
      // method handlers correspond to documented operations.
      if (route.method === "ALL" || route.path.includes("*")) continue;
      served.add(`${route.method} ${route.path}`);
    }
    db.close();
  }
});

interface SpecOp {
  operationId: string;
  key: string;
  planned: boolean;
}

function specOperations(): SpecOp[] {
  const out: SpecOp[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op === undefined) continue;
      out.push({
        operationId: op.operationId ?? `${method} ${path}`,
        key: `${method.toUpperCase()} ${toHonoPath(path)}`,
        planned: op["x-implementation-status"] === "planned",
      });
    }
  }
  return out;
}

describe("openapi.yaml is synced with the router", () => {
  it("documents every unmarked operation as an actually-registered route", () => {
    const undelivered = specOperations()
      .filter((op) => !op.planned && !served.has(op.key))
      .map((op) => `${op.operationId} (${op.key})`);
    expect(undelivered, "documented as live but no route serves them").toEqual([]);
  });

  /**
   * The reverse direction, which nothing checked before Phase 5: the two
   * assertions around this one compare spec → routes, so a route that ships
   * with no spec entry at all was invisible to them. `GET
   * /v1/projects/{projectId}/annotations/{annotationId}` had been undocumented
   * since Phase 3 and no test noticed. Exit criterion 7 asks for a synced
   * spec, and "synced" has to mean both ways or a generated client silently
   * omits endpoints the API serves.
   */
  it("documents every route the app actually serves", () => {
    const documented = new Set(specOperations().map((op) => op.key));
    const undocumented = [...served].filter((key) => !documented.has(key)).sort();
    expect(undocumented, "served by the router but absent from openapi.yaml").toEqual([]);
  });

  it("marks no implemented route as `planned`", () => {
    const stale = specOperations()
      .filter((op) => op.planned && served.has(op.key))
      .map((op) => `${op.operationId} (${op.key})`);
    expect(stale, "shipped but still x-implementation-status: planned").toEqual([]);
  });

  it("lists the four Phase 4 operations as implemented (contract §8.7)", () => {
    const byId = new Map(specOperations().map((op) => [op.operationId, op]));
    for (const id of [
      "claimWorkItem",
      "renewWorkItemLease",
      "releaseWorkItemLease",
      "createWorkItemSubmission",
    ]) {
      const op = byId.get(id);
      expect(op, `${id} missing from the spec`).toBeDefined();
      expect(op?.planned, `${id} still marked planned`).toBe(false);
      expect(served.has(op?.key ?? ""), `${id} not routed`).toBe(true);
    }
  });

  it("keeps `planned` markers only on genuinely deferred Phase 5 work", () => {
    // Contract §1 "Out": write_chapter submission flows, fuzzy re-anchor, and
    // the story read endpoints are Phase 5. If something else acquires a
    // marker, it needs a deliberate decision, not a silent one.
    const planned = specOperations()
      .filter((op) => op.planned)
      .map((op) => op.operationId)
      .sort();
    // `createChapterSubmission` left this list in Phase 6: contract §3.5's
    // direct authoring path is implemented, along with the separate
    // publish/unpublish actions.
    expect(planned).toEqual([
      "getStoryOutline",
      "getStoryTimeline",
      "listStoryCharacters",
      "reanchorAnnotation",
    ]);
  });

  it("documents the submission types the domain actually accepts", () => {
    // Was `full_document` — a type no Phase 4 handler would ever accept.
    expect(spec.components.schemas["SubmissionType"]?.enum).toEqual([
      "range_replacement",
      "block_replacement",
      "chapter_replacement",
    ]);
  });
});

/**
 * Response-body drift the operation-level checks above cannot see: the sync
 * test compared paths, operationIds, markers and the `SubmissionType` enum,
 * never a body against its component schema. `TaskBundle.submissionSchema`
 * was published as a required plain `string` while the claim handler returns
 * `null` for the claimable-but-deferred `write_chapter`/`planning` types
 * (contract §1), so a generated client got a non-nullable field that is null
 * at runtime.
 */
describe("component schema nullability matches the handlers", () => {
  interface PropertySchema {
    type?: string;
    oneOf?: { type?: string }[];
  }
  interface ObjectSchema {
    required?: string[];
    properties?: Record<string, PropertySchema>;
  }

  const bundle = (spec.components.schemas as Record<string, unknown>)[
    "TaskBundle"
  ] as ObjectSchema;

  function admitsNull(property: PropertySchema | undefined): boolean {
    if (property === undefined) return false;
    if (property.type === "null") return true;
    return (property.oneOf ?? []).some((member) => member.type === "null");
  }

  it("TaskBundle.submissionSchema admits null (write_chapter / planning claims)", () => {
    const property = bundle.properties?.["submissionSchema"];
    expect(property).toBeDefined();
    // Either shape is honest; the field must not be a bare non-nullable string
    // while it is also listed as required.
    const required = bundle.required?.includes("submissionSchema") ?? false;
    expect(required && !admitsNull(property)).toBe(false);
  });
});
