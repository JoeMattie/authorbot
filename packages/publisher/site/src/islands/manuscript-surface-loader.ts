import { loadLazyModule } from "./lazy-module.js";
import type {
  ManuscriptActivation,
  ManuscriptSurfaceModule,
  ManuscriptSurfaceOptions,
  ManuscriptSurfaceSession,
} from "./manuscript-surface.js";

type ManuscriptSurfaceModuleLoader = () => Promise<ManuscriptSurfaceModule>;

const defaultModuleLoader: ManuscriptSurfaceModuleLoader = () =>
  import("./milkdown-manuscript-surface.js");

let moduleRequest: Promise<ManuscriptSurfaceModule> | null = null;
let importModule: ManuscriptSurfaceModuleLoader = defaultModuleLoader;

/** Test seam for proving the reader entry never imports Milkdown eagerly. */
export function setManuscriptSurfaceModuleLoaderForTests(
  loader: ManuscriptSurfaceModuleLoader,
): void {
  importModule = loader;
  moduleRequest = null;
}

export function resetManuscriptSurfaceModuleLoaderForTests(): void {
  importModule = defaultModuleLoader;
  moduleRequest = null;
}

/**
 * Resolve the editor only after an explicit Notes or Edit action.
 *
 * The activation argument is intentionally required even though it is also in
 * the options passed to `create`: callers cannot accidentally turn a page-load
 * lifecycle into an implicit preload.
 */
export async function loadManuscriptSurface(
  activation: ManuscriptActivation,
): Promise<ManuscriptSurfaceModule> {
  if (activation !== "notes" && activation !== "edit") {
    throw new TypeError("A manuscript surface requires an explicit Notes or Edit activation.");
  }
  return moduleRequest ??= loadLazyModule(importModule);
}

export async function createLazyManuscriptSurface(
  options: ManuscriptSurfaceOptions,
): Promise<ManuscriptSurfaceSession> {
  const module = await loadManuscriptSurface(options.activation);
  return module.createManuscriptSurface(options);
}
