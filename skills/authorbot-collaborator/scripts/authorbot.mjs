#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

const USER_AGENT = "authorbot-collaborator/1.0";
const ENV_PATH = resolve(process.cwd(), process.env.AUTHORBOT_ENV_FILE ?? ".env");

if (existsSync(ENV_PATH)) {
  loadEnvFile(ENV_PATH);
}

const POLL_INTERVAL_MS = Number(process.env.AUTHORBOT_POLL_INTERVAL_MS ?? 1_000);
const POLL_TIMEOUT_MS = Number(process.env.AUTHORBOT_POLL_TIMEOUT_MS ?? 120_000);
const api = (process.env.AUTHORBOT_API ?? "").replace(/\/+$/, "");
const project = process.env.AUTHORBOT_PROJECT ?? "";
const token = process.env.AUTHORBOT_TOKEN ?? "";
const compact = process.env.AUTHORBOT_PRETTY !== "1";
const [command = "help", ...args] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`authorbot: ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(`Usage: scripts/authorbot.mjs <command> [ids]

Environment: AUTHORBOT_API, AUTHORBOT_PROJECT, AUTHORBOT_TOKEN
Loads .env from the current directory first when present. Exported variables
win. Set AUTHORBOT_PRETTY=1 for indented output or AUTHORBOT_WAIT=0 to skip
automatic operation polling.

Reads:
  health | me | project | chapters [query] | chapter ID | source ID
  canon                            outline + timeline + all characters
  story outline|timeline|characters [query]
  document outline|timeline|character REPOSITORY_PATH
  annotations CHAPTER_ID [query] | replies ANNOTATION_ID [query]
  work [status] [query] | work-item ID
  revisions [query] | revision ID | revision-diff ID
  history CHAPTER_ID [REVISION [previous|current]]
  operation ID | watch ID | events [after] | rate-limits

Writes (read JSON from stdin unless the body is shown):
  draft
  annotate CHAPTER_ID
  reply ANNOTATION_ID             JSON or plain-text body
  vote ANNOTATION_ID approve|reject|abstain
  unvote ANNOTATION_ID            no body
  withdraw ANNOTATION_ID          {}
  promote ANNOTATION_ID           {}
  claim WORK_ITEM_ID              no body
  renew|recover|release WORK_ITEM_ID
  submit WORK_ITEM_ID
  propose
  approve|reject PROPOSAL_ID      optional {} or {"reason":"..."}
  restore CHAPTER_ID REVISION     {}

Escape hatch:
  request METHOD /v1/path         optional JSON body on stdin
