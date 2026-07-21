/**
 * Terminal prompting, and its non-interactive counterpart.
 *
 * Built on `@clack/prompts`: the arrow-key select, the masked secret field,
 * and cancellation that works were all hand-rolled here before, and two of the
 * three were broken at some point in the doing.
 *
 * THE VAULT STILL SEES EVERY BYTE. `secrets.ts` describes redaction as
 * covering *every* way text leaves this process, and that is worth more than
 * any amount of presentation: it is the only reason a credential cannot reach
 * a terminal, a screen share, or a scrollback buffer. So clack is not handed
 * `process.stdout`. It is handed a stream that redacts and then forwards,
 * which keeps the guarantee over output this file never composed and does not
 * know the shape of.
 *
 * One seam worth naming: that redaction is per chunk, so a secret split across
 * two writes could slip through. Prompt text is composed here and short, and a
 * secret's value is masked rather than echoed, so the exposure is narrow — but
 * narrower than "not redacted at all", which is what handing over the real
 * stdout would have meant.
 */
import { confirm, isCancel, password, select, text } from "@clack/prompts";
import type {
  ConfirmPrompt,
  OutputPort,
  Prompter,
  SecretPrompt,
  SelectPrompt,
  TextPrompt,
} from "../ports.js";
import { AbortedError, NonInteractiveError, WizardError } from "../errors.js";
import type { SecretVault } from "../secrets.js";
import { RedactingStream } from "../ui/redacting-stream.js";

export interface TtyPrompterOptions {
  readonly input: NodeJS.ReadStream;
  readonly output: OutputPort;
  readonly rawInput?: NodeJS.ReadStream;
  /** The run's vault. Every byte the prompt library writes passes through it. */
  readonly vault?: SecretVault;
  /** The stream prompts draw on. Defaults to stdout; injected by tests. */
  readonly target?: NodeJS.WritableStream;
}

export class TtyPrompter implements Prompter {
  readonly #input: NodeJS.ReadStream;
  readonly #output: RedactingStream;
  readonly #vault: SecretVault | undefined;

  constructor(options: TtyPrompterOptions) {
    this.#input = options.input;
    this.#vault = options.vault;
    this.#output = new RedactingStream(options.target ?? process.stdout, options.vault);
  }

  #redact(value: string): string {
    return this.#vault === undefined ? value : this.#vault.redact(value);
  }

  /**
   * Ctrl-C at any prompt.
   *
   * An `AbortedError` rather than `process.exit`, so the run unwinds the same
   * way as any other early stop and still prints what it created and how to
   * remove it — which is precisely what someone who cancelled halfway through
   * setting up a book needs in front of them.
   */
  #settle<T>(value: T | symbol): T {
    if (isCancel(value)) {
      throw new AbortedError("cancelled at a prompt");
    }
    return value as T;
  }

  async text(prompt: TextPrompt): Promise<string> {
    const answer = await text({
      message: this.#redact(prompt.message),
      input: this.#input,
      output: this.#output,
      ...(prompt.hint === undefined ? {} : { placeholder: this.#redact(prompt.hint) }),
      ...(prompt.defaultValue === undefined
        ? {}
        : { initialValue: prompt.defaultValue, defaultValue: prompt.defaultValue }),
      ...(prompt.validate === undefined
        ? {}
        : {
            validate: (value: string | undefined) => {
              const problem = prompt.validate?.(value ?? "");
              return problem === null ? undefined : problem;
            },
          }),
    });
    return this.#settle(answer);
  }

  async confirm(prompt: ConfirmPrompt): Promise<boolean> {
    const answer = await confirm({
      message: this.#redact(prompt.message),
      input: this.#input,
      output: this.#output,
      initialValue: prompt.defaultValue ?? false,
    });
    return this.#settle(answer);
  }

  async select(prompt: SelectPrompt): Promise<string> {
    const answer = await select({
      message: this.#redact(prompt.message),
      input: this.#input,
      output: this.#output,
      options: prompt.choices.map((choice) => ({
        value: choice.value,
        label: this.#redact(choice.label),
        ...(choice.hint === undefined ? {} : { hint: this.#redact(choice.hint) }),
      })),
      ...(prompt.defaultValue === undefined ? {} : { initialValue: prompt.defaultValue }),
    });
    return this.#settle(answer);
  }

  async secret(prompt: SecretPrompt): Promise<string> {
    const answer = await password({
      message: this.#redact(prompt.message),
      input: this.#input,
      output: this.#output,
      // Asterisks rather than nothing. A field that gives no feedback at all
      // reads as a frozen terminal, and the usual response to that is to paste
      // the credential a second time.
      mask: "*",
    });
    return this.#settle(answer);
  }
}

/**
 * `--non-interactive` (contract §2.5). Answers come from the config file's
 * `answers` map, keyed by prompt id.
 *
 * **Strict, including where a default exists.** The contract says "fail loudly
 * on anything that would otherwise prompt", and a question with a suggested
 * answer is still a question. Silently accepting the default would be worst
 * exactly where it matters most: the slug is derived from the title and
 * becomes part of every URL the book ever publishes, so an unattended run
 * inventing one is a decision nobody made and nobody can cheaply undo. A
 * config file that must name every answer is longer and says what it does.
 */
export class NonInteractivePrompter implements Prompter {
  readonly #answers: Readonly<Record<string, unknown>>;

  constructor(answers: Readonly<Record<string, unknown>>) {
    this.#answers = answers;
  }

  #lookup(id: string): unknown {
    return Object.hasOwn(this.#answers, id) ? this.#answers[id] : undefined;
  }

  async text(prompt: TextPrompt): Promise<string> {
    const raw = this.#lookup(prompt.id);
    if (raw === undefined) {
      throw new NonInteractiveError(prompt.id, prompt.message);
    }
    const value = typeof raw === "string" ? raw : String(raw);
    const error = prompt.validate?.(value) ?? null;
    if (error !== null) {
      throw new WizardError(
        `The config file's "${prompt.id}" value is not usable: ${error}`,
        `Fix "${prompt.id}" in the config file and run again.`,
      );
    }
    return value;
  }

  async confirm(prompt: ConfirmPrompt): Promise<boolean> {
    const raw = this.#lookup(prompt.id);
    if (typeof raw === "boolean") {
      return raw;
    }
    if (raw === undefined) {
      // A destructive confirmation says so, because that is the one an
      // operator most needs to notice they left out.
      throw new NonInteractiveError(
        prompt.id,
        prompt.destructive === true
          ? `${prompt.message} (destructive: must be explicit)`
          : prompt.message,
      );
    }
    throw new WizardError(
      `The config file's "${prompt.id}" value must be true or false.`,
      `Fix "${prompt.id}" in the config file and run again.`,
    );
  }

  async select(prompt: SelectPrompt): Promise<string> {
    const raw = this.#lookup(prompt.id);
    if (raw === undefined) {
      throw new NonInteractiveError(prompt.id, prompt.message);
    }
    const value = typeof raw === "string" ? raw : String(raw);
    if (!prompt.choices.some((choice) => choice.value === value)) {
      throw new WizardError(
        `The config file's "${prompt.id}" value "${value}" is not one of: ${prompt.choices
          .map((choice) => choice.value)
          .join(", ")}.`,
        `Fix "${prompt.id}" in the config file and run again.`,
      );
    }
    return value;
  }

  async secret(prompt: SecretPrompt): Promise<string> {
    const raw = this.#lookup(prompt.id);
    if (typeof raw === "string" && raw.length > 0) {
      return raw;
    }
    throw new NonInteractiveError(prompt.id, prompt.message);
  }
}
