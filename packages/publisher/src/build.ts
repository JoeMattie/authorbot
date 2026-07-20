import { writeFile } from "node:fs/promises";
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
 * (`virtual:authorbot-site`) registered by an inline plugin below — see the
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
  });
  for (const warning of warnings) {
    options.onWarning?.(warning);
  }

  // Astro assumes the process cwd is near the project root: when `outDir`
  // lies outside cwd it stages its intermediate server bundle in
  // `<cwd>/.astro`, where a pnpm workspace root cannot resolve Astro's own
  // dependencies. Building with cwd at this package's root keeps the staging
  // dir inside the package (resolvable) while staying distinct from the site
  // root's `.astro` metadata dir — a collision there would sweep Astro's
  // content-layer artifacts into the published output.
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const previousCwd = process.cwd();
  process.chdir(packageRoot);
  try {
    await build({
      root: siteRoot,
      outDir,
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
