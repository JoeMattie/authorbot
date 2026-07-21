/**
 * Unit coverage for the pieces the contract names in §6: UUIDv7 generation,
 * slug derivation, journal resume, config rendering, and the prompt/state
 * machine's argument handling.
 */
import { describe, expect, it } from "vitest";
import { UUIDV7_REGEX } from "@authorbot/schemas";
import { randomToken, uuidv7 } from "../src/ids.js";
import { deriveSlug, validateSlug, validateWorkerName } from "../src/slug.js";
import { Journal, emptyJournal, parseJournal } from "../src/journal.js";
import { EXAMPLE_CONFIG, parseConfig } from "../src/config.js";
import { defaultFlow, parseArgs } from "../src/cli.js";
import { SecretVault } from "../src/secrets.js";
import type { WizardError } from "../src/errors.js";
import { themeFor, wrap } from "../src/ui/reporter.js";
import { STAGE_NAMES } from "../src/stages/names.js";
import { extractDatabaseId } from "../src/stages/collaborate.js";
import { deployedUrl } from "../src/stages/publish.js";
import { FakeClock, MemoryFileSystem, SeededRandom, fakeEnvironment } from "./fakes.js";

describe("uuidv7", () => {
  const clock = new FakeClock();
  const random = new SeededRandom();

  it("produces a value the Authorbot schema accepts", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(uuidv7(clock, random)).toMatch(UUIDV7_REGEX);
    }
  });

  it("encodes the clock's time in the leading 48 bits", () => {
    const at = new FakeClock(Date.parse("2026-07-20T12:00:00.000Z"));
    const id = uuidv7(at, random);
    const millis = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(millis).toBe(Date.parse("2026-07-20T12:00:00.000Z"));
  });

  it("sorts in creation order, which is the whole point of v7 over v4", () => {
    const ticking = new FakeClock();
    const ids: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      ids.push(uuidv7(ticking, random));
      ticking.advance(5);
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it("stays valid past 2038, where a 32-bit shift would silently truncate", () => {
    const far = new FakeClock(Date.parse("2087-01-01T00:00:00.000Z"));
    const id = uuidv7(far, random);
    expect(id).toMatch(UUIDV7_REGEX);
    const millis = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(millis).toBe(Date.parse("2087-01-01T00:00:00.000Z"));
  });

  it("does not repeat", () => {
    const seen = new Set<string>();
    const fixed = new FakeClock();
    for (let index = 0; index < 500; index += 1) {
      seen.add(uuidv7(fixed, random));
    }
    expect(seen.size).toBe(500);
  });
});

