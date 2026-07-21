/**
 * In-process fakes for every port (Phase 6 contract §6).
 *
 * These are *substitutions*, never monkey-patches: the wizard takes its ports
 * as arguments, so a test builds a `CliDeps` out of these and drives the real
 * `runCli`. Nothing here reaches into a module's internals, which means a
 * refactor that breaks the seams breaks compilation rather than silently
 * leaving tests passing against code nobody runs.
 */
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import type {
  BrowserOpener,
  Clock,
  ConfirmPrompt,
  Environment,
  ExecOptions,
  ExecResult,
  FileSystemPort,
  HttpClient,
  HttpRequest,
  HttpResponse,
  OutputPort,
  ProcessRunner,
  Prompter,
  RandomSource,
  SecretPrompt,
  SelectPrompt,
  TextPrompt,
} from "../src/ports.js";

// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

export interface RecordedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  /** Captured so the redaction property test can prove secrets went *here*. */
  readonly stdin?: string | undefined;
}

export type CommandHandler = (
  command: string,
  args: readonly string[],
  options: ExecOptions,
) => ExecResult | Promise<ExecResult>;

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

export class FakeProcessRunner implements ProcessRunner {
  readonly calls: RecordedCommand[] = [];
  readonly #handlers: { match: readonly string[]; handler: CommandHandler }[] = [];
  readonly #present = new Set<string>();
  /** Commands with no registered handler exit 0 silently unless this is set. */
  strict = false;

  constructor(present: readonly string[] = ["git", "gh", "wrangler", "npm", "npx", "authorbot"]) {
    for (const name of present) {
      this.#present.add(name);
    }
  }

  /** Registers a handler for a command whose argv starts with `match`. */
  on(match: readonly string[], handler: CommandHandler | ExecResult): this {
    this.#handlers.push({
      match,
      handler: typeof handler === "function" ? handler : () => handler,
    });
    return this;
  }

  remove(command: string): this {
    this.#present.delete(command);
    return this;
  }

  add(command: string): this {
    this.#present.add(command);
    return this;
  }

  async run(
    command: string,
    args: readonly string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    this.calls.push({ command, args, cwd: options.cwd, stdin: options.stdin });
    const argv = [path.basename(command), ...args];
    // Last registration wins, so a test can override a default set up by a
    // shared helper without unpicking it.
    for (let index = this.#handlers.length - 1; index >= 0; index -= 1) {
      const entry = this.#handlers[index];
      if (entry === undefined) {
        continue;
      }
      if (entry.match.every((part, position) => argv[position] === part)) {
        return await entry.handler(command, args, options);
      }
    }
    if (!this.#present.has(path.basename(command))) {
      return { code: 127, stdout: "", stderr: `${command}: not found` };
    }
    if (this.strict) {
      throw new Error(`FakeProcessRunner: no handler for ${argv.join(" ")}`);
    }
    return OK;
  }

  async which(command: string): Promise<string | null> {
    return this.#present.has(path.basename(command)) ? `/usr/bin/${command}` : null;
  }

  /** All argv strings joined, for coarse assertions. */
  transcript(): string {
    return this.calls.map((call) => [call.command, ...call.args].join(" ")).join("\n");
  }

  ran(command: string, ...argPrefix: string[]): boolean {
    return this.calls.some(
      (call) =>
        path.basename(call.command) === command &&
        argPrefix.every((part, index) => call.args[index] === part),
    );
  }
}

