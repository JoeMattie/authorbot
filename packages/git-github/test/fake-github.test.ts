/**
 * The fake's HTTP surface: the Git Data API subset the Phase 5 contract §7
 * names, plus installation-token auth.
 */
import { describe, expect, it } from "vitest";
import { decodeBase64, hashBlob, encodeUtf8 } from "../src/index.js";
import { createFakeGitHub, FakeGitHub, FAKE_GITHUB_ORIGIN } from "../src/testing/index.js";
import { api, commitViaApi, FAKE_APP_JWT, getInstallationToken, SAMPLE_BOOK } from "./helpers.js";

async function fixture(): Promise<{ fake: FakeGitHub; token: string }> {
  const fake = await createFakeGitHub({
    owner: "JoeMattie",
    repo: "causal-projector",
    files: SAMPLE_BOOK,
  });
  return { fake, token: await getInstallationToken(fake) };
}

describe("installation tokens", () => {
  it("mints a token for the configured installation", async () => {
    const fake = new FakeGitHub();
    const result = await api<{ token: string; expires_at: string; permissions: unknown }>(fake, {
      method: "POST",
      path: `/app/installations/${fake.installationId}/access_tokens`,
      token: FAKE_APP_JWT,
    });
    expect(result.status).toBe(201);
    expect(result.body.token).toMatch(/^ghs_/);
    expect(Date.parse(result.body.expires_at)).toBeGreaterThan(Date.now());
    expect(result.body.permissions).toEqual({ contents: "write", metadata: "read" });
  });

  it("rejects a missing or non-JWT authorization", async () => {
    const fake = new FakeGitHub();
    const path = `/app/installations/${fake.installationId}/access_tokens`;
    await expect(api(fake, { method: "POST", path })).resolves.toMatchObject({ status: 401 });
    await expect(
      api(fake, { method: "POST", path, token: "ghs_not_a_jwt" }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("404s an unknown installation id", async () => {
    const fake = new FakeGitHub();
    await expect(
      api(fake, {
        method: "POST",
        path: "/app/installations/99999/access_tokens",
        token: FAKE_APP_JWT,
      }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("requires a live token on repository requests", async () => {
    const { fake, token } = await fixture();
    const path = `/repos/${fake.fullName}`;
    await expect(api(fake, { method: "GET", path })).resolves.toMatchObject({ status: 401 });
    await expect(
      api(fake, { method: "GET", path, token: "ghs_forged" }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(api(fake, { method: "GET", path, token })).resolves.toMatchObject({ status: 200 });

    fake.revokeAllTokens();
    await expect(api(fake, { method: "GET", path, token })).resolves.toMatchObject({ status: 401 });
  });

  it("rejects an expired token", async () => {
    let now = Date.parse("2026-07-20T00:00:00.000Z");
    const fake = new FakeGitHub({ tokenTtlSeconds: 60, now: () => now });
    await fake.seedFiles(SAMPLE_BOOK);
    const token = await getInstallationToken(fake);
    const path = `/repos/${fake.fullName}`;
    await expect(api(fake, { method: "GET", path, token })).resolves.toMatchObject({ status: 200 });
    now += 61_000;
    await expect(api(fake, { method: "GET", path, token })).resolves.toMatchObject({ status: 401 });
  });
});

describe("repository metadata", () => {
  it("reports the default branch and full name", async () => {
    const { fake, token } = await fixture();
    const result = await api<{ full_name: string; default_branch: string }>(fake, {
      method: "GET",
      path: `/repos/${fake.fullName}`,
      token,
    });
    expect(result.body.full_name).toBe("JoeMattie/causal-projector");
    expect(result.body.default_branch).toBe("main");
  });

  it("404s another repository", async () => {
    const { fake, token } = await fixture();
    await expect(
      api(fake, { method: "GET", path: "/repos/someone/else", token }),
    ).resolves.toMatchObject({ status: 404 });
  });
});

describe("refs", () => {
  it("returns the branch head", async () => {
    const { fake, token } = await fixture();
    const result = await api<{ ref: string; object: { sha: string; type: string } }>(fake, {
      method: "GET",
      path: `/repos/${fake.fullName}/git/ref/heads/main`,
      token,
    });
    expect(result.status).toBe(200);
    expect(result.body.ref).toBe("refs/heads/main");
    expect(result.body.object.type).toBe("commit");
    expect(result.body.object.sha).toBe(fake.state.getRef("main"));
  });

  it("404s an unknown branch", async () => {
    const { fake, token } = await fixture();
    await expect(
      api(fake, { method: "GET", path: `/repos/${fake.fullName}/git/ref/heads/nope`, token }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("supports branch names containing slashes", async () => {
    const { fake, token } = await fixture();
    await fake.externalCommit({ "a.md": "a\n" }, { branch: "authorbot/scratch" });
    const result = await api<{ ref: string }>(fake, {
      method: "GET",
      path: `/repos/${fake.fullName}/git/ref/heads/authorbot/scratch`,
      token,
    });
    expect(result.body.ref).toBe("refs/heads/authorbot/scratch");
  });

  it("creates a branch with POST /git/refs and refuses a duplicate", async () => {
    const { fake, token } = await fixture();
    const head = fake.state.getRef("main")!;
    const path = `/repos/${fake.fullName}/git/refs`;
    await expect(
      api(fake, { method: "POST", path, token, body: { ref: "refs/heads/scratch", sha: head } }),
    ).resolves.toMatchObject({ status: 201 });
    await expect(
      api(fake, { method: "POST", path, token, body: { ref: "refs/heads/scratch", sha: head } }),
    ).resolves.toMatchObject({ status: 422 });
  });
});

describe("blobs", () => {
  it("creates a utf-8 blob at the sha real git would compute", async () => {
    const { fake, token } = await fixture();
    const result = await api<{ sha: string }>(fake, {
      method: "POST",
      path: `/repos/${fake.fullName}/git/blobs`,
      token,
      body: { content: "hello\n", encoding: "utf-8" },
    });
    expect(result.status).toBe(201);
    expect(result.body.sha).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("accepts base64 encoding", async () => {
    const { fake, token } = await fixture();
    const result = await api<{ sha: string }>(fake, {
      method: "POST",
      path: `/repos/${fake.fullName}/git/blobs`,
      token,
      body: { content: btoa("hello\n"), encoding: "base64" },
    });
    expect(result.body.sha).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("returns blob content base64-encoded and wrapped, as the real API does", async () => {
    const { fake, token } = await fixture();
    const sha = await hashBlob(encodeUtf8(SAMPLE_BOOK["chapters/001-baseline.md"]!));
    const result = await api<{ content: string; encoding: string; size: number }>(fake, {
      method: "GET",
      path: `/repos/${fake.fullName}/git/blobs/${sha}`,
      token,
    });
    expect(result.status).toBe(200);
    expect(result.body.encoding).toBe("base64");
    expect(new TextDecoder().decode(decodeBase64(result.body.content))).toBe(
      SAMPLE_BOOK["chapters/001-baseline.md"],
    );
    expect(result.body.size).toBe(encodeUtf8(SAMPLE_BOOK["chapters/001-baseline.md"]!).length);
  });

  it("serves raw bytes when asked with the raw media type", async () => {
    const { fake, token } = await fixture();
    const sha = await hashBlob(encodeUtf8(SAMPLE_BOOK["book.yml"]!));
    const response = await fake.fetch(
      new Request(`${FAKE_GITHUB_ORIGIN}/repos/${fake.fullName}/git/blobs/${sha}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github.raw" },
      }),
    );
    expect(await response.text()).toBe(SAMPLE_BOOK["book.yml"]);
  });

  it("rejects an invalid sha and 404s an unknown one", async () => {
    const { fake, token } = await fixture();
    const base = `/repos/${fake.fullName}/git/blobs`;
    await expect(
      api(fake, { method: "GET", path: `${base}/not-a-sha`, token }),
    ).resolves.toMatchObject({ status: 422 });
    await expect(
      api(fake, { method: "GET", path: `${base}/${"0".repeat(40)}`, token }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("422s a blob POST without content", async () => {
    const { fake, token } = await fixture();
    await expect(
      api(fake, { method: "POST", path: `/repos/${fake.fullName}/git/blobs`, token, body: {} }),
    ).resolves.toMatchObject({ status: 422 });
  });
});

describe("trees", () => {
  it("lists a tree recursively with paths, modes and sizes", async () => {
    const { fake, token } = await fixture();
    const head = fake.state.getRef("main")!;
    const treeSha = fake.state.getCommit(head).tree;
    const result = await api<{
      truncated: boolean;
      tree: { path: string; type: string; mode: string; size?: number }[];
    }>(fake, {
      method: "GET",
      path: `/repos/${fake.fullName}/git/trees/${treeSha}?recursive=1`,
      token,
    });
    expect(result.status).toBe(200);
    expect(result.body.truncated).toBe(false);
    const blobs = result.body.tree.filter((entry) => entry.type === "blob");
    expect(blobs.map((entry) => entry.path).sort()).toEqual(Object.keys(SAMPLE_BOOK).sort());
    expect(blobs.every((entry) => entry.mode === "100644")).toBe(true);
    expect(result.body.tree.some((entry) => entry.type === "tree" && entry.path === "chapters")).toBe(
      true,
    );
  });

  it("lists only the top level without recursive", async () => {
    const { fake, token } = await fixture();
    const treeSha = fake.state.getCommit(fake.state.getRef("main")!).tree;
    const result = await api<{ tree: { path: string }[] }>(fake, {
      method: "GET",
      path: `/repos/${fake.fullName}/git/trees/${treeSha}`,
      token,
    });
    expect(result.body.tree.map((entry) => entry.path).sort()).toEqual([
      "book.yml",
      "chapters",
      "story",
    ]);
  });

  it("creates a tree from base_tree, preserving untouched entries", async () => {
    const { fake, token } = await fixture();
    const baseTree = fake.state.getCommit(fake.state.getRef("main")!).tree;
    const result = await api<{ sha: string }>(fake, {
      method: "POST",
      path: `/repos/${fake.fullName}/git/trees`,
      token,
      body: {
        base_tree: baseTree,
        tree: [{ path: "chapters/001-baseline.md", mode: "100644", type: "blob", content: "new\n" }],
      },
    });
    expect(result.status).toBe(201);
    const files = fake.state.listTree(result.body.sha, true).filter((e) => e.type === "blob");
    expect(files.map((entry) => entry.path).sort()).toEqual(Object.keys(SAMPLE_BOOK).sort());
  });

  it("accepts the five-digit directory mode git emits", async () => {
    const { fake, token } = await fixture();
    const baseTree = fake.state.getCommit(fake.state.getRef("main")!).tree;
    const subtree = fake.state.resolvePath(baseTree, "chapters")!.sha;
    const result = await api<{ sha: string }>(fake, {
      method: "POST",
      path: `/repos/${fake.fullName}/git/trees`,
      token,
      body: { tree: [{ path: "copy", mode: "40000", type: "tree", sha: subtree }] },
    });
    expect(result.status).toBe(201);
    expect(
      fake.state.listTree(result.body.sha, true).map((entry) => entry.path),
    ).toContain("copy/001-baseline.md");
  });

  it("422s an unknown mode and a missing path", async () => {
    const { fake, token } = await fixture();
    const path = `/repos/${fake.fullName}/git/trees`;
    await expect(
      api(fake, {
        method: "POST",
        path,
        token,
        body: { tree: [{ path: "x.md", mode: "123456", content: "x" }] },
      }),
    ).resolves.toMatchObject({ status: 422 });
    await expect(
      api(fake, { method: "POST", path, token, body: { tree: [{ content: "x" }] } }),
    ).resolves.toMatchObject({ status: 422 });
  });
});

describe("commits and the §14.2 sequence", () => {
  it("commits several files as one commit and advances the ref", async () => {
    const { fake, token } = await fixture();
    const before = fake.state.getRef("main")!;
    const result = await commitViaApi(fake, {
      token,
      message: "Apply work item",
      files: {
        "chapters/001-baseline.md": "---\nid: c1\nrevision: 2\n---\n\nRevised prose.\n",
        ".authorbot/work-items/w1.md": "status: done\n",
        ".authorbot/attribution/a1.yml": "actor: github:JoeMattie\n",
      },
    });
    expect(result.ok).toBe(true);
    const head = fake.state.getRef("main")!;
    expect(head).toBe(result.commitSha);
    expect(fake.state.getCommit(head).parents).toEqual([before]);
    expect(fake.state.getCommit(head).message).toBe("Apply work item");
    expect(fake.fileAtHead("chapters/001-baseline.md")).toContain("revision: 2");
    expect(fake.fileAtHead(".authorbot/work-items/w1.md")).toBe("status: done\n");
    // Untouched files survive the base_tree merge.
    expect(fake.fileAtHead("book.yml")).toBe(SAMPLE_BOOK["book.yml"]);
    // Exactly one new commit.
    expect(fake.state.history("main")).toHaveLength(2);
  });

  it("returns commit metadata including tree and parents", async () => {
    const { fake, token } = await fixture();
    const head = fake.state.getRef("main")!;
    const result = await api<{ sha: string; tree: { sha: string }; parents: unknown[] }>(fake, {
      method: "GET",
      path: `/repos/${fake.fullName}/git/commits/${head}`,
      token,
    });
    expect(result.body.sha).toBe(head);
    expect(result.body.tree.sha).toBe(fake.state.getCommit(head).tree);
    expect(result.body.parents).toEqual([]);
  });

  it("422s a commit against an unknown tree or parent", async () => {
    const { fake, token } = await fixture();
    const path = `/repos/${fake.fullName}/git/commits`;
    await expect(
      api(fake, { method: "POST", path, token, body: { message: "m", tree: "0".repeat(40) } }),
    ).resolves.toMatchObject({ status: 422 });
    const tree = fake.state.getCommit(fake.state.getRef("main")!).tree;
    await expect(
      api(fake, {
        method: "POST",
        path,
        token,
        body: { message: "m", tree, parents: ["0".repeat(40)] },
      }),
    ).resolves.toMatchObject({ status: 422 });
  });

  it("refuses a non-fast-forward ref update and leaves the head untouched", async () => {
    const { fake, token } = await fixture();
    const head = fake.state.getRef("main")!;
    // Build a commit on the current head, then let an external push land.
    const stale = await commitViaApi(fake, { token, files: { "a.md": "a\n" } });
    expect(stale.ok).toBe(true);
    const afterFirst = fake.state.getRef("main")!;

    // A second commit pinned to the *original* head is not a fast-forward.
    const second = await commitViaApi(fake, {
      token,
      expectedHead: head,
      files: { "b.md": "b\n" },
    });
    expect(second.ok).toBe(false);
    expect(second.status).toBe(422);
    expect(second.message).toMatch(/not a fast forward/i);
    expect(fake.state.getRef("main")).toBe(afterFirst);
    expect(fake.fileAtHead("a.md")).toBe("a\n");
    expect(fake.fileAtHead("b.md")).toBeNull();
  });
});

describe("seeding and observation", () => {
  it("seeds from a nested directory object", async () => {
    const fake = new FakeGitHub();
    await fake.seedDirectory({
      "book.yml": "title: X\n",
      chapters: { "001.md": "# One\n" },
    });
    expect(fake.fileAtHead("chapters/001.md")).toBe("# One\n");
  });

  it("merges `directory` and `files` seeds, with `files` winning", async () => {
    const fake = await createFakeGitHub({
      directory: { chapters: { "001.md": "from directory\n" } },
      files: { "chapters/001.md": "from files\n" },
    });
    expect(fake.fileAtHead("chapters/001.md")).toBe("from files\n");
  });

  it("logs requests in arrival order for concurrency assertions", async () => {
    const { fake, token } = await fixture();
    const treeSha = fake.state.getCommit(fake.state.getRef("main")!).tree;
    const shas = fake.state
      .listTree(treeSha, true)
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.sha);
    await Promise.all(
      shas.map((sha) =>
        api(fake, { method: "GET", path: `/repos/${fake.fullName}/git/blobs/${sha}`, token }),
      ),
    );
    expect(
      fake.countRequests("GET", (pathname) => pathname.includes("/git/blobs/")),
    ).toBe(shas.length);
    expect(fake.requests.map((entry) => entry.sequence)).toEqual(
      fake.requests.map((_, index) => index + 1),
    );
  });

  it("404s an endpoint the fake does not implement", async () => {
    const { fake, token } = await fixture();
    await expect(
      api(fake, { method: "GET", path: `/repos/${fake.fullName}/contents/book.yml`, token }),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      api(fake, { method: "GET", path: "/user", token }),
    ).resolves.toMatchObject({ status: 404 });
  });
});
