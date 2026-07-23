/**
 * Private, progressive chapter-summary projection for the Outline page.
 *
 * Static HTML remains published-only. This element does not touch that
 * fallback until the shared project store has proved an authenticated
 * `chapters:read` capability and loaded a complete bounded chapter list.
 */
import {
  hasEffectiveCapability,
  type ChapterProjection,
} from "./api.js";
import { el } from "./dom.js";
import type { ProjectStore } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

interface Config {
  apiBase: string;
  project: string;
  staticId: string;
}

const MAX_RENDERED_SUMMARIES = 2_000;

function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project, staticId } = host.dataset;
  if (
    apiBase === undefined ||
    project === undefined ||
    staticId === undefined ||
    staticId === ""
  ) {
    return null;
  }
  return { apiBase, project, staticId };
}

function mayReadCurrentSummaries(store: ProjectStore): boolean {
  return hasEffectiveCapability(
    store.getState().session,
    "chapters:read",
    "chapters:read",
  );
}

function canonicalOrder(a: ChapterProjection, b: ChapterProjection): number {
  const aOrder = typeof a.order === "number" && Number.isFinite(a.order)
    ? a.order
    : Number.POSITIVE_INFINITY;
  const bOrder = typeof b.order === "number" && Number.isFinite(b.order)
    ? b.order
    : Number.POSITIVE_INFINITY;
  return aOrder - bOrder || a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id);
}

function currentChapters(store: ProjectStore): ChapterProjection[] | null {
  const chapters = Object.values(store.getState().chaptersById);
  // During a rolling deploy, an older Worker may return chapter projections
  // without `summary`. Preserve the public static view instead of replacing
  // it with a misleading set of empty summaries.
  if (chapters.some((chapter) => !Object.hasOwn(chapter, "summary"))) return null;
  return chapters
    .filter((chapter) => chapter.status !== "archived")
    .sort(canonicalOrder)
    .slice(0, MAX_RENDERED_SUMMARIES);
}

export class AuthorbotOutlineSummaries extends HTMLElement {
  private cfg!: Config;
  private store: ProjectStore | null = null;
  private staticSection: HTMLElement | null = null;
  private publicHrefByChapter = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private connectionHeld = false;
  private started = false;
  private generation = 0;
  private renderedProjection: string | null = null;

  connectedCallback(): void {
    if (this.started) return;
    const cfg = parseConfig(this);
    if (cfg === null) return;
    this.started = true;
    this.cfg = cfg;
    const generation = ++this.generation;
    this.staticSection = document.getElementById(cfg.staticId);
    this.capturePublicHrefs();
    void this.connectStore(generation);
  }

  disconnectedCallback(): void {
    this.started = false;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dropConnection();
    this.restoreStatic();
  }

  private current(generation: number): boolean {
    return this.started && this.isConnected && this.generation === generation;
  }

  private capturePublicHrefs(): void {
    this.publicHrefByChapter.clear();
    for (const item of this.staticSection?.querySelectorAll<HTMLElement>(
      "[data-chapter-summary-id]",
    ) ?? []) {
      const chapterId = item.dataset["chapterSummaryId"];
      const href = item.querySelector<HTMLAnchorElement>("a[href]")?.getAttribute("href");
      if (chapterId !== undefined && href !== null && href !== undefined) {
        this.publicHrefByChapter.set(chapterId, href);
      }
    }
  }

  private async connectStore(generation: number): Promise<void> {
    let store: ProjectStore;
    try {
      store = await loadProjectStore(this.cfg);
    } catch {
      return;
    }
    if (!this.current(generation)) return;
    this.store = store;
    this.unsubscribe = store.subscribe(() => {
      if (this.current(generation)) this.renderFromStore();
    });
    await store.getState().ensureSession();
    if (!this.current(generation) || !mayReadCurrentSummaries(store)) {
      this.restoreStatic();
      return;
    }
    await store.getState().ensureChapters();
    if (!this.current(generation)) return;
    this.renderFromStore();
  }