/** A runner preloaded with plausible answers for the happy path. */
export function happyRunner(
  options: { login?: string; siteUrl?: string; slug?: string } = {},
): FakeProcessRunner {
  const login = options.login ?? "novelist";
  const slug = options.slug ?? "hollow-creek-anomaly";
  const siteUrl = options.siteUrl ?? `https://${slug}.${login}.workers.dev`;
  return new FakeProcessRunner()
    .on(["git", "--version"], { code: 0, stdout: "git version 2.45.0\n", stderr: "" })
    .on(["gh", "--version"], { code: 0, stdout: "gh version 2.60.0\n", stderr: "" })
    .on(["gh", "auth", "status"], { code: 0, stdout: "Logged in\n", stderr: "" })
    .on(["gh", "api", "user"], { code: 0, stdout: `${login}\n`, stderr: "" })
    .on(["wrangler", "--version"], { code: 0, stdout: "4.0.0\n", stderr: "" })
    .on(["wrangler", "whoami"], { code: 0, stdout: `${login}@example.com\n`, stderr: "" })
    .on(["pnpm", "--version"], { code: 0, stdout: "9.0.0\n", stderr: "" })
    .on(["git", "diff", "--cached", "--quiet"], { code: 1, stdout: "", stderr: "" })
    .on(["git", "remote", "get-url"], {
      code: 0,
      stdout: `https://github.com/${login}/${slug}.git\n`,
      stderr: "",
    })
    .on(["wrangler", "deploy"], {
      code: 0,
      stdout: `Uploaded ${slug}\nDeployed ${slug}\n  ${siteUrl}\n`,
      stderr: "",
    })
    .on(["wrangler", "d1", "create"], {
      code: 0,
      stdout: `{ "uuid": "11111111-2222-4333-8444-555555555555", "name": "${slug}-authorbot" }\n`,
      stderr: "",
    })
    .on(["wrangler", "d1", "execute"], {
      code: 0,
      // What the first-boot seed leaves behind: the project, and the author
      // holding the maintainer role on it.
      stdout: `[{"results":[{"slug":"${slug}","maintainer":"github:${login}"}]}]\n`,
      stderr: "",
    });
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

export interface AskedPrompt {
  readonly id: string;
  readonly kind: "text" | "confirm" | "select" | "secret";
  readonly message: string;
  readonly destructive?: boolean;
}

/**
 * Answers prompts from a map keyed by id. An unanswered prompt throws by
 * default rather than falling back to a default value, so a test that adds a
 * new question notices instead of silently accepting whatever the wizard
 * suggests.
 */
export class ScriptedPrompter implements Prompter {
  readonly asked: AskedPrompt[] = [];
  readonly #answers: Record<string, unknown>;
  readonly #useDefaults: boolean;

  constructor(answers: Record<string, unknown> = {}, options: { useDefaults?: boolean } = {}) {
    this.#answers = answers;
    this.#useDefaults = options.useDefaults ?? false;
  }

  set(id: string, value: unknown): this {
    this.#answers[id] = value;
    return this;
  }

  #answer(id: string, fallback: unknown, kind: string): unknown {
    if (Object.hasOwn(this.#answers, id)) {
      return this.#answers[id];
    }
    if (this.#useDefaults && fallback !== undefined) {
      return fallback;
    }
    throw new Error(`ScriptedPrompter: no answer for ${kind} prompt "${id}"`);
  }

  async text(prompt: TextPrompt): Promise<string> {
    this.asked.push({ id: prompt.id, kind: "text", message: prompt.message });
    return String(this.#answer(prompt.id, prompt.defaultValue, "text"));
  }

  async confirm(prompt: ConfirmPrompt): Promise<boolean> {
    this.asked.push({
      id: prompt.id,
      kind: "confirm",
      message: prompt.message,
      ...(prompt.destructive === undefined ? {} : { destructive: prompt.destructive }),
    });
    return Boolean(this.#answer(prompt.id, prompt.defaultValue, "confirm"));
  }

  async select(prompt: SelectPrompt): Promise<string> {
    this.asked.push({ id: prompt.id, kind: "select", message: prompt.message });
    return String(this.#answer(prompt.id, prompt.defaultValue, "select"));
  }

  async secret(prompt: SecretPrompt): Promise<string> {
    this.asked.push({ id: prompt.id, kind: "secret", message: prompt.message });
    return String(this.#answer(prompt.id, undefined, "secret"));
  }

  askedIds(): string[] {
    return this.asked.map((entry) => entry.id);
  }
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export class MemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>(["/"]);
  readonly writes: string[] = [];
  /** Permission bits per path. Anything unset reads as a private 0600 file. */
  readonly modes = new Map<string, number>();

  /** Marks a file group- or world-readable, as a careless redirect would. */
  chmod(filePath: string, mode: number): this {
    this.modes.set(path.resolve(filePath), mode);
    return this;
  }

  async mode(filePath: string): Promise<number | null> {
    const resolved = path.resolve(filePath);
    if (!this.files.has(resolved)) {
      return null;
    }
    return this.modes.get(resolved) ?? 0o600;
  }

  seed(filePath: string, contents: string): this {
    this.files.set(path.resolve(filePath), contents);
    this.#ensureParents(path.resolve(filePath));
    return this;
  }

  #ensureParents(filePath: string): void {
    let current = path.dirname(filePath);
    while (current !== path.dirname(current)) {
      this.directories.add(current);
      current = path.dirname(current);
    }
  }

  async readFile(filePath: string): Promise<string> {
    const contents = this.files.get(path.resolve(filePath));
    if (contents === undefined) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return contents;
  }

  async writeFile(filePath: string, contents: string): Promise<void> {
    const resolved = path.resolve(filePath);
    this.files.set(resolved, contents);
    this.#ensureParents(resolved);
    this.writes.push(resolved);
  }

  async mkdirp(dirPath: string): Promise<void> {
    const resolved = path.resolve(dirPath);
    this.directories.add(resolved);
    this.#ensureParents(path.join(resolved, "x"));
  }

  async exists(filePath: string): Promise<boolean> {
    const resolved = path.resolve(filePath);
    return this.files.has(resolved) || this.directories.has(resolved);
  }

  async readDir(dirPath: string): Promise<string[]> {
    const resolved = path.resolve(dirPath);
    const entries = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (path.dirname(filePath) === resolved) {
        entries.add(path.basename(filePath));
      }
    }
    return [...entries].sort();
  }

  /** Every byte this filesystem holds, for leak assertions. */
  everything(): string {
    return [...this.files.entries()].map(([name, body]) => `${name}\n${body}`).join("\n");
  }
}

// ---------------------------------------------------------------------------
// Clock, randomness, output
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  #now: number;
  readonly slept: number[] = [];

  constructor(start = Date.parse("2026-07-20T12:00:00.000Z")) {
    this.#now = start;
  }

  now(): Date {
    return new Date(this.#now);
  }

  /** Sleeping advances the clock instead of waiting, so tests stay instant. */
  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.#now += ms;
    await Promise.resolve();
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}

/**
 * Deterministic bytes from a splitmix64-style generator. Deterministic so a
 * failing test reproduces; distinct per seed so ids in one test do not collide
 * with ids in another.
 */
export class SeededRandom implements RandomSource {
  #state: bigint;

  constructor(seed = 0x9e3779b97f4a7c15n) {
    this.#state = BigInt.asUintN(64, seed);
  }

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      this.#state = BigInt.asUintN(64, this.#state + 0x9e3779b97f4a7c15n);
      let z = this.#state;
      z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
      z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
      z = BigInt.asUintN(64, z ^ (z >> 31n));
      out[index] = Number(z & 0xffn);
    }
    return out;
  }
}

export class CollectingOutput implements OutputPort {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];

  write(line: string): void {
    this.stdout.push(line);
  }

  error(line: string): void {
    this.stderr.push(line);
  }

  /** Everything printed, both streams — what a leak test inspects. */
  all(): string {
    return [...this.stdout, ...this.stderr].join("\n");
  }
}

