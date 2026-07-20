/**
 * Child-process build step for the Phase 2b e2e global setup. Runs the two
 * `buildSite` calls in a plain Node process: the Playwright runner installs
 * its own module loader, which breaks Astro's dynamic imports of its staged
 * intermediate bundle on a second in-process build.
 *
 * argv[2]: JSON {repoDir, siteDir, plainDir, apiUrl}
 */
import { buildSite } from "../../dist/index.js";

const { repoDir, siteDir, plainDir, apiUrl } = JSON.parse(process.argv[2] ?? "{}");

await buildSite({
  repoPath: repoDir,
  outDir: siteDir,
  apiUrl,
  devLogin: true,
  logLevel: "error",
});
await buildSite({ repoPath: repoDir, outDir: plainDir, logLevel: "error" });
