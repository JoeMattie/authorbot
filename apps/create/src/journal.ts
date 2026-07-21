/**
 * Setup journal (Phase 6 contract §2.2): `.authorbot-setup.json` in the book
 * directory, gitignored by the scaffold, recording what has already happened
 * so a failure at step 9 never means starting at step 1.
 *
 * Two invariants hold this together:
 *
 * 1. **Never a secret** (§2.3). Secret *names* are recorded so a re-run knows
 *    it does not need to set `SESSION_SECRET` again; values are not. Writing
 *    additionally passes the serialized text through the vault, so a value
 *    that reached this file through a field nobody thought about is scrubbed
 *    on the way to disk rather than trusted not to be there.
 * 2. **Never load-bearing for correctness.** A stage marked done re-reads the
 *    world before skipping work; the journal is an accelerator and a record,
 *    not a source of truth. A deleted journal costs time, not safety.
 */
import path from "node:path";
import type { FileSystemPort } from "./ports.js";
import type { SecretVault } from "./secrets.js";
import { D1_NAME_RE, REPO_RE, SLUG_RE } from "./slug.js";
import { STAGE_NAMES, type StageName } from "./stages/names.js";

export const JOURNAL_FILENAME = ".authorbot-setup.json";

export const JOURNAL_VERSION = 1;

export type StageStatus = "pending" | "started" | "done" | "failed";

export interface StageRecord {
  status: StageStatus;
  /** RFC 3339 UTC. */
  updatedAt?: string;
  /** Redacted, author-facing note about the last outcome. */
  note?: string;
}

/**
 * An externally-created resource (contract §2.6): reported at the end with
 * how to delete it, so an author who abandons setup can clean up.
 */
export interface CreatedResource {
  /** e.g. "github-repo", "d1-database", "worker", "github-app". */
  kind: string;
  /** What the author would recognise it by. */
  name: string;
  /** One plain sentence: what it is. */
  description: string;
  /** Exact command or URL that removes it. */
  deleteWith: string;
  createdAt?: string;
}

export interface JournalData {
  version: number;
  createdAt?: string;
  updatedAt?: string;
  book?: {
    title?: string;
    slug?: string;
    id?: string;
    visibility?: "public" | "private";
    repo?: string;
    defaultBranch?: string;
  };
  publish?: {
    workerName?: string;
    siteUrl?: string;
    customDomain?: string;
  };
  collaborate?: {
    d1Name?: string;
    d1Id?: string;
    appSlug?: string;
    installationId?: string;
    apiVerified?: boolean;
  };
  agent?: {
    name?: string;
    promptPath?: string;
  };
  stages: Record<string, StageRecord>;
  /** Names only — never values (§2.3). */
  secretsSet: string[];
  resources: CreatedResource[];
  /**
   * SHA-256 of the contents of each file the wizard itself last wrote, keyed
   * by absolute path.
   *
   * This is what tells "a file the author edited" apart from "a file this
   * wizard wrote a minute ago". Without it, `collaborate` rewriting the
   * `wrangler.jsonc` that `publish` wrote would trip the
   * never-overwrite-silently rule against the wizard's own output — turning a
   * safety property into a prompt that trains authors to say yes.
   */
  managedFiles: Record<string, string>;
}

export function emptyJournal(now: string): JournalData {
  const stages: Record<string, StageRecord> = {};
  for (const name of STAGE_NAMES) {
    stages[name] = { status: "pending" };
  }
  return {
    version: JOURNAL_VERSION,
    createdAt: now,
    updatedAt: now,
    stages,
    secretsSet: [],
    resources: [],
    managedFiles: {},
  };
}

