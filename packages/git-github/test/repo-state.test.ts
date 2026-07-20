/**
 * The fake's content model: object store, `base_tree` merge semantics, ref
 * fast-forward rules, and the directory/file-map seeding helpers.
 */
import { describe, expect, it } from "vitest";
import { decodeUtf8, hashBlob, encodeUtf8 } from "../src/git-objects.js";
import {
  FakeRepoError,
  FakeRepoState,
  flattenDirectoryTree,
} from "../src/testing/repo-state.js";

async function seeded(): Promise<FakeRepoState> {
  const state = new FakeRepoState();
  await state.commitFiles({
    branch: "main",
    replaceTree: true,
    message: "Seed",
    files: {
      "book.yml": "title: Causal Projector\n",
      "chapters/001-baseline.md": "# Baseline\n",
      "chapters/002-null-results.md": "# Null Results\n",
      "story/characters/mara-voss.md": "# Mara\n",
    },
  });
  return state;
}

describe("object store", () => {
  it("is content addressed and deduplicates identical blobs", async () => {
    const state = new FakeRepoState();
    const first = await state.putBlob("same content");
    const second = await state.putBlob("same content");
    expect(first).toBe(second);
    expect(state.blobs.size).toBe(1);
    expect(decodeUtf8(state.getBlob(first))).toBe("same content");
  });

  it("stores trees as one level of entries, with subtrees as entries", async () => {
    const state = await seeded();
    const head = state.getRef("main")!;
    const rootTree = state.getCommit(head).tree;
    const names = state.getTree(rootTree).map((entry) => `${entry.type}:${entry.name}`);
    expect(names.sort()).toEqual(["blob:book.yml", "tree:chapters", "tree:story"]);
  });

  it("404s on unknown objects", async () => {
    const state = new FakeRepoState();
    expect(() => state.getBlob("0".repeat(40))).toThrow(FakeRepoError);
    expect(() => state.getTree("0".repeat(40))).toThrow(/tree not found/);
    expect(() => state.getCommit("0".repeat(40))).toThrow(/commit not found/);
  });

  it("lists trees recursively and non-recursively", async () => {
    const state = await seeded();
    const tree = state.getCommit(state.getRef("main")!).tree;
    expect(state.listTree(tree, false).map((entry) => entry.path).sort()).toEqual([
      "book.yml",
      "chapters",
      "story",
    ]);
    const recursive = state.listTree(tree, true);
    expect(recursive.filter((entry) => entry.type === "blob").map((entry) => entry.path).sort()).toEqual([
      "book.yml",
      "chapters/001-baseline.md",
      "chapters/002-null-results.md",
      "story/characters/mara-voss.md",
    ]);
    const blob = recursive.find((entry) => entry.path === "book.yml")!;
    expect(blob.size).toBe(encodeUtf8("title: Causal Projector\n").length);
  });

  it("resolves nested paths and returns null for missing ones", async () => {
    const state = await seeded();
    const tree = state.getCommit(state.getRef("main")!).tree;
    const entry = state.resolvePath(tree, "chapters/001-baseline.md");
    expect(entry?.type).toBe("blob");
    expect(entry?.sha).toBe(await hashBlob(encodeUtf8("# Baseline\n")));
    expect(state.resolvePath(tree, "chapters/missing.md")).toBeNull();
    expect(state.resolvePath(tree, "book.yml/nested")).toBeNull();
  });
});

