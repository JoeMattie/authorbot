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
import { BINARY_NAME } from "../invocation.js";
import { logoLines } from "./logo.js";
import { RedactingStream } from "./redacting-stream.js";
import { spinner } from "@clack/prompts";
import { Chalk, type ChalkInstance } from "chalk";

const MAX_WIDTH = 80;
const MIN_WIDTH = 40;



export interface Theme {
  readonly colour: boolean;
  readonly width: number;
  /**
   * Whether to draw with box characters and arrows rather than dashes and
   * hyphens.
   *
   * Tied to the same signal as colour, deliberately: a terminal that cannot be
   * trusted with `\u001b[32m` is a terminal that should not be sent `┌`
   * either, and NO_COLOR is set by people who want output they can pipe,
   * paste, and read in a log. Every symbol below has an ASCII twin that says
   * the same thing, so nothing is carried by the glyph alone.
   */
  readonly unicode: boolean;
  /**
   * The terminal's true width, unclamped.
   *
   * `width` is capped at 80 because prose past that is hard to read. The mark
   * is not prose: centring it inside an 80-column box on a 200-column terminal
   * leaves it sitting off to the left, which looks like a bug rather than a
   * decision.
   */
  readonly terminalWidth: number;
}

export function themeFor(env: Environment): Theme {
  // The NO_COLOR convention: presence disables colour regardless of value,
  // except that an explicitly empty string is treated as unset.
  const noColor = env.env["NO_COLOR"];
  const dumb = env.env["TERM"] === "dumb";
  const colour = (noColor === undefined || noColor === "") && !dumb && env.isTty;
  const columns = Number.isFinite(env.columns) && env.columns > 0 ? env.columns : MAX_WIDTH;
  return {
    colour,
    unicode: colour,
    width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(columns))),
    terminalWidth: Math.max(MIN_WIDTH, Math.floor(columns)),
  };
}

/**
 * Colour, via chalk.
 *
 * The escape sequences were written out by hand here, which worked and meant
 * every new colour was another pair of magic numbers to get right. chalk also
 * knows what a terminal can actually take — 16 colours, 256, or truecolor — so
 * the palette can be richer than the eight that were safe to hardcode.
 *
 * `this.#theme.colour` decides *whether* to colour anything, and this instance
 * is constructed with colour forced on so that stays true. chalk does its own
 * environment detection, and left to itself it would be a second opinion —
 * output coloured in one place and not another for reasons neither party fully
 * owns. The theme already answers to NO_COLOR, TERM=dumb and a non-TTY stdout;
 * it is the authority, and `#style` is where it is consulted.
 */
const paint = new Chalk({ level: 3 });

