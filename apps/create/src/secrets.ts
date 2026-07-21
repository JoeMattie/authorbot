/**
 * Secret containment (Phase 6 contract §2.3, exit criterion 6).
 *
 * The wizard handles four secret values it must never reveal: the GitHub App
 * private key, client secret, and webhook secret returned by the manifest
 * conversion, and the `SESSION_SECRET` it generates itself. They are piped
 * straight into `wrangler secret put` and otherwise exist only inside this
 * process.
 *
 * Containment is enforced rather than promised: every secret is registered
 * here the moment it comes into existence, and the output writer, the journal
 * serializer, and the top-level error handler all run their text through
 * `redact()`. A leak therefore requires bypassing all three, not merely
 * forgetting a `console.log`.
 */

export const REDACTED = "[redacted]";

/**
 * Values shorter than this are not registered. A four-character "secret" would
 * scrub innocuous substrings out of unrelated prose (and any real secret this
 * short is not a secret), so the guard protects the output, not the value.
 */
const MIN_REGISTERED_LENGTH = 8;

/**
 * Forms a registered value can take by the time it reaches an output sink.
 * A PEM inside a JSON journal is newline-escaped; a value in a URL is
 * percent-encoded. Scrubbing only the raw form would miss both.
 */
function variantsOf(value: string): string[] {
  const variants = new Set<string>([value]);
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  variants.add(jsonEscaped);
  try {
    variants.add(encodeURIComponent(value));
  } catch {
    // Lone surrogates cannot be percent-encoded; the raw form still covers it.
  }
  variants.add(Buffer.from(value, "utf8").toString("base64"));
  return [...variants].filter((variant) => variant.length >= MIN_REGISTERED_LENGTH);
}

export class SecretVault {
  readonly #variants = new Set<string>();
  readonly #names = new Set<string>();

  /**
   * Registers `value` for redaction and returns it unchanged, so a call site
   * can wrap the expression that produces the secret:
   * `vault.register("SESSION_SECRET", generate())`.
   */
  register(name: string, value: string): string {
    this.#names.add(name);
    if (value.length >= MIN_REGISTERED_LENGTH) {
      for (const variant of variantsOf(value)) {
        this.#variants.add(variant);
      }
    }
    return value;
  }

  /** Names of secrets that have been set — the only thing the journal records. */
  names(): string[] {
    return [...this.#names].sort();
  }

  /** True when `name` has been registered (used for idempotent re-runs). */
  hasName(name: string): boolean {
    return this.#names.has(name);
  }

  /**
   * Replaces every registered value with `[redacted]`. Longest-first so a
   * secret that contains another registered value is scrubbed whole rather
   * than leaving a partially-redacted remnant.
   */
  redact(text: string): string {
    if (this.#variants.size === 0) {
      return text;
    }
    let result = text;
    const ordered = [...this.#variants].sort((a, b) => b.length - a.length);
    for (const variant of ordered) {
      if (result.includes(variant)) {
        result = result.split(variant).join(REDACTED);
      }
    }
    return result;
  }

  /** True when `text` still contains a registered value. For tests and asserts. */
  leaks(text: string): boolean {
    for (const variant of this.#variants) {
      if (text.includes(variant)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Environment variables that carry a credential, and which therefore have to
 * be registered before any of them can be echoed back at the author.
 *
 * These are not values the wizard *asks* for, which is exactly why they were
 * missed: `CLOUDFLARE_API_TOKEN` is read straight out of the environment, and
 * `NodeProcessRunner` spreads the whole environment into every child process.
 * A failing `wrangler deploy` that mentions its own token in the last ten lines
 * of stderr has those lines quoted into a `WizardError` and printed — verbatim,
 * because the vault was never told the value was a secret.
 *
 * The vault's guarantee only ever covered secrets it was told about, so the
 * fix is to tell it about these at startup rather than to add another sink.
 */
export const CREDENTIAL_ENV_VARS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
] as const;

/**
 * Registers every credential-bearing environment variable that is actually
 * set. Returns the names registered, which is what a test can assert against.
 */
export function registerEnvironmentCredentials(
  vault: SecretVault,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const registered: string[] = [];
  for (const name of CREDENTIAL_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value.length > 0) {
      vault.register(name, value);
      registered.push(name);
    }
  }
  return registered;
}

/**
 * Renders an unknown thrown value as a redacted, human-readable string.
 * Stack traces are deliberately dropped: contract §5 requires "a
 * human-readable failure message naming the next action, never a bare stack
 * trace", and a stack can carry a secret that appeared as a call argument.
 */
export function redactError(vault: SecretVault, error: unknown): string {
  if (error instanceof Error) {
    return vault.redact(error.message);
  }
  return vault.redact(String(error));
}
