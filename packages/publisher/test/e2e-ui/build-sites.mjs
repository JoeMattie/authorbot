/**
 * Child-process build step for the Phase 2b e2e global setup. Runs the
 * `buildSite` calls in a plain Node process: the Playwright runner installs
 * its own module loader, which breaks Astro's dynamic imports of its staged
 * intermediate bundle on a second in-process build.
 *
 * argv[2]: JSON {repoDir, siteDir, plainDir, apiUrl, baseUrl}
 *
 * `plainDir` is optional: the api-url-less regression build is only needed for
 * the root deployment, and the base-path build reuses this script for a single
 * collab build under a prefix.
 */
import { buildSite } from "../../dist/index.js";

const { repoDir, siteDir, plainDir, apiUrl, baseUrl } = JSON.parse(process.argv[2] ?? "{}");

await buildSite({
  repoPath: repoDir,
  outDir: siteDir,
  apiUrl,
  // A base-path build (ADR-0019 §6) needs both halves: `baseUrl` drives the
  // URLs Astro writes and the nested output tree, `apiUrl` drives the prefix
  // the islands call. Passing one without the other is the misconfiguration
  // the base-path e2e exists to catch.
  ...(baseUrl === undefined ? {} : { baseUrl }),
  devLogin: true,
  logLevel: "error",
});

if (plainDir !== undefined) {
  await buildSite({ repoPath: repoDir, outDir: plainDir, logLevel: "error" });
}
