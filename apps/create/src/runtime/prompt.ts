/**
 * Terminal prompting, and its non-interactive counterpart.
 *
 * Hidden input (contract §2.3) is done by hand rather than with a dependency:
 * raw mode, no echo, and a `finally` that restores the terminal on every exit
 * path including Ctrl-C — a wizard that leaves a terminal in raw mode with
 * echo off after a failed secret prompt is a worse bug than the one that
 * caused the failure.
 */
import { createInterface } from "node:readline";
import type {
  ConfirmPrompt,
  OutputPort,
  Prompter,
  SecretPrompt,
  SelectPrompt,
  TextPrompt,
} from "../ports.js";
import { NonInteractiveError, WizardError } from "../errors.js";
import { wrap } from "../ui/reporter.js";

const WIDTH = 80;

export interface TtyPrompterOptions {
  readonly input: NodeJS.ReadStream;
  readonly output: OutputPort;
  readonly rawInput?: NodeJS.ReadStream;
}

export class TtyPrompter implements Prompter {
  readonly #input: NodeJS.ReadStream;
  readonly #output: OutputPort;

  constructor(options: TtyPrompterOptions) {
    this.#input = options.input;
    this.#output = options.output;
  }

  #ask(question: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: this.#input, output: process.stdout, terminal: true });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      rl.on("close", () => {
        // Ctrl-D at a prompt: no answer is coming, and looping would spin.
        resolve("");
      });
      rl.on("error", reject);
    });
  }

  #preamble(message: string, hint?: string): void {
    for (const line of wrap(message, WIDTH)) {
      this.#output.write(line);
    }
    if (hint !== undefined) {
      for (const line of wrap(hint, WIDTH, "  ")) {
        this.#output.write(line);
      }
    }
  }

  async text(prompt: TextPrompt): Promise<string> {
    for (;;) {
      this.#preamble(prompt.message, prompt.hint);
      const suffix = prompt.defaultValue === undefined ? "" : ` [${prompt.defaultValue}]`;
      const raw = (await this.#ask(`>${suffix} `)).trim();
      const value = raw.length === 0 ? (prompt.defaultValue ?? "") : raw;
      const error = prompt.validate?.(value) ?? null;
      if (error === null) {
        return value;
      }
      this.#output.write(`  ${error}`);
    }
  }

  async confirm(prompt: ConfirmPrompt): Promise<boolean> {
    for (;;) {
      this.#preamble(prompt.message, prompt.hint);
      // A destructive step never shows a capital Y (contract §2.1): the
      // default is no, and the rendering says so.
      const shape = prompt.destructive === true ? "y/N" : prompt.defaultValue ? "Y/n" : "y/N";
      const raw = (await this.#ask(`> [${shape}] `)).trim().toLowerCase();
      if (raw.length === 0) {
        return prompt.destructive === true ? false : prompt.defaultValue;
      }
      if (raw === "y" || raw === "yes") {
        return true;
      }
      if (raw === "n" || raw === "no") {
        return false;
      }
      this.#output.write('  Please answer "y" or "n".');
    }
  }

  async select(prompt: SelectPrompt): Promise<string> {
    for (;;) {
      this.#preamble(prompt.message);
      for (const [index, choice] of prompt.choices.entries()) {
        const marker = choice.value === prompt.defaultValue ? "*" : " ";
        this.#output.write(`  ${marker} ${String(index + 1)}. ${choice.label}`);
        if (choice.hint !== undefined) {
          for (const line of wrap(choice.hint, WIDTH, "       ")) {
            this.#output.write(line);
          }
        }
      }
      const raw = (await this.#ask("> ")).trim();
      if (raw.length === 0 && prompt.defaultValue !== undefined) {
        return prompt.defaultValue;
      }
      const byNumber = Number.parseInt(raw, 10);
      if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= prompt.choices.length) {
        const choice = prompt.choices[byNumber - 1];
        if (choice !== undefined) {
          return choice.value;
        }
      }
      const byValue = prompt.choices.find((choice) => choice.value === raw);
      if (byValue !== undefined) {
        return byValue.value;
      }
      this.#output.write(`  Enter a number from 1 to ${String(prompt.choices.length)}.`);
    }
  }

  async secret(prompt: SecretPrompt): Promise<string> {
    this.#preamble(prompt.message, prompt.hint);
    if (!this.#input.isTTY) {
      throw new WizardError(
        "A secret was requested but this is not an interactive terminal, so it cannot be typed without being echoed.",
        "Run the wizard in a terminal, or use --non-interactive with a config file that supplies the value from your secret store.",
      );
    }
    this.#output.write("> (typing is hidden)");
    return await readHidden(this.#input);
  }
}

/**
 * Reads a line with echo suppressed. Bytes are handled one at a time so
 * nothing is ever written back to the terminal, and the raw-mode/listener
 * state is unwound in `finally` regardless of how the read ends.
 */
function readHidden(input: NodeJS.ReadStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    let value = "";
    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      if (!wasRaw) {
        try {
          input.setRawMode(false);
        } catch {
          // Terminal already gone; nothing left to restore.
        }
      }
      input.pause();
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          cleanup();
          reject(new WizardError("Cancelled.", "Run the same command again when ready."));
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          cleanup();
          resolve(value);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    try {
      input.setRawMode(true);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    input.resume();
    input.on("data", onData);
    input.on("error", onError);
  });
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
