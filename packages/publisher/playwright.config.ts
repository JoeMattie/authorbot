import { defineConfig } from "@playwright/test";

/**
 * Playwright e2e for the Phase 2b collaboration islands (contract §5):
 * chromium-only, headless, fully self-contained. `test/e2e-ui/global-setup.ts`
 * creates a temp git book repo from examples/book-repo, starts the Phase 2
 * Node dev API against it (dev auth, temp SQLite, LocalGitAdapter mirror,
 * ALLOWED_ORIGINS = the static origin), builds the site with the API base +
 * dev-login flag, and serves it statically. Kept OUT of the default vitest
 * run — invoke with `pnpm --filter @authorbot/publisher test:e2e`.
 */
export default defineConfig({
  testDir: "./test/e2e-ui",
  globalSetup: "./test/e2e-ui/global-setup.ts",
  // One shared API + DB: the flows are stateful, so tests run serially.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    headless: true,
    // ≥ 960px so the desktop gutter layout (contract §2.1) is active.
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
