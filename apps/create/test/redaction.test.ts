/**
 * Redaction (Phase 6 contract §2.3, §6, exit criterion 6): a property test
 * asserting no secret value ever reaches stdout, the journal, or an error
 * message.
 *
 * "Property test" here means generated inputs rather than chosen ones: secrets
 * are drawn from a seeded generator across the shapes real credentials take -
 * base64, hex, PEM blocks with newlines, values containing quotes and regex
 * metacharacters - and every sink is checked for every one of them. Chosen
 * examples would only ever prove that the examples are handled.
 */
import { describe, expect, it } from "vitest";
import { REDACTED, SecretVault, redactError } from "../src/secrets.js";
import { Journal } from "../src/journal.js";
import { Reporter } from "../src/ui/reporter.js";
import { WizardError } from "../src/errors.js";
import { CollectingOutput, MemoryFileSystem, SeededRandom, fakeEnvironment } from "./fakes.js";
import { themeFor } from "../src/ui/reporter.js";

const NOW = "2026-07-20T12:00:00.000Z";

/** Deterministic generator over the shapes credentials actually take. */
function* generateSecrets(count: number): Generator<string> {
  const random = new SeededRandom(0xdeadbeefn);
  const shapes = [
    // base64, as `wrangler secret` values and SESSION_SECRET are
    () => Buffer.from(random.bytes(48)).toString("base64"),
    // base64url, as the wizard's own tokens are
    () => Buffer.from(random.bytes(32)).toString("base64url"),
    // hex, as a Cloudflare token looks
    () => Buffer.from(random.bytes(24)).toString("hex"),
    // a PEM: multi-line, with the newlines that JSON escaping mangles
    () =>
      `-----BEGIN PRIVATE KEY-----\n${Buffer.from(random.bytes(64)).toString("base64")}\n${Buffer.from(
        random.bytes(64),
      ).toString("base64")}\n-----END PRIVATE KEY-----\n`,
    // regex and JSON metacharacters, which a naive replace would break on
    () => `s3cret"${Buffer.from(random.bytes(8)).toString("hex")}"\\.*+?[]{}()|^$`,
    // a value containing a newline and a tab
    () => `line1\tvalue-${Buffer.from(random.bytes(12)).toString("hex")}\nline2`,
    // a long GitHub-style token
    () => `ghs_${Buffer.from(random.bytes(30)).toString("base64url")}`,
  ];
  for (let index = 0; index < count; index += 1) {
    const shape = shapes[index % shapes.length];
    yield shape === undefined ? "fallback-secret-value" : shape();
  }
}

