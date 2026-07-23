import type { ProjectStore, ProjectStoreConfig } from "./project-store.js";
import { loadLazyModule } from "./lazy-module.js";

interface ProjectStoreModule {
  getProjectStore(config: ProjectStoreConfig): ProjectStore;
}

type ProjectStoreModuleLoader = () => Promise<ProjectStoreModule>;

const defaultProjectStoreModuleLoader: ProjectStoreModuleLoader = () =>
  import("./project-store.js");

let moduleRequest: Promise<ProjectStoreModule> | null = null;
let importProjectStore: ProjectStoreModuleLoader = defaultProjectStoreModuleLoader;

/** Replace the dynamic import seam in the loader's isolated unit test. */
export function setProjectStoreModuleLoaderForTests(
  importModule: ProjectStoreModuleLoader,
): void {
  importProjectStore = importModule;
  moduleRequest = null;
}

/** Restore the production importer and clear the isolated unit-test cache. */
export function resetProjectStoreModuleLoaderForTests(): void {
  importProjectStore = defaultProjectStoreModuleLoader;
  moduleRequest = null;
}

/**
 * Load the collaboration state machine only on pages that actually connect to
 * an API. This boundary preserves one global project store without activating
 * it on pages that do not use it.
 */
export async function loadProjectStore(
  config: ProjectStoreConfig,
): Promise<ProjectStore> {
  // All islands share this request, including its one retry. A terminal
  // rejection stays cached for the page lifetime so six consumers cannot turn
  // one missing deployment chunk into six independent retry loops.
  const module = await (moduleRequest ??= loadLazyModule(importProjectStore));
  return module.getProjectStore(config);
}
