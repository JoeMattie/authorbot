import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildManifest } from "@authorbot/schemas";
import { build } from "astro";
import { loadSiteModel, PublisherError } from "./load.js";
import { createManifest, detectGitCommit } from "./manifest.js";
import type { SiteModel } from "./model.js";

/**
 * Programmatic Astro 5 static build (Phase 1 contract section 1).
 *
 * The Astro project root is the `site/` directory shipped inside this
 * package; repository data crosses into it through a Vite virtual module
 * (`virtual:authorbot-site`) registered by an inline plugin below - see the
 * package README for why that mechanism was chosen.
 */

export interface BuildSiteOptions {
  /** Book repository root. */
  repoPath: string;
  /** Output directory (created if needed; stale files are removed). */
  outDir: string;
  /** Public base URL or base path; recorded in the manifest as `base_url`. */
  baseUrl?: string | undefined;
  /** Overrides git detection; null forces "no commit" in the manifest. */
  commit?: string | null | undefined;
  /** Also publish `draft`/`proposed` chapters with a draft banner. */
  includeDrafts?: boolean | undefined;
  /**
   * Collaboration API base URL (Phase 2b contract §1); overrides
   * `publication.api_url` in book.yml. When neither is set the build emits
   * zero JavaScript and stays byte-comparable with a pre-2b site.
   */
  apiUrl?: string | undefined;
  /**
   * Surface the islands' dev-login form (`data-dev-login`) for local testing
   * against a dev-mode API. Never set for production builds.
   */
  devLogin?: boolean | undefined;
  /** Astro log level (default "warn" to keep CLI output terse). */
  logLevel?: "debug" | "info" | "warn" | "error" | "silent" | undefined;
  /** Receives non-fatal loader warnings (skipped records under --force). */
  onWarning?: ((message: string) => void) | undefined;
}

export const VIRTUAL_MODULE_ID = "virtual:authorbot-site";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

/** Inline Vite plugin exposing the site model to the Astro templates. */
function siteDataPlugin(model: SiteModel): {
  name: string;
  resolveId: (id: string) => string | undefined;
  load: (id: string) => string | undefined;
} {
  return {
    name: "authorbot-site-data",
    resolveId(id: string) {
      return id === VIRTUAL_MODULE_ID ? RESOLVED_VIRTUAL_MODULE_ID : undefined;
    },
    load(id: string) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) {
        return undefined;
      }
      // The model is data, never code: it is embedded as a JSON literal.
      return `export const site = ${JSON.stringify(model)};`;
    },
  };
}

/**
 * Bundle the collaboration islands (Phase 2b contract §1) into
 * `_astro/authorbot-collab.js` + `.css` - stable, unhashed names the chapter
 * template references. This is an explicit Vite step rather than an Astro
 * `<script>`: Astro emits every discovered script chunk into `_astro/` even
 * when no page renders it, which would break the contract's byte-comparable
 * script-free output for api-url-less builds. Running the bundler only when
 * collab is enabled keeps that invariant trivially true. The stylesheet is a
 * plain copied asset (never JS-injected), so the contract §3 CSP works
 * without 'unsafe-inline' styles.
 */
