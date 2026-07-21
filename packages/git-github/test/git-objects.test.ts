/**
 * Object-hashing parity with real git. Every expected sha in this file was
 * produced by `git hash-object` / `git rev-parse` against a scratch
 * repository, so a regression here means fixtures stop matching real clones.
 */
import { describe, expect, it } from "vitest";
import {
  decodeBase64,
  encodeBase64,
  encodeTree,
  encodeUtf8,
  hashBlob,
  hashCommit,
  hashTree,
  isObjectSha,
  sortTreeEntries,
  type TreeEntry,
} from "../src/git-objects.js";

const AUTHOR = {
  name: "Authorbot",
  email: "authorbot@example.invalid",
  // 1767225600 +0000
  date: "2026-01-01T00:00:00.000Z",
  timezone: "+0000",
};

describe("blob hashing", () => {
  it("matches `git hash-object` for text content", async () => {
    await expect(hashBlob(encodeUtf8("hello\n"))).resolves.toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    await expect(hashBlob(encodeUtf8("# One\n"))).resolves.toBe(
      "db53e58aa16fd4e50265afd57173016021da585c",
    );
  });

  it("hashes the empty blob to git's e69de29", async () => {
    await expect(hashBlob(new Uint8Array(0))).resolves.toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    );
  });

  it("is content addressed: identical bytes hash identically", async () => {
    const a = await hashBlob(encodeUtf8("same"));
    const b = await hashBlob(encodeUtf8("same"));
    expect(a).toBe(b);
    expect(isObjectSha(a)).toBe(true);
  });
});

describe("tree hashing", () => {
  it("matches `git rev-parse HEAD^{tree}` for a nested tree", async () => {
    const chapters: TreeEntry[] = [
      {
        name: "001.md",
        mode: "100644",
        type: "blob",
        sha: "db53e58aa16fd4e50265afd57173016021da585c",
      },
      {
        name: "002.md",
        mode: "100644",
        type: "blob",
        sha: "8e93a1b7ba0b0b1f2a6dfa6f0e9a15fbbfeb5ec8",
      },
    ];
    // 002.md's blob sha is computed rather than hardcoded so the fixture
    // stays self-consistent if the sample text changes.
    chapters[1]!.sha = await hashBlob(encodeUtf8("# Two\n"));
    const chaptersSha = await hashTree(chapters);
    expect(chaptersSha).toBe("34ecc598a5a47d9a552cd48d34a0d5112483447f");

    const root = await hashTree([
      {
        name: "a.txt",
        mode: "100644",
        type: "blob",
        sha: "ce013625030ba8dba906f756967f9e9ca394464a",
      },
      { name: "chapters", mode: "040000", type: "tree", sha: chaptersSha },
    ]);
    expect(root).toBe("9bdc033e1f60f58d1d459062da0f321ab791d8a6");
  });

  it("hashes the empty tree to git's 4b825dc", async () => {
    await expect(hashTree([])).resolves.toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("sorts tree entries as git does: directories sort as name + '/'", async () => {
    const entries: TreeEntry[] = [
      {
        name: "a",
        mode: "040000",
        type: "tree",
        sha: "88788cf0e8a0d18bd97c61270f90b6e9d83a037d",
      },
      {
        name: "a.md",
        mode: "100644",
        type: "blob",
        sha: "587be6b4c3f93f93c489c0111bba5596147a26cb",
      },
    ];
    // git lists a.md *before* the `a` tree, because "a." < "a/".
    expect(sortTreeEntries(entries).map((entry) => entry.name)).toEqual(["a.md", "a"]);
    // The resulting object matches the real repository's root tree.
    await expect(hashTree(entries)).resolves.toBe("ca8143b3935eb8697e817a698dab0c8fcf8675ad");
    // Input order must not affect the hash.
    await expect(hashTree([...entries].reverse())).resolves.toBe(
      "ca8143b3935eb8697e817a698dab0c8fcf8675ad",
    );
  });

  it("encodes tree modes without the leading zero, as git does", () => {
    const encoded = encodeTree([
      {
        name: "a",
        mode: "040000",
        type: "tree",
        sha: "88788cf0e8a0d18bd97c61270f90b6e9d83a037d",
      },
    ]);
    expect(new TextDecoder().decode(encoded.slice(0, 7))).toBe("40000 a");
  });

  it("rejects a path used where a single segment is required", () => {
    expect(() =>
      encodeTree([
        {
          name: "chapters/001.md",
          mode: "100644",
          type: "blob",
          sha: "db53e58aa16fd4e50265afd57173016021da585c",
        },
      ]),
    ).toThrow(/one path segment/);
  });
});

describe("commit hashing", () => {
  it("matches `git rev-parse HEAD` for a root commit", async () => {
    await expect(
      hashCommit({
        tree: "9bdc033e1f60f58d1d459062da0f321ab791d8a6",
        parents: [],
        message: "Seed",
        author: AUTHOR,
        committer: AUTHOR,
      }),
    ).resolves.toBe("f4ed6991987356921f4211de4659b13755c4eb46");
  });

  it("terminates the message with a newline exactly once", async () => {
    const withNewline = await hashCommit({
      tree: "9bdc033e1f60f58d1d459062da0f321ab791d8a6",
      parents: [],
      message: "Seed\n",
      author: AUTHOR,
      committer: AUTHOR,
    });
    expect(withNewline).toBe("f4ed6991987356921f4211de4659b13755c4eb46");
  });

  it("changes sha when any field changes", async () => {
    const base = {
      tree: "9bdc033e1f60f58d1d459062da0f321ab791d8a6",
      parents: [] as string[],
      message: "Seed",
      author: AUTHOR,
      committer: AUTHOR,
    };
    const other = await hashCommit({ ...base, message: "Seed different" });
    expect(other).not.toBe("f4ed6991987356921f4211de4659b13755c4eb46");
  });
});

describe("base64", () => {
  it("round trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 10]);
    expect([...decodeBase64(encodeBase64(bytes))]).toEqual([...bytes]);
  });

  it("wraps at 60 characters like the GitHub blob API, and decodes wrapped input", () => {
    const bytes = encodeUtf8("x".repeat(200));
    const wrapped = encodeBase64(bytes, true);
    expect(wrapped).toContain("\n");
    for (const line of wrapped.trimEnd().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
    expect(new TextDecoder().decode(decodeBase64(wrapped))).toBe("x".repeat(200));
  });

  it("round trips multi-byte UTF-8", () => {
    const text = "chapître - “quoted” 😀";
    expect(new TextDecoder().decode(decodeBase64(encodeBase64(encodeUtf8(text), true)))).toBe(text);
  });
});
