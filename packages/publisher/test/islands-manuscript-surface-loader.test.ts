// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadManuscriptSurface,
  resetManuscriptSurfaceModuleLoaderForTests,
  setManuscriptSurfaceModuleLoaderForTests,
} from "../site/src/islands/manuscript-surface-loader.js";
import type { ManuscriptSurfaceModule } from "../site/src/islands/manuscript-surface.js";

afterEach(() => resetManuscriptSurfaceModuleLoaderForTests());

describe("manuscript surface lazy boundary", () => {
  it("does not request Milkdown until an explicit Notes or Edit activation", async () => {
    const module = { createManuscriptSurface: vi.fn() } as unknown as ManuscriptSurfaceModule;
    const loader = vi.fn<() => Promise<ManuscriptSurfaceModule>>().mockResolvedValue(module);
    setManuscriptSurfaceModuleLoaderForTests(loader);

    expect(loader).not.toHaveBeenCalled();
    await expect(loadManuscriptSurface("notes")).resolves.toBe(module);
    await expect(loadManuscriptSurface("edit")).resolves.toBe(module);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("shares the bounded retry and caches the successful editor module", async () => {
    const module = { createManuscriptSurface: vi.fn() } as unknown as ManuscriptSurfaceModule;
    const loader = vi
      .fn<() => Promise<ManuscriptSurfaceModule>>()
      .mockRejectedValueOnce(new TypeError("deployment changed"))
      .mockResolvedValue(module);
    setManuscriptSurfaceModuleLoaderForTests(loader);

    await expect(loadManuscriptSurface("edit")).resolves.toBe(module);
    await expect(loadManuscriptSurface("edit")).resolves.toBe(module);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
