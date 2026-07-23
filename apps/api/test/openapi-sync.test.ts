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
import { applyMigrations, openSqliteDatabase } from "@authorbot/database/testing";
import { EDITORIAL_CAPABILITIES } from "@authorbot/domain";
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
  description?: string;
  "x-implementation-status"?: string;
  responses?: Record<
    string,
    { content?: Record<string, { schema?: SchemaNode }> }
  >;
}
interface SchemaNode {
  $ref?: string;
  type?: string;
  description?: string;
  const?: unknown;
  enum?: string[];
  maxItems?: number;
  required?: string[];
  allOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  discriminator?: { propertyName?: string; mapping?: Record<string, string> };
}
interface Spec {
  paths: Record<string, Record<string, Operation | undefined>>;
  components: { schemas: Record<string, SchemaNode> };
}

const spec = YAML.parse(readFileSync(SPEC_PATH, "utf8")) as Spec;

function responseSchema(path: string, method: string, status = "200"): SchemaNode | undefined {
  return spec.paths[path]?.[method]?.responses?.[status]?.content?.["application/json"]?.schema;
}

function schemaAdmitsNull(schema: SchemaNode | undefined): boolean {
  if (schema === undefined) return false;
  if (schema.type === "null") return true;
  return (schema.oneOf ?? []).some((member) => member.type === "null");
}

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
 * "implemented" - either mode alone would report the other's routes as
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

  it("lists the Phase 4 lease and submission operations as implemented (contract §8.7)", () => {
    const byId = new Map(specOperations().map((op) => [op.operationId, op]));
    for (const id of [
      "claimWorkItem",
      "recoverWorkItemLeaseToken",
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
    // Fuzzy re-anchor remains deferred. If something else acquires a marker,
    // it needs a deliberate decision, not a silent one.
    const planned = specOperations()
      .filter((op) => op.planned)
      .map((op) => op.operationId)
      .sort();
    // `createChapterSubmission` left this list in Phase 6: contract §3.5's
    // direct authoring path is implemented, along with the separate
    // publish/unpublish actions.
    expect(planned).toEqual(["reanchorAnnotation"]);
  });

  it("documents the submission types the domain actually accepts", () => {
    // Was `full_document` - a type no Phase 4 handler would ever accept.
    expect(spec.components.schemas["SubmissionType"]?.enum).toEqual([
      "range_replacement",
      "block_replacement",
      "chapter_replacement",
    ]);
  });

  it("documents the exact chapter-source hash needed by revision proposals", () => {
    const source = responseSchema(
      "/v1/projects/{projectId}/chapters/{chapterId}/source",
      "get",
    );
    expect(source?.required).toEqual(expect.arrayContaining([
      "chapterId",
      "revision",
      "contentHash",
      "body",
    ]));
    expect(source?.properties?.["contentHash"]?.allOf?.[0]?.$ref).toBe(
      "#/components/schemas/ContentHash",
    );
    expect(
      spec.components.schemas["CreateChapterReplacementProposal"]?.required,
    ).toEqual(expect.arrayContaining(["baseRevision", "baseContentHash"]));
  });

  it("documents canonical and legacy chapter authoring authorization accurately", () => {
    const submission = spec.paths["/v1/projects/{projectId}/chapter-submissions"]?.post;
    expect(submission?.description).toContain("canonical `chapters:write` capability");
    expect(submission?.description).toContain("legacy `submissions:write` scope");
    expect(submission?.description).toContain("editor or maintainer role");

    const source = spec.paths["/v1/projects/{projectId}/chapters/{chapterId}/source"]?.get;
    expect(source?.description).toContain("Canonical credentials require `chapters:read`");
    expect(source?.description).toContain("legacy credentials use the historical");
    expect(source?.description).toContain("not limited to editors and maintainers");
  });

  it("documents the exact canonical editorial capability vocabulary", () => {
    expect(spec.components.schemas["EditorialCapability"]?.enum).toEqual([
      ...EDITORIAL_CAPABILITIES,
    ]);
  });

  it("documents the completed-work history without retained submission prose", () => {
    const page = responseSchema(
      "/v1/projects/{projectId}/work-items/completed",
      "get",
    );
    expect(page?.properties?.["items"]?.items?.$ref).toBe(
      "#/components/schemas/CompletedWorkItem",
    );

    const completed = spec.components.schemas["CompletedWorkItem"];
    expect(completed?.required).toEqual(
      expect.arrayContaining([
        "source",
        "chapter",
        "completedBy",
        "completedAt",
        "resultingRevision",
        "commitSha",
        "revisionProposalId",
        "approvedBy",
      ]),
    );
    expect(completed?.properties?.["content"]).toBeUndefined();
    expect(completed?.properties?.["proposedContent"]).toBeUndefined();
  });

  it("documents bounded chapter history, detail comparison, and restore proposal shapes", () => {
    expect(
      responseSchema("/v1/projects/{projectId}/chapters/{chapterId}/history", "get")
        ?.$ref,
    ).toBe("#/components/schemas/ChapterHistoryPage");
    expect(
      responseSchema(
        "/v1/projects/{projectId}/chapters/{chapterId}/history/{revision}",
        "get",
      )?.$ref,
    ).toBe("#/components/schemas/ChapterHistoryDetail");
    expect(
      responseSchema(
        "/v1/projects/{projectId}/chapters/{chapterId}/history/{revision}/restore",
        "post",
        "201",
      )?.$ref,
    ).toBe("#/components/schemas/ChapterHistoryRestoreResult");

    expect(spec.components.schemas["ChapterHistoryPage"]?.properties?.["items"]?.maxItems)
      .toBe(50);
    expect(spec.components.schemas["ChapterHistoryRevision"]?.required).toContain("status");
    expect(spec.components.schemas["ChapterHistoryDetail"]?.required).toEqual([
      "chapterId",
      "compare",
      "selected",
      "comparison",
      "current",
      "diff",
    ]);
    expect(
      spec.components.schemas["ChapterHistoryRestoreResult"]?.properties?.["status"]?.const,
    ).toBe("pending_review");
  });

  it("documents repository-document source and proposal variants", () => {
    expect(
      responseSchema("/v1/projects/{projectId}/repository-documents/source", "get")?.$ref,
    ).toBe("#/components/schemas/RepositoryDocumentSource");
    expect(
      spec.components.schemas["RepositoryDocumentSource"]?.properties?.["target"]?.$ref,
    ).toBe("#/components/schemas/RepositoryDocumentTarget");
    expect(spec.components.schemas["RevisionProposalType"]?.enum).toEqual([
      "chapter_replacement",
      "chapter_summary",
      "repository_document",
    ]);
    expect(spec.components.schemas["RevisionProposalOrigin"]?.enum).toEqual([
      "work_submission",
      "direct_edit",
      "summary_proposal",
      "history_restore",
      "document_edit",
    ]);
    expect(spec.components.schemas["RevisionProposalTargetKind"]?.enum).toEqual([
      "chapter",
      "outline",
      "timeline",
      "character",
    ]);

    const proposal = spec.components.schemas["RevisionProposal"];
    expect(schemaAdmitsNull(proposal?.properties?.["chapterId"])).toBe(true);
    expect(schemaAdmitsNull(proposal?.properties?.["baseRevision"])).toBe(true);
    expect(proposal?.required).toEqual(
      expect.arrayContaining(["targetKind", "targetId", "targetPath"]),
    );

    const create = spec.components.schemas["CreateRevisionProposal"];
    expect(create?.oneOf?.map((member) => member.$ref)).toEqual([
      "#/components/schemas/CreateChapterReplacementProposal",
      "#/components/schemas/CreateChapterSummaryProposal",
      "#/components/schemas/CreateRepositoryDocumentProposal",
    ]);
    expect(create?.discriminator).toEqual({
      propertyName: "proposalType",
      mapping: {
        chapter_replacement: "#/components/schemas/CreateChapterReplacementProposal",
        chapter_summary: "#/components/schemas/CreateChapterSummaryProposal",
        repository_document: "#/components/schemas/CreateRepositoryDocumentProposal",
      },
    });
    expect(spec.components.schemas["CreateRepositoryDocumentProposal"]?.required).toEqual([
      "proposalType",
      "targetKind",
      "targetPath",
      "baseContentHash",
      "proposedContent",
    ]);
    const createOperation = spec.paths["/v1/projects/{projectId}/revision-proposals"]?.post;
    expect(createOperation?.description).toContain(
      "`chapters:read` plus `summaries:write`",
    );
    expect(createOperation?.description).toContain("contributor role floor");
    expect(createOperation?.description).toContain(
      "maintainer role plus `revisions:review`",
    );
    expect(
      spec.components.schemas["CreateChapterSummaryProposal"]
        ?.properties?.["proposedContent"]?.description,
    ).toContain("empty string removes");
  });

  it("documents authenticated, bounded story-bible reads and claim-bundle links", () => {
    expect(responseSchema("/v1/projects/{projectId}/story/outline", "get")?.$ref).toBe(
      "#/components/schemas/StoryOutlineResponse",
    );
    expect(responseSchema("/v1/projects/{projectId}/story/timeline", "get")?.$ref).toBe(
      "#/components/schemas/StoryTimelineResponse",
    );
    expect(responseSchema("/v1/projects/{projectId}/story/characters", "get")?.$ref).toBe(
      "#/components/schemas/StoryCharacterPage",
    );
    expect(spec.components.schemas["StoryCharacterPage"]?.properties?.["items"]?.maxItems)
      .toBe(20);
    expect(
      spec.components.schemas["TaskBundle"]?.properties?.["context"]?.properties?.["storyApi"]
        ?.$ref,
    ).toBe("#/components/schemas/StoryApiLinks");
  });

  it("documents capability-filtered chapter activity with the exact optional counts", () => {
    type ActivitySchema = {
      type?: string;
      required?: string[];
      additionalProperties?: boolean;
      properties?: Record<string, { type?: string; minimum?: number }>;
    };
    const activity = spec.components.schemas["ChapterActivity"] as ActivitySchema | undefined;
    expect(activity?.type).toBe("object");
    expect(activity?.additionalProperties).toBe(false);
    expect(activity?.required).toBeUndefined();
    expect(Object.keys(activity?.properties ?? {})).toEqual([
      "openSuggestions",
      "openBlockComments",
      "openChapterComments",
      "openReplies",
      "openWorkItems",
    ]);
    for (const field of Object.values(activity?.properties ?? {})) {
      expect(field).toEqual(expect.objectContaining({ type: "integer", minimum: 0 }));
    }

    const chapterList = spec.paths["/v1/projects/{projectId}/chapters"]?.["get"] as
      | {
          responses?: {
            "200"?: {
              content?: {
                "application/json"?: {
                  schema?: {
                    properties?: {
                      items?: { items?: { $ref?: string } };
                    };
                  };
                };
              };
            };
          };
        }
      | undefined;
    expect(
      chapterList?.responses?.["200"]?.content?.["application/json"]?.schema?.properties
        ?.items?.items?.$ref,
    ).toBe("#/components/schemas/ChapterSummary");
  });

  it("documents authenticated current chapter summaries on the bounded chapter list", () => {
    const chapter = spec.components.schemas["Chapter"] as
      | {
          required?: string[];
          properties?: Record<string, unknown>;
        }
      | undefined;
    expect(chapter?.required).toContain("summary");
    expect(chapter?.properties?.["summary"]).toEqual(
      expect.objectContaining({
        oneOf: expect.arrayContaining([
          expect.objectContaining({ type: "string" }),
          expect.objectContaining({ type: "null" }),
        ]),
      }),
    );

    const chapterList = spec.paths["/v1/projects/{projectId}/chapters"]?.["get"] as
      | { description?: string }
      | undefined;
    expect(chapterList?.description).toContain("chapters:read");
    expect(chapterList?.description).toContain("draft and proposed");
    expect(chapterList?.description).toContain("published summaries");
  });

  it("documents optional authentication for the public event-poll representation", () => {
    const events = spec.paths["/v1/projects/{projectId}/events"]?.["get"] as
      | { description?: string; security?: Record<string, never[]>[] }
      | undefined;
    expect(events?.security).toEqual([
      { githubSession: [] },
      { agentToken: [] },
      {},
    ]);
    expect(events?.description).toContain("exact effective read");
    expect(events?.description).toContain("capabilities, with an explicit");
    expect(events?.description).toContain("field projection");
    expect(events?.description).toContain("malformed,");
    expect(events?.description).toContain("control-plane event types fail closed");
  });

  it("documents capability-scoped operation reads for agent tokens", () => {
    const operation = spec.paths[
      "/v1/projects/{projectId}/operations/{operationId}"
    ]?.["get"];
    expect(operation?.description).toContain("uniquely owns it");
    expect(operation?.description).toContain("exact read capability");
    expect(operation?.description).toContain("Control-plane");
    expect(operation?.description).toContain("fail closed");
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

describe("shared-state response schemas match the live event and claim contracts", () => {
  type Schema = {
    type?: string;
    minimum?: number;
    const?: unknown;
    required?: string[];
    oneOf?: Schema[];
    properties?: Record<string, Schema>;
  };
  const schemas = spec.components.schemas as Record<string, Schema>;

  it("documents the exact event cursor envelope returned by the feed", () => {
    const event = schemas["Event"];
    expect(event?.required).toEqual(["id", "type", "payload", "createdAt"]);
    expect(event?.properties?.["id"]).toEqual(
      expect.objectContaining({ type: "integer", minimum: 1 }),
    );
    expect(Object.keys(event?.properties ?? {})).toEqual([
      "id",
      "type",
      "payload",
      "createdAt",
    ]);
  });

  it("documents compact claim metadata and the redacted replay alternative", () => {
    const bundle = schemas["TaskBundle"];
    const workItem = bundle?.properties?.["workItem"];
    expect(workItem?.required).toEqual(["id", "type", "acceptanceCriteria", "priority"]);
    expect(Object.keys(workItem?.properties ?? {})).toEqual([
      "id",
      "type",
      "acceptanceCriteria",
      "priority",
    ]);

    const lease = bundle?.properties?.["lease"];
    expect(lease?.required).toEqual(["id", "expiresAt", "maxExpiresAt", "renewalPromptAt"]);
    expect(lease?.oneOf).toEqual([
      { required: ["token"] },
      { required: ["tokenRedacted"] },
    ]);
    expect(lease?.properties?.["tokenRedacted"]?.const).toBe(true);
  });
});
