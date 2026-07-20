/**
 * Test-only client for the fake. It performs the design §14.2 blob → tree →
 * commit → ref sequence, so the fake's surface is exercised the way the real
 * writer will exercise it. This is deliberately *not* the production writer —
 * that lands separately against this same fake.
 */
import { FAKE_GITHUB_ORIGIN, type FakeGitHub } from "../src/testing/index.js";

/** A stand-in app JWT: the fake only checks the three-segment shape. */
export const FAKE_APP_JWT = "header.payload.signature";

export interface ApiResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export async function api<T = unknown>(
  fake: FakeGitHub,
  init: {
    method: string;
    path: string;
    token?: string | undefined;
    body?: unknown;
    accept?: string;
  },
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    accept: init.accept ?? "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "authorbot-test",
  };
  if (init.token !== undefined) headers["authorization"] = `Bearer ${init.token}`;
  const response = await fake.fetch(
    new Request(`${FAKE_GITHUB_ORIGIN}${init.path}`, {
      method: init.method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (text === "" ? undefined : JSON.parse(text)) as T,
  };
}

export async function getInstallationToken(fake: FakeGitHub): Promise<string> {
  const result = await api<{ token: string }>(fake, {
    method: "POST",
    path: `/app/installations/${fake.installationId}/access_tokens`,
    token: FAKE_APP_JWT,
  });
  if (result.status !== 201) {
    throw new Error(`token request failed: ${result.status}`);
  }
  return result.body.token;
}

export interface CommitViaApiOptions {
  branch?: string;
  files: Readonly<Record<string, string>>;
  message?: string;
  token: string;
  /** Head to build on; when omitted the branch ref is read first. */
  expectedHead?: string;
}

export interface CommitViaApiResult {
  ok: boolean;
  status: number;
  commitSha?: string;
  headRead?: string;
  message?: string;
}

/** The §14.2 sequence, without retry — retry belongs to the real writer. */
export async function commitViaApi(
  fake: FakeGitHub,
  options: CommitViaApiOptions,
): Promise<CommitViaApiResult> {
  const branch = options.branch ?? fake.defaultBranch;
  const repo = `/repos/${fake.fullName}`;
  const token = options.token;

  let head = options.expectedHead;
  if (head === undefined) {
    const ref = await api<{ object: { sha: string } }>(fake, {
      method: "GET",
      path: `${repo}/git/ref/heads/${branch}`,
      token,
    });
    if (ref.status !== 200) return { ok: false, status: ref.status };
    head = ref.body.object.sha;
  }

  const headCommit = await api<{ tree: { sha: string } }>(fake, {
    method: "GET",
    path: `${repo}/git/commits/${head}`,
    token,
  });
  if (headCommit.status !== 200) return { ok: false, status: headCommit.status, headRead: head };

  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const [path, content] of Object.entries(options.files)) {
    const blob = await api<{ sha: string }>(fake, {
      method: "POST",
      path: `${repo}/git/blobs`,
      token,
      body: { content, encoding: "utf-8" },
    });
    if (blob.status !== 201) return { ok: false, status: blob.status, headRead: head };
    tree.push({ path, mode: "100644", type: "blob", sha: blob.body.sha });
  }

  const created = await api<{ sha: string }>(fake, {
    method: "POST",
    path: `${repo}/git/trees`,
    token,
    body: { base_tree: headCommit.body.tree.sha, tree },
  });
  if (created.status !== 201) return { ok: false, status: created.status, headRead: head };

  const commit = await api<{ sha: string }>(fake, {
    method: "POST",
    path: `${repo}/git/commits`,
    token,
    body: {
      message: options.message ?? "Test commit",
      tree: created.body.sha,
      parents: [head],
    },
  });
  if (commit.status !== 201) return { ok: false, status: commit.status, headRead: head };

  const patched = await api<{ message?: string }>(fake, {
    method: "PATCH",
    path: `${repo}/git/refs/heads/${branch}`,
    token,
    body: { sha: commit.body.sha, force: false },
  });
  if (patched.status !== 200) {
    return {
      ok: false,
      status: patched.status,
      headRead: head,
      commitSha: commit.body.sha,
      ...(patched.body.message === undefined ? {} : { message: patched.body.message }),
    };
  }
  return { ok: true, status: 200, commitSha: commit.body.sha, headRead: head };
}

export const SAMPLE_BOOK: Record<string, string> = {
  "book.yml": "schema: authorbot.book/v1\ntitle: Causal Projector\n",
  "chapters/001-baseline.md": "---\nid: c1\nrevision: 1\n---\n\nBaseline prose.\n",
  "chapters/002-null-results.md": "---\nid: c2\nrevision: 1\n---\n\nNull results.\n",
  "story/outline.yml": "beats: []\n",
};