/**
 * Parses journal text, tolerating anything. A corrupt or future-versioned
 * journal yields a fresh one rather than an error: refusing to run because a
 * *progress note* is malformed would turn a cosmetic problem into a wall, and
 * the worst case is repeating idempotent work.
 *
 * **Tolerating a malformed journal is not the same as trusting its contents.**
 * `.authorbot-setup.json` is an ordinary file in an ordinary directory: it is
 * gitignored only by this wizard's own template, so a shared, forked, or
 * published book can simply carry one, and the author who clones it and runs
 * `create-authorbot publish` has adopted whatever it says. What it says is not
 * cosmetic — `book.repo` picks which GitHub repository receives a Cloudflare
 * API token, `publish.siteUrl` becomes the GitHub App's callback and webhook
 * host and the base a maintainer token is sent to, and `collaborate.d1Name`
 * and `publish.workerName` land in argv.
 *
 * So every field is validated on the way in, exactly as `resourceArray`
 * already validates resources, and **a field that fails is dropped rather than
 * adopted**. Dropping costs a re-prompt for a value the author can retype;
 * adopting costs the author their credentials.
 */
export function parseJournal(text: string, now: string): JournalData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyJournal(now);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return emptyJournal(now);
  }
  const record = raw as Record<string, unknown>;
  if (record["version"] !== JOURNAL_VERSION) {
    return emptyJournal(now);
  }
  const base = emptyJournal(now);
  const stages = base.stages;
  const rawStages = record["stages"];
  if (typeof rawStages === "object" && rawStages !== null) {
    for (const [name, value] of Object.entries(rawStages as Record<string, unknown>)) {
      if (!STAGE_NAMES.includes(name as StageName)) {
        continue;
      }
      if (typeof value !== "object" || value === null) {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const status = entry["status"];
      const stage: StageRecord = {
        status:
          status === "done" || status === "failed" || status === "started" ? status : "pending",
      };
      if (typeof entry["updatedAt"] === "string") {
        stage.updatedAt = entry["updatedAt"];
      }
      if (typeof entry["note"] === "string") {
        stage.note = entry["note"];
      }
      stages[name] = stage;
    }
  }

  const journal: JournalData = {
    version: JOURNAL_VERSION,
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : now,
    updatedAt: now,
    stages,
    secretsSet: stringArray(record["secretsSet"]),
    resources: resourceArray(record["resources"]),
    managedFiles: stringMap(record["managedFiles"]),
  };
  const book = bookSection(record["book"]);
  if (book !== undefined) {
    journal.book = book;
  }
  const publish = publishSection(record["publish"]);
  if (publish !== undefined) {
    journal.publish = publish;
  }
  const collaborate = collaborateSection(record["collaborate"]);
  if (collaborate !== undefined) {
    journal.collaborate = collaborate;
  }
  const agent = agentSection(record["agent"]);
  if (agent !== undefined) {
    journal.agent = agent;
  }
  return journal;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Field validation
//
// The shapes below are the ones the wizard itself produces. Anything else is
// either a hand-edit that will be re-derived, or a plant.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** GitHub App installation ids are decimal integers. */
const INSTALLATION_ID_RE = /^[0-9]{1,20}$/;
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
/** A git branch name, minus the forms git itself refuses. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** GitHub App slugs, as returned by the manifest conversion. */
const APP_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function matching(value: unknown, pattern: RegExp, maxLength: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    pattern.test(value)
    ? value
    : undefined;
}

/**
 * Free text (a title, a file path) that never reaches argv or a URL. Length is
 * still bounded, and control characters are refused so a planted value cannot
 * rewrite the terminal it is printed to.
 */
function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  // Control characters are refused too, so a planted title cannot rewrite
  // the terminal it is printed to.
  return /[\u0000-\u001f\u007f]/.test(value) ? undefined : value;
}

/**
 * An absolute `https:` URL and nothing else.
 *
 * `http:` is refused as well as the obvious `javascript:` and `file:`: this
 * value becomes an OAuth callback host and the base a bearer token is sent to,
 * and neither belongs on a cleartext origin. Credentials, userinfo, and a
 * missing host are refused for the same reason.
 */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname.length === 0) {
    return undefined;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return undefined;
  }
  return value;
}

