/**
 * `<authorbot-draft-chapters>` - the maintainer's private view of unpublished
 * chapters on the book home page.
 *
 * Drafts must not be part of the static site: hiding static HTML after load
 * would still publish the prose to every reader. This island first proves the
 * viewer is a maintainer, then fetches metadata from the authenticated API.
 * Opening a draft mounts the existing composer, whose source route performs
 * its own editor/maintainer authorization before returning any prose.
 */
import { isMaintainer, type ChapterProjection } from "./api.js";
import { createChapterActivityGroup } from "./chapter-activity.js";
import { el } from "./dom.js";
import type { ProjectStore } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

interface Config {
  apiBase: string;
  project: string;
}

function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project } = host.dataset;
  // `data-api-base=""` is valid for the usual same-origin deployment.
  if (apiBase === undefined || project === undefined) {
    return null;
  }
  return { apiBase, project };
}

function isUnpublished(chapter: ChapterProjection): boolean {
  return chapter.status === "draft" || chapter.status === "proposed";
}

export class AuthorbotDraftChapters extends HTMLElement {
  private store!: ProjectStore;
  private cfg!: Config;
  private started = false;
  private mountGeneration = 0;
  private unsubscribe: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private renderedProjection: string | null = null;
  private pendingDrafts: ChapterProjection[] | null = null;
  private pendingProjection: string | null = null;

  connectedCallback(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const generation = ++this.mountGeneration;
    const cfg = parseConfig(this);
    if (cfg === null) {
      return;
    }
    this.cfg = cfg;
    void this.connectStore(cfg, generation);
  }

  private async connectStore(cfg: Config, generation: number): Promise<void> {
    let store: ProjectStore;
    try {
      store = await loadProjectStore(cfg);
    } catch {
      // Draft metadata is private enhancement-only content. Keep the static
      // home-page fallback rather than surfacing a rejected module promise.
      return;
    }
    if (!this.isCurrentMount(generation)) return;
    this.store = store;
    this.unsubscribe = store.subscribe(() => {
      if (this.isCurrentMount(generation)) this.renderFromStore();
    });
    await this.start(generation, store);
  }

  disconnectedCallback(): void {
    this.started = false;
    this.mountGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.releaseConnection?.();
    this.releaseConnection = null;
  }

  private isCurrentMount(generation: number): boolean {
    return this.started && this.isConnected && this.mountGeneration === generation;
  }

  private async start(generation: number, store: ProjectStore): Promise<void> {
    await store.getState().ensureSession();
    if (!this.isCurrentMount(generation)) return;
    if (!isMaintainer(store.getState().session)) {
      return;
    }

    await store.getState().ensureChapters();
    if (!this.isCurrentMount(generation)) return;
    this.renderFromStore();
    if (!this.isCurrentMount(generation)) return;
    this.releaseConnection = store.getState().retainConnection();
  }

  private renderFromStore(): void {
    const state = this.store.getState();
    if (state.sessionStatus !== "ready" || !isMaintainer(state.session)) {
      this.pendingDrafts = null;
      this.pendingProjection = null;
      this.renderedProjection = null;
      this.textContent = "";
      return;
    }
    if (state.chaptersStatus !== "ready") {
      if (state.chaptersStatus === "error") {
        if (
          this.querySelector(
            ".ab-draft-panel:not([hidden]) authorbot-chapter-composer",
          ) !== null
        ) {
          return;
        }
        const message = state.chaptersError ?? "chapter metadata is unavailable";
        const projection = `error:${message}`;
        if (projection !== this.renderedProjection) {
          this.renderError(message);
          this.renderedProjection = projection;
        }
      }
      return;
    }

    const drafts = Object.values(state.chaptersById)
      .filter(isUnpublished)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const projection = JSON.stringify(
      drafts.map((chapter) => [
        chapter.id,
        chapter.title,
        chapter.status,
        chapter.revision,
        chapter.updatedAt,
        chapter.activity ?? null,
      ]),
    );
    if (projection === this.renderedProjection) {
      return;
    }
    // A store notification from the mounted composer's own save/poll must not
    // remove that composer mid-edit. Defer the changed list projection until
    // its review panel closes; authorization changes above still clear now.
    if (this.querySelector(".ab-draft-panel:not([hidden]) authorbot-chapter-composer") !== null) {
      this.pendingDrafts = drafts;
      this.pendingProjection = projection;
      return;
    }
    this.renderDrafts(drafts);
    this.renderedProjection = projection;
    this.pendingDrafts = null;
    this.pendingProjection = null;
  }

