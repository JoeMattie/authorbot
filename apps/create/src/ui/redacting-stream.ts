/**
 * A stream that redacts on its way to the terminal.
 *
 * `secrets.ts` describes redaction as covering *every* way text leaves this
 * process, and that guarantee is the only reason a credential cannot reach a
 * terminal, a screen share, or a scrollback buffer. Anything that draws its own
 * output - a prompt library, a spinner - would otherwise be a sink the vault
 * has never seen.
 *
 * So those libraries are never handed `process.stdout`. They are handed this,
 * which redacts and then forwards, and the guarantee holds over output this
 * codebase never composed and does not know the shape of.
 *
 * One seam worth naming: redaction happens per chunk, so a secret split across
 * two writes could slip through. Everything drawn this way is composed here and
 * short, and a secret's value is masked rather than echoed - so the exposure is
 * narrow, and narrower than handing over the real stdout, which is the only
 * alternative on offer.
 */
import { Writable } from "node:stream";
import type { SecretVault } from "../secrets.js";

export class RedactingStream extends Writable {
  readonly #target: NodeJS.WritableStream;
  readonly #vault: SecretVault | undefined;

  constructor(target: NodeJS.WritableStream, vault: SecretVault | undefined) {
    super();
    this.#target = target;
    this.#vault = vault;
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const written = String(chunk);
    this.#target.write(this.#vault === undefined ? written : this.#vault.redact(written));
    callback();
  }
}