describe("createTree base_tree merge semantics", () => {
  it("preserves every entry the change set does not name", async () => {
    const state = await seeded();
    const baseTree = state.getCommit(state.getRef("main")!).tree;
    const nextTree = await state.createTree(baseTree, [
      { path: "chapters/001-baseline.md", content: "# Baseline v2\n" },
    ]);

    const before = new Map(state.listTree(baseTree, true).map((e) => [e.path, e.sha]));
    const after = new Map(state.listTree(nextTree, true).map((e) => [e.path, e.sha]));

    expect(after.get("chapters/001-baseline.md")).not.toBe(
      before.get("chapters/001-baseline.md"),
    );
    // Everything else is byte-identical, including untouched subtrees.
    expect(after.get("book.yml")).toBe(before.get("book.yml"));
    expect(after.get("chapters/002-null-results.md")).toBe(
      before.get("chapters/002-null-results.md"),
    );
    expect(after.get("story")).toBe(before.get("story"));
    expect(after.get("story/characters/mara-voss.md")).toBe(
      before.get("story/characters/mara-voss.md"),
    );
  });

  it("creates intermediate trees for new nested paths", async () => {
    const state = await seeded();
    const baseTree = state.getCommit(state.getRef("main")!).tree;
    const next = await state.createTree(baseTree, [
      {
        path: ".authorbot/annotations/019f32b1/annotation.md",
        content: "---\nid: 019f32b1\n---\n",
      },
    ]);
    const paths = state.listTree(next, true).map((entry) => entry.path);
    expect(paths).toContain(".authorbot");
    expect(paths).toContain(".authorbot/annotations/019f32b1");
    expect(paths).toContain(".authorbot/annotations/019f32b1/annotation.md");
  });

  it("writes several files of one logical mutation into a single tree", async () => {
    const state = await seeded();
    const baseTree = state.getCommit(state.getRef("main")!).tree;
    const next = await state.createTree(baseTree, [
      { path: "chapters/001-baseline.md", content: "# Baseline v2\n" },
      { path: ".authorbot/work-items/w1.md", content: "status: done\n" },
      { path: ".authorbot/attribution/a1.yml", content: "actor: github:x\n" },
    ]);
    const files = state.listTree(next, true).filter((entry) => entry.type === "blob");
    expect(files.map((entry) => entry.path).sort()).toEqual([
      ".authorbot/attribution/a1.yml",
      ".authorbot/work-items/w1.md",
      "book.yml",
      "chapters/001-baseline.md",
      "chapters/002-null-results.md",
      "story/characters/mara-voss.md",
    ]);
  });

  it("deletes a path with sha: null and prunes the emptied directory", async () => {
    const state = await seeded();
    const baseTree = state.getCommit(state.getRef("main")!).tree;
    const next = await state.createTree(baseTree, [
      { path: "story/characters/mara-voss.md", sha: null },
    ]);
    const paths = state.listTree(next, true).map((entry) => entry.path);
    expect(paths).not.toContain("story/characters/mara-voss.md");
    expect(paths).not.toContain("story/characters");
    expect(paths).not.toContain("story");
    expect(paths).toContain("book.yml");
  });

  it("keeps a directory that still has siblings after a deletion", async () => {
    const state = await seeded();
    const baseTree = state.getCommit(state.getRef("main")!).tree;
    const next = await state.createTree(baseTree, [
      { path: "chapters/001-baseline.md", sha: null },
    ]);
    const paths = state.listTree(next, true).map((entry) => entry.path);
    expect(paths).toContain("chapters");
    expect(paths).toContain("chapters/002-null-results.md");
    expect(paths).not.toContain("chapters/001-baseline.md");
  });

  it("is deterministic: the same change set from the same base yields the same tree sha", async () => {
    const state = await seeded();
    const baseTree = state.getCommit(state.getRef("main")!).tree;
    const a = await state.createTree(baseTree, [{ path: "book.yml", content: "title: X\n" }]);
    const b = await state.createTree(baseTree, [{ path: "book.yml", content: "title: X\n" }]);
    expect(a).toBe(b);
  });

  it("a no-op change set reproduces the base tree exactly", async () => {
    const state = await seeded();
    const baseTree = state.getCommit(state.getRef("main")!).tree;
    await expect(state.createTree(baseTree, [])).resolves.toBe(baseTree);
  });

  it("rejects a missing base_tree, a bad sha, traversal, and entries with neither sha nor content", async () => {
    const state = await seeded();
    const baseTree = state.getCommit(state.getRef("main")!).tree;
    await expect(state.createTree("0".repeat(40), [])).rejects.toThrow(/base_tree does not exist/);
    await expect(
      state.createTree(baseTree, [{ path: "x.md", sha: "not-a-sha" }]),
    ).rejects.toThrow(/invalid sha/);
    await expect(
      state.createTree(baseTree, [{ path: "../escape.md", content: "x" }]),
    ).rejects.toThrow(/invalid tree path segment/);
    await expect(state.createTree(baseTree, [{ path: "x.md" }])).rejects.toThrow(
      /needs either sha or content/,
    );
  });
});