export function fakeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    cwd: "/work",
    env: { NO_COLOR: "1", PATH: "/usr/bin" },
    columns: 80,
    isTty: false,
    nodeVersion: "v22.11.0",
    invocation: "create-authorbot",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HTTP and the fake GitHub API
// ---------------------------------------------------------------------------

export type HttpHandler = (url: URL, init: HttpRequest) => HttpResponse | Promise<HttpResponse>;

export class FakeHttpClient implements HttpClient {
  readonly requests: { url: string; init: HttpRequest }[] = [];
  readonly #routes: { test: (url: URL) => boolean; handler: HttpHandler }[] = [];

  route(matcher: RegExp | ((url: URL) => boolean), handler: HttpHandler): this {
    const test = typeof matcher === "function" ? matcher : (url: URL) => matcher.test(url.href);
    this.#routes.push({ test, handler });
    return this;
  }

  async request(rawUrl: string, init: HttpRequest = {}): Promise<HttpResponse> {
    this.requests.push({ url: rawUrl, init });
    const url = new URL(rawUrl);
    for (let index = this.#routes.length - 1; index >= 0; index -= 1) {
      const route = this.#routes[index];
      if (route !== undefined && route.test(url)) {
        return await route.handler(url, init);
      }
    }
    return { status: 404, headers: {}, body: "" };
  }
}

/** Generated once per process: RSA keygen is the slowest thing in the suite. */
let cachedKeyPair: { privateKey: string; publicKey: string } | null = null;

export function testKeyPair(): { privateKey: string; publicKey: string } {
  if (cachedKeyPair === null) {
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    cachedKeyPair = { privateKey: pair.privateKey, publicKey: pair.publicKey };
  }
  return cachedKeyPair;
}

export interface FakeGitHubOptions {
  /** Codes the conversion endpoint will accept. */
  readonly acceptCode?: (code: string) => boolean;
  /** Requests before `/installation` starts returning 200. */
  readonly installAfterAttempts?: number;
  readonly clientSecret?: string;
  readonly webhookSecret?: string;
  readonly conversionStatus?: number;
}

export interface FakeGitHub {
  readonly client: FakeHttpClient;
  readonly apiBase: string;
  readonly webBase: string;
  readonly secrets: { clientSecret: string; webhookSecret: string; pem: string };
  installationAttempts(): number;
}

/**
 * The Phase 5 fake GitHub, extended with the manifest conversion endpoint
 * (contract §6) and the per-repository installation lookup.
 */
