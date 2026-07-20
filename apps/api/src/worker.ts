/**
 * Cloudflare Worker entry (contract §6). Builds `AppDeps` from bindings and
 * serves the app. Projection rebuild is skipped here: the Worker has no book
 * repository access until the Phase 5 GitHub reader (reads still work; the
 * webhook records deliveries and marks them `ignored`).
 *
 * Secrets (`SESSION_SECRET`, `WEBHOOK_SECRET`, `GITHUB_CLIENT_SECRET`) come
 * from `wrangler secret put` — never from vars or code.
 */
import { wrapD1Database, type D1DatabaseLike } from "@authorbot/database";
import { createApi, type AuthorbotApi } from "./app.js";
import type { AppConfig, AppDeps } from "./deps.js";
import { createDevIdentityProvider, type IdentityProvider } from "./identity/provider.js";
import { createGitHubIdentityProvider } from "./identity/github.js";

export interface WorkerBindings {
  DB: D1DatabaseLike;
  AUTH_MODE?: string;
  /**
   * Second, independent guard for dev auth (must be the string "true").
   * AUTH_MODE=dev mounts the unauthenticated `POST /v1/dev/login`; requiring
   * this extra flag means a deployment cannot end up with dev auth through a
   * single misconfigured variable.
   */
  DEV_LOGIN_ENABLED?: string;
  SESSION_SECRET?: string;
  WEBHOOK_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_REDIRECT_URI?: string;
  PROJECT_SLUG?: string;
  PROJECT_REPO?: string;
  INITIAL_MAINTAINER?: string;
  DEFAULT_BRANCH?: string;
  MIRROR_MODE?: string;
}

function required(bindings: WorkerBindings, name: keyof WorkerBindings): string {
  const value = bindings[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required binding ${String(name)}`);
  }
  return value;
}

export function configFromBindings(bindings: WorkerBindings): AppConfig {
  const authMode = bindings.AUTH_MODE;
  if (authMode !== "dev" && authMode !== "github") {
    // Explicit by design: a deployment must never fall back to dev auth.
    throw new Error(`AUTH_MODE must be "dev" or "github"`);
  }
  if (authMode === "dev" && bindings.DEV_LOGIN_ENABLED !== "true") {
    // Defense in depth: dev auth (the unauthenticated /v1/dev/login) requires
    // a second, independent opt-in so it cannot ship through AUTH_MODE alone.
    throw new Error(
      `AUTH_MODE=dev requires DEV_LOGIN_ENABLED=true (dev login must never reach a deployment)`,
    );
  }
  const config: AppConfig = {
    authMode,
    sessionSecret: required(bindings, "SESSION_SECRET"),
    webhookSecret: required(bindings, "WEBHOOK_SECRET"),
    projectSlug: required(bindings, "PROJECT_SLUG"),
    projectRepo: required(bindings, "PROJECT_REPO"),
    initialMaintainer: required(bindings, "INITIAL_MAINTAINER"),
    mirrorMode: bindings.MIRROR_MODE === "inline" ? "inline" : "queue",
  };
  if (bindings.DEFAULT_BRANCH !== undefined && bindings.DEFAULT_BRANCH.length > 0) {
    config.defaultBranch = bindings.DEFAULT_BRANCH;
  }
  if (authMode === "github") {
    config.github = {
      clientId: required(bindings, "GITHUB_CLIENT_ID"),
      clientSecret: required(bindings, "GITHUB_CLIENT_SECRET"),
      redirectUri: required(bindings, "GITHUB_REDIRECT_URI"),
    };
  }
  return config;
}

function identityProviderFor(config: AppConfig): IdentityProvider {
  if (config.authMode === "github") {
    if (config.github === undefined) {
      throw new Error("AUTH_MODE=github requires GitHub OAuth configuration");
    }
    return createGitHubIdentityProvider(config.github);
  }
  return createDevIdentityProvider();
}

interface WorkerState {
  api: AuthorbotApi;
  bootstrapped: Promise<unknown>;
}

/**
 * Worker runtime with retryable bootstrap: a failed bootstrap (e.g. a
 * transient D1 error, or losing a first-boot seed race before the seed became
 * conflict-tolerant) is NOT cached — the failing request gets a 500 and the
 * next request rebuilds state and retries, instead of poisoning the isolate
 * for its whole lifetime.
 */
export function createWorkerRuntime(
  buildApi: (bindings: WorkerBindings) => AuthorbotApi = defaultBuildApi,
): { fetch(request: Request, env: WorkerBindings): Promise<Response> } {
  let state: WorkerState | null = null;

  const getState = (bindings: WorkerBindings): WorkerState => {
    if (state === null) {
      const api = buildApi(bindings);
      state = { api, bootstrapped: api.bootstrap() };
    }
    return state;
  };

  return {
    async fetch(request: Request, env: WorkerBindings): Promise<Response> {
      let current: WorkerState;
      try {
        current = getState(env);
        await current.bootstrapped;
      } catch (error) {
        // Do not cache the failure: reset so the next request retries.
        state = null;
        void error; // never echo internals
        return internalProblem();
      }
      return current.api.app.fetch(request);
    },
  };
}

function defaultBuildApi(bindings: WorkerBindings): AuthorbotApi {
  const config = configFromBindings(bindings);
  const deps: AppDeps = {
    db: wrapD1Database(bindings.DB),
    config,
    identityProvider: identityProviderFor(config),
  };
  return createApi(deps);
}

function internalProblem(): Response {
  return new Response(
    JSON.stringify({
      type: "https://authorbot.dev/problems/internal",
      title: "Internal error",
      status: 500,
      code: "internal",
    }),
    { status: 500, headers: { "Content-Type": "application/problem+json; charset=utf-8" } },
  );
}

export default createWorkerRuntime();