function bookSection(value: unknown): NonNullable<JournalData["book"]> | undefined {
  const record = objectOrUndefined(value);
  if (record === undefined) {
    return undefined;
  }
  const book: NonNullable<JournalData["book"]> = {};
  const title = text(record["title"], 200);
  if (title !== undefined) {
    book.title = title;
  }
  const slug = matching(record["slug"], SLUG_RE, 64);
  if (slug !== undefined) {
    book.slug = slug;
  }
  const id = matching(record["id"], UUID_RE, 36);
  if (id !== undefined) {
    book.id = id;
  }
  if (record["visibility"] === "public" || record["visibility"] === "private") {
    book.visibility = record["visibility"];
  }
  // The one that sends a Cloudflare API token somewhere.
  const repo = matching(record["repo"], REPO_RE, 200);
  if (repo !== undefined) {
    book.repo = repo;
  }
  const defaultBranch = matching(record["defaultBranch"], BRANCH_RE, 255);
  if (defaultBranch !== undefined) {
    book.defaultBranch = defaultBranch;
  }
  return book;
}

function publishSection(value: unknown): NonNullable<JournalData["publish"]> | undefined {
  const record = objectOrUndefined(value);
  if (record === undefined) {
    return undefined;
  }
  const publish: NonNullable<JournalData["publish"]> = {};
  const workerName = matching(record["workerName"], SLUG_RE, 63);
  if (workerName !== undefined) {
    publish.workerName = workerName;
  }
  const siteUrl = httpsUrl(record["siteUrl"]);
  if (siteUrl !== undefined) {
    publish.siteUrl = siteUrl;
  }
  const customDomain = matching(record["customDomain"], HOSTNAME_RE, 253);
  if (customDomain !== undefined) {
    publish.customDomain = customDomain;
  }
  return publish;
}

function collaborateSection(value: unknown): NonNullable<JournalData["collaborate"]> | undefined {
  const record = objectOrUndefined(value);
  if (record === undefined) {
    return undefined;
  }
  const collaborate: NonNullable<JournalData["collaborate"]> = {};
  const d1Name = matching(record["d1Name"], D1_NAME_RE, 63);
  if (d1Name !== undefined) {
    collaborate.d1Name = d1Name;
  }
  const d1Id = matching(record["d1Id"], UUID_RE, 36);
  if (d1Id !== undefined) {
    collaborate.d1Id = d1Id;
  }
  const appSlug = matching(record["appSlug"], APP_SLUG_RE, 100);
  if (appSlug !== undefined) {
    collaborate.appSlug = appSlug;
  }
  const installationId = matching(record["installationId"], INSTALLATION_ID_RE, 20);
  if (installationId !== undefined) {
    collaborate.installationId = installationId;
  }
  if (typeof record["apiVerified"] === "boolean") {
    collaborate.apiVerified = record["apiVerified"];
  }
  return collaborate;
}

function agentSection(value: unknown): NonNullable<JournalData["agent"]> | undefined {
  const record = objectOrUndefined(value);
  if (record === undefined) {
    return undefined;
  }
  const agent: NonNullable<JournalData["agent"]> = {};
  const name = text(record["name"], 60);
  if (name !== undefined) {
    agent.name = name;
  }
  const promptPath = text(record["promptPath"], 4096);
  if (promptPath !== undefined) {
    agent.promptPath = promptPath;
  }
  return agent;
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function resourceArray(value: unknown): CreatedResource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const resources: CreatedResource[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const kind = record["kind"];
    const name = record["name"];
    const description = record["description"];
    const deleteWith = record["deleteWith"];
    if (
      typeof kind !== "string" ||
      typeof name !== "string" ||
      typeof description !== "string" ||
      typeof deleteWith !== "string"
    ) {
      continue;
    }
    const resource: CreatedResource = { kind, name, description, deleteWith };
    if (typeof record["createdAt"] === "string") {
      resource.createdAt = record["createdAt"];
    }
    resources.push(resource);
  }
  return resources;
}

