/**
 * `TtyPrompter`, which now sits on `@clack/prompts`.
 *
 * What is worth testing changed with it. Reading a line, redrawing on
 * validation failure, and masking a secret are clack's problem now, and it has
 * its own suite for them. What is still this repository's problem is the part
 * that wraps clack:
 *
 *  - every byte reaching the terminal goes through the secret vault, which is
 *    the guarantee that made adopting a prompt library acceptable at all;
 *  - a cancelled prompt becomes an `AbortedError`, so the run unwinds through
 *    the same path as any other early stop instead of calling `process.exit`
 *    and skipping the "here is what was created" summary.
 *
 * The streams below imitate a TTY because clack asks for raw mode and speaks
 * the keypress protocol; a plain PassThrough hangs forever waiting for input
 * it can never receive, which is exactly what the previous version of this
 * file did when the implementation changed under it.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TtyPrompter } from "../src/runtime/prompt.js";
import { AbortedError } from "../src/errors.js";
import { SecretVault } from "../src/secrets.js";

/** A PassThrough that claims to be a terminal, which is all clack checks. */
function ttyInput(): PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void } {
  const stream = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream;
}

/** Collects everything the prompt library writes, after redaction. */
function collector(): PassThrough & { text: () => string } {
  const chunks: string[] = [];
  const stream = new PassThrough() as PassThrough & { text: () => string };
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  stream.text = () => chunks.join("");
  return stream;
}

const ENTER = "\r";
const CTRL_C = "";

describe("TtyPrompter", () => {
  it("returns what was typed", async () => {
    const input = ttyInput();
    const target = collector();
    const prompter = new TtyPrompter({
      input: input as unknown as NodeJS.ReadStream,
      output: { write: () => {}, error: () => {} },
      target,
    });

    const answer = prompter.text({ id: "book.title", message: "What is your book called?" });
    setTimeout(() => input.write(`The Causal Projector${ENTER}`), 20);

    await expect(answer).resolves.toBe("The Causal Projector");
  });

  it("redacts a secret that reaches a prompt's message", async () => {
    // The reason clack is given a redacting stream rather than stdout: this
    // has to hold for output composed by a library that has never heard of the
    // vault.
    const vault = new SecretVault();
    const secret = vault.register("TOKEN", "super-secret-token-value");
    const input = ttyInput();
    const target = collector();
    const prompter = new TtyPrompter({
      input: input as unknown as NodeJS.ReadStream,
      output: { write: () => {}, error: () => {} },
      vault,
      target,
    });

    const answer = prompter.text({ id: "x", message: `Confirm the token ${secret}?` });
    setTimeout(() => input.write(`yes${ENTER}`), 20);
    await answer;

    expect(target.text()).not.toContain("super-secret-token-value");
  });

  it("shows a confirm's hint, which carries the reason for the answer", async () => {
    // Moving to clack silently dropped this: `confirm` has no hint slot, so
    // every explanatory line went with it — including the one telling an
    // author that a maintainer bearer token is something they do not have and
    // that "no" is the expected answer. The question survived; the part that
    // made it answerable did not.
    const input = ttyInput();
    const target = collector();
    const prompter = new TtyPrompter({
      input: input as unknown as NodeJS.ReadStream,
      output: { write: () => {}, error: () => {} },
      target,
    });

    const answer = prompter.confirm({
      id: "x",
      message: "Mint the token now?",
      hint: "Most authors do not hold one.",
      defaultValue: false,
    });
    setTimeout(() => input.write(ENTER), 20);
    await answer;

    expect(target.text()).toContain("Most authors do not hold one.");
  });

  it("shows a text prompt's hint", async () => {
    const input = ttyInput();
    const target = collector();
    const prompter = new TtyPrompter({
      input: input as unknown as NodeJS.ReadStream,
      output: { write: () => {}, error: () => {} },
      target,
    });

    const answer = prompter.text({
      id: "x",
      message: "Name?",
      hint: "Lowercase letters and hyphens.",
    });
    setTimeout(() => input.write(`book${ENTER}`), 20);
    await answer;

    expect(target.text()).toContain("Lowercase letters and hyphens.");
  });

  it("turns Ctrl-C into an AbortedError rather than killing the process", async () => {
    // The wizard's early-stop path prints what it created and how to remove
    // it. Exiting from inside a prompt would skip exactly that, for the person
    // who most needs it: someone abandoning setup halfway through.
    const input = ttyInput();
    const prompter = new TtyPrompter({
      input: input as unknown as NodeJS.ReadStream,
      output: { write: () => {}, error: () => {} },
      target: collector(),
    });

    const answer = prompter.text({ id: "x", message: "anything?" });
    setTimeout(() => input.write(CTRL_C), 20);

    await expect(answer).rejects.toBeInstanceOf(AbortedError);
  });

  it("re-asks on a validation failure and accepts the corrected answer", async () => {
    const input = ttyInput();
    const asked: string[] = [];
    const prompter = new TtyPrompter({
      input: input as unknown as NodeJS.ReadStream,
      output: { write: () => {}, error: () => {} },
      target: collector(),
    });

    const answer = prompter.text({
      id: "x",
      message: "Name?",
      validate: (value) => {
        asked.push(value);
        return value.trim() === "" ? "A name is required." : null;
      },
    });
    setTimeout(() => input.write(ENTER), 20);
    setTimeout(() => input.write(`Mara Voss${ENTER}`), 80);

    await expect(answer).resolves.toBe("Mara Voss");
    expect(asked).toContain("");
  });
});