`);
}

function requireApi() {
  if (api === "") fail("AUTHORBOT_API is required");
}

function requireToken() {
  if (token === "") fail("AUTHORBOT_TOKEN is required");
}

function requireProject() {
  if (project === "") fail("AUTHORBOT_PROJECT is required");
}

function need(value, label) {
  if (value === undefined || value === "") fail(`${label} is required`);
  return value;
}

function encoded(value) {
  return encodeURIComponent(value);
}

function projectPath(suffix = "") {
  requireProject();
  return `/v1/projects/${encoded(project)}${suffix}`;
}

function withQuery(path, query) {
  if (query === undefined || query === "") return path;
  return `${path}${query.startsWith("?") ? query : `?${query}`}`;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function jsonBody({ required = true, fallback } = {}) {
  const raw = await readStdin();
  if (raw === "") {
    if (fallback !== undefined) return fallback;
    if (!required) return undefined;
    fail("this command requires a JSON body on stdin");
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function headers(method, idempotencyKey) {
  const result = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  if (token !== "") result.authorization = `Bearer ${token}`;
  if (method !== "GET") {
    result["content-type"] = "application/json";
    result["idempotency-key"] = idempotencyKey;
  }
  return result;
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  }
  return 500 * 2 ** attempt;
}

async function request(method, path, body) {
  requireApi();
  const base = new URL(`${api}/`);
  const basePath = base.pathname.replace(/\/+$/u, "");
  let target;
  if (/^https?:\/\//u.test(path)) {
    target = new URL(path);
  } else if (
    basePath !== "" &&
    (path === basePath || path.startsWith(`${basePath}/`))
  ) {
    target = new URL(path, base.origin);
  } else {
    target = new URL(`${api}/${path.replace(/^\/+/u, "")}`);
  }
  if (target.origin !== base.origin) fail("refusing to send credentials to another origin");
  const idempotencyKey = method === "GET" ? undefined : crypto.randomUUID();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response;
    try {
      response = await fetch(target, {
        method,
        headers: headers(method, idempotencyKey),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
      continue;
    }

    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, retryDelay(response, attempt)),
      );
      continue;
    }

    const text = await response.text();
    let payload = null;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const detail = payload?.detail ?? payload?.title ?? text;
      fail(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return payload;
  }
  fail("request retry loop ended unexpectedly");
}

async function pollOperation(operationId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const operation = await request(
      "GET",
      projectPath(`/operations/${encoded(operationId)}`),
    );
    if (["committed", "verified", "failed"].includes(operation?.state)) {
      return operation;
    }
    if (Date.now() >= deadline) fail(`operation ${operationId} did not settle before timeout`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
}

async function readCanon() {
  const characters = [];
  let cursor;
  do {
    const page = await request(
      "GET",
      withQuery(
        projectPath("/story/characters"),
        `limit=20${cursor ? `&cursor=${encoded(cursor)}` : ""}`,
      ),
    );
    characters.push(...(Array.isArray(page?.items) ? page.items : []));
    cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  const [outline, timeline] = await Promise.all([
    request("GET", projectPath("/story/outline")),
    request("GET", projectPath("/story/timeline")),
  ]);
  return { outline, timeline, characters };
}

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, compact ? 0 : 2)}\n`);
}

