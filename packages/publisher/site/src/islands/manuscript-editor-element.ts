/**
 * Lightweight in-place chapter editor launcher.
 *
 * This element contains no Milkdown import. It offers Edit only after the
 * shared project store confirms both an editor/maintainer role and the exact
 * `revisions:write` capability, then requests the heavy surface on activation.
 * Submission is an event callback boundary for Slice 4; this module never
 * falls back to the legacy direct chapter-revision command.
 */
import { roleOf, type ChapterSource, type Me } from "./api.js";
import {
  clearChapterDraft,
  loadChapterDraft,
  saveChapterDraft,
} from "./chapter-composer-state.js";
import { el } from "./dom.js";
import { createLazyManuscriptSurface } from "./manuscript-surface-loader.js";
import type {
  ManuscriptSubmitRequest,
  ManuscriptSubmitResult,
  ManuscriptSurfaceSession,
} from "./manuscript-surface.js";
import type { ProjectStore } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

export const CHAPTER_REVISION_SUBMIT_EVENT = "authorbot:chapter-revision-submit";

export interface ChapterRevisionDraft {
  chapterId: string;
  title: string;
  markdown: string;
  baseRevision: number;
  /** Added to the read model by Slice 4; null on older compatible Workers. */
  baseContentHash: string | null;
}

export interface ChapterRevisionSubmitEventDetail {
  draft: ChapterRevisionDraft;
  /** A synchronous listener supplies the authoritative store/API action. */
  handle: ((draft: ChapterRevisionDraft) => Promise<ManuscriptSubmitResult>) | null;
}

interface Config {
  apiBase: string;
  project: string;
  chapterId: string;
  chapterTitle: string;
}

function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project, chapterId } = host.dataset;
  if (
    apiBase === undefined ||
    project === undefined ||
    chapterId === undefined ||
    chapterId === ""
  ) {
    return null;
  }
  return {
    apiBase,
    project,
    chapterId,
    chapterTitle: host.dataset["chapterTitle"] ?? "",
  };
}

function mayProposeRevision(me: Me | null): boolean {
  const role = roleOf(me);
  return me !== null &&
    (role === "editor" || role === "maintainer") &&
    me.scopes.includes("revisions:write");
}

function storageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function sourceContentHash(source: ChapterSource): string | null {
  const candidate = (source as ChapterSource & { contentHash?: unknown }).contentHash;
  return typeof candidate === "string" ? candidate : null;
}

export class AuthorbotManuscriptEditor extends HTMLElement {
  private cfg!: Config;
  private store!: ProjectStore;
  private prose: HTMLElement | null = null;
  private editButton: HTMLButtonElement | null = null;
  private editorShell: HTMLElement | null = null;
  private editorRoot: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private session: ManuscriptSurfaceSession | null = null;
  private source: ChapterSource | null = null;
  private started = false;
  private generation = 0;

  connectedCallback(): void {
    if (this.started) return;
    this.started = true;
    const cfg = parseConfig(this);
    if (cfg === null) return;
    this.cfg = cfg;
    const generation = ++this.generation;
    void this.connect(generation);
  }

  disconnectedCallback(): void {
    this.started = false;
    this.generation += 1;
    void this.destroySession(false);
  }

  private current(generation: number): boolean {
    return this.started && this.isConnected && this.generation === generation;
  }

  private async connect(generation: number): Promise<void> {
    let store: ProjectStore;
    try {
      store = await loadProjectStore(this.cfg);
      await store.getState().ensureSession();
    } catch {
      return; // progressive enhancement: untouched static manuscript
    }
    if (!this.current(generation)) return;
    this.store = store;
    const state = store.getState();
    if (state.sessionStatus !== "ready" || !mayProposeRevision(state.session)) return;
    this.prose = this.parentElement === null
      ? null
      : [...this.parentElement.children]
          .find((node): node is HTMLElement =>
            node instanceof HTMLElement && node.classList.contains("prose")) ?? null;
    if (this.prose === null) return;
    this.renderLauncher();
  }

  private renderLauncher(): void {
    this.textContent = "";
    const controls = el("div", "ab-manuscript-launcher");
    controls.setAttribute("aria-label", "Chapter editing");
    const edit = el("button", "ab-btn ab-manuscript-edit", "Edit chapter");
    edit.type = "button";
    edit.setAttribute("aria-expanded", "false");
    edit.addEventListener("click", () => void this.openEditor());
    this.editButton = edit;
    controls.append(edit);
    this.append(controls);
  }

