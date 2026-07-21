/**
 * The real `TtyPrompter` driven by a real stream.
 *
 * Every other test injects a fake prompter, so the class that actually reads
 * the terminal was never exercised — and it shipped returning "" for every
 * answer, because `rl.close()` emits `close` synchronously and the Ctrl-D
 * handler resolved the promise before the answer did. The first prompt of the
 * first run of the wizard rejected valid input and looped forever.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TtyPrompter } from "../src/runtime/prompt.js";

function prompterOn(lines: string[]): { prompter: TtyPrompter; written: string[] } {
  const input = new PassThrough();
  const written: string[] = [];
  const prompter = new TtyPrompter({
    input: input as unknown as NodeJS.ReadStream,
    output: { write: (l: string) => written.push(l) },
  });
  // Feed answers after the interface is listening.
  setTimeout(() => {
    for (const line of lines) input.write(`${line}\n`);
  }, 5);
  return { prompter, written };
}

describe("TtyPrompter reads what the user actually typed", () => {
  it("returns the typed answer, not an empty string", async () => {
    const { prompter } = prompterOn(["The Causal Projector"]);
    const answer = await prompter.text({
      id: "book.title",
      message: "What is your book called?",
    });
    expect(answer).toBe("The Causal Projector");
  });

  it("does not re-ask a valid answer", async () => {
    const { prompter } = prompterOn(["Mara Voss"]);
    let asked = 0;
    const answer = await prompter.text({
      id: "x",
      message: "Name?",
      validate: (v: string) => {
        asked += 1;
        return v.trim() === "" ? "A name is required." : null;
      },
    });
    expect(answer).toBe("Mara Voss");
    expect(asked).toBe(1);
  });

  it("still treats end-of-input as an empty answer rather than hanging", async () => {
    const input = new PassThrough();
    const prompter = new TtyPrompter({
      input: input as unknown as NodeJS.ReadStream,
      output: { write: () => {} },
    });
    setTimeout(() => input.end(), 5);
    await expect(prompter.text({ id: "y", message: "anything?" })).resolves.toBe("");
  });
});