async function execute() {
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command !== "health") requireToken();
  if (command === "canon") {
    print(await readCanon());
    return;
  }

  let method = "GET";
  let path;
  let body;
  let watchOnly = false;

  switch (command) {
    case "health":
      path = "/v1/health";
      break;
    case "me":
      path = "/v1/me";
      break;
    case "project":
      path = projectPath();
      break;
    case "chapters":
      path = withQuery(projectPath("/chapters"), args[0]);
      break;
    case "chapter":
      path = projectPath(`/chapters/${encoded(need(args[0], "chapter id"))}`);
      break;
    case "source":
      path = projectPath(`/chapters/${encoded(need(args[0], "chapter id"))}/source`);
      break;
    case "story": {
      const kind = need(args[0], "story kind");
      if (!["outline", "timeline", "characters"].includes(kind)) {
        fail("story kind must be outline, timeline, or characters");
      }
      path = withQuery(projectPath(`/story/${kind}`), args[1]);
      break;
    }
    case "document": {
      const kind = need(args[0], "document kind");
      if (!["outline", "timeline", "character"].includes(kind)) {
        fail("document kind must be outline, timeline, or character");
      }
      const repositoryPath = need(args[1], "repository path");
      path = projectPath(
        `/repository-documents/source?kind=${encoded(kind)}&path=${encoded(repositoryPath)}`,
      );
      break;
    }
    case "annotations":
      path = withQuery(
        projectPath(`/chapters/${encoded(need(args[0], "chapter id"))}/annotations`),
        args[1],
      );
      break;
    case "annotate":
      method = "POST";
      path = projectPath(`/chapters/${encoded(need(args[0], "chapter id"))}/annotations`);
      body = await jsonBody();
      break;
    case "replies":
      path = withQuery(
        projectPath(`/annotations/${encoded(need(args[0], "annotation id"))}/replies`),
        args[1],
      );
      break;
    case "reply": {
      method = "POST";
      path = projectPath(`/annotations/${encoded(need(args[0], "annotation id"))}/replies`);
      const raw = await readStdin();
      if (raw === "") fail("reply body is required on stdin");
      try {
        body = JSON.parse(raw);
      } catch {
        body = { body: raw };
      }
      break;
    }
    case "vote":
      method = "PUT";
      path = projectPath(`/annotations/${encoded(need(args[0], "annotation id"))}/vote`);
      body = { value: need(args[1], "vote value") };
      if (!["approve", "reject", "abstain"].includes(body.value)) {
        fail("vote value must be approve, reject, or abstain");
      }
      break;
    case "unvote":
      method = "DELETE";
      path = projectPath(`/annotations/${encoded(need(args[0], "annotation id"))}/vote`);
      break;
    case "withdraw":
    case "promote":
      method = "POST";
      path = projectPath(
        `/annotations/${encoded(need(args[0], "annotation id"))}/${
          command === "withdraw" ? "withdraw" : "force-create-work-item"
        }`,
      );
      body = {};
      break;
    case "work":
      path = withQuery(
        projectPath("/work-items"),
        [args[0] ? `status=${encoded(args[0])}` : "", args[1] ?? ""]
          .filter(Boolean)
          .join("&"),
      );
      break;
    case "work-item":
      path = projectPath(`/work-items/${encoded(need(args[0], "work item id"))}`);
      break;
    case "claim":
      method = "POST";
      path = projectPath(`/work-items/${encoded(need(args[0], "work item id"))}/claim`);
      break;
    case "renew":
    case "recover":
    case "release":
      method = "POST";
      path = projectPath(
        `/work-items/${encoded(need(args[0], "work item id"))}/lease/${command}`,
      );
      body = await jsonBody({
        required: command !== "release",
        fallback: command === "release" ? {} : undefined,
      });
      break;
    case "submit":
      method = "POST";
      path = projectPath(`/work-items/${encoded(need(args[0], "work item id"))}/submissions`);
      body = await jsonBody();
      break;
    case "revisions":
      path = withQuery(projectPath("/revision-proposals"), args[0]);
      break;
    case "revision":
      path = projectPath(`/revision-proposals/${encoded(need(args[0], "proposal id"))}`);
      break;
    case "revision-diff":
      path = projectPath(
        `/revision-proposals/${encoded(need(args[0], "proposal id"))}/diff`,
      );
      break;
    case "propose":
      method = "POST";
      path = projectPath("/revision-proposals");
      body = await jsonBody();
      break;
    case "approve":
    case "reject":
      method = "POST";
      path = projectPath(
        `/revision-proposals/${encoded(need(args[0], "proposal id"))}/${command}`,
      );
      body = await jsonBody({ required: false, fallback: {} });
      break;
    case "history":
      path = projectPath(`/chapters/${encoded(need(args[0], "chapter id"))}/history`);
      if (args[1] && !args[1].includes("=")) {
        path += `/${encoded(args[1])}`;
        path = withQuery(path, `compare=${encoded(args[2] ?? "previous")}`);
      } else {
        path = withQuery(path, args[1]);
      }
      break;
    case "restore":
      method = "POST";
      path = projectPath(
        `/chapters/${encoded(need(args[0], "chapter id"))}/history/${encoded(
          need(args[1], "revision"),
        )}/restore`,
      );
      body = {};
      break;
    case "draft":
      method = "POST";
      path = projectPath("/chapter-submissions");
      body = await jsonBody();
      break;
    case "operation":
      path = projectPath(`/operations/${encoded(need(args[0], "operation id"))}`);
      break;
    case "watch":
      watchOnly = true;
      break;
    case "events":
      path = withQuery(projectPath("/events"), `poll=1${args[0] ? `&after=${encoded(args[0])}` : ""}`);
      break;
    case "rate-limits":
      path = projectPath("/rate-limits");
      break;
    case "request":
      method = need(args[0], "HTTP method").toUpperCase();
      path = need(args[1], "API path");
      body = method === "GET" ? undefined : await jsonBody({ required: false, fallback: {} });
      break;
    default:
      fail(`unknown command "${command}" (run "scripts/authorbot.mjs help")`);
  }

  if (watchOnly) {
    print(await pollOperation(need(args[0], "operation id")));
    return;
  }

  const result = await request(method, path, body);
  if (
    method !== "GET" &&
    process.env.AUTHORBOT_WAIT !== "0" &&
    typeof result?.operationId === "string"
  ) {
    print({ result, operation: await pollOperation(result.operationId) });
    return;
  }
  print(result);
}

execute().catch((error) => fail(error instanceof Error ? error.message : String(error)));
