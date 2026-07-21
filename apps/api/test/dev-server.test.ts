/**
 * Regression for contract §6 BOOK_REPO_PATH: the Node dev entry wires the
 * book repository (reader + inline mirror) from the environment - previously
 * the binding was listed in the contract but read by no code, so no
 * configured deployment could exercise book-repo content outside tests.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeDevApi, serveNodeDevApi, type NodeDevApi } from "../src/dev-server.js";
import {
  CHAPTER_1,
  cloneExampleBookRepo,
  git,
  type BookRepoClone,
} from "./integration/helpers.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  AUTH_MODE: "dev",
  DEV_LOGIN_ENABLED: "true",
  SESSION_SECRET: "dev-server-session-secret",
  WEBHOOK_SECRET: "dev-server-webhook-secret",
  PROJECT_SLUG: "hollow-creek-anomaly",
  PROJECT_REPO: "JoeMattie/causal-projector",
  INITIAL_MAINTAINER: "github:JoeMattie",
};

describe("Node dev entry (BOOK_REPO_PATH)", () => {
  let clone: BookRepoClone;
  let dev: NodeDevApi;

  beforeAll(async () => {
    clone = await cloneExampleBookRepo();
    dev = await createNodeDevApi({ ...BASE_ENV, BOOK_REPO_PATH: clone.workTreePath });
  });
  afterAll(async () => {
    dev.close();
    await clone.cleanup();
  });

  it("refuses to boot without BOOK_REPO_PATH", async () => {
    await expect(createNodeDevApi({ ...BASE_ENV })).rejects.toThrow(/BOOK_REPO_PATH/);
  });

  it("enforces the dev-login guard (AUTH_MODE=dev needs DEV_LOGIN_ENABLED)", async () => {
    await expect(
      createNodeDevApi({
        ...BASE_ENV,
        DEV_LOGIN_ENABLED: undefined,
        BOOK_REPO_PATH: clone.workTreePath,
      }),
    ).rejects.toThrow(/DEV_LOGIN_ENABLED/);
  });

  it("fails closed in github mode without OAuth config - never falls back to dev auth", async () => {
    await expect(
      createNodeDevApi({
        ...BASE_ENV,
        AUTH_MODE: "github",
        DEV_LOGIN_ENABLED: undefined,
        GITHUB_CLIENT_ID: undefined,
        GITHUB_CLIENT_SECRET: undefined,
        GITHUB_REDIRECT_URI: undefined,
        BOOK_REPO_PATH: clone.workTreePath,
      }),
    ).rejects.toThrow(/GITHUB_CLIENT_ID|GitHub OAuth/);
  });

  it("bootstraps the projection from the repo and mirrors mutations inline over HTTP", async () => {
    const server = serveNodeDevApi(dev, 0);
    try {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const login = await fetch(`${base}/v1/dev/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ login: "devuser", role: "contributor" }),
      });
      expect(login.status).toBe(200);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;

      // The chapters projection was rebuilt from the real repo at bootstrap.
      const chapters = await fetch(`${base}/v1/projects/hollow-creek-anomaly/chapters`, {
        headers: { Cookie: cookie },
      });
      expect(chapters.status).toBe(200);
      const chapterPage = (await chapters.json()) as { items: { id: string }[] };
      expect(chapterPage.items.length).toBeGreaterThanOrEqual(3);

      // A mutation is committed to the work tree by the inline mirror.
      const create = await fetch(
        `${base}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_1.id}/annotations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            "Idempotency-Key": "dev-server-test-1",
            Origin: base,
          },
          body: JSON.stringify({
            kind: "comment",
            scope: "block",
            chapterRevision: CHAPTER_1.revision,
            target: { blockId: CHAPTER_1.firstBlockId },
            body: "Committed through the Node dev server.",
          }),
        },
      );
      expect(create.status).toBe(202);
      const { annotationId, operationId } = (await create.json()) as {
        annotationId: string;
        operationId: string;
      };

      const operation = await fetch(
        `${base}/v1/projects/hollow-creek-anomaly/operations/${operationId}`,
        { headers: { Cookie: cookie } },
      );
      const operationBody = (await operation.json()) as { state: string; commitSha: string };
      expect(operationBody.state).toBe("committed");

      const log = await git(clone.workTreePath, "log", "-1", "--format=%B");
      expect(log).toContain(`Authorbot-Annotation: ${annotationId}`);
    } finally {
      server.close();
    }
  });
});
