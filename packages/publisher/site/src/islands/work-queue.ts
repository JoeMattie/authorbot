/**
 * `<authorbot-work-queue>` — the read-only work-queue island for the `/work/`
 * page (Phase 3 contract §6). Lists **ready** work items (type, target
 * chapter, support summary, base revision) with a cursor "Load more"; no
 * mutation affordances in Phase 3.
 *
 * Progressive enhancement (§2b §1): the page ships a static fallback inside
 * the mount; this element replaces it only after the API answers. With JS off,
 * or the API unreachable, the fallback message stays and nothing errors.
 *
 * Security: every API string reaches the DOM through `textContent`; the only
 * markup is the chapter link, whose href comes from the build-time chapter map
 * (trusted), never from API data.
 */
import { CollabApi, type WorkItem } from "./api.js";
import { el, srOnly } from "./dom.js";
import { tallyOrEmpty, tallySummary } from "./vote-view.js";

interface ChapterRef {
  title: string;
  href: string;
}

interface WorkConfig {
  apiBase: string;
  project: string;
  chapters: Map<string, ChapterRef>;
}

function parseConfig(host: HTMLElement): WorkConfig | null {
  const { apiBase, project } = host.dataset;
  if (apiBase === undefined || project === undefined) {
    return null;
  }
  const chapters = new Map<string, ChapterRef>();
  try {
    const raw = JSON.parse(host.dataset.chapters ?? "{}") as Record<string, ChapterRef>;
    for (const [id, ref] of Object.entries(raw)) {
      if (typeof ref?.title === "string" && typeof ref?.href === "string") {
        chapters.set(id, ref);
      }
    }
  } catch {
    // malformed map: fall back to bare chapter ids
  }
  return { apiBase, project, chapters };
}

/** `revise_range` → "Revise range" (generic, so new types read sensibly). */
function typeLabel(type: string): string {
  const words = type.split("_");
  return words
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export class AuthorbotWorkQueue extends HTMLElement {
  private api!: CollabApi;
  private cfg!: WorkConfig;
  private started = false;
  private list!: HTMLElement;
  private status!: HTMLElement;
  private moreWrap!: HTMLElement;
  private cursor: string | null = null;
  private count = 0;

  connectedCallback(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const cfg = parseConfig(this);
    if (cfg === null) {
      return; // misconfigured build: leave the static fallback in place
    }
    this.cfg = cfg;
    this.api = new CollabApi(cfg.apiBase, cfg.project);
    void this.load(true);
  }

  private async load(first: boolean): Promise<void> {
    const result = await this.api.workItems(this.cursor ?? undefined);
    if (!result.ok) {
      // Only replace the static fallback once we have a real answer, so an
      // unreachable API leaves the page readable (progressive enhancement).
      if (result.status === 0) {
        return;
      }
      if (first) {
        this.scaffold();
      }
      this.status.hidden = false;
      this.status.textContent =
        result.status === 401 || result.status === 403
          ? "Sign in with an editor (or higher) role to view the work queue."
          : `Work queue unavailable: ${result.message}`;
      this.moreWrap.hidden = true;
      return;
    }
    if (first) {
      this.scaffold();
    }
    for (const item of result.value.items) {
      this.list.append(this.buildItem(item));
      this.count += 1;
    }
    this.cursor = result.value.nextCursor;
    this.moreWrap.hidden = this.cursor === null;
    this.status.hidden = this.count > 0;
    if (this.count === 0) {
      this.status.hidden = false;
      this.status.textContent = "No work items are ready.";
    }
  }

  private scaffold(): void {
    this.textContent = "";
    this.status = el("p", "ab-work-status");
    this.status.setAttribute("role", "status");
    this.status.hidden = true;
    this.list = el("ul", "ab-work-list");
    this.moreWrap = el("div", "ab-work-more");
    this.moreWrap.hidden = true;
    const more = el("button", "ab-btn", "Load more");
    more.type = "button";
    more.addEventListener("click", () => {
      more.disabled = true;
      void this.load(false).finally(() => {
        more.disabled = false;
      });
    });
    this.moreWrap.append(more);
    this.append(this.status, this.list, this.moreWrap);
  }

  private buildItem(item: WorkItem): HTMLElement {
    const li = el("li", "ab-work-item");
    const chapter = this.cfg.chapters.get(item.chapterId);

    const head = el("div", "ab-work-head");
    head.append(el("span", "ab-chip", typeLabel(item.type)));
    if (chapter !== undefined) {
      const link = el("a", "ab-work-chapter", chapter.title);
      link.href = chapter.href;
      head.append(link);
    } else {
      head.append(el("span", "ab-work-chapter", `Chapter ${item.chapterId}`));
    }
    li.append(head);

    const quote = item.target?.textQuote?.exact;
    if (typeof quote === "string" && quote.length > 0) {
      li.append(el("blockquote", "ab-quote", quote.length > 160 ? `${quote.slice(0, 159)}…` : quote));
    }

    const meta = el("p", "ab-work-meta");
    meta.append(
      el("span", "ab-work-base", `Base revision ${item.baseRevision}`),
      document.createTextNode(" · "),
      el("span", "ab-work-support", tallySummary(tallyOrEmpty(item.support))),
    );
    li.append(meta);

    li.append(srOnly(`Ready work item: ${typeLabel(item.type)} on ${chapter?.title ?? item.chapterId}`));
    return li;
  }
}
