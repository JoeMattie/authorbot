/**
 * Permission-gated editor for repository-backed story planning documents.
 *
 * The generated Outline, Timeline, and Character views remain the default.
 * Source is requested only after Edit is activated. YAML stays in a canonical
 * source textarea; character prose uses the same lazy Milkdown surface as the
 * manuscript while its schema-bearing frontmatter remains explicitly editable.
 */
import {
  hasEffectiveCapability,
  roleOf,
  type RepositoryDocumentKind,
  type RepositoryDocumentProposalCommand,
  type RepositoryDocumentSource,
  type RevisionProposalAccepted,
} from "./api.js";
import { el, labeledButton, setLabeledButton } from "./dom.js";
import {
  editorRevisionMessage,
  editorRevisionNeedsRecoveryWarning,
  isEditorRevisionPhase,
  repositoryEditorRevisionTarget,
  type EditorRevisionState,
  type EditorRevisionTarget,
} from "./editor-revision-state.js";
import { createLazyManuscriptSurface } from "./manuscript-surface-loader.js";
import type { ManuscriptSurfaceSession } from "./manuscript-surface.js";
import type { ProjectStore } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

interface Config {
  apiBase: string;
  project: string;
  kind: RepositoryDocumentKind;
  targetId: string;
  path: string;
  label: string;
  readingId: string;
}

interface StoredDraft {
  baseContentHash: string;
  content: string;
  changeSummary: string;
  proposalId?: string;
  proposalOperationId?: string | null;
  proposalCorrelationId?: string | null;
  proposalCommitSha?: string | null;
  proposalPhase?: string;
  proposalError?: string | null;
}

export interface CharacterDocumentParts {
  metadata: string;
  body: string;
}

let editorSequence = 0;

function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project, kind, targetId, path, label, readingId } = host.dataset;
  if (
    apiBase === undefined ||
    project === undefined ||
    (kind !== "outline" && kind !== "timeline" && kind !== "character") ||
    targetId === undefined ||
    targetId === "" ||
    path === undefined ||
    path === "" ||
    readingId === undefined ||
    readingId === ""
  ) {
    return null;
  }
  return {
    apiBase,
    project,
    kind,
    targetId,
    path,
    label: label?.trim() || (kind === "character" ? "Character" : kind),
    readingId,
  };
}

function storageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function draftKey(config: Config): string {
  return `authorbot.planning-document-draft.v1:${config.project}:${config.kind}:${config.path}`;
}

function readDraft(config: Config): StoredDraft | null {
  const storage = storageOrNull();
  if (storage === null) return null;
  try {
    const value = storage.getItem(draftKey(config));
    if (value === null) return null;
    const parsed = JSON.parse(value) as Partial<StoredDraft>;
    if (
      typeof parsed.baseContentHash !== "string" ||
      typeof parsed.content !== "string" ||
      typeof parsed.changeSummary !== "string"
    ) {
      return null;
    }
    return {
      baseContentHash: parsed.baseContentHash,
      content: parsed.content,
      changeSummary: parsed.changeSummary,
      ...(typeof parsed.proposalId === "string" ? { proposalId: parsed.proposalId } : {}),
      ...(typeof parsed.proposalOperationId === "string" || parsed.proposalOperationId === null
        ? { proposalOperationId: parsed.proposalOperationId }
        : {}),
      ...(typeof parsed.proposalCorrelationId === "string" ||
          parsed.proposalCorrelationId === null
        ? { proposalCorrelationId: parsed.proposalCorrelationId }
        : {}),
      ...(typeof parsed.proposalCommitSha === "string" || parsed.proposalCommitSha === null
        ? { proposalCommitSha: parsed.proposalCommitSha }
        : {}),
      ...(typeof parsed.proposalPhase === "string"
        ? { proposalPhase: parsed.proposalPhase }
        : {}),
      ...(typeof parsed.proposalError === "string" || parsed.proposalError === null
        ? { proposalError: parsed.proposalError }
        : {}),
    };
  } catch {
    return null;
  }
}