describe("ref updates", () => {
  it("accepts a fast-forward", async () => {
    const state = await seeded();
    const head = state.getRef("main")!;
    const tree = await state.createTree(state.getCommit(head).tree, [
      { path: "book.yml", content: "title: Next\n" },
    ]);
    const identity = {
      name: "Authorbot",
      email: "a@b.invalid",
      date: state.nextTimestamp(),
    };
    const next = await state.putCommit({
      tree,
      parents: [head],
      message: "Advance",
      author: identity,
      committer: identity,
    });
    state.updateRef("main", next);
    expect(state.getRef("main")).toBe(next);
  });

  it("accepts a no-op update to the same sha", async () => {
    const state = await seeded();
    const head = state.getRef("main")!;
    expect(() => state.updateRef("main", head)).not.toThrow();
  });

  it("refuses a non-fast-forward without force, and does not move the ref", async () => {
    const state = await seeded();
    const head = state.getRef("main")!;
    // Two siblings off the same parent: neither is an ancestor of the other.
    const identity = { name: "A", email: "a@b.invalid", date: state.nextTimestamp() };
    const treeA = await state.createTree(state.getCommit(head).tree, [
      { path: "book.yml", content: "title: A\n" },
    ]);
    const treeB = await state.createTree(state.getCommit(head).tree, [
      { path: "book.yml", content: "title: B\n" },
    ]);
    const a = await state.putCommit({
      tree: treeA,
      parents: [head],
      message: "A",
      author: identity,
      committer: identity,
    });
    const b = await state.putCommit({
      tree: treeB,
      parents: [head],
      message: "B",
      author: identity,
      committer: identity,
    });
    state.updateRef("main", a);
    expect(() => state.updateRef("main", b)).toThrow(/not a fast forward/);
    expect(state.getRef("main")).toBe(a);
    // force is available, but nothing in the writer path may use it.
    state.updateRef("main", b, { force: true });
    expect(state.getRef("main")).toBe(b);
  });

  it("refuses updates to an unknown branch or unknown object", async () => {
    const state = await seeded();
    const head = state.getRef("main")!;
    expect(() => state.updateRef("nope", head)).toThrow(/Reference does not exist/);
    expect(() => state.updateRef("main", "0".repeat(40))).toThrow(/object does not exist/);
    expect(() => state.updateRef("main", "nope")).toThrow(/invalid sha/);
  });

  it("computes ancestry across a chain", async () => {
    const state = await seeded();
    const first = state.getRef("main")!;
    await state.commitFiles({ branch: "main", files: { "book.yml": "title: 2\n" } });
    const second = state.getRef("main")!;
    await state.commitFiles({ branch: "main", files: { "book.yml": "title: 3\n" } });
    const third = state.getRef("main")!;
    expect(state.isAncestor(first, third)).toBe(true);
    expect(state.isAncestor(second, third)).toBe(true);
    expect(state.isAncestor(third, first)).toBe(false);
    expect(state.history("main")).toEqual([third, second, first]);
  });
});

describe("seeding helpers", () => {
  it("flattens a directory-like plain object", () => {
    const flat = flattenDirectoryTree({
      "book.yml": "title: X\n",
      chapters: { "001.md": "# One\n" },
      story: { characters: { "mara.md": "# Mara\n" } },
    });
    expect(Object.keys(flat).sort()).toEqual([
      "book.yml",
      "chapters/001.md",
      "story/characters/mara.md",
    ]);
    expect(decodeUtf8(flat["chapters/001.md"]!)).toBe("# One\n");
  });

  it("commitFiles merges onto the branch by default and replaces with replaceTree", async () => {
    const state = await seeded();
    await state.commitFiles({ branch: "main", files: { "extra.md": "x\n" } });
    expect(Object.keys(state.readFiles(state.getRef("main")!)).sort()).toContain("extra.md");
    expect(state.readFile(state.getRef("main")!, "book.yml")).toBe("title: Causal Projector\n");

    await state.commitFiles({
      branch: "main",
      files: { "only.md": "y\n" },
      replaceTree: true,
    });
    expect(Object.keys(state.readFiles(state.getRef("main")!))).toEqual(["only.md"]);
  });

  it("creates the branch when it does not exist and gives the root commit no parents", async () => {
    const state = new FakeRepoState();
    const sha = await state.commitFiles({ branch: "draft", files: { "a.md": "a\n" } });
    expect(state.getRef("draft")).toBe(sha);
    expect(state.getCommit(sha).parents).toEqual([]);
  });

  it("gives sequential commits distinct shas even with identical content", async () => {
    const state = new FakeRepoState();
    const first = await state.commitFiles({ branch: "main", files: { "a.md": "a\n" } });
    const second = await state.commitFiles({
      branch: "main",
      files: { "a.md": "a\n" },
      message: "again",
    });
    expect(second).not.toBe(first);
    expect(state.getCommit(second).tree).toBe(state.getCommit(first).tree);
  });
});