export class Journal {
  readonly #fs: FileSystemPort;
  readonly #vault: SecretVault;
  readonly #path: string;
  /** Dry run (§2.4): the journal is read but never written. */
  readonly #readOnly: boolean;
  #data: JournalData;

  private constructor(
    fs: FileSystemPort,
    vault: SecretVault,
    journalPath: string,
    data: JournalData,
    readOnly: boolean,
  ) {
    this.#fs = fs;
    this.#vault = vault;
    this.#path = journalPath;
    this.#data = data;
    this.#readOnly = readOnly;
  }

  static async open(options: {
    fs: FileSystemPort;
    vault: SecretVault;
    directory: string;
    now: string;
    readOnly: boolean;
  }): Promise<Journal> {
    const journalPath = path.join(options.directory, JOURNAL_FILENAME);
    let data: JournalData;
    if (await options.fs.exists(journalPath)) {
      data = parseJournal(await options.fs.readFile(journalPath), options.now);
    } else {
      data = emptyJournal(options.now);
    }
    // A journal written by an earlier run recorded which secrets exist. Their
    // names (never values) are restored so a resumed run can skip re-setting
    // them, and so the final report is complete.
    for (const name of data.secretsSet) {
      options.vault.register(name, "");
    }
    return new Journal(options.fs, options.vault, journalPath, data, options.readOnly);
  }

  get path(): string {
    return this.#path;
  }

  get data(): JournalData {
    return this.#data;
  }

  stage(name: StageName): StageRecord {
    return this.#data.stages[name] ?? { status: "pending" };
  }

  isDone(name: StageName): boolean {
    return this.stage(name).status === "done";
  }

  /** The first stage that is not yet done — where a bare re-run resumes. */
  resumeAt(order: readonly StageName[]): StageName | null {
    for (const name of order) {
      if (!this.isDone(name)) {
        return name;
      }
    }
    return null;
  }

  async markStage(
    name: StageName,
    status: StageStatus,
    now: string,
    note?: string,
  ): Promise<void> {
    const record: StageRecord = { status, updatedAt: now };
    if (note !== undefined) {
      record.note = this.#vault.redact(note);
    }
    this.#data.stages[name] = record;
    await this.save(now);
  }

  /** Records *that* a secret was set. The value never reaches this method. */
  async recordSecret(name: string, now: string): Promise<void> {
    if (!this.#data.secretsSet.includes(name)) {
      this.#data.secretsSet.push(name);
      this.#data.secretsSet.sort();
    }
    await this.save(now);
  }

  hasSecret(name: string): boolean {
    return this.#data.secretsSet.includes(name);
  }

  /** The digest of the wizard's own last write to `filePath`, if any. */
  managedDigest(filePath: string): string | undefined {
    return this.#data.managedFiles[filePath];
  }

  async recordManagedFile(filePath: string, digest: string, now: string): Promise<void> {
    if (this.#data.managedFiles[filePath] === digest) {
      return;
    }
    this.#data.managedFiles[filePath] = digest;
    await this.save(now);
  }

  async recordResource(resource: CreatedResource, now: string): Promise<void> {
    const existing = this.#data.resources.find(
      (entry) => entry.kind === resource.kind && entry.name === resource.name,
    );
    if (existing !== undefined) {
      return;
    }
    this.#data.resources.push({ ...resource, createdAt: now });
    await this.save(now);
  }

  resources(): readonly CreatedResource[] {
    return this.#data.resources;
  }

  async update(mutate: (data: JournalData) => void, now: string): Promise<void> {
    mutate(this.#data);
    await this.save(now);
  }

  async save(now: string): Promise<void> {
    if (this.#readOnly) {
      return;
    }
    this.#data.updatedAt = now;
    // Redaction applies to the serialized text, not to individual fields: it
    // is the last gate before the bytes hit the disk, so it catches a value
    // that arrived through any field at all.
    const text = this.#vault.redact(`${JSON.stringify(this.#data, null, 2)}\n`);
    await this.#fs.writeFile(this.#path, text);
  }
}
