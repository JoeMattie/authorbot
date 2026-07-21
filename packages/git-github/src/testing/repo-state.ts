/**
 * The fake repository's content model (Phase 5 contract §7): a mutable,
 * content-addressed object store plus branch refs, using real git object
 * hashing (see `git-objects.ts`).
 *
 *   refs:    branch name -> commit sha
 *   commits: sha -> { tree, parents, message, author, committer }
 *   trees:   sha -> TreeEntry[]      (one level; subtrees are entries)
 *   blobs:   sha -> bytes
 *
 * This is a value store, not a server: it has no HTTP, no faults and no
 * filesystem access. `FakeGitHub` wraps it with the Git Data API surface.
 * Worker-compatible - no `node:` imports anywhere.
 */
import {
  decodeUtf8,
  encodeUtf8,
  hashBlob,
  hashCommit,
  hashTree,
  isObjectSha,
  sortTreeEntries,
  type GitCommitObject,
  type GitFileMode,
  type GitIdentity,
  type GitObjectType,
  type TreeEntry,
} from "../git-objects.js";

/** Thrown for malformed input; `FakeGitHub` maps these onto HTTP responses. */
export class FakeRepoError extends Error {
  override readonly name = "FakeRepoError";
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One requested change when composing a tree (`POST /git/trees` entry). */
export interface TreeChange {
  /** Repo-relative path; nested paths create/replace intermediate trees. */
  path: string;
  mode?: GitFileMode;
  type?: GitObjectType;
  /** Existing object sha, or `null` to delete the path (GitHub semantics). */
  sha?: string | null;
  /** Inline UTF-8 content; creates the blob implicitly. */
  content?: string;
}

/** A flattened tree listing entry, as `GET /git/trees/{sha}` returns it. */
export interface FlatTreeEntry {
  path: string;
  mode: GitFileMode;
  type: GitObjectType;
  sha: string;
  /** Byte size, blobs only. */
  size?: number;
}

/** A map of repo-relative path -> file content, the seeding input shape. */
export type RepoFileMap = Readonly<Record<string, string | Uint8Array>>;

/**
 * A directory-like plain object: values are file contents or nested
 * directories. `{ chapters: { "001.md": "..." } }` seeds `chapters/001.md`.
 */
export interface DirectoryTree {
  [name: string]: string | Uint8Array | DirectoryTree;
}

export interface CommitFilesOptions {
  branch: string;
  files: RepoFileMap;
  message?: string;
  author?: GitIdentity;
  /** Paths to delete in the same commit. */
  deletions?: readonly string[];
  /**
   * Start from an empty tree instead of the branch's current tree, i.e. the
   * commit replaces the whole worktree. Used for the initial seed commit.
   */
  replaceTree?: boolean;
}

const DEFAULT_IDENTITY: GitIdentity = {
  name: "Authorbot Fake",
  email: "fake@authorbot.invalid",
  date: "2026-01-01T00:00:00.000Z",
  timezone: "+0000",
};

type MutableNode =
  | { kind: "leaf"; mode: GitFileMode; type: GitObjectType; sha: string }
  | { kind: "dir"; sha: string | null; loaded: boolean; children: Map<string, MutableNode> };

function splitPath(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    throw new FakeRepoError(422, `invalid tree path: ${JSON.stringify(path)}`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new FakeRepoError(422, `invalid tree path segment: ${JSON.stringify(path)}`);
    }
  }
  return segments;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encodeUtf8(content) : content;
}

/** Flatten a directory-like plain object into a path -> content map. */
export function flattenDirectoryTree(tree: DirectoryTree, prefix = ""): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (typeof value === "string" || value instanceof Uint8Array) {
      out[path] = toBytes(value);
    } else {
      Object.assign(out, flattenDirectoryTree(value, path));
    }
  }
  return out;
}

export class FakeRepoState {
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, GitCommitObject>();
  readonly trees = new Map<string, TreeEntry[]>();
  readonly blobs = new Map<string, Uint8Array>();

  /** Monotonic counter so seeded commits get distinct, ordered timestamps. */
  #clock = 0;