function writeDraft(config: Config, draft: StoredDraft): void {
  try {
    storageOrNull()?.setItem(draftKey(config), JSON.stringify(draft));
  } catch {
    // Storage is a recovery convenience, never a requirement for editing.
  }
}

function clearDraft(config: Config): void {
  try {
    storageOrNull()?.removeItem(draftKey(config));
  } catch {
    // A denied storage API must not prevent a successful proposal.
  }
}

/** Same canonical text boundary used by the repository-document validator. */
export function canonicalRepositoryContent(source: string): string {
  return `${source.replace(/\r\n?/gu, "\n").trimEnd()}\n`;
}

/** Split schema frontmatter from prose without interpreting author data. */
export function splitCharacterDocument(source: string): CharacterDocumentParts | null {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/u.exec(normalized);
  if (match === null) return null;
  return {
    metadata: match[1] ?? "",
    body: (match[2] ?? "").replace(/^\n+/u, "").trimEnd(),
  };
}

/** Reassemble the complete character artifact submitted to validation/Git. */
export function joinCharacterDocument(metadata: string, body: string): string {
  return canonicalRepositoryContent(
    `---\n${metadata.replace(/\r\n?/gu, "\n").trimEnd()}\n---\n\n${body}`,
  );
}

function mayEdit(store: ProjectStore): boolean {
  return hasEffectiveCapability(
    store.getState().session,
    "revisions:write",
    "revisions:write",
  );
}

function mayApply(store: ProjectStore): boolean {
  const session = store.getState().session;
  return roleOf(session) === "maintainer" &&
    hasEffectiveCapability(session, "revisions:write", "revisions:write") &&
    hasEffectiveCapability(session, "revisions:review", "revisions:review");
}