const STYLES: Record<string, ChalkInstance> = {
  bold: paint.bold,
  dim: paint.dim,
  green: paint.green,
  yellow: paint.yellow,
  red: paint.red,
  cyan: paint.cyan,
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

  readonly #invocation: string;

  constructor(out: OutputPort, vault: SecretVault, theme: Theme, invocation = BINARY_NAME) {
    this.#out = out;
    this.#vault = vault;
    this.#theme = theme;
    this.#invocation = invocation;
  }

  /**
   * Says the wizard's name the way the author can actually type it.
   *
   * Roughly twenty messages tell someone to run `create-authorbot <stage>` —
   * every resume hint and most error remedies. That binary exists only for a
   * global install; `npx @authorbot/create`, the documented way in, leaves
   * nothing on PATH. So the advice offered at the moment something had already
   * failed was itself a command not found.
   *
   * Rewriting here rather than at each call site is deliberate: this is the
   * single point every line passes through on its way to the terminal, and the
   * alternative was threading the invocation into five files and trusting the
   * twenty-first message to remember. It runs after redaction and before
   * wrapping, so the substituted (longer) text is what gets measured.
   */
  #named(text: string): string {
    return this.#invocation === BINARY_NAME
      ? text
      : text.replaceAll(BINARY_NAME, this.#invocation);
  }

  get theme(): Theme {
    return this.#theme;
  }

  #style(text: string, name: keyof typeof STYLES): string {
    if (!this.#theme.colour) {
      return text;
    }
    const style = STYLES[name];
    return style === undefined ? text : style(text);
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
    return wrap(this.#named(this.#vault.redact(text)), this.#theme.width, indent);
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

  /**
   * Runs `work` under a spinner, when the terminal can show one.
   *
   * For the steps that take minutes rather than moments — installing the
   * toolchain, deploying, waiting for a site to answer. Silence for four
   * minutes reads as a hang: the first author to meet the cold toolchain
   * install asked whether to kill the process, and was right to, because
   * nothing on screen distinguished "downloading wrangler" from "stopped".
   *
   * The `timer` indicator is deliberate. A spinning character says only that
   * the process is alive; elapsed time answers the question actually being
   * asked, which is whether this is taking longer than it should.
   *
   * Degrades to the ordinary step line whenever the terminal cannot take a
   * spinner — a redrawing cursor in a log file is worse than no spinner at
   * all — so the caller's output is the same either way, minus the animation.
   */
  async during<T>(label: string, work: () => Promise<T>): Promise<T> {
    if (!this.#theme.unicode) {
      this.step(label);
      return await work();
    }
    const spin = spinner({
      indicator: "timer",
      // Never `process.stdout`: a spinner draws its own output, and the vault
      // has to see it like everything else.
      output: new RedactingStream(process.stdout, this.#vault),
    });
    spin.start(this.#named(this.#vault.redact(label)));
    try {
      const result = await work();
      spin.stop(this.#named(this.#vault.redact(label)));
      return result;
    } catch (error) {
      // Stop before rethrowing, or the spinner keeps drawing over the error
      // that explains why it stopped.
      spin.error(this.#named(this.#vault.redact(label)));
      throw error;
    }
  }

  /**
   * The mark, once, at the top of a run.
   *
   * Not per stage: a logo that reappears every few seconds stops being a mark
   * and becomes noise between the author and what they are being told.
   */
  logo(): void {
    for (const line of logoLines({ ...this.#theme, width: this.#theme.terminalWidth })) {
      this.#emit(line);
    }
    this.blank();
  }

  /**
   * Section banner introducing a stage.
   *
   * A drawn box where the terminal can take it, the original underline where
   * it cannot. Both are one visual break between stages, which is the job:
   * the wizard prints a lot, and without a hard edge every stage reads as a
   * continuation of the last one.
   */
  heading(text: string): void {
    const label = this.#named(this.#vault.redact(text));
    this.blank();
    if (!this.#theme.unicode) {
      this.#emit(this.#style(label, "bold"));
      this.#emit(this.#style("-".repeat(Math.min(label.length, this.#theme.width)), "dim"));
      return;
    }
    // Four characters of border and padding, so the text still respects width.
    const inner = Math.min(label.length, this.#theme.width - 4);
    const line = "\u2500".repeat(inner + 2);
    this.#emit(this.#style(`\u250c${line}\u2510`, "dim"));
    this.#emit(
      `${this.#style("\u2502", "dim")} ${this.#style(label.slice(0, inner), "bold")} ${this.#style(
        "\u2502",
        "dim",
      )}`,
    );
    this.#emit(this.#style(`\u2514${line}\u2518`, "dim"));
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
    const marker = this.#theme.unicode ? "\u203a" : "-";
    for (const [index, line] of this.#lines(text, "  ").entries()) {
      this.#emit(index === 0 ? this.#style(marker, "cyan") + line.slice(1) : line);
    }
  }

  ok(text: string): void {
    this.#prefixed(this.#style(this.#theme.unicode ? "\u2713 " : "ok", "green"), text);
  }

  warn(text: string): void {
    this.#prefixed(this.#style(this.#theme.unicode ? "\u25b2 " : "!!", "yellow"), text);
  }

  fail(text: string): void {
    this.#prefixed(this.#style(this.#theme.unicode ? "\u2717 " : "XX", "red"), text);
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
    for (const line of this.#named(this.#vault.redact(text)).split("\n")) {
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
