import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { ClientRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildManifest } from "@authorbot/schemas";
import { build, dev } from "astro";
import type { Plugin, ProxyOptions, ViteDevServer } from "vite";
import { isDirectory } from "./fs-utils.js";
import { loadSiteModel, PublisherError } from "./load.js";
import { createManifest, detectGitCommit } from "./manifest.js";
import type { SiteModel } from "./model.js";
import { serializeSiteJson, SITE_JSON_FILENAME } from "./site-json.js";

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
const CLOUDFLARE_HEADERS = `/*
  Cache-Control: public, max-age=0, must-revalidate, no-transform
`;

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

interface DevServerHandle {
  address: { address: string; port: number };
  stop(): Promise<void>;
}

export interface StartDevSiteOptions {
  repoPath: string;
  port?: number;
  apiTarget: string;
  bootstrapPath: string;
  status?: () => Promise<Record<string, unknown>>;
  onWarning?: (message: string) => void;
  onBuildState?: (error: string | null) => void;
}

export interface DevSite {
  url: string;
  stop(): Promise<void>;
}

const DEV_ASSET_ENTRIES: Readonly<Record<string, string>> = Object.freeze({
  "authorbot-collab.js": "index.ts",
  "authorbot-account.js": "account-entry.ts",
  "authorbot-planning.js": "planning-entry.ts",
  "authorbot-settings.js": "settings.ts",
  "authorbot-access.js": "access.ts",
  "authorbot-collab.css": "collab.css",
  "authorbot-planning.css": "planning-editor.css",
  "authorbot-access.css": "access.css",
  "authorbot-settings.css": "settings.css",
  "authorbot-work.css": "work.css",
  "authorbot-revisions.css": "revision-review.css",
  "authorbot-history.css": "chapter-history.css",
});

/**
 * Start the book UI on Astro/Vite's loopback server. The browser has one
 * origin; `/v1` is proxied to the private Node API and the stable production
 * island URLs are mapped onto their source modules for HMR.
 */