async function buildIslands(siteRoot: string, outDir: string): Promise<void> {
  const assetDir = path.join(outDir, "_astro");
  await mkdir(assetDir, { recursive: true });
  const { build: viteBuild } = await import("vite");

  /**
   * Two entries, bundled independently rather than as one multi-input build.
   *
   * `authorbot-collab` is what every reader downloads on every chapter page,
   * and Phase 2b §1 budgets it at 35 KB gzipped for exactly that reason.
   * `authorbot-access` is the Phase 7 maintainer surface - a collaborator
   * table, an agent-token list, an audit view and a moderation queue - which
   * only `/settings/` ever loads and which no reader should pay for.
   *
   * Independent builds (rather than shared chunks) keep both output names
   * stable and unhashed, which is what the page templates reference. The cost
   * is that the small shared helpers are duplicated into the access bundle;
   * that duplication is paid only on the settings page, by a maintainer, and
   * is far cheaper than putting the whole surface in every reader's page load.
   */
  const entries = [
    { input: "src/islands/index.ts", js: "authorbot-collab.js" },
    { input: "src/islands/account-entry.ts", js: "authorbot-account.js" },
    { input: "src/islands/planning-entry.ts", js: "authorbot-planning.js" },
    { input: "src/islands/settings.ts", js: "authorbot-settings.js" },
    { input: "src/islands/access.ts", js: "authorbot-access.js" },
  ] as const;

  for (const entry of entries) {
    try {
      await viteBuild({
        configFile: false,
        logLevel: "warn",
        root: siteRoot,
        // Lazy chunks must resolve beside the stable entry under `_astro/`.
        // Vite's default `/` base emits `/assets/...`, which 404s at both the
        // origin root and every ADR-0019 base-path deployment.
        base: "./",
        build: {
          outDir: assetDir,
          emptyOutDir: false,
          target: "es2022",
          minify: "esbuild",
          rollupOptions: {
            input: path.join(siteRoot, entry.input),
            output: { entryFileNames: entry.js, format: "es" },
          },
        },
      });
    } catch (error) {
      throw new PublisherError(
        `islands bundle failed (${entry.js}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Stylesheets are plain copied assets (never JS-injected), so the contract
  // §3 CSP works without 'unsafe-inline' styles.
  for (const [source, target] of [
    ["collab.css", "authorbot-collab.css"],
    ["planning-editor.css", "authorbot-planning.css"],
    ["access.css", "authorbot-access.css"],
    ["settings.css", "authorbot-settings.css"],
    ["work.css", "authorbot-work.css"],
    ["revision-review.css", "authorbot-revisions.css"],
    ["chapter-history.css", "authorbot-history.css"],
  ] as const) {
    // Source styles keep their section comments for maintainers, while the
    // browser asset drops CSS comments just like the JS bundle drops source
    // comments. This is grammar-safe for these authored stylesheets and keeps
    // the collaboration payload inside its long-standing gzip budget.
    const css = await readFile(path.join(siteRoot, "src/islands", source), "utf8");
    await writeFile(
      path.join(assetDir, target),
      css.replace(/\/\*[\s\S]*?\*\//g, ""),
      "utf8",
    );
  }
}

/**
 * Build the static reading site for a book repository and write
 * `authorbot-build.json` (`authorbot.build/v1`) into the output directory.
 * Returns the manifest. Throws {@link PublisherError} when the repository
 * is unusable.
 */
export async function buildSite(options: BuildSiteOptions): Promise<BuildManifest> {
  const repoPath = path.resolve(options.repoPath);
  const outDir = path.resolve(options.outDir);
  const siteRoot = fileURLToPath(new URL("../site/", import.meta.url));

  const { model, warnings } = await loadSiteModel({
    repoPath,
    baseUrl: options.baseUrl,
    includeDrafts: options.includeDrafts,
    apiUrl: options.apiUrl,
    devLogin: options.devLogin,
  });
  for (const warning of warnings) {
    options.onWarning?.(warning);
  }

  // Astro assumes the process cwd is near the project root: when `outDir`
  // lies outside cwd it stages its intermediate server bundle in
  // `<cwd>/.astro`, where a pnpm workspace root cannot resolve Astro's own
  // dependencies. Building with cwd at this package's root keeps the staging
  // dir inside the package (resolvable) while staying distinct from the site
  // root's `.astro` metadata dir - a collision there would sweep Astro's
  // content-layer artifacts into the published output.
  // A base path nests the emitted tree, because `base` only rewrites the URLs
  // Astro *writes* - it does not move the files those URLs point at. Building
  // `--base-url /my-book` therefore used to emit `index.html` and `_astro/` at
  // the root while every link pointed at `/my-book/…`. Cloudflare Workers
  // static assets resolve a request path directly against the tree
  // (`"assets": { "directory": "./_site" }`), so `/my-book/` and every asset
  // under it 404'd and only an unlinked root copy was reachable: the whole
  // site published broken. Emitting under `_site/my-book/` makes the tree
  // match the URLs, which is ADR-0019 §6 and exit criterion 9.
  const siteOutDir =
    model.basePath === "/" ? outDir : path.join(outDir, ...model.basePath.split("/").filter(Boolean));

  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const previousCwd = process.cwd();
  process.chdir(packageRoot);
  try {
    await build({
      root: siteRoot,
      outDir: siteOutDir,
      output: "static",
      base: model.basePath,
      integrations: [],
      devToolbar: { enabled: false },
      logLevel: options.logLevel ?? "warn",
      build: {
        format: "directory",
        // One shared stylesheet for the whole site (design section 16.1);
        // never inlined so every page links the same cacheable file.
        inlineStylesheets: "never",
      },
      vite: {
        plugins: [siteDataPlugin(model)],
      },
    });
  } catch (error) {
    throw new PublisherError(
      `astro build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    process.chdir(previousCwd);
  }

  if (model.collab !== null) {
    // Islands land beside the rest of the site's assets, under the same base
    // path prefix their `<script src>` tags point at.
    await buildIslands(siteRoot, siteOutDir);
  }

  const commit =
    options.commit === undefined ? detectGitCommit(repoPath) : options.commit;
  const manifest = createManifest({
    commit,
    baseUrl: options.baseUrl,
    chapters: model.chapters,
  });
  await writeFile(
    path.join(outDir, "authorbot-build.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}