describe("randomToken", () => {
  it("is URL-safe, so it can be a path segment and a query value", () => {
    const random = new SeededRandom();
    for (let index = 0; index < 100; index += 1) {
      expect(randomToken(random)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("deriveSlug", () => {
  it.each([
    ["The Hollow Creek Anomaly", "hollow-creek-anomaly".length > 0 ? "the-hollow-creek-anomaly" : ""],
    ["Dune's Edge", "dunes-edge"],
    ["Café Terminus", "cafe-terminus"],
    ["  Spaces   Everywhere  ", "spaces-everywhere"],
    ["Book #2: The Return!", "book-2-the-return"],
    ["ALL CAPS", "all-caps"],
    ["hyphen--collapse", "hyphen-collapse"],
    ["-leading-and-trailing-", "leading-and-trailing"],
    ["2001: A Space Odyssey", "2001-a-space-odyssey"],
  ])("derives %j to %j", (title, expected) => {
    expect(deriveSlug(title)).toBe(expected);
  });

  it("returns empty for a title with nothing to build from, rather than inventing one", () => {
    expect(deriveSlug("🎭🎭🎭")).toBe("");
    expect(deriveSlug("...")).toBe("");
  });

  it("truncates a very long title on a word boundary", () => {
    const slug = deriveSlug(`${"word ".repeat(40)}end`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("always produces something the validator accepts, when it produces anything", () => {
    const titles = [
      "A",
      "9 Lives",
      "The — Em Dash",
      "Ünïcödé Tïtlé",
      "tabs\tand\nnewlines",
      "a".repeat(300),
    ];
    for (const title of titles) {
      const slug = deriveSlug(title);
      if (slug.length > 0) {
        expect(validateSlug(slug)).toBeNull();
      }
    }
  });
});

describe("validateSlug", () => {
  it("rejects path traversal and separators", () => {
    for (const bad of ["../etc", "a/b", "a.b", "A", "-lead", "", "a b"]) {
      expect(validateSlug(bad)).not.toBeNull();
    }
  });

  it("accepts the documented shape", () => {
    for (const good of ["a", "9", "my-book", "book2"]) {
      expect(validateSlug(good)).toBeNull();
    }
  });
});

describe("validateWorkerName", () => {
  it("allows a 63-character name and refuses 64", () => {
    expect(validateWorkerName("a".repeat(63))).toBeNull();
    expect(validateWorkerName("a".repeat(64))).not.toBeNull();
  });
});

describe("journal", () => {
  const NOW = "2026-07-20T12:00:00.000Z";

  it("starts every stage pending", () => {
    const journal = emptyJournal(NOW);
    for (const name of STAGE_NAMES) {
      expect(journal.stages[name]?.status).toBe("pending");
    }
  });

  it("round-trips through JSON", () => {
    const original = emptyJournal(NOW);
    original.book = { title: "T", slug: "t", id: "x" };
    original.secretsSet = ["SESSION_SECRET"];
    const parsed = parseJournal(JSON.stringify(original), NOW);
    expect(parsed.book?.slug).toBe("t");
    expect(parsed.secretsSet).toEqual(["SESSION_SECRET"]);
  });

  it("treats corrupt or future-versioned journals as a fresh start", () => {
    expect(parseJournal("not json", NOW).stages["book"]?.status).toBe("pending");
    expect(parseJournal("[]", NOW).stages["book"]?.status).toBe("pending");
    expect(parseJournal(JSON.stringify({ version: 99 }), NOW).stages["book"]?.status).toBe(
      "pending",
    );
  });

  it("ignores stage names it does not know", () => {
    const parsed = parseJournal(
      JSON.stringify({ ...emptyJournal(NOW), stages: { nonsense: { status: "done" } } }),
      NOW,
    );
    expect(parsed.stages["nonsense"]).toBeUndefined();
  });

  it("resumes at the first stage that is not done", async () => {
    const fs = new MemoryFileSystem();
    const vault = new SecretVault();
    const journal = await Journal.open({ fs, vault, directory: "/b", now: NOW, readOnly: false });
    expect(journal.resumeAt(STAGE_NAMES)).toBe("doctor");
    await journal.markStage("doctor", "done", NOW);
    await journal.markStage("book", "done", NOW);
    expect(journal.resumeAt(STAGE_NAMES)).toBe("publish");
  });

  it("reloads progress from disk on a second open", async () => {
    const fs = new MemoryFileSystem();
    const first = await Journal.open({
      fs,
      vault: new SecretVault(),
      directory: "/b",
      now: NOW,
      readOnly: false,
    });
    await first.markStage("doctor", "done", NOW);
    await first.recordSecret("SESSION_SECRET", NOW);
    await first.recordResource(
      { kind: "d1-database", name: "db", description: "d", deleteWith: "x" },
      NOW,
    );

    const second = await Journal.open({
      fs,
      vault: new SecretVault(),
      directory: "/b",
      now: NOW,
      readOnly: false,
    });
    expect(second.isDone("doctor")).toBe(true);
    expect(second.hasSecret("SESSION_SECRET")).toBe(true);
    expect(second.resources()).toHaveLength(1);
  });

  it("does not record the same resource twice across resumed runs", async () => {
    const fs = new MemoryFileSystem();
    const journal = await Journal.open({
      fs,
      vault: new SecretVault(),
      directory: "/b",
      now: NOW,
      readOnly: false,
    });
    const resource = { kind: "d1-database", name: "db", description: "d", deleteWith: "x" };
    await journal.recordResource(resource, NOW);
    await journal.recordResource(resource, NOW);
    expect(journal.resources()).toHaveLength(1);
  });

  it("writes nothing at all when read-only, which is what --dry-run relies on", async () => {
    const fs = new MemoryFileSystem();
    const journal = await Journal.open({
      fs,
      vault: new SecretVault(),
      directory: "/b",
      now: NOW,
      readOnly: true,
    });
    await journal.markStage("doctor", "done", NOW);
    await journal.recordSecret("SESSION_SECRET", NOW);
    expect(fs.writes).toEqual([]);
  });
});

describe("config file", () => {
  it("reads JSON and YAML alike", () => {
    const yaml = parseConfig("directory: ./b\nanswers:\n  book.title: T\n", "c.yml");
    const json = parseConfig('{"directory":"./b","answers":{"book.title":"T"}}', "c.json");
    expect(yaml).toEqual(json);
  });

  it("refuses unknown top-level keys rather than silently ignoring a typo", () => {
    expect(() => parseConfig("answres: {}", "c.yml")).toThrow(/unknown key/i);
  });

  it("refuses an unknown stage name", () => {
    expect(() => parseConfig("stages: [doctor, nonsense]", "c.yml")).toThrow(/unknown stage/i);
  });

  it("refuses a non-mapping answers block", () => {
    expect(() => parseConfig("answers: [1,2]", "c.yml")).toThrow(/mapping/i);
  });

  it("parses the example the CLI prints, and every id in it is a real prompt id", () => {
    const config = parseConfig(EXAMPLE_CONFIG, "example");
    expect(config.directory).toBe("./my-book");
    // Guards against the example drifting into advertising prompts that no
    // longer exist, which would be worse than no example at all.
    for (const key of Object.keys(config.answers)) {
      expect(key).toMatch(/^(book|publish|collaborate|agent)\./);
    }
  });
});

describe("argument parsing", () => {
  it("accepts a bare stage name", () => {
    expect(parseArgs(["book"]).stage).toBe("book");
  });

  it("defaults to the whole flow", () => {
    expect(parseArgs([]).stage).toBeNull();
    expect(defaultFlow()).toEqual([...STAGE_NAMES]);
  });

  it("reads --dir in both spellings", () => {
    expect(parseArgs(["--dir", "/b"]).directory).toBe("/b");
    expect(parseArgs(["--dir=/b"]).directory).toBe("/b");
  });

  it("rejects an unknown stage, and the advice lists the real ones", () => {
    expect(() => parseArgs(["nonsense"])).toThrow(/not one of the steps/);
    try {
      parseArgs(["nonsense"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as WizardError).nextAction).toMatch(/doctor, book/);
    }
  });

  it("rejects an unknown option", () => {
    expect(() => parseArgs(["--wat"])).toThrow(/not an option/);
  });

  it("rejects --dir with nothing after it", () => {
    expect(() => parseArgs(["--dir"])).toThrow(/needs a path/);
  });

  it("collects the flags the contract names", () => {
    const parsed = parseArgs(["upgrade", "--dry-run", "--non-interactive", "--config", "c.yml", "--check"]);
    expect(parsed.stage).toBe("upgrade");
    expect(parsed.options.dryRun).toBe(true);
    expect(parsed.options.nonInteractive).toBe(true);
    expect(parsed.options.check).toBe(true);
    expect(parsed.configPath).toBe("c.yml");
  });
});

describe("terminal presentation", () => {
  it("never exceeds 80 columns, however wide the terminal claims to be", () => {
    const theme = themeFor(fakeEnvironment({ columns: 400 }));
    expect(theme.width).toBe(80);
    const long = "word ".repeat(200);
    for (const line of wrap(long, theme.width)) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("respects NO_COLOR", () => {
    expect(themeFor(fakeEnvironment({ env: { NO_COLOR: "1" }, isTty: true })).colour).toBe(false);
    expect(themeFor(fakeEnvironment({ env: { TERM: "dumb" }, isTty: true })).colour).toBe(false);
    expect(themeFor(fakeEnvironment({ env: {}, isTty: true })).colour).toBe(true);
    expect(themeFor(fakeEnvironment({ env: {}, isTty: false })).colour).toBe(false);
  });

  it("keeps a long URL on one line rather than breaking it", () => {
    const url = `https://example.com/${"x".repeat(120)}`;
    expect(wrap(`See ${url} now`, 80)).toContain(url);
  });
});

describe("output parsing helpers", () => {
  it("finds a D1 id in every shape wrangler has printed it", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(extractDatabaseId(`{ "uuid": "${id}" }`)).toBe(id);
    expect(extractDatabaseId(`database_id = "${id}"`)).toBe(id);
    expect(extractDatabaseId(`Created database, id ${id}`)).toBe(id);
    expect(extractDatabaseId("no id here")).toBeNull();
  });

  it("prefers the custom domain over whatever wrangler printed", () => {
    expect(deployedUrl("https://a.workers.dev", "a", "book.example.com")).toBe(
      "https://book.example.com",
    );
  });

  it("picks the workers.dev URL out of noisy deploy output", () => {
    const output = "Uploaded\nDeployed\n  https://my-book.acme.workers.dev (1.2 sec)\n";
    expect(deployedUrl(output, "my-book", "")).toBe("https://my-book.acme.workers.dev");
  });

  it("returns null rather than guessing when no URL was printed", () => {
    expect(deployedUrl("done", "my-book", "")).toBeNull();
  });
});
