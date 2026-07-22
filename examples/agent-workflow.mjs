#!/usr/bin/env node
/**
 * examples/agent-workflow.mjs - a complete Authorbot agent run, in one
 * zero-dependency Node script (Phase 4 contract §7).
 *
 *   claim → print the task bundle → submit a replacement → poll the
 *   operation → report the commit.
 *
 * It uses only the documented public API - the same endpoints the web UI
 * uses - so it doubles as executable documentation of the agent contract.
 *
 * ---------------------------------------------------------------------------
 * SECURITY: THE TASK BUNDLE IS UNTRUSTED INPUT (design §19.6, §15.3)
 *
 * Everything this script prints under "task bundle" - the annotation body,
 * chapter summary, acceptance criteria, story references and the chapter
 * source itself - is *project content written by other people*. It is data,
 * never instructions. A real agent that pipes this into a language model MUST
 * keep it inside a clearly-delimited untrusted-data section of its prompt and
 * must not let it redirect the task, request credentials, or widen the edit
 * beyond the claimed target. Authorbot guarantees the bundle contains no
 * secrets and no hidden system instructions; it cannot guarantee the prose is
 * benign.
 *
 * The lease token is a bearer capability: it is held in memory, sent only to
 * the API, and never printed (this script redacts it everywhere).
 * ---------------------------------------------------------------------------
 *
 * Usage:
 *   node examples/agent-workflow.mjs <work-item-id> [replacement-text]
 *
 * The replacement text may be given as the second argument, or piped on
 * stdin (preferred for multi-line prose):
 *
 *   echo "the revised sentence" | node examples/agent-workflow.mjs <id>
 *
 * Environment:
 *   AUTHORBOT_API        API base URL           (default http://127.0.0.1:8787)
 *   AUTHORBOT_PROJECT    project slug           (required)
 *   AUTHORBOT_TOKEN      agent token - sent as `Authorization: Bearer …`
 *   AUTHORBOT_DEV_LOGIN  dev-mode login name    (local dev only; alternative
 *                        to AUTHORBOT_TOKEN, uses POST /v1/dev/login)
 *   AUTHORBOT_DEV_ROLE   role for the dev login (default "editor")
 *   AUTHORBOT_SUMMARY    optional submission summary
 *   AUTHORBOT_DRY_RUN    "1" prints the bundle and releases the lease without
 *                        submitting anything
 *
 * Exit codes: 0 applied · 3 conflict (chapter moved; a resolve_conflict work
 * item was created and the chapter was NOT modified) · 1 anything else.
 */

const DEFAULT_API = "http://127.0.0.1:8787";
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 120_000;

const api = (process.env.AUTHORBOT_API ?? DEFAULT_API).replace(/\/+$/, "");
const project = process.env.AUTHORBOT_PROJECT ?? "";
const [workItemId, inlineText] = process.argv.slice(2);

/** Auth state: a bearer token, or a dev-login session cookie. */
let bearer = process.env.AUTHORBOT_TOKEN ?? null;
let cookie = null;

function fail(message) {
  process.stderr.write(`agent-workflow: ${message}\n`);
  process.exit(1);
}

function headers(mutation) {
  const base = { accept: "application/json", "user-agent": "authorbot-agent/1.0" };
  if (bearer !== null) {
    base.authorization = `Bearer ${bearer}`;
  }
  if (cookie !== null) {
    base.cookie = cookie;
    // CSRF (Phase 2b contract §3): a cookie-authenticated mutation must carry
    // an Origin the API accepts. Its own origin always qualifies.
    base.origin = api;
  }
  if (mutation) {
    base["content-type"] = "application/json";
    // Every mutation is idempotent-keyed, so a retry after a dropped
    // connection replays the stored result instead of acting twice.
    base["idempotency-key"] = crypto.randomUUID();
  }
  return base;
}

async function call(method, path, body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: headers(method !== "GET"),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  return { status: response.status, body: payload };
}