describe("SecretVault", () => {
  it("scrubs every generated secret from arbitrary surrounding text", () => {
    for (const secret of generateSecrets(140)) {
      const vault = new SecretVault();
      vault.register("TEST_SECRET", secret);
      const surrounded = `before ${secret} after`;
      const redacted = vault.redact(surrounded);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain(REDACTED);
      expect(vault.leaks(redacted)).toBe(false);
    }
  });

  it("scrubs the JSON-escaped form, which is how a PEM reaches a journal", () => {
    for (const secret of generateSecrets(70)) {
      const vault = new SecretVault();
      vault.register("TEST_SECRET", secret);
      const serialized = JSON.stringify({ oops: secret });
      expect(vault.redact(serialized)).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
  });

  it("scrubs the percent-encoded form, which is how one reaches a URL", () => {
    for (const secret of generateSecrets(70)) {
      const vault = new SecretVault();
      vault.register("TEST_SECRET", secret);
      const url = `https://example.com/?t=${encodeURIComponent(secret)}`;
      expect(vault.redact(url)).not.toContain(encodeURIComponent(secret));
    }
  });

  it("leaves unrelated text untouched", () => {
    const vault = new SecretVault();
    vault.register("TEST_SECRET", "a-very-long-secret-value-here");
    expect(vault.redact("nothing to see")).toBe("nothing to see");
  });

  it("records names without values, which is all the journal ever learns", () => {
    const vault = new SecretVault();
    vault.register("SESSION_SECRET", "the-actual-value-goes-here");
    expect(vault.names()).toEqual(["SESSION_SECRET"]);
    expect(JSON.stringify(vault.names())).not.toContain("the-actual-value");
  });

  it("scrubs a secret that contains another registered secret, whole", () => {
    const vault = new SecretVault();
    const inner = "inner-secret-value-1234";
    const outer = `prefix-${inner}-suffix`;
    vault.register("INNER", inner);
    vault.register("OUTER", outer);
    const redacted = vault.redact(`text ${outer} text`);
    expect(redacted).not.toContain(inner);
    expect(redacted).toBe(`text ${REDACTED} text`);
  });
});

describe("no secret reaches any sink", () => {
  it("never reaches stdout or stderr through the reporter", () => {
    for (const secret of generateSecrets(70)) {
      const vault = new SecretVault();
      const out = new CollectingOutput();
      const reporter = new Reporter(out, vault, themeFor(fakeEnvironment()));
      vault.register("TEST_SECRET", secret);

      // Every method that can print, fed the secret directly. If any of them
      // bypassed the vault this would catch it.
      reporter.explain(`the value is ${secret}`);
      reporter.step(`step with ${secret}`);
      reporter.ok(`ok ${secret}`);
      reporter.warn(`warn ${secret}`);
      reporter.fail(`fail ${secret}`);
      reporter.info(`info ${secret}`);
      reporter.bullet(`bullet ${secret}`);
      reporter.literal(secret);
      reporter.heading(`heading ${secret}`);
      reporter.problem(`problem ${secret}`, `advice ${secret}`);

      expect(vault.leaks(out.all())).toBe(false);
    }
  });

  it("never reaches the journal on disk", async () => {
    for (const secret of generateSecrets(50)) {
      const vault = new SecretVault();
      const fs = new MemoryFileSystem();
      const journal = await Journal.open({
        fs,
        vault,
        directory: "/book",
        now: NOW,
        readOnly: false,
      });
      vault.register("SESSION_SECRET", secret);

      // The journal's own API cannot carry a value, so the leak is simulated
      // the only way it could really happen: a field somebody added later.
      await journal.recordSecret("SESSION_SECRET", NOW);
      await journal.markStage("collaborate", "failed", NOW, `failed while setting ${secret}`);
      await journal.update((data) => {
        (data as unknown as Record<string, unknown>)["accident"] = secret;
        data.book = { title: `A book ${secret}`, slug: "s" };
      }, NOW);

      const written = fs.files.get("/book/.authorbot-setup.json") ?? "";
      expect(written.length).toBeGreaterThan(0);
      expect(vault.leaks(written)).toBe(false);
      expect(written).toContain("SESSION_SECRET");
      expect(vault.leaks(fs.everything())).toBe(false);
    }
  });

  it("never reaches an error message", () => {
    for (const secret of generateSecrets(70)) {
      const vault = new SecretVault();
      vault.register("TEST_SECRET", secret);

      expect(vault.leaks(redactError(vault, new Error(`boom: ${secret}`)))).toBe(false);
      expect(vault.leaks(redactError(vault, secret))).toBe(false);
      expect(
        vault.leaks(redactError(vault, new WizardError(`bad ${secret}`, `fix ${secret}`))),
      ).toBe(false);

      const out = new CollectingOutput();
      const reporter = new Reporter(out, vault, themeFor(fakeEnvironment()));
      const error = new WizardError(`failed with ${secret}`, `retry with ${secret}`);
      reporter.problem(error.message, error.nextAction);
      expect(vault.leaks(out.all())).toBe(false);
    }
  });

  it("scrubs a secret registered after the text was composed but before it printed", () => {
    // The realistic ordering hazard: a message is built, then the secret is
    // registered, then the message prints. Redaction at the sink covers it;
    // redaction at composition time would not.
    const vault = new SecretVault();
    const out = new CollectingOutput();
    const reporter = new Reporter(out, vault, themeFor(fakeEnvironment()));
    const secret = "registered-after-composition-1234567";
    const message = `value: ${secret}`;
    vault.register("LATE", secret);
    reporter.info(message);
    expect(vault.leaks(out.all())).toBe(false);
  });
});