export async function startDevSite(options: StartDevSiteOptions): Promise<DevSite> {
  const siteRoot = fileURLToPath(new URL("../site/", import.meta.url));
  const islandsRoot = path.join(siteRoot, "src", "islands");
  const bookPublicDir = path.join(options.repoPath, "public");
  const hasBookPublicDir = await isDirectory(bookPublicDir);
  let current = await loadSiteModel({
    repoPath: options.repoPath,
    includeDrafts: true,
    apiUrl: "/",
    devLogin: false,
  });
  for (const warning of current.warnings) options.onWarning?.(warning);
  current.model.localDev = { bootstrapPath: options.bootstrapPath };
  let viteServer: ViteDevServer | null = null;
  const proxyRequests = new Set<ClientRequest>();
  const trackedProxy = (): ProxyOptions => ({
    target: options.apiTarget,
    changeOrigin: false,
    configure(proxy) {
      proxy.on("proxyReq", (request) => {
        proxyRequests.add(request);
        request.once("close", () => proxyRequests.delete(request));
      });
    },
  });

  const dynamicDataPlugin: Plugin = {
    name: "authorbot-local-site-data",
    resolveId(id: string) {
      return id === VIRTUAL_MODULE_ID ? RESOLVED_VIRTUAL_MODULE_ID : undefined;
    },
    load(id: string) {
      return id === RESOLVED_VIRTUAL_MODULE_ID
        ? `export const site = ${JSON.stringify(current.model)};`
        : undefined;
    },
    configureServer(server) {
      viteServer = server;
      server.watcher.add(options.repoPath);
      let pending: ReturnType<typeof setTimeout> | null = null;
      server.watcher.on("all", (_event, changedPath) => {
        if (!path.resolve(changedPath).startsWith(path.resolve(options.repoPath) + path.sep)) return;
        if (pending !== null) clearTimeout(pending);
        pending = setTimeout(() => {
          void loadSiteModel({
            repoPath: options.repoPath,
            includeDrafts: true,
            apiUrl: "/",
            devLogin: false,
          }).then((loaded) => {
            loaded.model.localDev = { bootstrapPath: options.bootstrapPath };
            current = loaded;
            options.onBuildState?.(null);
            const module = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE_ID);
            if (module !== undefined) server.moduleGraph.invalidateModule(module);
            server.ws.send({ type: "full-reload", path: "*" });
          }).catch((error: unknown) => {
            const message = `book reload failed; serving the last good view: ${
              error instanceof Error ? error.message : String(error)
            }`;
            options.onBuildState?.(message);
            options.onWarning?.(message);
          });
        }, 100);
      });
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const asset = pathname.match(/\/_astro\/([^/]+)$/u)?.[1];
        const source = asset === undefined ? undefined : DEV_ASSET_ENTRIES[asset];
        if (source !== undefined) {
          req.url = `/@fs/${path.join(islandsRoot, source)}`;
          next();
          return;
        }
        // Generated image thumbnails (covers, character portraits) exist
        // only in memory during dev; production builds write them into
        // `_astro/` on disk.
        const image =
          asset === undefined
            ? undefined
            : current.imageAssets.find((entry) => entry.fileName === asset);
        if (image !== undefined) {
          res.statusCode = 200;
          res.setHeader("content-type", "image/webp");
          res.setHeader("cache-control", "no-cache");
          res.end(Buffer.from(image.data));
          return;
        }
        // Site-data JSON, same URL shape as a production build (base is
        // always "/" in dev), so book-authored custom pages under public/
        // can fetch it relatively in both environments.
        if (pathname === `/${SITE_JSON_FILENAME}`) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("cache-control", "no-cache");
          res.end(serializeSiteJson(current.model));
          return;
        }
        // Directory-index resolution for book-authored pages under public/:
        // production static hosting serves `/story-map/` from
        // `story-map/index.html`, but Vite's public-dir middleware does not,
        // and a custom page that 404s only in dev would be a parity trap.
        if (hasBookPublicDir && pathname.endsWith("/") && pathname !== "/") {
          const indexRel = `${pathname.slice(1)}index.html`;
          void stat(path.join(bookPublicDir, indexRel)).then(
            (stats) => {
              if (stats.isFile()) {
                req.url = `/${indexRel}`;
              }
              next();
            },
            () => {
              next();
            },
          );
          return;
        }
        if (pathname === "/__authorbot/status" && options.status !== undefined) {
          void options.status().then((status) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(status));
          }).catch((error: unknown) => {
            res.statusCode = 500;
            res.end(error instanceof Error ? error.message : String(error));
          });
          return;
        }
        next();
      });
    },
  };

  const server = await dev({
    root: siteRoot,
    output: "static",
    base: "/",
    ...(hasBookPublicDir ? { publicDir: bookPublicDir } : {}),
    integrations: [],
    devToolbar: { enabled: false },
    logLevel: "warn",
    server: {
      host: "127.0.0.1",
      port: options.port ?? 4321,
      open: false,
    },
    vite: {
      plugins: [dynamicDataPlugin],
      server: {
        strictPort: true,
        watch: {
          usePolling: true,
          interval: 250,
          ignored: ["**/.git/**", "**/node_modules/**"],
        },
        proxy: {
          "/v1": trackedProxy(),
          "/__authorbot/bootstrap": trackedProxy(),
        },
      },
    },
  }) as DevServerHandle;
  return {
    url: `http://localhost:${String(server.address.port)}`,
    stop: async () => {
      // Vite waits for every pending request before closing. A proxied SSE
      // stream is intentionally pending forever, so disconnect browser and
      // WebSocket clients first and let the proxy cancel its upstream request.
      for (const request of proxyRequests) request.destroy();
      proxyRequests.clear();
      if (viteServer !== null) {
        await viteServer.ws.close();
        const httpServer = viteServer.httpServer;
        if (httpServer !== null && "closeAllConnections" in httpServer) {
          httpServer.closeAllConnections();
        }
      }
      await server.stop();
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
async function buildIslands(
  siteRoot: string,
  outDir: string,
  siteBasePath: string,
): Promise<void> {
  const assetDir = path.join(outDir, "_astro");
  const publicAssetBase = `${siteBasePath}_astro/`;
  await mkdir(assetDir, { recursive: true });
  const { build: viteBuild } = await import("vite");

  /**
   * Two entries, bundled independently rather than as one multi-input build.
   *
   * `authorbot-collab` owns the reader-facing chapter behavior.
   * `authorbot-access` is the Phase 7 maintainer surface - a collaborator
   * table, an agent-token list, an audit view and a moderation queue - which
   * only `/settings/` loads.
   *
   * Independent builds (rather than shared chunks) keep both output names
   * stable and unhashed, which is what the page templates reference. Shared
   * helpers may be duplicated, but each entry remains owned by the page that
   * activates it.
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
        // Give Vite the complete public path of this nested build. A relative
        // base makes its CSS preload helper resolve dependencies through
        // `new URL(..., import.meta.url).href`, which expands link hrefs to a
        // full origin URL at runtime. Static Authorbot assets are root-relative
        // and must retain the book prefix, including under ADR-0019 base-path
        // deployments such as `/my-book/_astro/assets/...`.
        base: publicAssetBase,
        build: {
          outDir: assetDir,
          emptyOutDir: false,
          target: "es2022",
          minify: "esbuild",
          // Entry boundaries are architectural page/activation boundaries,
          // not release gates.
          chunkSizeWarningLimit: Number.POSITIVE_INFINITY,
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
    // source commentary out of the shipped payload.
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

  const { model, warnings, imageAssets, headless } = await loadSiteModel({
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

  // Book-owned static assets: `public/` in the repository is copied verbatim
  // into the site output by Astro's public-dir passthrough. The site package
  // ships no public dir of its own, so pointing Astro at the book's is safe;
  // when the book has none, Astro's default (`<siteRoot>/public`, absent)
  // keeps today's behavior.
  const bookPublicDir = path.join(repoPath, "public");
  const hasBookPublicDir = await isDirectory(bookPublicDir);

  if (headless) {
    // `publication.mode: headless` (Phase 1 contract): no generated pages,
    // no islands - the book owns the entire frontend. The output is the
    // `public/` tree copied verbatim plus the data artifacts written below
    // (image thumbnails, `authorbot-site.json`, manifest, `_headers`).
    await rm(siteOutDir, { recursive: true, force: true });
    await mkdir(siteOutDir, { recursive: true });
    if (hasBookPublicDir) {
      await cp(bookPublicDir, siteOutDir, { recursive: true });
    }
  } else {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const previousCwd = process.cwd();
    process.chdir(packageRoot);
    try {
      await build({
        root: siteRoot,
        outDir: siteOutDir,
        output: "static",
        base: model.basePath,
        ...(hasBookPublicDir ? { publicDir: bookPublicDir } : {}),
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
      // Islands land beside the rest of the site's assets, under the same
      // base path prefix their `<script src>` tags point at.
      await buildIslands(siteRoot, siteOutDir, model.basePath);
    }
  }

  if (imageAssets.length > 0) {
    // Generated thumbnails carry a content hash in their names, so they land
    // in `_astro/` beside Astro's own immutable assets.
    const assetDir = path.join(siteOutDir, "_astro");
    await mkdir(assetDir, { recursive: true });
    for (const asset of imageAssets) {
      await writeFile(path.join(assetDir, asset.fileName), asset.data);
    }
  }

  // Site-data JSON for book-authored custom pages (Phase 1 contract): the
  // same model the generated pages embed, next to `index.html` so it nests
  // with the base path and a public/ page can fetch it relatively. Written
  // after the Astro build, so it deterministically wins over a book's own
  // `public/authorbot-site.json` (validate warns about the shadowing).
  await writeFile(
    path.join(siteOutDir, SITE_JSON_FILENAME),
    serializeSiteJson(model),
  );

  const commit =
    options.commit === undefined ? detectGitCommit(repoPath) : options.commit;
  const manifest = createManifest({
    commit,
    baseUrl: options.baseUrl,
    headless,
    chapters: model.chapters,
  });
  await writeFile(
    path.join(outDir, "authorbot-build.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  // Cloudflare Web Analytics can inject its browser beacon into HTML at the
  // edge. Authorbot sites keep request-level Cloudflare analytics, but opt out
  // of response rewriting (and therefore the third-party browser beacon).
  // `_headers` must live at the static-assets root, not under a base path.
  await writeFile(path.join(outDir, "_headers"), CLOUDFLARE_HEADERS, "utf8");
  return manifest;
}
