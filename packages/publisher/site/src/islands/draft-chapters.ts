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
import { getProjectStore, type ProjectStore } from "./project-store.js";

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

  connectedCallback(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const cfg = parseConfig(this);
    if (cfg === null) {
      return;
    }
    this.cfg = cfg;
    this.store = getProjectStore(cfg);
    void this.start();
  }

  private async start(): Promise<void> {
    await this.store.getState().ensureSession();
    if (!isMaintainer(this.store.getState().session)) {
      return;
    }

    await this.store.getState().ensureChapters();
    const state = this.store.getState();
    if (state.chaptersStatus !== "ready") {
      this.renderError(state.chaptersError ?? "chapter metadata is unavailable");
      return;
    }

    const drafts = Object.values(state.chaptersById)
      .filter(isUnpublished)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (drafts.length === 0) {
      return;
    }
    this.renderDrafts(drafts);
  }

  private renderDrafts(drafts: ChapterProjection[]): void {
    this.textContent = "";
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
