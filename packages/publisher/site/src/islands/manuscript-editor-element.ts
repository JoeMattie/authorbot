/**
 * Lightweight in-place chapter editor launcher.
 *
 * This element contains no Milkdown import. It offers Edit only after the
 * shared project store confirms the exact read/write capabilities, then
 * requests the heavy surface on activation. Submissions are immutable,
 * hash-bound revision proposals; this module never falls back to the legacy
 * direct chapter-revision command.
 */
import {
  hasEffectiveCapability,
  roleOf,
  type ChapterRevisionProposalCommand,
  type ChapterSource,
  type Me,
} from "./api.js";
import "./manuscript-editor-element.css";
import {
  clearChapterDraft,
  loadChapterDraft,
  saveChapterDraft,
  type StoredChapterDraft,
} from "./chapter-composer-state.js";
import { el, labeledButton, setLabeledButton } from "./dom.js";
import {
  chapterEditorRevisionTarget,
  editorRevisionMessage,
  editorRevisionNeedsRecoveryWarning,
  isEditorRevisionPhase,
  type EditorRevisionState,
  type EditorRevisionTarget,
} from "./editor-revision-state.js";
import { createLazyManuscriptSurface } from "./manuscript-surface-loader.js";
import type {
  ManuscriptSubmitRequest,
  ManuscriptSubmitResult,
  ManuscriptSurfaceSession,
} from "./manuscript-surface.js";
import type { ProjectStore, StoreActionResult } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

export const CHAPTER_REVISION_SUBMIT_EVENT = "authorbot:chapter-revision-submit";

const CHAPTER_EDIT_ACTIVE_ATTRIBUTE = "data-chapter-edit-active";

export interface ChapterRevisionDraft {
  chapterId: string;
  title: string;
  markdown: string;
  baseRevision: number;
  baseContentHash: string;
  changeSummary?: string;
  notes?: string;
  applyImmediately?: boolean;
}

export interface ChapterRevisionSubmitEventDetail {
  draft: ChapterRevisionDraft;
  /** Optional compatibility hook; normal submissions use the shared store. */
  handle: ((draft: ChapterRevisionDraft) => Promise<ManuscriptSubmitResult>) | null;
}

interface Config {
  apiBase: string;
  project: string;
  chapterId: string;
  chapterTitle: string;
}

interface ChapterCollabElement extends HTMLElement {
  prepareForExternalMode?: () => Promise<boolean>;
  setChapterEditMode?: (active: boolean) => void;
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
  return hasEffectiveCapability(me, "chapters:read", "chapters:read") &&
    hasEffectiveCapability(me, "revisions:write", "revisions:write");
}

function mayApplyRevision(me: Me | null): boolean {
  return roleOf(me) === "maintainer" && mayProposeRevision(me) &&
    hasEffectiveCapability(me, "revisions:review", "revisions:review");
}

function storageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function sourceContentHash(source: ChapterSource): string | null {
  const candidate = source.contentHash;
  return typeof candidate === "string" && /^sha256:[0-9a-f]{64}$/u.test(candidate)
    ? candidate
    : null;
}

function canonicalBody(markdown: string): string {
  return markdown.replace(/\r\n?/gu, "\n").trim();
}

