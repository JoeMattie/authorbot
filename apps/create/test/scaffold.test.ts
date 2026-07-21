/**
 * The generated book, and its agreement with `templates/book-repo`.
 *
 * The drift test matters more than it looks: the wizard embeds copies of the
 * template because the published package has no `templates/` directory
 * (ADR-0022). Embedded copies rot silently, so the suite asserts they are
 * byte-identical to the originals — an edit to either side without the other
 * fails here rather than in an author's repository.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bookConfigSchema } from "@authorbot/schemas";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_LICENSE,
  TOOLCHAIN_VERSION,
  assertBookYmlValid,
  renderBookYml,
  renderPackageJson,
  renderReadme,
  scaffoldFiles,
  type BookIdentity,
} from "../src/scaffold/render.js";
import { renderWrangler } from "../src/scaffold/wrangler.js";
import { KEEP_DIRECTORIES, STATIC_TEMPLATE_FILES } from "../src/scaffold/static-files.js";
import { uuidv7 } from "../src/ids.js";
import { FakeClock, SeededRandom } from "./fakes.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const templateDir = path.join(repoRoot, "templates/book-repo");

const identity: BookIdentity = {
  title: "The Hollow Creek Anomaly",
  slug: "hollow-creek-anomaly",
  id: uuidv7(new FakeClock(), new SeededRandom()),
  workerName: "hollow-creek-anomaly",
  authorLogin: "novelist",
};

describe("template drift", () => {
  it.each(Object.keys(STATIC_TEMPLATE_FILES))(
    "%s is byte-identical to templates/book-repo",
    async (relative) => {
      const onDisk = await readFile(path.join(templateDir, relative), "utf8");
      expect(STATIC_TEMPLATE_FILES[relative]).toBe(onDisk);
    },
  );

  it("pins the same @authorbot/cli version the template does", async () => {
    const templatePackage = JSON.parse(
      await readFile(path.join(templateDir, "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    expect(templatePackage.devDependencies?.["@authorbot/cli"]).toBe(TOOLCHAIN_VERSION);
  });

  it("pins the version this package itself ships as", async () => {
    const own = JSON.parse(
      await readFile(path.join(repoRoot, "apps/create/package.json"), "utf8"),
    ) as { version: string };
    // The wizard and the toolchain it pins are released together; a mismatch
    // means a generated book would be built by a different version than the
    // one that generated it.
    expect(own.version).toBe(TOOLCHAIN_VERSION);
  });
});

describe("book.yml", () => {
  it("passes the Authorbot book schema", () => {
    const text = renderBookYml(identity);
    const parsed = parseYaml(text);
    expect(bookConfigSchema.safeParse(parsed).success).toBe(true);
    expect(() => {
      assertBookYmlValid(text);
    }).not.toThrow();
  });

  it("carries a real UUIDv7 and the author's choices", () => {
    const parsed = parseYaml(renderBookYml(identity)) as Record<string, unknown>;
    expect(parsed["id"]).toBe(identity.id);
    expect(parsed["title"]).toBe(identity.title);
    expect(parsed["slug"]).toBe(identity.slug);
    expect(parsed["license"]).toBe(DEFAULT_LICENSE);
  });

  it("survives a title containing YAML metacharacters", () => {
    const awkward = [
      'Title: with a colon and "quotes"',
      "#starts-with-a-hash",
      "- starts with a dash",
      "{braces} [brackets] &anchor *alias",
      "trailing space ",
      "multi\nline",
      "emoji 🎭 and ünïcödé",
    ];
    for (const title of awkward) {
      const text = renderBookYml({ ...identity, title });
      const parsed = parseYaml(text) as Record<string, unknown>;
      expect(parsed["title"]).toBe(title);
      expect(bookConfigSchema.safeParse(parsed).success).toBe(true);
    }
  });

  it("has no api_url until collaboration is switched on", () => {
    // The switch that makes sign-in controls appear stays off until the API
    // has been verified healthy; a book born with it on would ship buttons
    // that lead nowhere.
    const parsed = parseYaml(renderBookYml(identity)) as {
      publication?: Record<string, unknown>;
    };
    expect(parsed.publication?.["api_url"]).toBeUndefined();
  });
});

describe("the scaffold as a whole", () => {
  const files = scaffoldFiles(identity);
  const names = files.map((file) => file.path);

  it("writes exactly the files the template describes, and nothing else", () => {
    expect(names).toContain("book.yml");
    expect(names).toContain("package.json");
    expect(names).toContain("wrangler.jsonc");
    expect(names).toContain("README.md");
    expect(names).toContain(".gitignore");
    for (const relative of Object.keys(STATIC_TEMPLATE_FILES)) {
      expect(names).toContain(relative);
    }
    for (const directory of KEEP_DIRECTORIES) {
      expect(names).toContain(`${directory}/.gitkeep`);
    }
  });

  it("contains no chapters and no sample prose, which is the point", () => {
    // Contract §3.2: "No chapters, and no sample content." A chapterless book
    // is a first-class state, and an author's first act must not be editing
    // frontmatter by hand.
    expect(names.filter((name) => name.startsWith("chapters/") && name.endsWith(".md"))).toEqual([]);
    expect(names.filter((name) => name.startsWith("story/characters/") && name.endsWith(".md"))).toEqual(
      [],
    );
    const outline = parseYaml(STATIC_TEMPLATE_FILES["story/outline.yml"] ?? "") as {
      nodes?: unknown[];
    };
    const timeline = parseYaml(STATIC_TEMPLATE_FILES["story/timeline.yml"] ?? "") as {
      events?: unknown[];
    };
    expect(outline.nodes).toEqual([]);
    expect(timeline.events).toEqual([]);
  });

  it("gitignores the setup journal, so progress state never lands in Git", () => {
    expect(STATIC_TEMPLATE_FILES[".gitignore"]).toContain(".authorbot-setup.json");
  });

  it("gives every file a plain-language purpose for the dry-run plan", () => {
    for (const file of files) {
      expect(file.purpose.length).toBeGreaterThan(0);
      expect(file.purpose).not.toMatch(/D1|UUIDv7|provision/);
    }
  });

  it("is deterministic: the same identity produces the same bytes", () => {
    expect(scaffoldFiles(identity)).toEqual(scaffoldFiles(identity));
  });
});

describe("package.json", () => {
  it("is valid JSON naming the book and pinning the toolchain", () => {
    const parsed = JSON.parse(renderPackageJson(identity)) as {
      name: string;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(parsed.name).toBe(identity.slug);
    expect(parsed.devDependencies["@authorbot/cli"]).toBe(TOOLCHAIN_VERSION);
    expect(parsed.scripts["validate"]).toBe("authorbot validate .");
  });
});

describe("wrangler.jsonc", () => {
  it("starts as a static site with no database and no API", () => {
    const text = renderWrangler({ workerName: "my-book" });
    expect(text).toContain('"name": "my-book"');
    expect(text).toContain('"directory": "./_site"');
    expect(text).not.toContain("d1_databases");
    expect(text).not.toContain('"main"');
  });

  it("never contains a secret, only the public client id", () => {
    const text = renderWrangler({
      workerName: "my-book",
      collaboration: {
        d1Name: "db",
        d1Id: "11111111-2222-4333-8444-555555555555",
        projectSlug: "my-book",
        projectRepo: "novelist/my-book",
        maintainerLogin: "novelist",
        defaultBranch: "main",
        githubClientId: "Iv1.public_client_id",
        redirectUri: "https://my-book.workers.dev/v1/auth/github/callback",
        installationId: "777777",
      publicAnnotations: true,
      },
    });
    for (const secretName of [
      "GITHUB_CLIENT_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "SESSION_SECRET",
      "WEBHOOK_SECRET",
    ]) {
      expect(text).not.toContain(`"${secretName}"`);
    }
    expect(text).toContain('"GITHUB_CLIENT_ID": "Iv1.public_client_id"');
  });

  it("upgrades in place: same worker name, same origin, API added", () => {
    const collaboration = {
      d1Name: "db",
      d1Id: "11111111-2222-4333-8444-555555555555",
      projectSlug: "my-book",
      projectRepo: "novelist/my-book",
      maintainerLogin: "novelist",
      defaultBranch: "main",
      githubClientId: "Iv1.x",
      redirectUri: "https://my-book.workers.dev/v1/auth/github/callback",
      installationId: "777777",
      publicAnnotations: true,
    };
    const text = renderWrangler({ workerName: "my-book", collaboration });
    expect(text).toContain('"name": "my-book"');
    expect(text).toContain("node_modules/@authorbot/api/dist/worker.js");
    expect(text).toContain("node_modules/@authorbot/api/migrations");
    expect(text).toContain('"AUTH_MODE": "github"');
    expect(text).toContain('"MIRROR_MODE": "durable"');
    expect(text).toContain('"INITIAL_MAINTAINER": "github:novelist"');
    expect(text).toContain("ProjectCoordinator");
    // The callback must be on the site's own origin (ADR-0019).
    expect(text).toContain('"GITHUB_REDIRECT_URI": "https://my-book.workers.dev/v1/auth/github/callback"');
  });

  it("mirrors show_public_annotations into the Worker's PUBLIC_ANNOTATIONS", () => {
    // One decision, two places. The book saying annotations are public while
    // the Worker was never told produced a site that rendered the whole
    // collaboration UI over an API that refused every anonymous read with a
    // 401 — so a visitor saw no annotations and no sign-in link either,
    // because the island gives up when its first read fails.
    const base = {
      d1Name: "db",
      d1Id: "11111111-2222-4333-8444-555555555555",
      projectSlug: "my-book",
      projectRepo: "novelist/my-book",
      maintainerLogin: "novelist",
      defaultBranch: "main",
      githubClientId: "Iv1.x",
      redirectUri: "https://my-book.workers.dev/v1/auth/github/callback",
      installationId: "777777",
    };

    const open = renderWrangler({
      workerName: "my-book",
      collaboration: { ...base, publicAnnotations: true },
    });
    expect(open).toContain('"PUBLIC_ANNOTATIONS": "true"');

    const closed = renderWrangler({
      workerName: "my-book",
      collaboration: { ...base, publicAnnotations: false },
    });
    expect(closed).toContain('"PUBLIC_ANNOTATIONS": "false"');
  });

  it("emits valid JSONC: strips to parseable JSON", () => {
    const withEverything = renderWrangler({
      workerName: "my-book",
      customDomain: "book.example.com",
      collaboration: {
        d1Name: "db",
        d1Id: "11111111-2222-4333-8444-555555555555",
        projectSlug: "my-book",
        projectRepo: "novelist/my-book",
        maintainerLogin: "novelist",
        defaultBranch: "main",
        githubClientId: "Iv1.x",
        redirectUri: "https://book.example.com/v1/auth/github/callback",
        installationId: "777777",
      publicAnnotations: true,
        basePath: "/my-book",
      },
    });
    expect(() => JSON.parse(stripComments(withEverything))).not.toThrow();
    const parsed = JSON.parse(stripComments(withEverything)) as Record<string, unknown>;
    expect(parsed["routes"]).toEqual([{ pattern: "book.example.com", custom_domain: true }]);
    expect((parsed["vars"] as Record<string, unknown>)["API_BASE_PATH"]).toBe("/my-book");
  });

  it("emits valid JSONC in the static-only shape too", () => {
    expect(() => JSON.parse(stripComments(renderWrangler({ workerName: "my-book" })))).not.toThrow();
  });
});

describe("README", () => {
  it("tells the author how to write chapter one without hand-writing a UUID", () => {
    const text = renderReadme(identity);
    expect(text).toContain(identity.title);
    expect(text).toContain("New chapter");
    expect(text).toContain("@novelist");
  });
});

/** Line comments only — which is all `renderWrangler` emits. */
function stripComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}
