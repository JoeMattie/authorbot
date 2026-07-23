/**
 * Capability-gated chapter-summary editor.
 *
 * The rendered deck remains the published truth. This element reads the exact
 * repository-backed summary only after activation and submits a hash-bound
 * metadata proposal. A successful submit closes immediately, while the deck
 * changes only after the Git write is deployed.
 */
import "./chapter-summary-editor.css";
import {
  hasEffectiveCapability,
  roleOf,
  type ChapterSource,
  type ChapterSummaryProposalCommand,
  type Me,
} from "./api.js";
import { el } from "./dom.js";
import type { ProjectStore } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

interface Config {
  apiBase: string;
  project: string;
  chapterId: string;
  chapterTitle: string;
}

let editorSequence = 0;

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
    chapterTitle: host.dataset["chapterTitle"]?.trim() || "this chapter",
  };
}

function mayEditSummary(me: Me | null): boolean {
  return hasEffectiveCapability(me, "chapters:read", "chapters:read") &&
    hasEffectiveCapability(me, "summaries:write");
}

function mayApplySummary(me: Me | null): boolean {
  return roleOf(me) === "maintainer" && mayEditSummary(me) &&
    hasEffectiveCapability(me, "revisions:review");
}

function exactContentHash(source: ChapterSource): string | null {
  return typeof source.contentHash === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(source.contentHash)
    ? source.contentHash
    : null;
}

function normalizedSummary(value: string): string {
  return value.trim();
}