  private renderDrafts(drafts: ChapterProjection[]): void {
    this.textContent = "";
    if (drafts.length === 0) return;
    const section = el("section", "ab-drafts");
    section.setAttribute("aria-labelledby", "authorbot-drafts-heading");
    const heading = el("h2", "ab-drafts-heading", "Drafts");
    heading.id = "authorbot-drafts-heading";
    const note = el(
      "p",
      "ab-drafts-note",
      "Private workspace - only maintainers can see these unpublished chapters.",
    );
    const list = el("ol", "ab-draft-list");
    drafts.forEach((chapter, index) => list.append(this.draftItem(chapter, index)));
    section.append(heading, note, list);
    this.append(section);
  }

  private draftItem(chapter: ChapterProjection, index: number): HTMLLIElement {
    const item = el("li", "ab-draft-item");
    item.dataset.chapterActivityId = chapter.id;
    const summary = el("div", "ab-draft-summary");
    const title = el("span", "ab-draft-title", chapter.title);
    const badge = el("span", "ab-chip", chapter.status);
    const revision = el("span", "ab-draft-revision", `Revision ${chapter.revision}`);
    const activitySlot = el("span");
    activitySlot.dataset.chapterActivitySlot = "";
    const activity = chapter.activity;
    const activityGroup =
      activity === undefined ? null : createChapterActivityGroup(activity);
    activitySlot.hidden = activityGroup === null;
    if (activityGroup !== null) {
      activitySlot.append(activityGroup);
    }
    summary.append(title, badge, revision, activitySlot);

    const review = el("button", "ab-btn ab-draft-review", "Review draft");
    review.type = "button";
    review.setAttribute("aria-label", `Review draft: ${chapter.title}`);
    review.setAttribute("aria-expanded", "false");
    const panelId = `authorbot-draft-review-${index + 1}`;
    review.setAttribute("aria-controls", panelId);

    const panel = el("div", "ab-draft-panel");
    panel.id = panelId;
    panel.hidden = true;
    let mounted = false;
    review.addEventListener("click", () => {
      const opening = panel.hidden;
      panel.hidden = !opening;
      review.setAttribute("aria-expanded", String(opening));
      review.textContent = opening ? "Close draft" : "Review draft";
      review.setAttribute(
        "aria-label",
        `${opening ? "Close" : "Review"} draft: ${chapter.title}`,
      );
      if (!opening || mounted) {
        if (!opening) this.flushPendingProjection();
        return;
      }
      mounted = true;
      const composer = document.createElement("authorbot-chapter-composer");
      composer.dataset.apiBase = this.cfg.apiBase;
      composer.dataset.project = this.cfg.project;
      composer.dataset.chapterId = chapter.id;
      composer.dataset.chapterTitle = chapter.title;
      composer.dataset.standalone = "false";
      panel.append(composer);
    });

    item.append(summary, review, panel);
    return item;
  }

  private flushPendingProjection(): void {
    if (this.pendingDrafts === null || this.pendingProjection === null) return;
    const drafts = this.pendingDrafts;
    const projection = this.pendingProjection;
    this.pendingDrafts = null;
    this.pendingProjection = null;
    this.renderDrafts(drafts);
    this.renderedProjection = projection;
  }

  private renderError(message: string): void {
    this.textContent = "";
    const section = el("section", "ab-drafts");
    section.append(
      el("h2", "ab-drafts-heading", "Drafts"),
      el("p", "ab-error", `Drafts could not be loaded: ${message}`),
    );
    this.append(section);
  }
}
