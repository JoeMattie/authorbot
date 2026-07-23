/**
 * Regression tests for two deployment-safety findings:
 *
 * 1. The committed wrangler.jsonc must never default AUTH_MODE=dev - that
 *    would ship the unauthenticated maintainer-granting /v1/dev/login on any
 *    `wrangler deploy`. Dev auth additionally requires the independent
 *    DEV_LOGIN_ENABLED=true flag (defense in depth).
 * 2. A rejected bootstrap (e.g. a first-boot seed race) must not be cached:
 *    the isolate retries on the next request, and the seed itself tolerates
 *    unique-constraint races.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyMigrations, createRepositories, openSqliteDatabase } from "@authorbot/database/testing";
import type { Repositories } from "@authorbot/database/testing";
import { configFromBindings, createWorkerRuntime, type WorkerBindings } from "../src/worker.js";
import type { AuthorbotApi } from "../src/app.js";
import { seedProject } from "../src/seed.js";
import { SYSTEM_CLOCK } from "../src/deps.js";
import { baseConfig, MIGRATIONS_DIR } from "./helpers.js";

const WRANGLER_CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

function bindings(
  overrides: {
    [K in Exclude<keyof WorkerBindings, "DB">]?: WorkerBindings[K] | undefined;
  } = {},
): WorkerBindings {
  const merged: Record<string, unknown> = {
    DB: {} as WorkerBindings["DB"],
    AUTH_MODE: "github",
    SESSION_SECRET: "s",
    WEBHOOK_SECRET: "w",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    GITHUB_REDIRECT_URI: "https://example.test/cb",
    PROJECT_SLUG: "slug",
    PROJECT_REPO: "owner/repo",
    INITIAL_MAINTAINER: "github:owner",
  };
  // An explicit `undefined` override removes the binding (exactOptionalPropertyTypes).
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged as unknown as WorkerBindings;
}

describe("deployable configuration never defaults to dev auth", () => {
  it("wrangler.jsonc sets no AUTH_MODE (a deploy must opt in explicitly)", async () => {
    const raw = await readFile(WRANGLER_CONFIG, "utf8");
    // Strip comments, then parse: the committed vars must not carry AUTH_MODE
    // or DEV_LOGIN_ENABLED in any environment block.
    const withoutComments = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const config = JSON.parse(withoutComments) as { vars?: Record<string, unknown> };
    expect(config.vars?.["AUTH_MODE"]).toBeUndefined();
    expect(config.vars?.["DEV_LOGIN_ENABLED"]).toBeUndefined();
    expect(withoutComments).not.toContain('"dev"');
  });

  it("configFromBindings rejects a missing or unknown AUTH_MODE", () => {
    expect(() => configFromBindings(bindings({ AUTH_MODE: undefined }))).toThrow(/AUTH_MODE/);
    expect(() => configFromBindings(bindings({ AUTH_MODE: "development" }))).toThrow(/AUTH_MODE/);
  });

  it("configFromBindings rejects AUTH_MODE=dev without DEV_LOGIN_ENABLED=true", () => {
    expect(() => configFromBindings(bindings({ AUTH_MODE: "dev" }))).toThrow(
      /DEV_LOGIN_ENABLED/,
    );
    expect(() =>
      configFromBindings(bindings({ AUTH_MODE: "dev", DEV_LOGIN_ENABLED: "1" })),
    ).toThrow(/DEV_LOGIN_ENABLED/);
    const config = configFromBindings(
      bindings({ AUTH_MODE: "dev", DEV_LOGIN_ENABLED: "true" }),
    );
    expect(config.authMode).toBe("dev");
  });

  it("configFromBindings requires the OAuth trio in github mode", () => {
    expect(() =>
      configFromBindings(bindings({ GITHUB_CLIENT_SECRET: undefined })),
    ).toThrow(/GITHUB_CLIENT_SECRET/);
    const config = configFromBindings(bindings());
    expect(config.authMode).toBe("github");
  });
});

describe("worker bootstrap failure is not cached", () => {
  it("a rejected bootstrap returns 500 and the next request retries", async () => {
    let builds = 0;
    const okResponse = new Response("ok");
    const buildApi = (): AuthorbotApi => {
      builds += 1;
      const failing = builds === 1;
      return {
        app: { fetch: () => Promise.resolve(okResponse) },
        bootstrap: () =>
          failing
            ? Promise.reject(new Error("UNIQUE constraint failed: projects.slug"))
            : Promise.resolve({ project: {}, rebuild: null }),
      } as unknown as AuthorbotApi;
    };

    const runtime = createWorkerRuntime(buildApi);
    const env = bindings();

    const first = await runtime.fetch(new Request("https://x.test/v1/me"), env);
    expect(first.status).toBe(500);
    expect(first.headers.get("content-type")).toContain("application/problem+json");

    const second = await runtime.fetch(new Request("https://x.test/v1/me"), env);
    expect(second.status).toBe(200);
    expect(builds).toBe(2); // state was reset, not poisoned

    const third = await runtime.fetch(new Request("https://x.test/v1/me"), env);
    expect(third.status).toBe(200);
    expect(builds).toBe(2); // healthy state is cached
  });
});

describe("seedProject tolerates first-boot races", () => {
  it("a lost insert race re-reads the winner's rows instead of throwing", async () => {
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, MIGRATIONS_DIR);
    const repos = createRepositories(db);
    const config = baseConfig();

    // Isolate A seeds normally.
    const seeded = await seedProject(repos, config, SYSTEM_CLOCK);

    // Isolate B raced A: it observed "no rows yet" (stale reads), so its
    // seed takes the insert path and every INSERT hits a unique index.
    let staleProject = true;
    let staleActor = true;
    let staleMembership = true;
    const racedRepos: Repositories = {
      ...repos,
      projects: Object.assign(Object.create(Object.getPrototypeOf(repos.projects)), repos.projects, {
        getBySlug: async (slug: string) => {
          if (staleProject) {
            staleProject = false;
            return null;
          }
          return repos.projects.getBySlug(slug);
        },
      }),
      actors: Object.assign(Object.create(Object.getPrototypeOf(repos.actors)), repos.actors, {
        getByExternalIdentity: async (ref: string) => {
          if (staleActor) {
            staleActor = false;
            return null;
          }
          return repos.actors.getByExternalIdentity(ref);
        },
      }),
      projectMemberships: Object.assign(
        Object.create(Object.getPrototypeOf(repos.projectMemberships)),
        repos.projectMemberships,
        {
          getByProjectAndActor: async (projectId: string, actorId: string) => {
            if (staleMembership) {
              staleMembership = false;
              return null;
            }
            return repos.projectMemberships.getByProjectAndActor(projectId, actorId);
          },
        },
      ),
    };

    const reseeded = await seedProject(racedRepos, config, SYSTEM_CLOCK);
    expect(reseeded.id).toBe(seeded.id);

    // Exactly one project / actor / membership row exists.
    const projects = await db.prepare(`SELECT COUNT(*) AS n FROM projects`).all();
    expect(Number(projects[0]?.["n"])).toBe(1);
    const memberships = await db
      .prepare(`SELECT COUNT(*) AS n FROM project_memberships`)
      .all();
    expect(Number(memberships[0]?.["n"])).toBe(1);
    db.close();
  });
});