export class AuthorbotChapterSummaryEditor extends HTMLElement {
  private cfg!: Config;
  private store!: ProjectStore;
  private button: HTMLButtonElement | null = null;
  private shell: HTMLElement | null = null;
  private summaryInput: HTMLTextAreaElement | null = null;
  private notesInput: HTMLTextAreaElement | null = null;
  private errorLine: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private source: ChapterSource | null = null;
  private started = false;
  private busy = false;
  private generation = 0;
  private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this.isDirty()) return;
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
    window.removeEventListener("beforeunload", this.beforeUnload);
  }

  private current(generation = this.generation): boolean {
    return this.started && this.isConnected && generation === this.generation;
  }

  private async connect(generation: number): Promise<void> {
    try {
      const store = await loadProjectStore(this.cfg);
      await store.getState().ensureSession();
      if (!this.current(generation)) return;
      if (
        store.getState().sessionStatus !== "ready" ||
        !mayEditSummary(store.getState().session)
      ) {
        return;
      }
      this.store = store;
      this.renderLauncher();
    } catch {
      // Progressive enhancement: a failed authoring chunk leaves the deck alone.
    }
  }

  private renderLauncher(): void {
    this.replaceChildren();
    const button = el("button", "ab-btn ab-summary-edit", "Edit summary");
    button.type = "button";
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => void this.open());
    const launcher = el("div", "ab-summary-launcher");
    launcher.setAttribute("aria-label", "Chapter summary editing");
    launcher.append(button);
    this.append(launcher);
    this.button = button;
  }

  private async open(): Promise<void> {
    const button = this.button;
    if (button === null || this.shell !== null || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    button.disabled = true;
    this.setLauncherStatus("Loading the current summary…");
    const result = await this.store.getState().readChapterSource(this.cfg.chapterId);
    if (!this.current(generation)) return;
    this.busy = false;
    button.disabled = false;
    if (!result.ok) {
      this.setLauncherStatus(`The summary editor could not open: ${result.message}`, true);
      return;
    }
    if (
      result.value.chapterId !== this.cfg.chapterId ||
      exactContentHash(result.value) === null
    ) {
      this.setLauncherStatus(
        "The summary editor could not open because the source response lacks an exact chapter identity and content hash.",
        true,
      );
      return;
    }
    this.source = result.value;
    this.mountForm(result.value);
  }

  private mountForm(source: ChapterSource): void {
    const button = this.button;
    if (button === null) return;
    const editorId = `ab-summary-editor-${++editorSequence}`;
    const headingId = `${editorId}-heading`;
    const shell = el("section", "ab-summary-editor-shell");
    shell.id = editorId;
    shell.setAttribute("aria-labelledby", headingId);

    const heading = el("h2", "ab-summary-editor-heading", "Edit chapter summary");
    heading.id = headingId;
    const guidance = el(
      "p",
      "ab-summary-editor-guidance",
      "This creates a reviewable metadata revision. The published summary stays unchanged on this page until the next deployment.",
    );

    const summaryLabel = el("label", "ab-summary-editor-field");
    summaryLabel.append(el("span", "ab-field-label", "Summary"));
    const summary = el("textarea", "ab-textarea ab-summary-editor-input");
    summary.rows = 4;
    summary.maxLength = 2000;
    summary.value = source.summary ?? "";
    summary.setAttribute(
      "aria-describedby",
      `${editorId}-summary-help`,
    );
    const help = el(
      "span",
      "ab-field-help",
      "Leave this empty to remove the chapter summary.",
    );
    help.id = `${editorId}-summary-help`;
    summaryLabel.append(summary, help);

    const notesLabel = el("label", "ab-summary-editor-field");
    notesLabel.append(el("span", "ab-field-label", "Notes for reviewer (optional)"));
    const notes = el("textarea", "ab-textarea ab-summary-editor-notes");
    notes.rows = 3;
    notes.maxLength = 10_000;
    notesLabel.append(notes);

    const error = el("p", "ab-error ab-summary-editor-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const status = el("p", "ab-summary-editor-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.hidden = true;

    const actions = el("div", "ab-form-actions ab-summary-editor-actions");
    const cancel = el("button", "ab-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.cancel());
    const submit = el("button", "ab-btn ab-primary", "Submit for review");
    submit.type = "button";
    submit.dataset.summarySubmit = "review";
    submit.addEventListener("click", () => void this.submit(false));
    actions.append(cancel, submit);
    if (mayApplySummary(this.store.getState().session)) {
      const apply = el("button", "ab-btn ab-primary ab-summary-apply", "Apply summary");
      apply.type = "button";
      apply.dataset.summarySubmit = "apply";
      apply.addEventListener("click", () => void this.submit(true));
      actions.append(apply);
    }

    shell.append(heading, guidance, summaryLabel, notesLabel, error, status, actions);
    this.append(shell);
    this.shell = shell;
    this.summaryInput = summary;
    this.notesInput = notes;
    this.errorLine = error;
    this.statusLine = status;
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-controls", editorId);
    this.setLauncherStatus("");
    window.addEventListener("beforeunload", this.beforeUnload);
    summary.focus();
    summary.setSelectionRange(summary.value.length, summary.value.length);
  }

  private async submit(applyImmediately: boolean): Promise<void> {
    const source = this.source;
    const summary = this.summaryInput;
    const error = this.errorLine;
    const status = this.statusLine;
    if (
      source === null || summary === null || error === null || status === null || this.busy
    ) {
      return;
    }
    const me = this.store.getState().session;
    if (!mayEditSummary(me)) {
      this.showError("You no longer have permission to submit chapter summaries.");
      return;
    }
    if (applyImmediately && !mayApplySummary(me)) {
      this.showError("You no longer have permission to apply chapter summaries.");
      return;
    }
    const proposedContent = normalizedSummary(summary.value);
    const baseContent = normalizedSummary(source.summary ?? "");
    if (proposedContent === baseContent) {
      this.showError("Change or clear the summary before submitting it.");
      return;
    }
    const baseContentHash = exactContentHash(source);
    if (baseContentHash === null) {
      this.showError("The exact chapter base is no longer available.");
      return;
    }
    const notes = this.notesInput?.value.trim() ?? "";
    const removing = proposedContent === "";
    const command: ChapterSummaryProposalCommand = {
      proposalType: "chapter_summary",
      chapterId: source.chapterId,
      baseRevision: source.revision,
      baseContentHash,
      proposedContent,
      changeSummary: removing ? "Remove the chapter summary." : "Update the chapter summary.",
      ...(notes === "" ? {} : { notes }),
      ...(applyImmediately ? { applyImmediately: true } : {}),
    };

    this.busy = true;
    this.setBusy(true);
    error.hidden = true;
    status.textContent = applyImmediately
      ? "Applying the summary…"
      : "Submitting the summary for review…";
    status.hidden = false;
    const result = await this.store.getState().proposeChapterSummary(command);
    if (!this.current()) return;
    this.busy = false;
    this.setBusy(false);
    if (!result.ok) {
      const prefix = result.status === 409
        ? "The chapter changed after this editor opened. Your summary is still here. "
        : "";
      this.showError(`${prefix}${result.message}`);
      return;
    }

    this.close(false);
    this.setLauncherStatus(
      applyImmediately
        ? "Summary is applying. The published page will update after deployment."
        : "Summary submitted for review. The published page stays unchanged until it is approved and deployed.",
    );
    this.button?.focus();
  }

  private cancel(): void {
    if (this.busy) return;
    if (this.isDirty() && !window.confirm("Discard this in-progress summary edit?")) return;
    this.close(true);
  }

  private close(restoreFocus: boolean): void {
    window.removeEventListener("beforeunload", this.beforeUnload);
    this.shell?.remove();
    this.shell = null;
    this.summaryInput = null;
    this.notesInput = null;
    this.errorLine = null;
    this.statusLine = null;
    this.source = null;
    if (this.button !== null) {
      this.button.setAttribute("aria-expanded", "false");
      this.button.removeAttribute("aria-controls");
      if (restoreFocus) this.button.focus();
    }
  }

  private isDirty(): boolean {
    const source = this.source;
    if (source === null || this.summaryInput === null) return false;
    return normalizedSummary(this.summaryInput.value) !== normalizedSummary(source.summary ?? "") ||
      (this.notesInput?.value.trim() ?? "") !== "";
  }

  private setBusy(busy: boolean): void {
    for (const control of this.shell?.querySelectorAll<
      HTMLButtonElement | HTMLTextAreaElement
    >("button, textarea") ?? []) {
      control.disabled = busy;
    }
  }

  private showError(message: string): void {
    if (this.errorLine === null || this.statusLine === null) return;
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
    this.statusLine.hidden = true;
  }

  private setLauncherStatus(message: string, error = false): void {
    let line = this.querySelector<HTMLElement>(".ab-summary-launcher-status");
    if (message === "") {
      line?.remove();
      return;
    }
    if (line === null) {
      line = el("p", "ab-summary-launcher-status");
      this.querySelector(".ab-summary-launcher")?.append(line);
    }
    line.classList.toggle("ab-error", error);
    line.setAttribute("role", error ? "alert" : "status");
    line.textContent = message;
  }
}
