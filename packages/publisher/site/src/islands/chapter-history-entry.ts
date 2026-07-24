/** Capability-gated, click-lazy entry point for the inline chapter time machine. */
import { hasEffectiveCapability, type Me } from "./api.js";
import { el, labeledButton } from "./dom.js";
import { loadLazyModule } from "./lazy-module.js";
import { loadProjectStore } from "./project-store-loader.js";
import { chapterHistoryRevisionFromHash } from "../lib/chapter-history-link.js";

interface ChapterHistoryEntryConfig {
  apiBase: string;
  project: string;
  base: string;
  chapterId: string;
  chapterTitle: string;
  chapterRevision: string;
  chapterStatus: string;
}

interface ChapterHistoryPanelModule {
  AuthorbotChapterHistoryPanel: CustomElementConstructor;
}

interface ChapterHistoryPanelElement extends HTMLElement {
  showRevision?: (revision: number) => void;
}

type PanelLoader = () => Promise<ChapterHistoryPanelModule>;

const defaultPanelLoader: PanelLoader = () =>
  loadLazyModule(() => import("./chapter-history-panel.js"));

let panelLoader: PanelLoader = defaultPanelLoader;
let panelSequence = 0;

/** Test seam for terminal split-chunk behavior without changing production retry policy. */
export function setChapterHistoryPanelLoaderForTests(loader: PanelLoader): void {
  panelLoader = loader;
}

export function resetChapterHistoryPanelLoaderForTests(): void {
  panelLoader = defaultPanelLoader;
}

function parseConfig(host: HTMLElement): ChapterHistoryEntryConfig | null {
  const {
    apiBase,
    project,
    base,
    chapterId,
    chapterTitle,
    chapterRevision,
    chapterStatus,
  } = host.dataset;
  if (
    apiBase === undefined ||
    project === undefined ||
    base === undefined ||
    chapterId === undefined ||
    chapterTitle === undefined ||
    chapterRevision === undefined ||
    chapterStatus === undefined
  ) {
    return null;
  }
  return {
    apiBase,
    project,
    base,
    chapterId,
    chapterTitle,
    chapterRevision,
    chapterStatus,
  };
}

function canReadHistory(me: Me | null): boolean {
  return hasEffectiveCapability(me, "history:read", "history:read");
}

export class AuthorbotChapterHistory extends HTMLElement {
  private cfg!: ChapterHistoryEntryConfig;
  private started = false;
  private generation = 0;
  private button: HTMLButtonElement | null = null;
  private panel: ChapterHistoryPanelElement | null = null;
  private status: HTMLSpanElement | null = null;
  private terminalChunkFailure = false;
  private prose: HTMLElement | null = null;
  private gutter: HTMLElement | null = null;
  private proseWasHidden = false;
  private gutterWasHidden = false;
  private historyModeActive = false;
  private panelId: string | null = null;
  private historyLoadingOverlay: HTMLElement | null = null;
  private manuscriptResizeObserver: ResizeObserver | null = null;

  connectedCallback(): void {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;
    const cfg = parseConfig(this);
    if (cfg === null) return;
    this.cfg = cfg;
    void this.authorize(generation);
  }

  disconnectedCallback(): void {
    this.setHistoryMode(false);
    this.manuscriptResizeObserver?.disconnect();
    this.manuscriptResizeObserver = null;
    this.panel?.remove();
    this.panel = null;
    this.started = false;
    this.generation += 1;
    globalThis.removeEventListener?.("hashchange", this.onHashChange);
  }

  private isCurrent(generation = this.generation): boolean {
    return this.started && this.isConnected && generation === this.generation;
  }

  private async authorize(generation: number): Promise<void> {
    try {
      const store = await loadProjectStore(this.cfg);
      if (!this.isCurrent(generation)) return;
      await store.getState().ensureSession();
      if (!this.isCurrent(generation)) return;
      if (canReadHistory(store.getState().session)) {
        this.scaffold();
        globalThis.addEventListener?.("hashchange", this.onHashChange);
        void this.openLinkedRevision();
      }
    } catch {
      // History is supplemental. A failed shared chunk leaves the reader intact.
    }
  }