  /** A distinct ISO timestamp per call, keeping generated commit shas unique. */
  nextTimestamp(): string {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    this.#clock += 1;
    return new Date(base + this.#clock * 1000).toISOString();
  }

  // ---------------------------------------------------------------- objects

  async putBlob(content: string | Uint8Array): Promise<string> {
    const bytes = toBytes(content);
    const sha = await hashBlob(bytes);
    this.blobs.set(sha, bytes);
    return sha;
  }

  getBlob(sha: string): Uint8Array {
    const bytes = this.blobs.get(sha);
    if (!bytes) throw new FakeRepoError(404, `blob not found: ${sha}`);
    return bytes;
  }

  async putTree(entries: readonly TreeEntry[]): Promise<string> {
    const sorted = sortTreeEntries(entries);
    const sha = await hashTree(sorted);
    this.trees.set(sha, sorted);
    return sha;
  }

  getTree(sha: string): TreeEntry[] {
    const entries = this.trees.get(sha);
    if (!entries) throw new FakeRepoError(404, `tree not found: ${sha}`);
    return entries;
  }

  async putCommit(commit: GitCommitObject): Promise<string> {
    const sha = await hashCommit(commit);
    this.commits.set(sha, commit);
    return sha;
  }

  getCommit(sha: string): GitCommitObject {
    const commit = this.commits.get(sha);
    if (!commit) throw new FakeRepoError(404, `commit not found: ${sha}`);
    return commit;
  }

  /** The canonical empty tree object (git's `4b825dc...`). */
  emptyTree(): Promise<string> {
    return this.putTree([]);
  }

  // ------------------------------------------------------------------ refs

  /** Head commit sha of a branch, or `null` when the branch does not exist. */
  getRef(branch: string): string | null {
    return this.refs.get(branch) ?? null;
  }

  /** Set a ref with no fast-forward check - seeding and fault injection only. */
  setRefUnchecked(branch: string, sha: string): void {
    this.refs.set(branch, sha);
  }

  /**
   * `PATCH /git/refs/heads/{branch}` semantics: without `force`, the update
   * must be a fast-forward (the current head is an ancestor of, or equal to,
   * the new sha). A non-fast-forward without force is a 422, never a clobber.
   */
  updateRef(branch: string, sha: string, options: { force?: boolean } = {}): void {
    if (!isObjectSha(sha)) throw new FakeRepoError(422, `invalid sha: ${sha}`);
    if (!this.commits.has(sha)) throw new FakeRepoError(422, `object does not exist: ${sha}`);
    const current = this.refs.get(branch);
    if (current === undefined) {
      throw new FakeRepoError(422, `Reference does not exist: refs/heads/${branch}`);
    }
    if (!options.force && !this.isAncestor(current, sha)) {
      throw new FakeRepoError(422, "Update is not a fast forward");
    }
    this.refs.set(branch, sha);
  }

  /** True when `ancestor` is reachable from `descendant` (or is it). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const sha = queue.pop();
      if (sha === undefined || seen.has(sha)) continue;
      seen.add(sha);
      const commit = this.commits.get(sha);
      if (!commit) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  // ----------------------------------------------------------------- trees

  /**
   * Compose a new tree from `baseTree` plus `changes` - the `base_tree` merge
   * semantics of `POST /git/trees`. Entries not named by a change are
   * preserved byte-for-byte (untouched subtrees are not even expanded, so
   * their shas are carried over unchanged). `sha: null` deletes a path, and
   * a directory left empty by a deletion disappears, as in git.
   */
  async createTree(baseTree: string | null, changes: readonly TreeChange[]): Promise<string> {
    const root: MutableNode = baseTree
      ? { kind: "dir", sha: baseTree, loaded: false, children: new Map() }
      : { kind: "dir", sha: null, loaded: true, children: new Map() };
    if (baseTree && !this.trees.has(baseTree)) {
      throw new FakeRepoError(422, `base_tree does not exist: ${baseTree}`);
    }

    for (const change of changes) {
      const segments = splitPath(change.path);
      const fileName = segments[segments.length - 1] as string;
      const parent = this.#descend(root, segments.slice(0, -1));

      if (change.sha === null) {
        parent.children.delete(fileName);
        continue;
      }

      let sha = change.sha;
      let type: GitObjectType = change.type ?? "blob";
      if (sha === undefined) {
        if (change.content === undefined) {
          throw new FakeRepoError(422, `tree entry ${change.path} needs either sha or content`);
        }
        sha = await this.putBlob(change.content);
        type = "blob";
      }
      if (!isObjectSha(sha)) {
        throw new FakeRepoError(422, `invalid sha for ${change.path}: ${sha}`);
      }
      const mode: GitFileMode = change.mode ?? (type === "tree" ? "040000" : "100644");
      if (type === "tree") {
        parent.children.set(fileName, { kind: "dir", sha, loaded: false, children: new Map() });
      } else {
        parent.children.set(fileName, { kind: "leaf", mode, type, sha });
      }
    }

    this.#prune(root);
    return this.#writeNode(root);
  }

  #descend(root: MutableNode, segments: readonly string[]): Extract<MutableNode, { kind: "dir" }> {
    let node = root as Extract<MutableNode, { kind: "dir" }>;
    for (const segment of segments) {
      this.#expand(node);
      const existing = node.children.get(segment);
      if (existing && existing.kind === "dir") {
        node = existing;
      } else {
        // A file replaced by a directory, or a fresh directory.
        const created: MutableNode = { kind: "dir", sha: null, loaded: true, children: new Map() };
        node.children.set(segment, created);
        node = created;
      }
    }
    this.#expand(node);
    return node;
  }

