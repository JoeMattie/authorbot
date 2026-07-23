/** Capability-gated, click-lazy entry point for the inline chapter time machine. */
import { hasEffectiveCapability, type Me } from "./api.js";
import { el } from "./dom.js";
import { loadLazyModule } from "./lazy-module.js";
import { loadProjectStore } from "./project-store-loader.js";

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
  private panel: HTMLElement | null = null;
  private status: HTMLSpanElement | null = null;
  private terminalChunkFailure = false;

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
    this.started = false;
    this.generation += 1;
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
      if (canReadHistory(store.getState().session)) this.scaffold();
    } catch {
      // History is supplemental. A failed shared chunk leaves the reader intact.
    }
  }

  private scaffold(): void {
    if (this.button !== null) return;
    this.textContent = "";
    const panelId = `ab-chapter-history-${++panelSequence}`;
    const button = el("button", "ab-history-trigger");
    button.type = "button";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", panelId);
    const icon = el("span", "ab-history-trigger-icon", "↶");
    icon.setAttribute("aria-hidden", "true");
    button.append(icon, document.createTextNode("History"));
    button.addEventListener("click", () => void this.toggle(panelId));
    const status = el("span", "ab-history-entry-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    this.append(button, status);
    this.button = button;
    this.status = status;
  }

  private async toggle(panelId: string): Promise<void> {
    const button = this.button;
    if (button === null) return;
    if (this.panel !== null) {
      const opening = this.panel.hidden;
      this.panel.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
      if (opening) this.panel.focus();
      return;
    }
    if (this.terminalChunkFailure) {
      this.showStatus("History could not load. Reload the page to try again.");
      return;
    }
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
      const panel = document.createElement("authorbot-chapter-history-panel");
      panel.id = panelId;
      for (const [key, value] of Object.entries(this.cfg)) panel.dataset[key] = value;
      panel.tabIndex = -1;
      panel.addEventListener("authorbot-history-close", () => this.closePanel());
      this.append(panel);
      this.panel = panel;
      button.setAttribute("aria-expanded", "true");
      this.hideStatus();
      panel.focus();
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
    this.button.focus();
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
}