export function fakeGitHub(options: FakeGitHubOptions = {}): FakeGitHub {
  const apiBase = "https://api.github.test";
  const webBase = "https://github.test";
  const { privateKey } = testKeyPair();
  const clientSecret = options.clientSecret ?? "ghcs_fake_client_secret_value_0123456789";
  const webhookSecret = options.webhookSecret ?? "whsec_fake_webhook_secret_value_0123456789";
  const accept = options.acceptCode ?? (() => true);
  const installAfter = options.installAfterAttempts ?? 0;
  let attempts = 0;

  const client = new FakeHttpClient();

  client.route(/\/app-manifests\/[^/]+\/conversions$/, (url) => {
    const code = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    if (!accept(code)) {
      return { status: 404, headers: {}, body: JSON.stringify({ message: "Not Found" }) };
    }
    const status = options.conversionStatus ?? 201;
    if (status !== 201 && status !== 200) {
      return { status, headers: {}, body: JSON.stringify({ message: "nope" }) };
    }
    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: 424242,
        slug: "my-book-authorbot",
        html_url: `${webBase}/apps/my-book-authorbot`,
        client_id: "Iv1.fake_client_id",
        client_secret: clientSecret,
        webhook_secret: webhookSecret,
        pem: privateKey,
      }),
    };
  });

  client.route(/\/repos\/[^/]+\/[^/]+\/installation$/, () => {
    attempts += 1;
    if (attempts <= installAfter) {
      return { status: 404, headers: {}, body: JSON.stringify({ message: "Not Found" }) };
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 777777 }),
    };
  });

  return {
    client,
    apiBase,
    webBase,
    secrets: { clientSecret, webhookSecret, pem: privateKey },
    installationAttempts: () => attempts,
  };
}

/**
 * Adds the site's own health endpoints to a fake HTTP client: the API refusing
 * anonymous callers, and the OAuth start redirecting to GitHub.
 */
export function withHealthyApi(client: FakeHttpClient, siteUrl: string): FakeHttpClient {
  const base = new URL(siteUrl);
  client.route(
    (url) => url.host === base.host && url.pathname === "/v1/me",
    () => ({ status: 401, headers: { "content-type": "application/problem+json" }, body: "{}" }),
  );
  client.route(
    (url) => url.host === base.host && url.pathname === "/v1/auth/github",
    () => ({
      status: 302,
      headers: {
        location:
          "https://github.test/login/oauth/authorize?client_id=Iv1.fake_client_id&state=abc123",
      },
      body: "",
    }),
  );
  client.route(
    (url) => url.host === base.host && url.pathname === "/",
    () => ({ status: 200, headers: {}, body: "<html>book</html>" }),
  );
  return client;
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

export class FakeBrowser implements BrowserOpener {
  readonly opened: string[] = [];
  #handler: ((url: string) => Promise<void> | void) | null = null;

  onOpen(handler: (url: string) => Promise<void> | void): this {
    this.#handler = handler;
    return this;
  }

  async open(url: string): Promise<void> {
    this.opened.push(url);
    await this.#handler?.(url);
  }
}

/**
 * A browser that actually completes the manifest flow against the real
 * loopback server: it fetches the start page, reads the manifest out of the
 * form exactly as a browser would, and calls the `redirect_url` the manifest
 * declares. That exercises the unpredictable path, the `state` round trip, and
 * the redirect-URL wiring, rather than asserting them from the inside.
 */
export function manifestBrowser(options: {
  code: string;
  /** Override the state sent back, to test the mismatch path. */
  stateOverride?: string;
  /** Skip the callback entirely, to test the timeout path. */
  neverCallBack?: boolean;
}): FakeBrowser {
  const browser = new FakeBrowser();
  browser.onOpen(async (url) => {
    if (!url.includes("127.0.0.1")) {
      // The installation page: a real browser would show it; nothing to do.
      return;
    }
    if (options.neverCallBack === true) {
      return;
    }
    const page = await fetch(url);
    const html = await page.text();
    const action = /action="([^"]+)"/.exec(html)?.[1] ?? "";
    const state = new URL(decodeHtml(action)).searchParams.get("state") ?? "";
    const manifestJson = /name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "{}";
    const manifest = JSON.parse(decodeHtml(manifestJson)) as { redirect_url?: string };
    const redirect = manifest.redirect_url;
    if (redirect === undefined) {
      throw new Error("manifestBrowser: the page carried no redirect_url");
    }
    const target = new URL(redirect);
    target.searchParams.set("code", options.code);
    target.searchParams.set("state", options.stateOverride ?? state);
    await fetch(target.href);
  });
  return browser;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
