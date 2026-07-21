/**
 * Injection seams for everything the wizard cannot do purely in memory
 * (Phase 6 contract §6: "`gh`, `wrangler`, and the GitHub API replaced by
 * in-process fakes"). Nothing in `src/stages` may import `node:child_process`,
 * `node:http`, or `globalThis.fetch` directly — it asks one of these ports,
 * which the test suite substitutes rather than monkey-patches.
 */

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  /** Written to the child's stdin and closed. The vehicle for `wrangler secret put`. */
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** Absolute path of `command` on PATH, or null when it is not installed. */
  which(command: string): Promise<string | null>;
}

export interface TextPrompt {
  /** Stable key; the non-interactive config answers prompts by this id. */
  readonly id: string;
  readonly message: string;
  readonly hint?: string;
  readonly defaultValue?: string;
  /** Returns an error message, or null when the value is acceptable. */
  readonly validate?: (value: string) => string | null;
}

export interface ConfirmPrompt {
  readonly id: string;
  readonly message: string;
  readonly hint?: string;
  /**
   * Contract §2.1: a destructive step never defaults to yes. `destructive`
   * forces the default to false and makes the non-interactive config state it
   * explicitly rather than inheriting a default.
   */
  readonly defaultValue: boolean;
  readonly destructive?: boolean;
}

export interface SelectChoice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface SelectPrompt {
  readonly id: string;
  readonly message: string;
  readonly choices: readonly SelectChoice[];
  readonly defaultValue?: string;
}

export interface SecretPrompt {
  readonly id: string;
  readonly message: string;
  readonly hint?: string;
}

export interface Prompter {
  text(prompt: TextPrompt): Promise<string>;
  confirm(prompt: ConfirmPrompt): Promise<boolean>;
  select(prompt: SelectPrompt): Promise<string>;
  /** Hidden input (contract §2.3). The value is never echoed. */
  secret(prompt: SecretPrompt): Promise<string>;
}

export interface HttpRequest {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  /** When false, a 3xx is returned as-is instead of being followed. */
  readonly followRedirects?: boolean;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpClient {
  request(url: string, init?: HttpRequest): Promise<HttpResponse>;
}

export interface BrowserOpener {
  /**
   * Hands `url` to the user's browser. Implementations must not block on the
   * browser exiting; the fake uses this hook to drive the loopback callback.
   */
  open(url: string): Promise<void>;
}

export interface LoopbackRequest {
  readonly method: string;
  /** Path with query string, exactly as received. */
  readonly url: string;
}

export interface LoopbackResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export interface LoopbackServer {
  /** `http://127.0.0.1:<port>` — always a loopback address, never 0.0.0.0. */
  readonly origin: string;
  /** Idempotent; safe to call from a `finally` that may run twice. */
  close(): Promise<void>;
}

export interface LoopbackServerFactory {
  start(handler: (request: LoopbackRequest) => Promise<LoopbackResponse>): Promise<LoopbackServer>;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface RandomSource {
  /** Cryptographically strong bytes. Used for ids, `state`, and SESSION_SECRET. */
  bytes(length: number): Uint8Array;
}

export interface FileSystemPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Entry names of a directory, or [] when it does not exist. */
  readDir(path: string): Promise<string[]>;
}

export interface OutputPort {
  write(line: string): void;
  error(line: string): void;
}

export interface Environment {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The Node version actually running the wizard (`process.version`), which is
   * the one that matters — not whichever `node` is first on PATH.
   */
  readonly nodeVersion: string;
  /** Terminal width, clamped by the reporter to at most 80 (contract §2.8). */
  readonly columns: number;
  readonly isTty: boolean;
}