export class AuthorbotPlanningDocumentEditor extends HTMLElement {
  private cfg!: Config;
  private store!: ProjectStore;
  private reading: HTMLElement | null = null;
  private editButton: HTMLButtonElement | null = null;
  private shell: HTMLElement | null = null;
  private editorRoot: HTMLElement | null = null;
  private rawTextarea: HTMLTextAreaElement | null = null;
  private metadataTextarea: HTMLTextAreaElement | null = null;
  private summaryInput: HTMLInputElement | null = null;
  private errorLine: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private source: RepositoryDocumentSource | null = null;
  private baseContentHash: string | null = null;
  private characterBody = "";
  private session: ManuscriptSurfaceSession | null = null;
  private started = false;
  private busy = false;
  private generation = 0;
  private target: EditorRevisionTarget | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private closingAcceptedEditor = false;
  private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.isDirty() && !this.needsRecoveryWarning()) return;
    event.preventDefault();
  };

  connectedCallback(): void {
    if (this.started) return;
    this.started = true;
    const config = parseConfig(this);
    if (config === null) return;
    this.cfg = config;
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
    void this.destroyEditor(false);
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
      return; // progressive enhancement leaves the static story page untouched
    }
    if (!this.current(generation)) return;
    this.store = store;
    if (store.getState().sessionStatus !== "ready" || !mayEdit(store)) return;
    this.reading = document.getElementById(this.cfg.readingId);
    if (this.reading === null) return;
    this.target = repositoryEditorRevisionTarget(this.cfg.kind, this.cfg.path);
    this.renderLauncher();
    this.unsubscribeStore = store.subscribe((state, before) => {
      const key = this.target?.key;
      if (key === undefined ||
          state.editorRevisionsByTargetKey[key] === before.editorRevisionsByTargetKey[key]) {
        return;
      }
      this.renderLifecycle(state.editorRevisionsByTargetKey[key]);
    });
    const stored = readDraft(this.cfg);
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
    this.replaceChildren();
    const controls = el("div", "ab-planning-launcher");
    controls.setAttribute("aria-label", `${this.cfg.label} editing`);
    const edit = labeledButton(
      "ab-btn ab-planning-edit",
      "Edit",
      "pencil",
    );
    edit.setAttribute("aria-expanded", "false");
    edit.addEventListener("click", () => {
      if (this.shell === null) {
        void this.openEditor();
      } else {
        void this.cancelEditor();
      }
    });
    this.editButton = edit;
    controls.append(edit);
    this.append(controls);
  }

  private async openEditor(): Promise<void> {
    if (this.editButton === null || this.reading === null || this.shell !== null || this.busy) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.editButton.disabled = true;
    this.setLauncherStatus(`Loading ${this.cfg.label} source…`);
    const result = await this.store.getState().readRepositoryDocument(
      this.cfg.kind,
      this.cfg.path,
    );
    if (!this.current(generation)) return;
    this.busy = false;
    this.editButton.disabled = false;
    if (!result.ok) {
      this.setLauncherStatus(
        `The ${this.cfg.label} editor could not open: ${result.message}`,
        true,
      );
      return;
    }
    if (
      result.value.target.kind !== this.cfg.kind ||
      result.value.target.id !== this.cfg.targetId ||
      result.value.target.path !== this.cfg.path
    ) {
      this.setLauncherStatus(
        `The ${this.cfg.label} editor could not open: the source identity did not match this page.`,
        true,
      );
      return;
    }
    this.source = result.value;
    const draft = readDraft(this.cfg);
    this.baseContentHash = draft?.baseContentHash ?? result.value.contentHash;
    const content = draft?.content ?? result.value.content;
    this.buildShell(
      draft?.changeSummary ?? "",
      draft !== null && draft.baseContentHash !== result.value.contentHash,
    );
    try {
      if (this.cfg.kind === "character") {
        await this.mountCharacterEditor(content);
      } else {
        this.mountYamlEditor(content);
      }
    } catch (caught) {
      if (!this.current(generation)) return;
      await this.destroyEditor(false);
      this.editButton.disabled = false;
      this.setLauncherStatus(
        `The ${this.cfg.label} editor could not open: ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
        true,
      );
      return;
    }
    if (!this.current(generation)) {
      await this.destroyEditor(false);
      return;
    }
    this.reading.hidden = true;
    this.editButton.setAttribute("aria-expanded", "true");
    this.editButton.disabled = false;
    this.setLauncherStatus("");
    this.renderLifecycle(this.currentLifecycle());
    window.addEventListener("beforeunload", this.beforeUnload);
    if (this.session !== null) {
      this.session.focus();
    } else {
      this.rawTextarea?.focus();
    }
  }

  private buildShell(changeSummary: string, staleBase: boolean): void {
    const shellId = `ab-planning-editor-${++editorSequence}`;
    const shell = el("section", "ab-planning-editor-shell");
    shell.id = shellId;
    shell.setAttribute("aria-label", `Editing ${this.cfg.label}`);
    shell.append(el("h2", "ab-planning-editor-title", `Editing ${this.cfg.label}`));
    if (staleBase) {
      shell.append(el(
        "p",
        "ab-warning ab-planning-stale-warning",
        "This recovered draft is based on an older repository version. It has not been replaced. Submitting it may report a conflict, and Cancel lets you discard it explicitly.",
      ));
    }
    const editorRoot = el("div", "ab-planning-editor-root");
    shell.append(editorRoot);

    const summaryLabel = el("label", "ab-planning-summary-field");
    summaryLabel.append(el("span", "ab-field-label", "Change summary (optional)"));
    const summary = el("input", "ab-input ab-planning-summary");
    summary.type = "text";
    summary.maxLength = 2000;
    summary.value = changeSummary;
    summary.addEventListener("input", () => this.persistDraft());
    summaryLabel.append(summary);
    shell.append(summaryLabel);

    const error = el("p", "ab-error ab-planning-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const status = el("p", "ab-planning-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;
    shell.append(error, status);

    const actions = el("div", "ab-form-actions ab-planning-actions");
    const cancel = el("button", "ab-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => void this.cancelEditor());
    const submit = el("button", "ab-btn ab-primary", "Submit for review");
    submit.type = "button";
    submit.dataset.planningSubmit = "review";
    submit.addEventListener("click", () => void this.submitEditor(false));
    actions.append(cancel, submit);
    if (mayApply(this.store)) {
      const apply = el("button", "ab-btn ab-primary ab-planning-apply", "Apply changes");
      apply.type = "button";
      apply.dataset.planningSubmit = "apply";
      apply.addEventListener("click", () => void this.submitEditor(true));
      actions.append(apply);
    }
    shell.append(actions);

    this.shell = shell;
    this.editorRoot = editorRoot;
    this.summaryInput = summary;
    this.errorLine = error;
    this.statusLine = status;
    this.editButton?.setAttribute("aria-controls", shellId);
    this.reading?.before(shell);
  }

  private mountYamlEditor(content: string): void {
    const field = el("label", "ab-planning-source-field");
    field.append(
      el(
        "span",
        "ab-field-label",
        this.cfg.kind === "outline" ? "Outline YAML" : "Timeline YAML",
      ),
    );
    const textarea = el("textarea", "ab-textarea ab-planning-source");
    textarea.rows = 28;
    textarea.spellcheck = false;
    textarea.value = content;
    textarea.addEventListener("input", () => this.persistDraft());
    field.append(textarea);
    this.editorRoot?.append(field);
    this.rawTextarea = textarea;
  }

  private async mountCharacterEditor(content: string): Promise<void> {
    const parts = splitCharacterDocument(content);
    if (parts === null) {
      throw new Error("the character source has no valid frontmatter boundary");
    }
    this.characterBody = parts.body;
    const metadataField = el("label", "ab-planning-metadata-field");
    metadataField.append(el("span", "ab-field-label", "Character metadata (YAML)"));
    const metadata = el("textarea", "ab-textarea ab-planning-metadata");
    metadata.rows = 9;
    metadata.spellcheck = false;
    metadata.value = parts.metadata;
    metadata.addEventListener("input", () => this.persistDraft());
    metadataField.append(metadata);
    const bodyLabel = el("p", "ab-field-label ab-planning-body-label", "Character notes");
    const bodyRoot = el(
      "div",
      "ab-manuscript-editor-root ab-planning-milkdown-root",
    );
    this.editorRoot?.append(metadataField, bodyLabel, bodyRoot);
    this.metadataTextarea = metadata;
    this.session = await createLazyManuscriptSurface({
      root: bodyRoot,
      markdown: parts.body,
      blockIds: [],
      activation: "edit",
      accessibleName: `Character notes for ${this.cfg.label}`,
      allowBlockNotes: false,
      onMarkdownChange: (markdown) => {
        this.characterBody = markdown;
        this.persistDraft();
      },
    });
  }

  private currentContent(): string | null {
    if (this.cfg.kind === "character") {
      if (this.metadataTextarea === null) return null;
      return joinCharacterDocument(this.metadataTextarea.value, this.characterBody);
    }
    return this.rawTextarea === null
      ? null
      : canonicalRepositoryContent(this.rawTextarea.value);
  }

  private isDirty(): boolean {
    const source = this.source;
    const content = this.currentContent();
    if (source === null || content === null) return false;
    return this.baseContentHash !== source.contentHash ||
      content !== canonicalRepositoryContent(source.content) ||
      (this.summaryInput?.value.trim() ?? "") !== "";
  }

  private persistDraft(): void {
    const source = this.source;
    const content = this.currentContent();
    const baseContentHash = this.baseContentHash;
    if (source === null || content === null || baseContentHash === null) return;
    const lifecycle = this.currentLifecycle();
    const recoverableLifecycle = editorRevisionNeedsRecoveryWarning(lifecycle)
      ? lifecycle
      : undefined;
    if (!this.isDirty() && recoverableLifecycle === undefined) {
      clearDraft(this.cfg);
      return;
    }
    writeDraft(this.cfg, {
      baseContentHash,
      content,
      changeSummary: this.summaryInput?.value ?? "",
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
    });
  }

  private async submitEditor(applyImmediately: boolean): Promise<void> {
    if (
      this.busy || this.source === null || this.baseContentHash === null ||
      this.errorLine === null || this.statusLine === null
    ) {
      return;
    }
    if (applyImmediately && !mayApply(this.store)) {
      this.showEditorError("You no longer have permission to apply this revision.");
      return;
    }
    let content: string | null;
    try {
      if (this.cfg.kind === "character" && this.session !== null) {
        this.characterBody = this.session.getMarkdown();
      }
      content = this.currentContent();
    } catch (caught) {
      this.showEditorError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    if (content === null) return;
    if (content === canonicalRepositoryContent(this.source.content)) {
      this.showEditorError("Make a change before submitting this revision.");
      return;
    }

    const command: RepositoryDocumentProposalCommand = {
      proposalType: "repository_document",
      targetKind: this.cfg.kind,
      targetPath: this.cfg.path,
      baseContentHash: this.baseContentHash,
      proposedContent: content,
      ...(this.summaryInput?.value.trim()
        ? { changeSummary: this.summaryInput.value.trim() }
        : {}),
      ...(applyImmediately ? { applyImmediately: true } : {}),
    };
    this.busy = true;
    this.setEditorBusy(true);
    this.errorLine.hidden = true;
    this.statusLine.textContent = applyImmediately
      ? `Applying ${this.cfg.label} changes…`
      : `Submitting ${this.cfg.label} changes for review…`;
    this.statusLine.hidden = false;
    const result = await this.store.getState().proposeRepositoryDocument(command);
    if (!this.started) return;
    this.busy = false;
    this.setEditorBusy(false);
    if (!result.ok) {
      const prefix = result.status === 409
        ? "The source changed after this editor opened. Your draft is still here. "
        : "";
      this.showEditorError(`${prefix}${result.message}`);
      this.persistDraft();
      const lifecycle = this.currentLifecycle();
      if (lifecycle?.proposalId !== null && lifecycle?.proposalId !== undefined) {
        this.renderLifecycle(lifecycle);
      }
      return;
    }

    this.persistSubmittedDraft(result.value);
    await this.destroyEditor(false);
    this.renderLifecycle(this.currentLifecycle());
    this.editButton?.focus();
  }

  private setEditorBusy(busy: boolean): void {
    for (const button of this.shell?.querySelectorAll<HTMLButtonElement>("button") ?? []) {
      button.disabled = busy;
    }
    if (this.rawTextarea !== null) this.rawTextarea.disabled = busy;
    if (this.metadataTextarea !== null) this.metadataTextarea.disabled = busy;
    if (this.summaryInput !== null) this.summaryInput.disabled = busy;
  }

  private showEditorError(message: string): void {
    if (this.errorLine === null || this.statusLine === null) return;
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
    this.statusLine.hidden = true;
  }

  private async cancelEditor(): Promise<void> {
    if (this.busy) return;
    if (this.isDirty() && !window.confirm(`Discard this in-progress ${this.cfg.label} edit?`)) {
      return;
    }
    clearDraft(this.cfg);
    if (this.target !== null) this.store.getState().forgetEditorRevision(this.target.key);
    await this.destroyEditor(true);
  }

  private async destroyEditor(restoreFocus: boolean): Promise<void> {
    window.removeEventListener("beforeunload", this.beforeUnload);
    this.busy = false;
    const session = this.session;
    this.session = null;
    if (session !== null) await session.destroy();
    this.shell?.remove();
    this.shell = null;
    this.editorRoot = null;
    this.rawTextarea = null;
    this.metadataTextarea = null;
    this.summaryInput = null;
    this.errorLine = null;
    this.statusLine = null;
    this.source = null;
    this.baseContentHash = null;
    this.characterBody = "";
    if (this.reading !== null) this.reading.hidden = false;
    if (this.editButton !== null) {
      this.editButton.setAttribute("aria-expanded", "false");
      this.editButton.removeAttribute("aria-controls");
      setLabeledButton(this.editButton, "Edit", "pencil");
      if (restoreFocus) this.editButton.focus();
    }
    this.syncNavigationWarning();
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

  private persistSubmittedDraft(accepted: RevisionProposalAccepted): void {
    const source = this.source;
    const content = this.currentContent();
    const baseContentHash = this.baseContentHash;
    if (source === null || content === null || baseContentHash === null) return;
    writeDraft(this.cfg, {
      baseContentHash,
      content,
      changeSummary: this.summaryInput?.value ?? "",
      proposalId: accepted.proposalId,
      proposalOperationId: accepted.operationId,
      proposalCorrelationId: accepted.correlationId,
      proposalCommitSha: null,
      proposalPhase: this.currentLifecycle()?.phase ?? (accepted.operationId === null
        ? "pending_review"
        : "applying"),
      proposalError: null,
    });
  }

  private persistLifecycleMetadata(state: EditorRevisionState): void {
    if (state.proposalId === null) return;
    const stored = readDraft(this.cfg);
    if (stored === null ||
        (stored.proposalId !== undefined && stored.proposalId !== state.proposalId)) {
      return;
    }
    writeDraft(this.cfg, {
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
        this.editButton.disabled = this.busy;
        setLabeledButton(
          this.editButton,
          this.shell === null ? "Edit" : "Stop editing",
          this.shell === null ? "pencil" : "x",
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
      const stored = readDraft(this.cfg);
      if (stored?.proposalId === state.proposalId) clearDraft(this.cfg);
    }
    const accepted = state.proposalId !== null && state.phase !== "save_failed" &&
      state.phase !== "rejected" && state.phase !== "apply_failed";
    if (this.shell !== null && !this.busy && accepted) {
      if (!this.closingAcceptedEditor) {
        this.closingAcceptedEditor = true;
        void this.destroyEditor(false).finally(() => {
          this.closingAcceptedEditor = false;
          if (this.started) this.renderLifecycle(this.currentLifecycle());
        });
      }
      return;
    }
    const label = this.cfg.label.toLowerCase();
    const message = editorRevisionMessage(state, label);
    const failed = state.phase === "save_failed" || state.phase === "apply_failed" ||
      state.phase === "deployment_failed";
    if (this.shell !== null && this.statusLine !== null && this.errorLine !== null) {
      if (this.editButton !== null) {
        this.editButton.disabled = this.busy;
        setLabeledButton(this.editButton, "Stop editing", "x");
      }
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
    if (this.editButton !== null && this.shell === null) {
      const locked = state.phase === "saving" || state.phase === "pending_review" ||
        state.phase === "applying" || state.phase === "integrated" ||
        state.phase === "publishing" || state.phase === "deployment_failed";
      this.editButton.disabled = locked;
      setLabeledButton(
        this.editButton,
        state.phase === "rejected" || state.phase === "apply_failed" ||
            state.phase === "save_failed"
          ? "Edit draft"
          : "Edit",
        "pencil",
      );
    }
    this.syncNavigationWarning();
  }

  private setLauncherStatus(message: string, error = false): void {
    let line = this.querySelector<HTMLElement>(".ab-planning-launcher-status");
    if (message === "") {
      line?.remove();
      return;
    }
    if (line === null) {
      line = el("p", "ab-planning-launcher-status");
      this.querySelector(".ab-planning-launcher")?.append(line);
    }
    line.classList.toggle("ab-error", error);
    line.setAttribute("role", error ? "alert" : "status");
    line.textContent = message;
  }
}