export class AuthorbotManuscriptEditor extends HTMLElement {
  private cfg!: Config;
  private store!: ProjectStore;
  private manuscriptSurface: HTMLElement | null = null;
  private prose: HTMLElement | null = null;
  private editButton: HTMLButtonElement | null = null;
  private editorShell: HTMLElement | null = null;
  private editorRoot: HTMLElement | null = null;
  private summaryInput: HTMLInputElement | null = null;
  private notesInput: HTMLTextAreaElement | null = null;
  private errorLine: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private recoveryPanel: HTMLElement | null = null;
  private session: ManuscriptSurfaceSession | null = null;
  private source: ChapterSource | null = null;
  private baseRevision: number | null = null;
  private baseContentHash: string | null = null;
  private started = false;
  private busy = false;
  private applyImmediately = false;
  private generation = 0;
  private target: EditorRevisionTarget | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private closingAcceptedEditor = false;
  private editModeAnnounced = false;
  private loadingOverlay: HTMLElement | null = null;
  /** Exact island told to suppress entry, retained even if its subtree detaches. */
  private editModeCollab: ChapterCollabElement | null = null;
  private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.isDirty() && !this.needsRecoveryWarning()) return;
    event.preventDefault();
    event.returnValue = true;
  };

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
    this.busy = false;
    this.generation += 1;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.releaseConnection?.();
    this.releaseConnection = null;
    window.removeEventListener("beforeunload", this.beforeUnload);
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
    const chapter = this.closest<HTMLElement>("article.chapter") ?? this.closest("article");
    this.manuscriptSurface =
      chapter === null
        ? null
        : Array.from(chapter.children).find(
            (child): child is HTMLElement =>
              child instanceof HTMLElement &&
              child.hasAttribute("data-chapter-manuscript-surface"),
          ) ?? null;
    this.prose =
      this.manuscriptSurface === null
        ? null
        : Array.from(this.manuscriptSurface.children).find(
            (child): child is HTMLElement =>
              child instanceof HTMLElement && child.classList.contains("prose"),
          ) ?? null;
    if (this.prose === null) return;
    this.target = chapterEditorRevisionTarget(this.cfg.chapterId);
    this.renderLauncher();
    this.unsubscribeStore = store.subscribe((state, before) => {
      const key = this.target?.key;
      if (key === undefined ||
          state.editorRevisionsByTargetKey[key] === before.editorRevisionsByTargetKey[key]) {
        return;
      }
      this.renderLifecycle(state.editorRevisionsByTargetKey[key]);
    });
    const stored = loadChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
    if (stored?.proposalId !== undefined) {
      store.getState().trackEditorRevision(this.target, {
        proposalId: stored.proposalId,
        operationId: stored.proposalOperationId ?? null,
        correlationId: stored.proposalCorrelationId ?? null,
        commitSha: stored.proposalCommitSha ?? null,
        ...(isEditorRevisionPhase(stored.proposalPhase)
          ? { phase: stored.proposalPhase }
          : {}),
        error: stored.proposalError ?? null,
      });
    }
    this.releaseConnection = store.getState().retainConnection();
    this.renderLifecycle(store.getState().editorRevisionsByTargetKey[this.target.key]);
  }

  private renderLauncher(): void {
    this.textContent = "";
    const controls = el("div", "ab-manuscript-launcher");
    controls.setAttribute("aria-label", "Chapter editing");
    const edit = labeledButton("ab-btn ab-manuscript-edit", "Edit chapter", "pencil");
    edit.setAttribute("aria-expanded", "false");
    edit.addEventListener("click", () => void this.toggleEditor());
    this.editButton = edit;
    controls.append(edit);
    this.append(controls);
  }

  private async toggleEditor(): Promise<void> {
    if (this.busy) return;
    if (
      this.session !== null ||
      this.editorShell !== null ||
      this.recoveryPanel !== null
    ) {
      await this.cancelEditor();
      return;
    }
    await this.openEditor();
  }

  /** Let the read-only Notes surface take over without losing an edit draft. */
  async prepareForExternalMode(): Promise<boolean> {
    if (this.busy) return false;
    if (this.session === null && this.recoveryPanel === null) return true;
    this.persistDraft();
    await this.destroySession(false);
    this.setLauncherStatus("Chapter edit saved in this tab.");
    return true;
  }

  private async openEditor(): Promise<void> {
    if (
      this.session !== null || this.recoveryPanel !== null || this.editButton === null ||
      this.prose === null || this.busy
    ) return;
    const generation = this.generation;
    this.busy = true;
    this.editButton.disabled = true;
    this.editButton.setAttribute("aria-busy", "true");
    this.setLauncherStatus("");
    this.beginEditorLoading();
    // Suppress collaboration entry for the entire handoff, including closing
    // the rich Notes surface and loading source. Any suspended composer remains
    // in the collaboration element's state and is restored if launch aborts.
    const collab = this.chapterCollab();
    this.setEditModeAnnounced(true, collab);
    try {
      if (collab?.prepareForExternalMode !== undefined) {
        const ready = await collab.prepareForExternalMode();
        if (!ready || !this.current(generation)) {
          if (this.current(generation)) {
            this.abortEditorLaunch(
              ready ? "" : "The Notes view is still switching modes.",
              !ready,
            );
          } else {
            this.setEditModeAnnounced(false);
          }
          return;
        }
      }
    } catch (caught) {
      if (!this.current(generation)) {
        this.setEditModeAnnounced(false);
        return;
      }
      this.abortEditorLaunch(
        `The chapter editor could not open: ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
        true,
      );
      return;
    }
    let read: StoreActionResult<ChapterSource>;
    try {
      read = await this.store.getState().readChapterSource(this.cfg.chapterId);
    } catch (caught) {
      if (!this.current(generation)) {
        this.setEditModeAnnounced(false);
        return;
      }
      this.abortEditorLaunch(
        `The chapter editor could not open: ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
        true,
      );
      return;
    }
    if (!this.current(generation)) {
      this.setEditModeAnnounced(false);
      return;
    }
    if (!read.ok) {
      this.abortEditorLaunch(`The chapter editor could not open: ${read.message}`, true);
      return;
    }
    const contentHash = sourceContentHash(read.value);
    if (read.value.chapterId !== this.cfg.chapterId || contentHash === null) {
      this.abortEditorLaunch(
        "The chapter editor could not open: the source response did not include the exact chapter identity and content hash.",
        true,
      );
      return;
    }
    this.source = read.value;
    const stored = loadChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
    if (
      stored !== null &&
      (stored.baseRevision !== read.value.revision || stored.baseContentHash !== contentHash)
    ) {
      this.setEditModeAnnounced(false);
      this.renderStaleDraftChoice(read.value, stored, contentHash, generation);
      return;
    }
    await this.mountEditor(
      read.value,
      stored,
      read.value.revision,
      contentHash,
      false,
      generation,
    );
  }

  private abortEditorLaunch(message: string, error = false): void {
    this.setEditModeAnnounced(false);
    this.clearEditorLoading();
    this.busy = false;
    if (this.editButton !== null) {
      this.editButton.disabled = false;
      this.editButton.removeAttribute("aria-busy");
      setLabeledButton(this.editButton, "Edit chapter", "pencil");
    }
    this.setLauncherStatus(message, error);
  }

  private renderStaleDraftChoice(
    source: ChapterSource,
    stored: StoredChapterDraft,
    currentContentHash: string,
    generation: number,
  ): void {
    if (this.editButton === null) return;
    this.clearEditorLoading();
    this.busy = false;
    this.editButton.disabled = true;
    this.editButton.removeAttribute("aria-busy");
    this.editButton.setAttribute("aria-expanded", "true");
    this.setLauncherStatus("");

    const panel = el("section", "ab-manuscript-recovery");
    panel.setAttribute("role", "alert");
    panel.setAttribute("aria-label", "Saved chapter draft needs attention");
    panel.append(
      el("h2", "ab-manuscript-recovery-title", "Saved draft needs attention"),
      el(
        "p",
        "ab-manuscript-recovery-copy",
        `This saved draft is based on ${
          stored.baseRevision === null ? "an unknown revision" : `revision ${stored.baseRevision}`
        }, while the chapter is now revision ${source.revision}. It has not been discarded or overwritten.`,
      ),
    );
    const preview = el("details", "ab-manuscript-recovery-preview");
    preview.append(el("summary", "", "Preview saved draft"));
    const prose = el("pre", "ab-manuscript-recovery-prose");
    prose.textContent = stored.body;
    preview.append(prose);
    panel.append(preview);

    const actions = el("div", "ab-form-actions ab-manuscript-recovery-actions");
    const validStoredHash = typeof stored.baseContentHash === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(stored.baseContentHash);
    if (stored.baseRevision !== null && validStoredHash) {
      const recover = el("button", "ab-btn ab-primary", "Recover saved draft");
      recover.type = "button";
      recover.addEventListener("click", () => {
        if (this.busy || this.recoveryPanel !== panel) return;
        this.busy = true;
        panel.remove();
        this.recoveryPanel = null;
        void this.mountEditor(
          source,
          stored,
          stored.baseRevision as number,
          stored.baseContentHash as string,
          true,
          generation,
        );
      });
      actions.append(recover);
    } else {
      panel.append(el(
        "p",
        "ab-manuscript-recovery-copy",
        "This draft predates exact source hashes, so it can be previewed and copied but cannot be submitted as a revision.",
      ));
    }
    const discard = el(
      "button",
      "ab-btn ab-danger",
      "Discard saved draft and edit current",
    );
    discard.type = "button";
    discard.addEventListener("click", () => {
      if (this.busy || this.recoveryPanel !== panel) return;
      this.busy = true;
      clearChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
      panel.remove();
      this.recoveryPanel = null;
      void this.mountEditor(
        source,
        null,
        source.revision,
        currentContentHash,
        false,
        generation,
      );
    });
    const keep = el("button", "ab-btn", "Keep saved draft");
    keep.type = "button";
    keep.addEventListener("click", () => {
      if (this.recoveryPanel !== panel) return;
      panel.remove();
      this.recoveryPanel = null;
      this.source = null;
      window.removeEventListener("beforeunload", this.beforeUnload);
      this.editButton!.disabled = false;
      this.editButton!.setAttribute("aria-expanded", "false");
      this.setLauncherStatus("Saved draft kept in this tab.");
      this.editButton!.focus();
    });
    actions.append(discard, keep);
    panel.append(actions);
    this.recoveryPanel = panel;
    this.mountInManuscriptSurface(panel);
    window.addEventListener("beforeunload", this.beforeUnload);
  }

  private async mountEditor(
    source: ChapterSource,
    stored: StoredChapterDraft | null,
    baseRevision: number,
    baseContentHash: string,
    staleBase: boolean,
    generation: number,
  ): Promise<void> {
    if (this.editButton === null || this.prose === null) {
      this.setEditModeAnnounced(false);
      return;
    }
    this.busy = true;
    this.editButton.disabled = true;
    this.editButton.setAttribute("aria-busy", "true");
    this.beginEditorLoading();
    this.source = source;
    this.baseRevision = baseRevision;
    this.baseContentHash = baseContentHash;
    const markdown = stored?.body ?? source.body;
    const shell = el(
      "section",
      "ab-manuscript-editor-shell ab-manuscript-editor-preparing",
    );
    shell.setAttribute("aria-label", `Editing ${source.title || this.cfg.chapterTitle}`);
    if (staleBase) {
      shell.append(el(
        "p",
        "ab-warning ab-manuscript-stale-warning",
        `Recovered draft from revision ${baseRevision}. It remains bound to that older source and may conflict with current revision ${source.revision}.`,
      ));
    }
    const editorRoot = el("div", "ab-manuscript-editor-root");
    const error = el("p", "ab-error ab-manuscript-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const status = el("p", "ab-manuscript-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    const reviewFields = el("div", "ab-manuscript-review-fields");
    const summaryLabel = el("label", "ab-manuscript-summary-field");
    summaryLabel.append(el("span", "ab-field-label", "Change summary (optional)"));
    const summary = el("input", "ab-input ab-manuscript-summary");
    summary.type = "text";
    summary.maxLength = 2000;
    summary.value = stored?.changeSummary ?? "";
    summary.addEventListener("input", () => this.persistDraft());
    summaryLabel.append(summary);
    const notesLabel = el("label", "ab-manuscript-notes-field");
    notesLabel.append(el("span", "ab-field-label", "Notes for reviewer (optional)"));
    const notes = el("textarea", "ab-textarea ab-manuscript-notes");
    notes.rows = 3;
    notes.maxLength = 10_000;
    notes.value = stored?.notes ?? "";
    notes.addEventListener("input", () => this.persistDraft());
    notesLabel.append(notes);
    reviewFields.append(summaryLabel, notesLabel);
    const actions = el("div", "ab-form-actions ab-manuscript-editor-actions");
    const cancel = el("button", "ab-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => void this.cancelEditor());
    const submit = el("button", "ab-btn ab-primary", "Submit for review");
    submit.type = "button";
    submit.dataset.manuscriptSubmit = "review";
    submit.addEventListener("click", () => void this.submitEditor(false));
    actions.append(cancel, submit);
    if (mayApplyRevision(this.store.getState().session)) {
      const apply = el(
        "button",
        "ab-btn ab-primary ab-manuscript-apply",
        "Apply changes",
      );
      apply.type = "button";
      apply.dataset.manuscriptSubmit = "apply";
      apply.addEventListener("click", () => void this.submitEditor(true));
      actions.append(apply);
    }
    shell.append(editorRoot, reviewFields, error, status, actions);
    this.editorShell = shell;
    this.editorRoot = editorRoot;
    this.summaryInput = summary;
    this.notesInput = notes;
    this.errorLine = error;
    this.statusLine = status;
    this.mountInManuscriptSurface(shell);
    this.setEditModeAnnounced(true);

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
        accessibleName: `Chapter text for ${source.title || this.cfg.chapterTitle}`,
        allowBlockNotes: false,
        onMarkdownChange: (body) => {
          this.persistDraft(body);
        },
        onSubmit: (request) => this.requestSubmission(request),
      });
    } catch (caught) {
      if (!this.current(generation)) return;
      await this.destroySession(false);
      this.busy = false;
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
    this.busy = false;
    this.finishEditorLoading(shell);
    this.editButton.setAttribute("aria-expanded", "true");
    this.editButton.removeAttribute("aria-busy");
    this.setLauncherStatus("");
    this.editButton.disabled = false;
    setLabeledButton(this.editButton, "Stop editing", "x");
    this.renderLifecycle(this.currentLifecycle());
    window.addEventListener("beforeunload", this.beforeUnload);
    this.session.focus();
  }

  private async requestSubmission(
    request: ManuscriptSubmitRequest,
  ): Promise<ManuscriptSubmitResult> {
    const source = this.source;
    const baseRevision = this.baseRevision;
    const baseContentHash = this.baseContentHash;
    if (source === null || baseRevision === null || baseContentHash === null) {
      return { ok: false, message: "The chapter base is no longer available." };
    }
    const markdown = canonicalBody(request.markdown);
    if (markdown === "") {
      return { ok: false, message: "Write some text before submitting this revision." };
    }
    if (markdown === canonicalBody(source.body)) {
      return { ok: false, message: "Make a change before submitting this revision." };
    }
    const changeSummary = this.summaryInput?.value.trim() ?? "";
    const notes = this.notesInput?.value.trim() ?? "";
    const draft: ChapterRevisionDraft = {
      chapterId: this.cfg.chapterId,
      title: source.title,
      markdown,
      baseRevision,
      baseContentHash,
      ...(changeSummary === "" ? {} : { changeSummary }),
      ...(notes === "" ? {} : { notes }),
      ...(this.applyImmediately ? { applyImmediately: true } : {}),
    };
    const detail: ChapterRevisionSubmitEventDetail = { draft, handle: null };
    this.dispatchEvent(new CustomEvent<ChapterRevisionSubmitEventDetail>(
      CHAPTER_REVISION_SUBMIT_EVENT,
      { bubbles: true, composed: true, detail },
    ));
    if (detail.handle !== null) {
      return detail.handle(draft);
    }
    const command: ChapterRevisionProposalCommand = {
      proposalType: "chapter_replacement",
      chapterId: draft.chapterId,
      baseRevision: draft.baseRevision,
      baseContentHash: draft.baseContentHash,
      proposedContent: draft.markdown,
      ...(draft.changeSummary === undefined ? {} : { changeSummary: draft.changeSummary }),
      ...(draft.notes === undefined ? {} : { notes: draft.notes }),
      ...(draft.applyImmediately === true ? { applyImmediately: true } : {}),
    };
    const result = await this.store.getState().proposeChapterRevision(command);
    return result.ok
      ? {
          ok: true,
          proposalId: result.value.proposalId,
          operationId: result.value.operationId,
          correlationId: result.value.correlationId,
          message: draft.applyImmediately === true
            ? "Changes are applying. This page will update after deployment."
            : "Revision submitted for review.",
        }
      : { ok: false, message: result.message, status: result.status };
  }

  private async submitEditor(applyImmediately: boolean): Promise<void> {
    const session = this.session;
    const error = this.errorLine;
    const status = this.statusLine;
    if (session === null || error === null || status === null || this.busy) return;
    const me = this.store.getState().session;
    if (!mayProposeRevision(me)) {
      this.showEditorError("You no longer have permission to submit this revision.");
      return;
    }
    if (applyImmediately && !mayApplyRevision(me)) {
      this.showEditorError("You no longer have permission to apply this revision.");
      return;
    }
    this.persistDraft();
    this.busy = true;
    this.applyImmediately = applyImmediately;
    this.setEditorBusy(true);
    error.hidden = true;
    status.textContent = applyImmediately
      ? "Applying chapter changes…"
      : "Submitting the chapter for review…";
    status.hidden = false;
    let result: ManuscriptSubmitResult;
    try {
      result = await session.submit();
    } catch (caught) {
      result = { ok: false, message: caught instanceof Error ? caught.message : String(caught) };
    }
    this.applyImmediately = false;
    this.busy = false;
    this.setEditorBusy(false);
    if (!result.ok) {
      const prefix = result.status === 409
        ? "The chapter changed after this editor opened. Your draft is still here. "
        : "";
      error.textContent = `${prefix}${result.message ?? "The revision could not be submitted."}`;
      error.hidden = false;
      status.hidden = true;
      this.persistDraft();
      const lifecycle = this.currentLifecycle();
      if (lifecycle?.proposalId !== null && lifecycle?.proposalId !== undefined) {
        this.renderLifecycle(lifecycle);
      }
      return;
    }
    if (result.proposalId !== undefined) {
      this.persistSubmittedDraft(result);
    } else {
      // A compatibility handler owns its own durable state and cannot be
      // reconciled by this store without a proposal identifier.
      clearChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
    }
    await this.destroySession(false);
    if (result.proposalId === undefined) {
      this.setLauncherStatus(
        result.message ?? (applyImmediately
          ? "Changes are applying. This page will update after deployment."
          : "Revision submitted for review."),
      );
    } else {
      this.renderLifecycle(this.currentLifecycle());
    }
    this.editButton?.focus();
  }

  private async cancelEditor(): Promise<void> {
    if (this.busy) return;
    if (this.isDirty() && !window.confirm("Discard this in-progress chapter edit?")) {
      return;
    }
    clearChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
    if (this.target !== null) this.store.getState().forgetEditorRevision(this.target.key);
    await this.destroySession(true);
  }

  private async destroySession(restoreFocus: boolean): Promise<void> {
    window.removeEventListener("beforeunload", this.beforeUnload);
    this.busy = true;
    this.applyImmediately = false;
    const session = this.session;
    this.session = null;
    try {
      if (session !== null) await session.destroy();
    } catch {
      // The editor shell and static manuscript are owned here, not by the lazy
      // surface. Teardown must remain fail-safe even if a third-party editor
      // plugin rejects while destroying itself.
    } finally {
      this.editorShell?.remove();
      this.editorShell = null;
      this.editorRoot = null;
      this.summaryInput = null;
      this.notesInput = null;
      this.errorLine = null;
      this.statusLine = null;
      this.source = null;
      this.baseRevision = null;
      this.baseContentHash = null;
      this.recoveryPanel?.remove();
      this.recoveryPanel = null;
      this.clearEditorLoading();
      if (this.prose !== null) this.prose.hidden = false;
      if (this.editButton !== null) {
        this.editButton.setAttribute("aria-expanded", "false");
        this.editButton.disabled = false;
        this.editButton.removeAttribute("aria-busy");
        setLabeledButton(this.editButton, "Edit chapter", "pencil");
      }
      this.busy = false;
      // Re-enable annotation/suggestion entry only after the editor shell is
      // gone and the static manuscript is visible again.
      this.setEditModeAnnounced(false);
      this.syncNavigationWarning();
      if (restoreFocus) this.editButton?.focus();
    }
  }

  private setEditModeAnnounced(
    active: boolean,
    collab = this.chapterCollab(),
  ): void {
    if (active) {
      this.setAttribute(CHAPTER_EDIT_ACTIVE_ATTRIBUTE, "true");
    } else {
      this.removeAttribute(CHAPTER_EDIT_ACTIVE_ATTRIBUTE);
    }
    if (this.editModeAnnounced === active) return;
    this.editModeAnnounced = active;
    if (active) {
      this.editModeCollab = collab ?? null;
      collab?.setChapterEditMode?.(true);
      return;
    }
    const announcedCollab = this.editModeCollab;
    this.editModeCollab = null;
    announcedCollab?.setChapterEditMode?.(false);
    if (collab !== announcedCollab) collab?.setChapterEditMode?.(false);
  }

  private chapterCollab(): ChapterCollabElement | undefined {
    return [...document.querySelectorAll<ChapterCollabElement>("authorbot-collab")]
      .find((candidate) => candidate.dataset.chapterId === this.cfg.chapterId);
  }

  private currentLifecycle(): EditorRevisionState | undefined {
    const key = this.target?.key;
    return key === undefined ? undefined : this.store.getState().editorRevisionsByTargetKey[key];
  }

  private needsRecoveryWarning(): boolean {
    return editorRevisionNeedsRecoveryWarning(this.currentLifecycle());
  }

  private syncNavigationWarning(): void {
    window.removeEventListener("beforeunload", this.beforeUnload);
    if (!this.started || !this.isConnected) return;
    if (this.isDirty() || this.needsRecoveryWarning()) {
      window.addEventListener("beforeunload", this.beforeUnload);
    }
  }

  private persistSubmittedDraft(result: ManuscriptSubmitResult): void {
    const source = this.source;
    const baseRevision = this.baseRevision;
    const baseContentHash = this.baseContentHash;
    if (
      source === null || baseRevision === null || baseContentHash === null ||
      result.proposalId === undefined
    ) return;
    let body: string;
    try {
      body = this.session?.getMarkdown() ?? source.body;
    } catch {
      return;
    }
    saveChapterDraft(storageOrNull(), this.cfg.project, {
      chapterId: this.cfg.chapterId,
      title: source.title,
      body,
      baseRevision,
      baseContentHash,
      changeSummary: this.summaryInput?.value ?? "",
      notes: this.notesInput?.value ?? "",
      proposalId: result.proposalId,
      proposalOperationId: result.operationId ?? null,
      proposalCorrelationId: result.correlationId ?? null,
      proposalCommitSha: null,
      proposalPhase: this.currentLifecycle()?.phase ?? (result.operationId === null
        ? "pending_review"
        : "applying"),
      proposalError: null,
      caret: null,
      focus: "body",
    });
  }

  private persistLifecycleMetadata(state: EditorRevisionState): void {
    if (state.proposalId === null) return;
    const stored = loadChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
    if (stored === null ||
        (stored.proposalId !== undefined && stored.proposalId !== state.proposalId)) {
      return;
    }
    saveChapterDraft(storageOrNull(), this.cfg.project, {
      ...stored,
      proposalId: state.proposalId,
      proposalOperationId: state.operationId,
      proposalCorrelationId: state.correlationId,
      proposalCommitSha: state.commitSha,
      proposalPhase: state.phase,
      proposalError: state.error,
    });
  }

  private renderLifecycle(state: EditorRevisionState | undefined): void {
    if (state === undefined) {
      delete this.dataset["editorRevisionPhase"];
      delete this.dataset["editorProposalId"];
      this.setLauncherStatus("");
      if (this.editButton !== null) {
        const editing = this.editorShell !== null;
        this.editButton.disabled = this.busy;
        setLabeledButton(
          this.editButton,
          editing ? "Stop editing" : "Edit chapter",
          editing ? "x" : "pencil",
        );
      }
      this.syncNavigationWarning();
      return;
    }
    this.dataset["editorRevisionPhase"] = state.phase;
    if (state.proposalId === null) {
      delete this.dataset["editorProposalId"];
    } else {
      this.dataset["editorProposalId"] = state.proposalId;
    }
    this.persistLifecycleMetadata(state);
    if (state.phase === "deployed" && state.proposalId !== null) {
      const stored = loadChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
      if (stored?.proposalId === state.proposalId) {
        clearChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
      }
    }
    const accepted = state.proposalId !== null && state.phase !== "save_failed" &&
      state.phase !== "rejected" && state.phase !== "apply_failed";
    if (this.editorShell !== null && !this.busy && accepted) {
      if (!this.closingAcceptedEditor) {
        this.closingAcceptedEditor = true;
        void this.destroySession(false).finally(() => {
          this.closingAcceptedEditor = false;
          if (this.started) this.renderLifecycle(this.currentLifecycle());
        });
      }
      return;
    }
    const message = editorRevisionMessage(state, "chapter");
    const failed = state.phase === "save_failed" || state.phase === "apply_failed" ||
      state.phase === "deployment_failed";
    if (this.editorShell !== null && this.statusLine !== null && this.errorLine !== null) {
      this.statusLine.textContent = message;
      this.statusLine.hidden = failed;
      if (failed) {
        this.errorLine.textContent = message;
        this.errorLine.hidden = false;
      } else {
        this.errorLine.hidden = true;
      }
    } else {
      this.setLauncherStatus(message, failed);
    }
    if (this.editButton !== null && this.editorShell === null) {
      const locked = state.phase === "saving" || state.phase === "pending_review" ||
        state.phase === "applying" || state.phase === "integrated" ||
        state.phase === "publishing" || state.phase === "deployment_failed";
      this.editButton.disabled = locked;
      setLabeledButton(
        this.editButton,
        state.phase === "rejected" || state.phase === "apply_failed" ||
            state.phase === "save_failed"
          ? "Edit submitted draft"
          : "Edit chapter",
        "pencil",
      );
    } else if (this.editButton !== null && this.editorShell !== null) {
      this.editButton.disabled = this.busy;
      setLabeledButton(this.editButton, "Stop editing", "x");
    }
    this.syncNavigationWarning();
  }

  private isDirty(): boolean {
    if (this.recoveryPanel !== null) return true;
    let proseChanged = this.session?.dirty === true;
    if (this.session !== null && this.source !== null) {
      try {
        proseChanged = this.baseRevision !== this.source.revision ||
          this.baseContentHash !== sourceContentHash(this.source) ||
          canonicalBody(this.session.getMarkdown()) !== canonicalBody(this.source.body);
      } catch {
        // The surface's own dirty flag remains the safe loss-warning fallback.
      }
    }
    return proseChanged || (this.summaryInput?.value.trim() ?? "") !== "" ||
      (this.notesInput?.value.trim() ?? "") !== "";
  }

  private persistDraft(markdown?: string): void {
    const source = this.source;
    const baseRevision = this.baseRevision;
    const baseContentHash = this.baseContentHash;
    if (source === null || baseRevision === null || baseContentHash === null) return;
    let body = markdown;
    if (body === undefined) {
      try {
        body = this.session?.getMarkdown() ?? source.body;
      } catch {
        return;
      }
    }
    const baseMatchesCurrent = baseRevision === source.revision &&
      baseContentHash === sourceContentHash(source);
    const lifecycle = this.currentLifecycle();
    const recoverableLifecycle = editorRevisionNeedsRecoveryWarning(lifecycle)
      ? lifecycle
      : undefined;
    if (
      baseMatchesCurrent &&
      canonicalBody(body) === canonicalBody(source.body) &&
      (this.summaryInput?.value.trim() ?? "") === "" &&
      (this.notesInput?.value.trim() ?? "") === "" &&
      recoverableLifecycle?.proposalId == null
    ) {
      clearChapterDraft(storageOrNull(), this.cfg.project, this.cfg.chapterId);
      return;
    }
    saveChapterDraft(storageOrNull(), this.cfg.project, {
      chapterId: this.cfg.chapterId,
      title: source.title,
      body,
      baseRevision,
      baseContentHash,
      changeSummary: this.summaryInput?.value ?? "",
      notes: this.notesInput?.value ?? "",
      ...(recoverableLifecycle?.proposalId === null || recoverableLifecycle?.proposalId === undefined
        ? {}
        : {
            proposalId: recoverableLifecycle.proposalId,
            proposalOperationId: recoverableLifecycle.operationId,
            proposalCorrelationId: recoverableLifecycle.correlationId,
            proposalCommitSha: recoverableLifecycle.commitSha,
            proposalPhase: recoverableLifecycle.phase,
            proposalError: recoverableLifecycle.error,
          }),
      caret: null,
      focus: "body",
    });
  }

  private setEditorBusy(busy: boolean): void {
    for (const button of this.editorShell?.querySelectorAll<HTMLButtonElement>("button") ?? []) {
      button.disabled = busy;
    }
    if (this.summaryInput !== null) this.summaryInput.disabled = busy;
    if (this.notesInput !== null) this.notesInput.disabled = busy;
    if (this.editButton !== null && this.editorShell !== null) {
      this.editButton.disabled = busy;
      setLabeledButton(this.editButton, "Stop editing", "x");
    }
  }

  private showEditorError(message: string): void {
    if (this.errorLine === null || this.statusLine === null) return;
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
    this.statusLine.hidden = true;
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

  private mountInManuscriptSurface(node: HTMLElement): void {
    const surface = this.manuscriptSurface;
    const prose = this.prose;
    if (surface !== null && prose !== null && prose.parentElement === surface) {
      prose.before(node);
      return;
    }
    this.append(node);
  }

  private beginEditorLoading(): void {
    const surface = this.manuscriptSurface;
    const prose = this.prose;
    if (surface === null || prose === null || this.loadingOverlay !== null) return;
    surface.classList.add("ab-manuscript-source-loading");
    prose.classList.add("ab-manuscript-source-loading-prose");
    const overlay = el("div", "ab-manuscript-source-loading-overlay");
    overlay.setAttribute("role", "status");
    overlay.append(
      el("span", "ab-manuscript-loading-spinner"),
      el("span", undefined, "Loading chapter editor…"),
    );
    surface.append(overlay);
    this.loadingOverlay = overlay;
  }

  private finishEditorLoading(shell: HTMLElement): void {
    if (this.prose !== null) this.prose.hidden = true;
    shell.classList.remove("ab-manuscript-editor-preparing");
    this.clearEditorLoading();
  }

  private clearEditorLoading(): void {
    this.manuscriptSurface?.classList.remove("ab-manuscript-source-loading");
    this.prose?.classList.remove("ab-manuscript-source-loading-prose");
    this.editorShell?.classList.remove("ab-manuscript-editor-preparing");
    this.loadingOverlay?.remove();
    this.loadingOverlay = null;
  }
}
