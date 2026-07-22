// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorbotAccount } from "../site/src/islands/account.js";
import { AuthorbotChapterActivity } from "../site/src/islands/chapter-activity.js";
import { AuthorbotChapterComposer } from "../site/src/islands/chapter-composer.js";
import { AuthorbotCollab } from "../site/src/islands/collab-element.js";
import { AuthorbotDraftChapters } from "../site/src/islands/draft-chapters.js";
import type { ProjectStore } from "../site/src/islands/project-store.js";
import {
  loadProjectStore,
  resetProjectStoreModuleLoaderForTests,
  setProjectStoreModuleLoaderForTests,
} from "../site/src/islands/project-store-loader.js";
import { AuthorbotWorkQueue } from "../site/src/islands/work-queue.js";

const ELEMENTS: ReadonlyArray<readonly [string, CustomElementConstructor]> = [
  ["authorbot-account", AuthorbotAccount],
  ["authorbot-chapter-activity", AuthorbotChapterActivity],
  ["authorbot-chapter-composer", AuthorbotChapterComposer],
  ["authorbot-collab", AuthorbotCollab],
  ["authorbot-draft-chapters", AuthorbotDraftChapters],
  ["authorbot-work-queue", AuthorbotWorkQueue],
];

for (const [tag, constructor] of ELEMENTS) {
  if (customElements.get(tag) === undefined) {
    customElements.define(tag, constructor);
  }
}

afterEach(() => {
  document.body.textContent = "";
  resetProjectStoreModuleLoaderForTests();
});

describe("project store lazy loader", () => {
  it("retries one transient import failure inside the shared request", async () => {
    const store = { marker: "shared-store" } as unknown as ProjectStore;
    const importModule = vi
      .fn<() => Promise<{ getProjectStore(): ProjectStore }>>()
      .mockRejectedValueOnce(new TypeError("chunk request failed"))
      .mockResolvedValue({ getProjectStore: () => store });
    const config = { apiBase: "https://api.example", project: "book" };
    setProjectStoreModuleLoaderForTests(importModule);

    await expect(loadProjectStore(config)).resolves.toBe(store);
    await expect(loadProjectStore(config)).resolves.toBe(store);

    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("caches a terminal failure after the bounded retry across every caller", async () => {
    const failure = new TypeError("chunk stayed unavailable");
    const importModule = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
    const config = { apiBase: "https://api.example", project: "book" };
    setProjectStoreModuleLoaderForTests(importModule);

    const first = loadProjectStore(config);
    const concurrent = loadProjectStore(config);
    await expect(first).rejects.toBe(failure);
    await expect(concurrent).rejects.toBe(failure);
    await expect(loadProjectStore(config)).rejects.toBe(failure);

    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("keeps every consumer fallback through terminal failure and reconnect", async () => {
    const importModule = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new TypeError("deployment chunk missing"));
    setProjectStoreModuleLoaderForTests(importModule);

    document.body.innerHTML = `
      <main>
        <article><div class="prose"><p id="b-one">Readable prose.</p></div></article>
      </main>`;
    const main = document.querySelector("main") as HTMLElement;
    const mounts: Array<{ host: HTMLElement; parent: HTMLElement }> = [];
    const mount = (
      tag: string,
      data: Record<string, string>,
      parent: HTMLElement = document.body,
    ): void => {
      const host = document.createElement(tag);
      for (const [key, value] of Object.entries(data)) {
        host.dataset[key] = value;
      }
      const fallback = document.createElement("p");
      fallback.dataset.lazyFallback = tag;
      fallback.textContent = `${tag} fallback`;
      host.append(fallback);
      parent.append(host);
      mounts.push({ host, parent });
    };

    const shared = { apiBase: "https://api.example", project: "book" };
    mount("authorbot-account", { ...shared, base: "/" });
    mount("authorbot-chapter-activity", shared);
    mount("authorbot-chapter-composer", { ...shared, standalone: "true" });
    mount(
      "authorbot-collab",
      { ...shared, chapterId: "chapter-1", chapterRevision: "1" },
      main,
    );
    mount("authorbot-draft-chapters", shared);
    mount("authorbot-work-queue", { ...shared, chapters: "{}" });

    await expect.poll(() => importModule.mock.calls.length).toBe(2);
    expect(document.querySelectorAll("[data-lazy-fallback]")).toHaveLength(6);
    expect(document.querySelector(".ab-gutter")).toBeNull();
    expect(document.querySelector(".ab-chapter-form")).toBeNull();
    expect(document.querySelector(".ab-work-list")).toBeNull();

    // A custom-element reconnect starts a new mount generation, but a terminal
    // page-level module failure remains bounded instead of starting six more
    // chunk requests.
    for (const { host, parent } of mounts) {
      host.remove();
      parent.append(host);
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(importModule).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll("[data-lazy-fallback]")).toHaveLength(6);
  });
});
