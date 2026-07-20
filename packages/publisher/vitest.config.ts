import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Playwright specs (test/e2e-ui) run under `pnpm test:e2e`, never under
    // the default vitest run (Phase 2b contract §5 keeps them separate).
    exclude: [...configDefaults.exclude, "test/e2e-ui/**"],
    // Astro builds stage their intermediate server bundle in this package's
    // `.astro` directory (see src/build.ts): two test files building
    // concurrently race on it and sweep staging artifacts into each other's
    // output. Run test files serially; the suite is build-dominated anyway.
    fileParallelism: false,
  },
});