  #expand(node: Extract<MutableNode, { kind: "dir" }>): void {
    if (node.loaded) return;
    node.loaded = true;
    if (node.sha === null) return;
    for (const entry of this.getTree(node.sha)) {
      node.children.set(
        entry.name,
        entry.type === "tree"
          ? { kind: "dir", sha: entry.sha, loaded: false, children: new Map() }
          : { kind: "leaf", mode: entry.mode, type: entry.type, sha: entry.sha },
      );
    }
  }

  /** Drop directories that lost all their entries, bottom-up (git behavior). */
  #prune(node: MutableNode): boolean {
    if (node.kind === "leaf") return true;
    if (!node.loaded) return true;
    for (const [name, child] of [...node.children]) {
      if (!this.#prune(child)) node.children.delete(name);
    }
    return node.children.size > 0;
  }

  async #writeNode(node: MutableNode): Promise<string> {
    if (node.kind === "leaf") return node.sha;
    if (!node.loaded && node.sha !== null) return node.sha;
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.children) {
      if (child.kind === "leaf") {
        entries.push({ name, mode: child.mode, type: child.type, sha: child.sha });
      } else {
        entries.push({ name, mode: "040000", type: "tree", sha: await this.#writeNode(child) });
      }
    }
    return this.putTree(entries);
  }

  /** Flatten a tree; `recursive` descends into subtrees as GitHub's API does. */
  listTree(sha: string, recursive: boolean): FlatTreeEntry[] {
    const out: FlatTreeEntry[] = [];
    const walk = (treeSha: string, prefix: string): void => {
      for (const entry of this.getTree(treeSha)) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.type === "tree") {
          out.push({ path, mode: entry.mode, type: "tree", sha: entry.sha });
          if (recursive) walk(entry.sha, path);
        } else {
          const size = this.blobs.get(entry.sha)?.length;
          out.push({
            path,
            mode: entry.mode,
            type: entry.type,
            sha: entry.sha,
            ...(size === undefined ? {} : { size }),
          });
        }
      }
    };
    walk(sha, "");
    return out;
  }

  /** Resolve a repo-relative path inside a tree to its entry, or `null`. */
  resolvePath(treeSha: string, path: string): TreeEntry | null {
    const segments = splitPath(path);
    let currentTree = treeSha;
    for (let i = 0; i < segments.length; i += 1) {
      const name = segments[i] as string;
      const entry = this.getTree(currentTree).find((candidate) => candidate.name === name);
      if (!entry) return null;
      if (i === segments.length - 1) return entry;
      if (entry.type !== "tree") return null;
      currentTree = entry.sha;
    }
    return null;
  }

  // ------------------------------------------------------------- convenience

  /**
   * Commit `files` onto `branch`, creating the branch when it does not exist.
   * Used by the seeding helpers and by the moved-head fault to write an
   * out-of-band commit; it bypasses the HTTP surface deliberately.
   */
  async commitFiles(options: CommitFilesOptions): Promise<string> {
    const parentSha = this.getRef(options.branch);
    const baseTree =
      parentSha && !options.replaceTree ? this.getCommit(parentSha).tree : null;
    const changes: TreeChange[] = [];
    for (const [path, content] of Object.entries(options.files)) {
      changes.push({ path, sha: await this.putBlob(content), mode: "100644", type: "blob" });
    }
    for (const path of options.deletions ?? []) {
      changes.push({ path, sha: null });
    }
    const tree = await this.createTree(baseTree, changes);
    const identity: GitIdentity = options.author ?? {
      ...DEFAULT_IDENTITY,
      date: this.nextTimestamp(),
    };
    const sha = await this.putCommit({
      tree,
      parents: parentSha ? [parentSha] : [],
      message: options.message ?? "seed",
      author: identity,
      committer: identity,
    });
    this.refs.set(options.branch, sha);
    return sha;
  }

  /** Every blob in a commit's tree as a path -> UTF-8 text map (test helper). */
  readFiles(commitSha: string): Record<string, string> {
    const commit = this.getCommit(commitSha);
    const out: Record<string, string> = {};
    for (const entry of this.listTree(commit.tree, true)) {
      if (entry.type !== "blob") continue;
      out[entry.path] = decodeUtf8(this.getBlob(entry.sha));
    }
    return out;
  }

  /** One file's text at a commit, or `null` when absent (test helper). */
  readFile(commitSha: string, path: string): string | null {
    const entry = this.resolvePath(this.getCommit(commitSha).tree, path);
    if (!entry || entry.type !== "blob") return null;
    return decodeUtf8(this.getBlob(entry.sha));
  }

  /** Commit shas from `branch` head back to the root, newest first. */
  history(branch: string): string[] {
    const out: string[] = [];
    let sha = this.getRef(branch);
    while (sha !== null) {
      out.push(sha);
      sha = this.commits.get(sha)?.parents[0] ?? null;
    }
    return out;
  }
}
