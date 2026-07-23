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
} from "./api.js";
import { el } from "./dom.js";
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

function readDraft(config: Config, contentHash: string): StoredDraft | null {
  const storage = storageOrNull();
  if (storage === null) return null;
  try {
    const value = storage.getItem(draftKey(config));
    if (value === null) return null;
    const parsed = JSON.parse(value) as Partial<StoredDraft>;
    if (
      parsed.baseContentHash !== contentHash ||
      typeof parsed.content !== "string" ||
      typeof parsed.changeSummary !== "string"
    ) {
      storage.removeItem(draftKey(config));
      return null;
    }
    return parsed as StoredDraft;
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
  private characterBody = "";
  private session: ManuscriptSurfaceSession | null = null;
  private started = false;
  private busy = false;
  private generation = 0;
  private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.isDirty()) return;
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
    this.renderLauncher();
  }

  private renderLauncher(): void {
    this.replaceChildren();
    const controls = el("div", "ab-planning-launcher");
    controls.setAttribute("aria-label", `${this.cfg.label} editing`);
    const edit = el("button", "ab-btn ab-planning-edit", `Edit ${this.cfg.label}`);
    edit.type = "button";
    edit.setAttribute("aria-expanded", "false");
    edit.addEventListener("click", () => void this.openEditor());
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
    const draft = readDraft(this.cfg, result.value.contentHash);
    const content = draft?.content ?? result.value.content;
    this.buildShell(draft?.changeSummary ?? "");
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
    window.addEventListener("beforeunload", this.beforeUnload);
    if (this.session !== null) {
      this.session.focus();
    } else {
      this.rawTextarea?.focus();
    }
  }

  private buildShell(changeSummary: string): void {
    const shellId = `ab-planning-editor-${++editorSequence}`;
    const shell = el("section", "ab-planning-editor-shell");
    shell.id = shellId;
    shell.setAttribute("aria-label", `Editing ${this.cfg.label}`);
    shell.append(el("h2", "ab-planning-editor-title", `Editing ${this.cfg.label}`));
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
    this.append(shell);
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
    const bodyRoot = el("div", "ab-planning-milkdown-root");
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
    return content !== canonicalRepositoryContent(source.content) ||
      (this.summaryInput?.value.trim() ?? "") !== "";
  }

  private persistDraft(): void {
    const source = this.source;
    const content = this.currentContent();
    if (source === null || content === null) return;
    if (!this.isDirty()) {
      clearDraft(this.cfg);
      return;
    }
    writeDraft(this.cfg, {
      baseContentHash: source.contentHash,
      content,
      changeSummary: this.summaryInput?.value ?? "",
    });
  }

  private async submitEditor(applyImmediately: boolean): Promise<void> {
    if (this.busy || this.source === null || this.errorLine === null || this.statusLine === null) {
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
      baseContentHash: this.source.contentHash,
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
      return;
    }

    clearDraft(this.cfg);
    await this.destroyEditor(false);
    this.setLauncherStatus(
      applyImmediately
        ? "Changes are applying. This page will update after deployment."
        : "Revision submitted for review.",
    );
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
    this.characterBody = "";
    if (this.reading !== null) this.reading.hidden = false;
    if (this.editButton !== null) {
      this.editButton.setAttribute("aria-expanded", "false");
      this.editButton.removeAttribute("aria-controls");
      if (restoreFocus) this.editButton.focus();
    }
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
