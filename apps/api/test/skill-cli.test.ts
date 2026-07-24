import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(
  new URL("../../../skills/authorbot-collaborator/scripts/authorbot.mjs", import.meta.url),
);

interface SeenRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  userAgent: string | undefined;
  idempotencyKey: string | undefined;
  body: unknown;
}

const seen: SeenRequest[] = [];
let origin = "";
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  const entry: SeenRequest = {
    method: request.method ?? "",
    url: request.url ?? "",
    authorization: request.headers.authorization,
    userAgent: request.headers["user-agent"],
    idempotencyKey: request.headers["idempotency-key"] as string | undefined,
    body: raw === "" ? null : JSON.parse(raw),
  };
  seen.push(entry);
  response.setHeader("content-type", "application/json");

  if (entry.url === "/book/v1/me") {
    response.end(JSON.stringify({ actor: { id: "local:agent" } }));
    return;
  }
  if (entry.url === "/v1/projects/exported/annotations/ann-1/vote") {
    response.end(JSON.stringify({ operationId: "op-1", status: "queued" }));
    return;
  }
  if (entry.url === "/v1/projects/exported/operations/op-1") {
    response.end(JSON.stringify({ id: "op-1", state: "committed", commitSha: "abc123" }));
    return;
  }
  if (entry.url === "/v1/projects/canon/story/outline") {
    response.end(JSON.stringify({ outline: "outline" }));
    return;
  }
  if (entry.url === "/v1/projects/canon/story/timeline") {
    response.end(JSON.stringify({ timeline: "timeline" }));
    return;
  }
  if (entry.url === "/v1/projects/canon/story/characters?limit=20") {
    response.end(JSON.stringify({ items: [{ id: "one" }], nextCursor: "next" }));
    return;
  }
  if (entry.url === "/v1/projects/canon/story/characters?limit=20&cursor=next") {
    response.end(JSON.stringify({ items: [{ id: "two" }], nextCursor: null }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ detail: "not found" }));
});

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AUTHORBOT_")) delete env[key];
  }
  return env;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test server");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

describe("authorbot collaborator command", () => {
  it("loads credentials from .env and sends the standard request headers", async () => {
    seen.length = 0;
    const cwd = await mkdtemp(path.join(tmpdir(), "authorbot-skill-"));
    try {
      await writeFile(
        path.join(cwd, ".env"),
        `AUTHORBOT_API=${origin}/book\nAUTHORBOT_PROJECT=from-env\nAUTHORBOT_TOKEN=env-token\n`,
        { mode: 0o600 },
      );
      const result = await execFileAsync(process.execPath, [script, "me"], {
        cwd,
        env: cleanEnv(),
      });
      expect(JSON.parse(result.stdout)).toEqual({ actor: { id: "local:agent" } });
      expect(seen).toMatchObject([
        {
          method: "GET",
          url: "/book/v1/me",
          authorization: "Bearer env-token",
          userAgent: "authorbot-collaborator/1.0",
        },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prefers exported values, creates the write body, and polls the operation", async () => {
    seen.length = 0;
    const cwd = await mkdtemp(path.join(tmpdir(), "authorbot-skill-"));
    try {
      await writeFile(
        path.join(cwd, ".env"),
        "AUTHORBOT_API=http://127.0.0.1:1\nAUTHORBOT_PROJECT=wrong\nAUTHORBOT_TOKEN=wrong\n",
        { mode: 0o600 },
      );
      const result = await execFileAsync(
        process.execPath,
        [script, "vote", "ann-1", "approve"],
        {
          cwd,
          env: {
            ...cleanEnv(),
            AUTHORBOT_API: origin,
            AUTHORBOT_PROJECT: "exported",
            AUTHORBOT_TOKEN: "exported-token",
          },
        },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        result: { operationId: "op-1" },
        operation: { state: "committed", commitSha: "abc123" },
      });
      expect(seen[0]).toMatchObject({
        method: "PUT",
        url: "/v1/projects/exported/annotations/ann-1/vote",
        authorization: "Bearer exported-token",
        body: { value: "approve" },
      });
      expect(seen[0]?.idempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(seen[1]).toMatchObject({
        method: "GET",
        url: "/v1/projects/exported/operations/op-1",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reads the complete canon, including every character page, in one command", async () => {
    seen.length = 0;
    const result = await execFileAsync(process.execPath, [script, "canon"], {
      env: {
        ...cleanEnv(),
        AUTHORBOT_API: origin,
        AUTHORBOT_PROJECT: "canon",
        AUTHORBOT_TOKEN: "canon-token",
      },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      outline: { outline: "outline" },
      timeline: { timeline: "timeline" },
      characters: [{ id: "one" }, { id: "two" }],
    });
    expect(seen.slice(0, 2).map(({ url }) => url)).toEqual([
      "/v1/projects/canon/story/characters?limit=20",
      "/v1/projects/canon/story/characters?limit=20&cursor=next",
    ]);
    expect(new Set(seen.slice(2).map(({ url }) => url))).toEqual(
      new Set([
        "/v1/projects/canon/story/outline",
        "/v1/projects/canon/story/timeline",
      ]),
    );
  });
});
