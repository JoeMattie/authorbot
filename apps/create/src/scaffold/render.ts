/**
 * Rendering the per-book files (Phase 6 contract §3.2).
 *
 * Four files carry the book's identity and so cannot be copied verbatim:
 * `book.yml`, `package.json`, `wrangler.jsonc`, and `README.md`. Everything
 * else is a byte-for-byte copy of `templates/book-repo` (see
 * `static-files.ts`).
 *
 * The contract's "no chapters, and no sample content" is a property of this
 * module: it emits an empty `chapters/`, an empty outline, and an empty
 * timeline. A chapterless book is a first-class state that validates, builds,
 * and publishes, and the author's first chapter comes from the site's "New
 * chapter" button rather than from hand-written frontmatter.
 */
import { bookConfigSchema } from "@authorbot/schemas";
import { parse as parseYaml } from "yaml";
import { WizardError } from "../errors.js";
import { KEEP_DIRECTORIES, STATIC_TEMPLATE_FILES } from "./static-files.js";
import { renderWrangler } from "./wrangler.js";

/**
 * The `@authorbot/cli` version generated books pin (ADR-0022). It is a
 * constant rather than a lookup so the pin is visible in a diff; a test
 * asserts it matches this package's own version, because the wizard and the
 * toolchain it pins are released together.
 */
export const TOOLCHAIN_VERSION = "0.1.11";

/** Contract §3.2: "license defaults to CC-BY-NC-4.0 and is changed in settings". */
export const DEFAULT_LICENSE = "CC-BY-NC-4.0";
export const DEFAULT_LANGUAGE = "en-US";
export const DEFAULT_BRANCH = "main";

export interface BookIdentity {
  readonly title: string;
  readonly slug: string;
  readonly id: string;
  /** Cloudflare Worker name; defaults to the slug. */
  readonly workerName: string;
  /** From the authenticated `gh` account (contract §3.2), or undefined. */
  readonly authorLogin?: string;
}

export interface ScaffoldFile {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly contents: string;
  /** Author-facing description, used by `--dry-run` and the step output. */
  readonly purpose: string;
}

/**
 * YAML-quotes a scalar. Titles are author input and may contain colons,
 * quotes, or leading `#` — all of which change the meaning of an unquoted
 * YAML scalar. Double quotes with escaping is the one form that is safe for
 * every string.
 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function renderBookYml(identity: BookIdentity): string {
  return `# Authorbot book configuration (schema: authorbot.book/v1).
#
# \`id\` is this book's permanent identity — a lowercase UUIDv7, generated once
# when the book was created. Never change it; records elsewhere refer to it.
#
# Title, language, license, and the publication display options below are all
# editable from the Settings view on your own site once collaboration is
# switched on, where each change lands as an ordinary reviewed commit to this
# file. There is no second configuration store.
schema: authorbot.book/v1
id: ${identity.id}
title: ${yamlString(identity.title)}
slug: ${identity.slug}
language: ${DEFAULT_LANGUAGE}
license: ${DEFAULT_LICENSE}
repository:
  default_branch: ${DEFAULT_BRANCH}
content:
  chapters_glob: chapters/*.md
  raw_html: false
planning:
  method: custom
  outline: story/outline.yml
  timeline: story/timeline.yml
  characters_glob: story/characters/*.md
publication:
  # Changing \`chapter_url\` or \`slug\` breaks links to chapters you have already
  # published, so both are guarded in the Settings view.
  chapter_url: /chapters/{slug}/
  show_revision: true
  show_attribution: true
  show_public_annotations: true
# Secrets, GitHub App installation IDs, agent tokens, webhook secrets, and
# deployment credentials never belong in this file.
`;
}

export function renderPackageJson(identity: BookIdentity): string {
  // Written by hand rather than JSON.stringify of a literal so the key order
  // is stable and reviewable in a diff.
  return `{
  "name": "${identity.slug}",
  "version": "0.0.0",
  "private": true,
  "description": "An Authorbot book. This file exists only to pin the toolchain; the book itself is the Markdown and YAML around it.",
  "license": "UNLICENSED",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "validate": "authorbot validate .",
    "build": "authorbot build . --out _site",
    "upgrade": "authorbot upgrade"
  },
  "devDependencies": {
    "@authorbot/cli": "${TOOLCHAIN_VERSION}",
    "wrangler": "^4.0.0"
  }
}
`;
}

/**
 * The static-site-only `wrangler.jsonc` a new book starts with. It delegates
 * to the same renderer the `collaborate` stage uses, so the file a book is
 * born with and the file it is upgraded to are produced by one piece of code
 * rather than two that can disagree.
 */
export function renderWranglerJsonc(identity: BookIdentity): string {
  return renderWrangler({ workerName: identity.workerName });
}