  private scaffold(): void {
    if (this.button !== null) return;
    this.textContent = "";
    const panelId = `ab-chapter-history-${++panelSequence}`;
    this.panelId = panelId;
    const button = labeledButton("ab-history-trigger", "History", "history");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", panelId);
    button.addEventListener("click", () => void this.toggle(panelId));
    const status = el("span", "ab-history-entry-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    this.append(button, status);
    this.button = button;
    this.status = status;
  }

  private async toggle(panelId: string, revision: number | null = null): Promise<void> {
    const button = this.button;
    if (button === null) return;
    if (this.panel !== null) {
      const opening = this.panel.hidden;
      this.panel.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
      if (opening) {
        this.setHistoryMode(true);
        if (revision !== null) this.panel.showRevision?.(revision);
        this.panel.focus({ preventScroll: true });
      } else {
        this.setHistoryMode(false);
      }
      return;
    }
    if (this.terminalChunkFailure) {
      this.showStatus("History could not load. Reload the page to try again.");
      return;
    }
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    this.showStatus("Loading chapter history…");
    try {
      const module = await panelLoader();
      if (!this.isCurrent()) return;
      if (customElements.get("authorbot-chapter-history-panel") === undefined) {
        customElements.define(
          "authorbot-chapter-history-panel",
          module.AuthorbotChapterHistoryPanel,
        );
      }
      const panel = document.createElement(
        "authorbot-chapter-history-panel",
      ) as ChapterHistoryPanelElement;
      panel.id = panelId;
      for (const [key, value] of Object.entries(this.cfg)) panel.dataset[key] = value;
      const latestLinkedRevision = chapterHistoryRevisionFromHash(
        globalThis.location?.hash ?? "",
      );
      const initialRevision = latestLinkedRevision ?? revision;
      if (initialRevision !== null) panel.dataset.initialRevision = String(initialRevision);
      panel.tabIndex = -1;
      panel.addEventListener("authorbot-history-close", () => this.closePanel());
      panel.addEventListener("authorbot-history-ready", () => {
        this.finishHistoryLoading();
      });
      this.panel = panel;
      const prose = this.chapterProse();
      if (prose !== null) {
        prose.before(panel);
      } else {
        (this.manuscriptSurface() ?? this.closest("article") ?? this).append(panel);
      }
      button.setAttribute("aria-expanded", "true");
      this.setHistoryMode(true);
      this.hideStatus();
      panel.focus({ preventScroll: true });
    } catch {
      if (!this.isCurrent()) return;
      this.terminalChunkFailure = true;
      button.setAttribute("aria-expanded", "false");
      this.showStatus("History could not load. Reload the page to try again.");
    } finally {
      if (this.isCurrent()) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
  }

  private closePanel(): void {
    if (this.panel === null || this.button === null) return;
    this.panel.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    this.setHistoryMode(false);
    this.button.focus();
  }

  /** History takes over the same inline reading surface as chapter editing. */
  private setHistoryMode(active: boolean): void {
    if (active === this.historyModeActive) return;
    const chapter = this.closest<HTMLElement>("article.chapter") ?? this.closest("article");
    const layout = this.closest<HTMLElement>(".ab-reading-layout");
    if (active) {
      this.historyModeActive = true;
      this.prose = this.chapterProse(chapter);
      this.gutter = layout?.querySelector<HTMLElement>(":scope > .ab-gutter") ?? null;
      this.observeManuscriptMeasure(layout);
      this.proseWasHidden = this.prose?.hidden ?? false;
      this.gutterWasHidden = this.gutter?.hidden ?? false;
      if (this.gutter !== null) this.gutter.hidden = true;
      layout?.classList.add("ab-history-active");
      if (this.panel?.dataset.historyReady === "true") {
        if (this.prose !== null) this.prose.hidden = true;
      } else {
        this.beginHistoryLoading();
      }
      return;
    }
    this.clearHistoryLoading();
    if (this.prose !== null) this.prose.hidden = this.proseWasHidden;
    if (this.gutter !== null) this.gutter.hidden = this.gutterWasHidden;
    layout?.classList.remove("ab-history-active");
    this.manuscriptResizeObserver?.disconnect();
    this.manuscriptResizeObserver = null;
    layout?.style.removeProperty("--ab-manuscript-surface-width");
    this.historyModeActive = false;
    this.prose = null;
    this.gutter = null;
  }

  /**
   * History controls can occupy the Notes column, but its prose keeps the
   * exact live manuscript measure. The chapter's 64ch cap makes that narrower
   * than the reading column's nominal 700px track.
   */
  private observeManuscriptMeasure(layout: HTMLElement | null): void {
    const surface = this.manuscriptSurface();
    if (layout === null || surface === null) return;
    const update = (): void => {
      const width = surface.getBoundingClientRect().width;
      if (width > 0) {
        layout.style.setProperty("--ab-manuscript-surface-width", `${width}px`);
      }
    };
    update();
    this.manuscriptResizeObserver?.disconnect();
    this.manuscriptResizeObserver = new ResizeObserver(update);
    this.manuscriptResizeObserver.observe(surface);
  }

  private beginHistoryLoading(): void {
    const surface = this.manuscriptSurface();
    if (surface === null || this.prose === null || this.panel === null) return;
    surface.classList.add("ab-history-source-loading");
    this.prose.classList.add("ab-history-source-loading-prose");
    this.panel.classList.add("ab-history-panel-preparing");
    const overlay = el("div", "ab-history-source-loading-overlay");
    overlay.setAttribute("role", "status");
    overlay.append(
      el("span", "ab-history-loading-spinner"),
      el("span", undefined, "Loading revision…"),
    );
    surface.append(overlay);
    this.historyLoadingOverlay = overlay;
  }

  private finishHistoryLoading(): void {
    if (!this.historyModeActive) return;
    this.clearHistoryLoading();
    if (this.prose !== null) this.prose.hidden = true;
  }

  private clearHistoryLoading(): void {
    this.manuscriptSurface()?.classList.remove("ab-history-source-loading");
    this.prose?.classList.remove("ab-history-source-loading-prose");
    this.panel?.classList.remove("ab-history-panel-preparing");
    this.historyLoadingOverlay?.remove();
    this.historyLoadingOverlay = null;
  }

  /**
   * Only the article's direct manuscript is replaceable. History's rendered
   * diff deliberately shares the `prose` class, so a descendant-wide lookup
   * starts selecting the diff itself after the first open.
   */
  private chapterProse(chapter?: HTMLElement | null): HTMLElement | null {
    const surface = this.manuscriptSurface(chapter);
    return surface?.querySelector<HTMLElement>(":scope > .prose") ?? null;
  }

  private manuscriptSurface(chapter?: HTMLElement | null): HTMLElement | null {
    const article =
      chapter ??
      this.closest<HTMLElement>("article.chapter") ??
      this.closest<HTMLElement>("article");
    return (
      article?.querySelector<HTMLElement>(
        ":scope > [data-chapter-manuscript-surface]",
      ) ?? null
    );
  }

  private showStatus(message: string): void {
    if (this.status === null) return;
    this.status.textContent = message;
    this.status.hidden = false;
  }

  private hideStatus(): void {
    if (this.status === null) return;
    this.status.textContent = "";
    this.status.hidden = true;
  }

  private async openLinkedRevision(): Promise<void> {
    const panelId = this.panelId;
    if (panelId === null) return;
    const revision = chapterHistoryRevisionFromHash(globalThis.location?.hash ?? "");
    if (revision === null) return;
    if (this.panel !== null && !this.panel.hidden) {
      this.panel.showRevision?.(revision);
      return;
    }
    await this.toggle(panelId, revision);
  }

  private readonly onHashChange = (): void => {
    void this.openLinkedRevision();
  };
}