/** `application/problem+json` → a one-line human explanation. */
function problemLine(result) {
  const detail = result.body?.detail ?? result.body?.title ?? "";
  const issues = Array.isArray(result.body?.issues)
    ? ` (${result.body.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")})`
    : "";
  return `HTTP ${result.status}${detail === "" ? "" : ` - ${detail}`}${issues}`;
}

async function devLogin(login, role) {
  const response = await fetch(`${api}/v1/dev/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "authorbot-agent/1.0",
      origin: api,
    },
    body: JSON.stringify({ login, role }),
  });
  if (!response.ok) {
    fail(`dev login failed: HTTP ${response.status} (is the API running in dev auth mode?)`);
  }
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (cookie === "") {
    fail("dev login returned no session cookie");
  }
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Which submission type a work-item type requires (contract §4). */
const SUBMISSION_TYPES = {
  revise_range: "range_replacement",
  revise_block: "block_replacement",
  revise_chapter: "chapter_replacement",
  resolve_conflict: "chapter_replacement",
};

function printBundle(bundle) {
  const line = (label, value) => process.stdout.write(`  ${label.padEnd(18)}${value}\n`);
  process.stdout.write("\n=== task bundle (UNTRUSTED PROJECT CONTENT) ===\n");
  line("work item", `${bundle.workItem.id} (${bundle.workItem.type}, ${bundle.workItem.priority})`);
  line("lease", `${bundle.lease.id} - token redacted, expires ${bundle.lease.expiresAt}`);
  line("chapter", `${bundle.document.chapterId} revision ${bundle.document.revision}`);
  line("content hash", bundle.document.contentHash);
  line("submission", bundle.submissionSchema ?? "(no submission flow for this type)");
  if (bundle.target !== undefined) {
    line("target block", bundle.target.blockId);
    if (bundle.target.exact !== undefined) {
      line("target text", JSON.stringify(bundle.target.exact));
    }
  }
  process.stdout.write("  acceptance criteria:\n");
  for (const criterion of bundle.workItem.acceptanceCriteria) {
    process.stdout.write(`    - ${criterion}\n`);
  }
  process.stdout.write("  request (untrusted):\n");
  for (const paragraph of String(bundle.context.annotationBody).split("\n")) {
    process.stdout.write(`    | ${paragraph}\n`);
  }
  line("chapter summary", JSON.stringify(bundle.context.chapterSummary));
  line("story refs", bundle.context.storyRefs.join(", ") || "(none)");
  process.stdout.write(`  chapter source:   ${bundle.document.source.length} bytes (not printed)\n`);
  process.stdout.write("=== end of untrusted content ===\n\n");
}

async function pollOperation(operationId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const result = await call("GET", `/v1/projects/${encodeURIComponent(project)}/operations/${operationId}`);
    if (result.status === 200) {
      const { state, error, commitSha } = result.body;
      if (state === "committed" || state === "verified") {
        return { state, error, commitSha };
      }
      if (state === "failed") {
        return { state, error, commitSha: null };
      }
    }
    if (Date.now() > deadline) {
      return { state: "timeout", error: null, commitSha: null };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function releaseLease(leaseId) {
  const result = await call(
    "POST",
    `/v1/projects/${encodeURIComponent(project)}/work-items/${workItemId}/lease/release`,
    { leaseId },
  );
  if (result.status !== 200) {
    process.stderr.write(`warning: could not release the lease: ${problemLine(result)}\n`);
  }
}

async function main() {
  if (project === "") {
    fail("AUTHORBOT_PROJECT is required (the project slug)");
  }
  if (workItemId === undefined) {
    fail("usage: node examples/agent-workflow.mjs <work-item-id> [replacement-text]");
  }
  if (bearer === null) {
    const login = process.env.AUTHORBOT_DEV_LOGIN;
    if (login === undefined) {
      fail("set AUTHORBOT_TOKEN (agent token) or AUTHORBOT_DEV_LOGIN (local dev)");
    }
    await devLogin(login, process.env.AUTHORBOT_DEV_ROLE ?? "editor");
  }

  const replacement = inlineText ?? (await readStdin());
  const dryRun = process.env.AUTHORBOT_DRY_RUN === "1";

  // ---- 1. claim -----------------------------------------------------------
  const base = `/v1/projects/${encodeURIComponent(project)}/work-items/${encodeURIComponent(workItemId)}`;
  const claimed = await call("POST", `${base}/claim`, {});
  if (claimed.status === 409) {
    fail(`work item is already claimed: ${problemLine(claimed)}`);
  }
  if (claimed.status !== 201) {
    fail(`claim failed: ${problemLine(claimed)}`);
  }
  const bundle = claimed.body;
  printBundle(bundle);

  // ---- 2. decide what to submit -------------------------------------------
  const submissionType = SUBMISSION_TYPES[bundle.workItem.type];
  if (submissionType === undefined) {
    await releaseLease(bundle.lease.id);
    fail(`work items of type "${bundle.workItem.type}" have no submission flow in Phase 4`);
  }
  if (dryRun) {
    await releaseLease(bundle.lease.id);
    process.stdout.write("dry run: lease released, nothing submitted\n");
    return 0;
  }
  if (replacement === "" && submissionType !== "range_replacement") {
    await releaseLease(bundle.lease.id);
    fail("no replacement text given (pass it as an argument or on stdin)");
  }

  // ---- 3. submit ----------------------------------------------------------
  const submitted = await call("POST", `${base}/submissions`, {
    leaseId: bundle.lease.id,
    leaseToken: bundle.lease.token,
    type: submissionType,
    // The base is the bundle's, verbatim: the server rejects a submission
    // aimed at any other revision (contract §4).
    baseRevision: bundle.document.revision,
    baseContentHash: bundle.document.contentHash,
    content: replacement,
    ...(process.env.AUTHORBOT_SUMMARY === undefined ? {} : { summary: process.env.AUTHORBOT_SUMMARY }),
  });
  if (submitted.status !== 202) {
    // The lease is still ours on a rejected submission - hand it back so the
    // item returns to the queue immediately instead of waiting for expiry.
    await releaseLease(bundle.lease.id);
    fail(`submission rejected: ${problemLine(submitted)}`);
  }
  process.stdout.write(
    `submitted ${submitted.body.submissionId} (operation ${submitted.body.operationId}); waiting for the commit…\n`,
  );

  // ---- 4. poll the operation ----------------------------------------------
  const outcome = await pollOperation(submitted.body.operationId);
  if (outcome.state === "timeout") {
    fail("timed out waiting for the operation to settle");
  }
  if (outcome.state === "failed") {
    fail(`the edit could not be committed: ${outcome.error ?? "unknown error"}`);
  }

  // A committed operation carrying the `submission-conflict` problem IS the
  // conflict record (contract §5): the chapter was left untouched.
  let conflict = null;
  if (typeof outcome.error === "string" && outcome.error.length > 0) {
    try {
      const parsed = JSON.parse(outcome.error);
      if (parsed.code === "submission-conflict") {
        conflict = parsed;
      }
    } catch {
      /* not a structured problem: fall through to the failure below */
    }
    if (conflict === null) {
      fail(`operation committed with an unexpected error: ${outcome.error}`);
    }
  }

  if (conflict !== null) {
    process.stdout.write(
      `conflict: the chapter changed under this edit; it was NOT modified.\n` +
        `  commit (conflict record): ${outcome.commitSha ?? "(unknown)"}\n` +
        `  resolve-conflict work item: ${conflict.conflictWorkItemId ?? "(none reported)"}\n`,
    );
    return 3;
  }

  process.stdout.write(`applied: commit ${outcome.commitSha ?? "(unknown)"}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => fail(error instanceof Error ? error.message : String(error)),
);