  private async openEditor(): Promise<void> {
    if (this.session !== null || this.editButton === null || this.prose === null) return;
    const generation = this.generation;
    this.editButton.disabled = true;
    this.setLauncherStatus("Loading chapter editor…");
    const read = await this.store.getState().readChapterSource(this.cfg.chapterId);
    if (!this.current(generation)) return;
    if (!read.ok) {
      this.editButton.disabled = false;
      this.setLauncherStatus(`The chapter editor could not open: ${read.message}`, true);
      return;
    }
    this.source = read.value;
    const stored = loadChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
    const markdown = stored?.body ?? read.value.body;
    const shell = el("section", "ab-manuscript-editor-shell");
    shell.setAttribute("aria-label", `Editing ${read.value.title || this.cfg.chapterTitle}`);
    const editorRoot = el("div", "ab-manuscript-editor-root");
    const error = el("p", "ab-error ab-manuscript-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const status = el("p", "ab-manuscript-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    const actions = el("div", "ab-form-actions ab-manuscript-editor-actions");
    const cancel = el("button", "ab-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => void this.cancelEditor());
    const submit = el("button", "ab-btn ab-primary", "Submit for review");
    submit.type = "button";
    submit.addEventListener("click", () => void this.submitEditor(submit, error, status));
    actions.append(cancel, submit);
    shell.append(editorRoot, error, status, actions);
    this.editorShell = shell;
    this.editorRoot = editorRoot;
    this.statusLine = status;
    this.append(shell);
    this.prose.hidden = true;
    this.editButton.setAttribute("aria-expanded", "true");

    try {
      const blockIds = [...this.prose.children]
        .filter((node): node is HTMLElement =>
          node instanceof HTMLElement && node.id.startsWith("b-")
        )
        .map((block) => block.id.slice(2));
      this.session = await createLazyManuscriptSurface({
        root: editorRoot,
        markdown,
        blockIds,
        activation: "edit",
        accessibleName: `Chapter text for ${read.value.title || this.cfg.chapterTitle}`,
        allowBlockNotes: false,
        onMarkdownChange: (body) => {
          saveChapterDraft(storageOrNull(), this.cfg.project, {
            chapterId: this.cfg.chapterId,
            title: read.value.title,
            body,
            baseRevision: read.value.revision,
            caret: null,
            focus: "body",
          });
        },
        onSubmit: (request) => this.requestSubmission(request),
      });
    } catch (caught) {
      if (!this.current(generation)) return;
      await this.destroySession(false);
      this.editButton.disabled = false;
      this.setLauncherStatus(
        `The chapter editor could not open: ${caught instanceof Error ? caught.message : String(caught)}`,
        true,
      );
      return;
    }
    if (!this.current(generation)) {
      await this.destroySession(false);
      return;
    }
    this.editButton.disabled = false;
    this.setLauncherStatus("");
    this.session.focus();
  }

  private async requestSubmission(
    request: ManuscriptSubmitRequest,
  ): Promise<ManuscriptSubmitResult> {
    const source = this.source;
    if (source === null) {
      return { ok: false, message: "The chapter base is no longer available." };
    }
    const draft: ChapterRevisionDraft = {
      chapterId: this.cfg.chapterId,
      title: source.title,
      markdown: request.markdown,
      baseRevision: source.revision,
      baseContentHash: sourceContentHash(source),
    };
    const detail: ChapterRevisionSubmitEventDetail = { draft, handle: null };
    this.dispatchEvent(new CustomEvent<ChapterRevisionSubmitEventDetail>(
      CHAPTER_REVISION_SUBMIT_EVENT,
      { bubbles: true, composed: true, detail },
    ));
    if (detail.handle === null) {
      return {
        ok: false,
        message: "Revision submission is not connected on this deployment.",
      };
    }
    return detail.handle(draft);
  }

  private async submitEditor(
    button: HTMLButtonElement,
    error: HTMLElement,
    status: HTMLElement,
  ): Promise<void> {
    const session = this.session;
    if (session === null) return;
    button.disabled = true;
    error.hidden = true;
    status.textContent = "Submitting the chapter for review…";
    status.hidden = false;
    let result: ManuscriptSubmitResult;
    try {
      result = await session.submit();
    } catch (caught) {
      result = { ok: false, message: caught instanceof Error ? caught.message : String(caught) };
    }
    button.disabled = false;
    if (!result.ok) {
      error.textContent = result.message ?? "The revision could not be submitted.";
      error.hidden = false;
      status.hidden = true;
      return;
    }
    clearChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
    status.textContent = result.message ?? "Revision submitted for review.";
    status.hidden = false;
  }

  private async cancelEditor(): Promise<void> {
    if (this.session?.dirty === true && !window.confirm("Discard this in-progress chapter edit?")) {
      return;
    }
    clearChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
    await this.destroySession(true);
  }

  private async destroySession(restoreFocus: boolean): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session !== null) await session.destroy();
    this.editorShell?.remove();
    this.editorShell = null;
    this.editorRoot = null;
    this.statusLine = null;
    if (this.prose !== null) this.prose.hidden = false;
    if (this.editButton !== null) {
      this.editButton.setAttribute("aria-expanded", "false");
      if (restoreFocus) this.editButton.focus();
    }
  }

  private setLauncherStatus(message: string, error = false): void {
    let line = this.querySelector<HTMLElement>(".ab-manuscript-launcher-status");
    if (message === "") {
      line?.remove();
      return;
    }
    if (line === null) {
      line = el("p", "ab-manuscript-launcher-status");
      line.setAttribute("role", error ? "alert" : "status");
      this.querySelector(".ab-manuscript-launcher")?.append(line);
    }
    line.classList.toggle("ab-error", error);
    line.setAttribute("role", error ? "alert" : "status");
    line.textContent = message;
  }
}