  private renderFromStore(): void {
    const store = this.store;
    if (
      store === null ||
      store.getState().sessionStatus !== "ready" ||
      !mayReadCurrentSummaries(store)
    ) {
      this.dropConnection();
      this.restoreStatic();
      return;
    }
    const state = store.getState();
    if (state.chaptersStatus === "idle") {
      void state.ensureChapters();
      return;
    }
    if (state.chaptersStatus === "error") {
      const message = state.chaptersError ?? "chapter summaries are unavailable";
      const projection = `error:${message}`;
      if (projection === this.renderedProjection) return;
      this.replaceChildren(
        el(
          "p",
          "ab-error ab-outline-summaries-error",
          `Current summaries could not be loaded: ${message}`,
        ),
      );
      this.renderedProjection = projection;
      this.showStatic();
      return;
    }
    if (state.chaptersStatus !== "ready") return;
    this.holdConnection(store);

    const chapters = currentChapters(store);
    if (chapters === null) {
      const projection = "unsupported:summary";
      if (projection === this.renderedProjection) return;
      this.replaceChildren(
        el(
          "p",
          "ab-error ab-outline-summaries-error",
          "Current summaries need the matching Authorbot API deployment.",
        ),
      );
      this.renderedProjection = projection;
      this.showStatic();
      return;
    }
    const projection = JSON.stringify(
      chapters.map((chapter) => [
        chapter.id,
        chapter.title,
        chapter.summary,
        chapter.order,
        chapter.status,
        chapter.revision,
      ]),
    );
    if (projection === this.renderedProjection) return;
    this.renderCurrent(chapters);
    this.renderedProjection = projection;
    if (this.staticSection !== null) this.staticSection.hidden = true;
  }

  private renderCurrent(chapters: readonly ChapterProjection[]): void {
    this.replaceChildren();
    const section = el("section", "story-chapter-summaries ab-current-chapter-summaries");
    section.setAttribute("aria-labelledby", "chapter-summaries-current-title");
    const header = document.createElement("header");
    header.append(
      el("p", "story-eyebrow", "Current project metadata · collaborator view"),
      el("h2", "", "Chapter summaries"),
    );
    header.querySelector("h2")!.id = "chapter-summaries-current-title";
    section.append(header);

    if (chapters.length === 0) {
      section.append(el("p", "story-empty", "This project has no current chapters."));
      this.append(section);
      return;
    }

    const list = document.createElement("ol");
    for (const chapter of chapters) {
      const item = document.createElement("li");
      const heading = el("div", "ab-outline-summary-heading");
      const href = this.publicHrefByChapter.get(chapter.id);
      if (href === undefined) {
        heading.append(el("span", "ab-outline-summary-title", chapter.title));
      } else {
        const link = el("a", "ab-outline-summary-title", chapter.title);
        link.href = href;
        heading.append(link);
      }
      heading.append(
        el(
          "span",
          `story-status-pill story-status-${chapter.status}`,
          chapter.status,
        ),
      );
      item.append(heading);
      const summary = typeof chapter.summary === "string" ? chapter.summary.trim() : "";
      item.append(
        el(
          "p",
          summary === "" ? "ab-outline-summary-empty" : "",
          summary === "" ? "No summary yet." : summary,
        ),
      );
      list.append(item);
    }
    section.append(list);
    this.append(section);
  }

  private showStatic(): void {
    if (this.staticSection !== null) this.staticSection.hidden = false;
  }

  private holdConnection(store: ProjectStore): void {
    if (this.connectionHeld) return;
    // Set the guard first: retainConnection synchronously publishes its
    // connecting state, and that store notification re-enters this renderer.
    this.connectionHeld = true;
    this.releaseConnection = store.getState().retainConnection();
  }

  private dropConnection(): void {
    if (!this.connectionHeld) return;
    this.connectionHeld = false;
    const release = this.releaseConnection;
    this.releaseConnection = null;
    release?.();
  }

  private restoreStatic(): void {
    this.renderedProjection = null;
    this.replaceChildren();
    this.showStatic();
  }
}
