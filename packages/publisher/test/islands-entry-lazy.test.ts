// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const lazy = vi.hoisted(() => ({
  loadLazyModule: vi.fn(),
}));

vi.mock("../site/src/islands/lazy-module.js", () => ({
  LAZY_MODULE_ATTEMPTS: 2,
  loadLazyModule: lazy.loadLazyModule,
}));

afterEach(() => {
  document.body.textContent = "";
  vi.resetModules();
  lazy.loadLazyModule.mockReset();
});

describe("collaboration entry lazy modules", () => {
  it("handles a terminal work-queue import and preserves its fallback", async () => {
    const failure = new TypeError("work queue chunk unavailable");
    lazy.loadLazyModule.mockRejectedValue(failure);
    document.body.innerHTML = `
      <authorbot-work-queue>
        <p class="work-fallback">The work queue loads here once JavaScript is enabled.</p>
      </authorbot-work-queue>`;

    await import("../site/src/islands/index.js");
    await Promise.resolve();

    expect(lazy.loadLazyModule).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".work-fallback")?.textContent).toContain(
      "work queue loads here",
    );
    expect(customElements.get("authorbot-work-queue")).toBeUndefined();
  });

  it("keeps the revision-review fallback after its page-only chunk fails", async () => {
    lazy.loadLazyModule.mockRejectedValue(new TypeError("revision chunk unavailable"));
    document.body.innerHTML = `
      <authorbot-revision-review>
        <p class="revision-fallback">Revision proposals load here once JavaScript is enabled.</p>
      </authorbot-revision-review>`;

    await import("../site/src/islands/index.js");
    await Promise.resolve();

    expect(lazy.loadLazyModule).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".revision-fallback")?.textContent).toContain(
      "Revision proposals load here",
    );
    expect(customElements.get("authorbot-revision-review")).toBeUndefined();
  });
});
