/**
 * Real git object encoding and hashing (Phase 5 contract §7).
 *
 * The fake GitHub uses **genuine git object hashing**: SHA-1 over the loose
 * object encoding `"<type> <byteLength>\0" + payload`, exactly as `git
 * hash-object` computes it. A blob written into the fake therefore has the
 * same SHA it would have in a real repository, so fixtures are comparable
 * with `git hash-object` / `git cat-file` output and reader tests can assert
 * against SHAs taken from a real clone.
 *
 * Worker-compatible: SHA-1 comes from `crypto.subtle.digest` (WebCrypto),
 * never `node:crypto`. All hashing is therefore asynchronous.
 */

/** Git file modes as they appear in the Git Data API. */
export type GitFileMode =
  /** Regular file. */
  | "100644"
  /** Executable file. */
  | "100755"
  /** Symbolic link. */
  | "120000"
  /** Subdirectory (the API spells it `040000`; git encodes it `40000`). */
  | "040000"
  /** Submodule / commit entry. */
  | "160000";

export type GitObjectType = "blob" | "tree" | "commit";

/** One entry of a tree object. `name` is a single path segment, never a path. */
export interface TreeEntry {
  name: string;
  mode: GitFileMode;
  type: GitObjectType;
  sha: string;
}

/** Author/committer identity as git encodes it and the API returns it. */
export interface GitIdentity {
  name: string;
  email: string;
  /** ISO-8601 instant, e.g. `2026-07-20T09:00:00Z`. */
  date: string;
  /** Numeric timezone as git writes it. Defaults to `+0000`. */
  timezone?: string;
}

export interface GitCommitObject {
  tree: string;
  parents: readonly string[];
  message: string;
  author: GitIdentity;
  committer: GitIdentity;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex string: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** True for a well-formed 40-character lowercase hex object id. */
export function isObjectSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * SHA-1 of the loose git object `"<type> <length>\0" + payload`. Identical to
 * `git hash-object -t <type>`.
 */
export async function hashGitObject(
  type: GitObjectType,
  payload: Uint8Array,
): Promise<string> {
  const framed = concatBytes([encodeUtf8(`${type} ${payload.length}\0`), payload]);
  // `crypto.subtle` is WebCrypto — available in Workers and Node 22 alike.
  const digest = await crypto.subtle.digest("SHA-1", framed as unknown as ArrayBufferView);
  return toHex(new Uint8Array(digest));
}

export function hashBlob(bytes: Uint8Array): Promise<string> {
  return hashGitObject("blob", bytes);
}

/**
 * git's tree entry ordering: byte-wise by name, except that tree (directory)
 * entries sort as if their name ended in `/`. Getting this wrong produces
 * SHAs that differ from real git for any repo with both `a` and `a.md`.
 */
function treeSortKey(entry: TreeEntry): string {
  return entry.type === "tree" ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((left, right) => {
    const a = treeSortKey(left);
    const b = treeSortKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Encode a tree object exactly as git stores it (git drops the leading 0 of `040000`). */
export function encodeTree(entries: readonly TreeEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of sortTreeEntries(entries)) {
    if (entry.name === "" || entry.name.includes("/")) {
      throw new Error(`tree entry name must be one path segment: ${JSON.stringify(entry.name)}`);
    }
    const mode = entry.mode.replace(/^0+/, "");
    parts.push(encodeUtf8(`${mode} ${entry.name}\0`));
    parts.push(fromHex(entry.sha));
  }
  return concatBytes(parts);
}

export function hashTree(entries: readonly TreeEntry[]): Promise<string> {
  return hashGitObject("tree", encodeTree(entries));
}

function encodeIdentity(identity: GitIdentity): string {
  const seconds = Math.floor(new Date(identity.date).getTime() / 1000);
  if (!Number.isFinite(seconds)) {
    throw new Error(`invalid git identity date: ${JSON.stringify(identity.date)}`);
  }
  return `${identity.name} <${identity.email}> ${seconds} ${identity.timezone ?? "+0000"}`;
}

/** Encode a commit object exactly as git stores it. */
export function encodeCommit(commit: GitCommitObject): Uint8Array {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${encodeIdentity(commit.author)}`);
  lines.push(`committer ${encodeIdentity(commit.committer)}`);
  const message = commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
  return encodeUtf8(`${lines.join("\n")}\n\n${message}`);
}

export function hashCommit(commit: GitCommitObject): Promise<string> {
  return hashGitObject("commit", encodeCommit(commit));
}

const BASE64_LINE_LENGTH = 60;

/**
 * Base64 as the GitHub blob API returns it: standard alphabet, wrapped every
 * 60 characters with `\n`. Real GitHub wraps, so consumers must strip
 * whitespace before decoding; the fake wraps too, deliberately, so that bug
 * is caught in tests rather than production.
 */
export function encodeBase64(bytes: Uint8Array, wrap = false): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const raw = btoa(binary);
  if (!wrap) return raw;
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += BASE64_LINE_LENGTH) {
    lines.push(raw.slice(i, i + BASE64_LINE_LENGTH));
  }
  return `${lines.join("\n")}\n`;
}

/** Decode base64, tolerating the newline wrapping GitHub applies. */
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
