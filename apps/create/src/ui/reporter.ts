/**
 * Author-facing output (Phase 6 contract §2.7 and §2.8).
 *
 * Three rules are enforced here rather than remembered at each call site:
 *
 * - **Redaction.** Every line goes through the vault on its way out, so the
 *   only way to print a secret is to bypass this class entirely.
 * - **Width.** Text wraps to at most 80 columns; a narrower terminal narrows
 *   further, a wider one does not widen. Nothing ever requires more than 80.
 * - **Colour degrades.** `NO_COLOR` (any value, per the convention), a
 *   non-TTY stdout, or `TERM=dumb` disables styling, and every styled string
 *   still reads correctly as plain text — colour is never the only carrier of
 *   meaning. Symbols are ASCII for the same reason.
 */
import type { Environment, OutputPort } from "../ports.js";
import type { SecretVault } from "../secrets.js";

const MAX_WIDTH = 80;
const MIN_WIDTH = 40;

export interface Theme {
  readonly colour: boolean;
  readonly width: number;
}

export function themeFor(env: Environment): Theme {
  // The NO_COLOR convention: presence disables colour regardless of value,
  // except that an explicitly empty string is treated as unset.
  const noColor = env.env["NO_COLOR"];
  const dumb = env.env["TERM"] === "dumb";
  const colour = (noColor === undefined || noColor === "") && !dumb && env.isTty;
  const columns = Number.isFinite(env.columns) && env.columns > 0 ? env.columns : MAX_WIDTH;
  return { colour, width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(columns))) };
}

const CODES: Record<string, [string, string]> = {
  bold: ["\u001b[1m", "\u001b[22m"],
  dim: ["\u001b[2m", "\u001b[22m"],
  green: ["\u001b[32m", "\u001b[39m"],
  yellow: ["\u001b[33m", "\u001b[39m"],
  red: ["\u001b[31m", "\u001b[39m"],
  cyan: ["\u001b[36m", "\u001b[39m"],
};

/**
 * Greedy wrap. Words longer than the width (a URL, a command) are left intact
 * on their own line rather than broken: a broken URL is worse than a long one,
 * because it cannot be clicked or copied.
 */
export function wrap(text: string, width: number, indent = ""): string[] {
  const usable = Math.max(1, width - indent.length);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= usable) {
        current = `${current} ${word}`;
      } else {
        lines.push(indent + current);
        current = word;
      }
    }
    if (current.length > 0) {
      lines.push(indent + current);
    }
  }
  return lines;
}

export class Reporter {
  readonly #out: OutputPort;
  readonly #vault: SecretVault;
  readonly #theme: Theme;
  /** Values already handed to `revealOnce`, so "once" is enforced not promised. */
  readonly #revealed = new Set<string>();

  constructor(out: OutputPort, vault: SecretVault, theme: Theme) {
    this.#out = out;
    this.#vault = vault;
    this.#theme = theme;
  }

  get theme(): Theme {
    return this.#theme;
  }

  #style(text: string, name: keyof typeof CODES): string {
    if (!this.#theme.colour) {
      return text;
    }
    const pair = CODES[name];
    return pair === undefined ? text : `${pair[0]}${text}${pair[1]}`;
  }

  /**
   * Redacts, THEN wraps — in that order, and the order matters.
   *
   * A multi-line secret (a PEM, most obviously) is emitted as several lines.
   * Redacting each line on its way out would find no line that equals the
   * secret, and the terminal would faithfully reassemble it for the reader.
   * Scrubbing the whole string before it is broken up is the only placement
   * that closes that gap, so every method composes text and hands it here
   * rather than wrapping first.
   */
  #lines(text: string, indent = ""): string[] {
    return wrap(this.#vault.redact(text), this.#theme.width, indent);
  }

  // Redaction is applied again at the sink: cheap, and it means a future
  // method that forgets `#lines` still cannot print a secret verbatim.
  #emit(line: string): void {
    this.#out.write(this.#vault.redact(line));
  }

  #emitError(line: string): void {
    this.#out.error(this.#vault.redact(line));
  }

  blank(): void {
    this.#emit("");
  }

  /** Section banner introducing a stage. */
  heading(text: string): void {
    this.blank();
    this.#emit(this.#style(this.#vault.redact(text), "bold"));
    this.#emit(this.#style("-".repeat(Math.min(text.length, this.#theme.width)), "dim"));
  }

  /**
   * Contract §2.7 — "explain before doing". One or two plain sentences about
   * what is about to happen and why, before anything happens.
   */
  explain(text: string): void {
    for (const line of this.#lines(text)) {
      this.#emit(line);
    }
    this.blank();
  }

  /** A step that is about to run or has just run. */
  step(text: string): void {
    for (const [index, line] of this.#lines(text, "  ").entries()) {
      this.#emit(index === 0 ? `-${line.slice(1)}` : line);
    }
  }

  ok(text: string): void {
    this.#prefixed(this.#style("ok", "green"), text);
  }

  warn(text: string): void {
    this.#prefixed(this.#style("!!", "yellow"), text);
  }

  fail(text: string): void {
    this.#prefixed(this.#style("XX", "red"), text);
  }

  info(text: string): void {
    this.#prefixed("  ", text);
  }

  #prefixed(marker: string, text: string): void {
    const lines = this.#lines(text, "     ");
    const first = lines[0] ?? "";
    this.#emit(`${marker}  ${first.trimStart()}`);
    for (const line of lines.slice(1)) {
      this.#emit(line);
    }
  }

  /** Verbatim block (a command, a URL, a file path) — never wrapped. */
  literal(text: string): void {
    for (const line of this.#vault.redact(text).split("\n")) {
      this.#emit(`    ${this.#style(line, "cyan")}`);
    }
  }

  /**
   * The one deliberate exception to redaction, and the only method in this
   * class that writes to the sink without consulting the vault.
   *
   * It exists because one value in the whole wizard is *meant* to be read by
   * the author: the agent token, which the server keeps only as a hash. Every
   * other method here redacts — which is correct, and which silently turned
   * "this is the only time this token will ever be shown" into a banner over
   * the word `[redacted]`, losing a token that could not be recovered by any
   * means including minting another one.
   *
   * Two properties keep the exception from becoming a hole. It is *named* for
   * what it does, so a call site that reveals a secret says so in the diff and
   * cannot be reached by accident. And it is single-use: revealing the same
   * value twice is a bug (the caller has lost track of a one-time value), so it
   * throws rather than printing again.
   */
  revealOnce(value: string): void {
    if (this.#revealed.has(value)) {
      throw new Error(
        "Reporter.revealOnce: this value has already been shown; a one-time value must not be printed twice.",
      );
    }
    this.#revealed.add(value);
    for (const line of value.split("\n")) {
      this.#out.write(`    ${this.#style(line, "cyan")}`);
    }
  }

  /** An error the author must act on, with the next action named. */
  problem(summary: string, nextAction: string): void {
    this.blank();
    for (const [index, line] of this.#lines(`Problem: ${summary}`).entries()) {
      this.#emitError(index === 0 ? this.#style(line, "red") : line);
    }
    for (const line of this.#lines(`What to do: ${nextAction}`)) {
      this.#emitError(line);
    }
  }

  bullet(text: string): void {
    const lines = this.#lines(text, "    ");
    const first = lines[0] ?? "";
    this.#emit(`  * ${first.trimStart()}`);
    for (const line of lines.slice(1)) {
      this.#emit(line);
    }
  }
}