export function renderReadme(identity: BookIdentity): string {
  const byline =
    identity.authorLogin === undefined ? "" : `\nWritten by @${identity.authorLogin}.\n`;
  return `# ${identity.title}

An Authorbot book. The prose is Markdown, everything else is YAML, and it all
reads perfectly well without any tooling at all.
${byline}
It has no chapters yet, and that is a normal state rather than a broken one:
it validates, it builds, and the published site says "No chapters published
yet." rather than rendering an empty index.

## Writing your first chapter

Once collaboration is switched on (\`create-authorbot collaborate\`), sign in on
your own site and press **New chapter**. You get a plain title-and-prose
composer; Authorbot generates the frontmatter, the chapter id, and the block
markers, so you never hand-write a UUID. Saving creates a draft, and
publishing it is a separate, deliberate action.

To do it by hand instead, copy a chapter from \`examples/book-repo/chapters/\`
in the Authorbot repository and replace every \`id\` with a fresh UUIDv7.

## Layout

\`\`\`text
book.yml                  this book's identity and settings
chapters/                 one Markdown file per chapter
story/outline.yml         the story graph: premise, parts, scenes
story/timeline.yml        sortable events with human-readable labels
story/characters/         one Markdown file per character
.authorbot/               collaboration records, written by Authorbot
.github/workflows/        validate every change; publish from main
wrangler.jsonc            the Cloudflare Worker that serves the site
package.json              pins the Authorbot toolchain, and nothing else
\`\`\`

## Everyday commands

\`\`\`sh
npm run validate    # check the book against the Authorbot rules
npm run build       # render the site into _site/ (gitignored)
npm run upgrade     # move to a newer Authorbot, as a pull request
\`\`\`

## Things worth knowing

- **IDs are permanent.** \`book.id\`, chapter ids, and block markers are
  lowercase UUIDv7. Generate them once; never edit or reuse one.
- **Changing \`slug\` or \`chapter_url\` breaks existing links** to chapters you
  have already published. Both are guarded in the Settings view.
- **No secrets in this repository.** Deployment credentials are GitHub
  repository secrets; the Worker's own secrets are set with
  \`wrangler secret put\`, which never writes them to disk.
- **Publishing is CI's job.** Pushing to \`main\` validates, builds, and deploys.
  A local \`wrangler deploy\` publishes whatever is in \`_site\` at the time,
  which may be older than what is live.
`;
}

/**
 * Every file the `book` stage writes, in the order it writes them. Returning
 * the whole set as data (rather than writing as we go) is what lets
 * `--dry-run` list the exact file set without a second code path that could
 * disagree with the real one.
 */
export function scaffoldFiles(identity: BookIdentity): ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    {
      path: "book.yml",
      contents: renderBookYml(identity),
      purpose: "your book's identity and settings",
    },
    {
      path: "package.json",
      contents: renderPackageJson(identity),
      purpose: `pins the Authorbot toolchain at ${TOOLCHAIN_VERSION}`,
    },
    {
      path: "wrangler.jsonc",
      contents: renderWranglerJsonc(identity),
      purpose: "tells Cloudflare how to serve your site",
    },
    {
      path: "README.md",
      contents: renderReadme(identity),
      purpose: "what this repository is, for anyone who opens it",
    },
  ];

  for (const [relative, contents] of Object.entries(STATIC_TEMPLATE_FILES)) {
    files.push({
      path: relative,
      contents,
      purpose: purposeOf(relative),
    });
  }

  for (const directory of KEEP_DIRECTORIES) {
    files.push({
      path: `${directory}/.gitkeep`,
      contents: "",
      purpose: `keeps the empty ${directory}/ directory in Git`,
    });
  }

  return files;
}

function purposeOf(relative: string): string {
  switch (relative) {
    case ".gitignore":
      return "keeps build output and setup state out of Git";
    case "story/outline.yml":
      return "an empty story graph, ready for you to grow";
    case "story/timeline.yml":
      return "an empty timeline, ready for you to grow";
    case ".github/workflows/validate.yml":
      return "checks every change before it lands";
    case ".github/workflows/publish.yml":
      return "publishes the site whenever main changes";
    default:
      return "part of the book scaffold";
  }
}

/**
 * Parses and schema-checks a rendered `book.yml` before it is written.
 *
 * `authorbot validate` is still run afterwards and is the authority
 * (contract §3.2: "does not proceed until it passes"). This earlier check
 * exists so a bad *title* — the one field that is arbitrary author input —
 * produces a pointed message about the title rather than a validation report
 * about a file the author never wrote.
 */
export function assertBookYmlValid(text: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new WizardError(
      `The generated book.yml is not valid YAML: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "This is a bug in the wizard. Please report it with the title you used.",
    );
  }
  const result = bookConfigSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first === undefined ? "" : ` (${first.path.join(".")}: ${first.message})`;
    throw new WizardError(
      `The generated book.yml does not match the Authorbot book schema${where}.`,
      "Try a simpler title, or report this with the exact title you used.",
    );
  }
}
