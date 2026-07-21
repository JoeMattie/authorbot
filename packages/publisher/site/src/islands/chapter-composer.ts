/**
 * `<authorbot-chapter-composer>` - the Phase 6 §3.5 authoring surface: a plain
 * title-and-prose composer that creates a chapter from nothing (the `/write/`
 * page) or revises an existing one (the chapter page).
 *
 * The author writes **Markdown only**: no frontmatter, no block markers, no
 * ids. The server generates the chapter id, the slug, the order and every
 * marker, so no UUID is ever rendered into this UI or typed into it - in edit
 * mode the id arrives as a build-time `data-chapter-id` attribute the reader
 * never sees.
 *
 * Progressive enhancement (§2b §1): the page ships a static fallback inside the
 * mount; this element replaces it only after `/v1/me` answers. With JS off, or
 * the API unreachable, the fallback stays and nothing errors.
 *
 * Honest degradation: a revise sends a COMPLETE replacement body, so if the
 * chapter's current text cannot be read the composer refuses to open an
 * editable box at all rather than inviting an edit that would silently destroy
 * the chapter.
 *
 * Security (§2b §3): every string reaches the DOM through `textContent`;
 * `innerHTML` is never used (the build test greps the bundle for it), and no
 * `setAttribute("style", …)` - dynamic style goes through the CSSOM.
 */
import {
  CollabApi,
  canAuthorChapters,
  isMaintainer,
  type ApiResult,
  type Me,
} from "./api.js";
import {
  CHAPTER_IDLE,
  chapterComposerReduce,
  clearChapterDraft,
  loadChapterDraft,
  saveChapterDraft,
  type ChapterAccepted,
  type ChapterComposerEvent,
  type ChapterComposerState,
  type ChapterDraft,
  type ChapterSource,
} from "./chapter-composer-state.js";
import { MAX_OPERATION_POLLS, pollDelayMs } from "./composer-state.js";
import { el } from "./dom.js";

interface Config {
  apiBase: string;
  project: string;
  devLogin: boolean;
  /** This composer is the page's own island, so it owns sign-in. */
  standalone: boolean;
  /** Present = EDIT mode; absent = CREATE mode. */
  chapterId: string | null;
  chapterTitle: string;
  chapterStatus: string;
}

const HELP_TEXT =
  "Write the chapter in plain Markdown - just the prose. No frontmatter, no ids, " +
  "no markers: Authorbot assigns all of that when it saves.";

const DENIED_TEXT = "Writing chapters needs the editor or maintainer role.";

const READ_FAILED_PREFIX = "This chapter's text could not be read, so it cannot be edited here";

const STATE_CONFLICT_TEXT =
  `${READ_FAILED_PREFIX}: this deployment has no repository reader configured, so the browser ` +
  "cannot see the chapter's current text. Editing from an empty box would replace the whole " +
  "chapter, so the editor stays closed. Edit the file in the repository instead.";

const STALE_TEXT =
  "Still syncing. Your text was accepted - reload the page in a moment to see where it landed.";

function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project } = host.dataset;
  // `data-api-base=""` is valid (a same-origin deployment, ADR-0019).
  if (apiBase === undefined || project === undefined) {
    return null;
  }
  const chapterId = host.dataset["chapterId"];
  return {
    apiBase,
    project,
    devLogin: host.dataset["devLogin"] === "true",
    /**
     * Whether this composer is the page's own island (the `/write/` page) or a
     * secondary mount on a chapter page. Only a standalone composer offers
     * sign-in: a chapter page already carries the collaboration island's auth
     * bar, and a second "Sign in" form beside it would be two ways to do one
     * thing - ambiguous to a reader and, as it turns out, to a test locator.
     */
    standalone: host.dataset["standalone"] === "true",
    chapterId: chapterId === undefined || chapterId === "" ? null : chapterId,
    chapterTitle: host.dataset["chapterTitle"] ?? "",
    chapterStatus: host.dataset["chapterStatus"] ?? "",
  };
}

/** sessionStorage, or null where it is unavailable (privacy modes, SSR). */
function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export class AuthorbotChapterComposer extends HTMLElement {
  private api!: CollabApi;
  private cfg!: Config;
  private started = false;
  private disposed = false;
  private me: Me | null = null;
  private state: ChapterComposerState = { ...CHAPTER_IDLE };
  private pollTimer: number | null = null;
  private published = false;

  // Live nodes.
  private authbar!: HTMLElement;
  private body!: HTMLElement;
  private statusLine!: HTMLElement;
  private errorLine!: HTMLElement;
  private titleInput: HTMLInputElement | null = null;
  private bodyInput: HTMLTextAreaElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private publishBtn: HTMLButtonElement | null = null;

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
    void this.start();
  }

  disconnectedCallback(): void {
    this.disposed = true;
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async start(): Promise<void> {
    const auth = await this.api.meResult();
    if (!auth.ok) {
      // Unreachable API: leave the static fallback (progressive enhancement).
      return;
    }
    this.me = auth.value;
    this.published = this.cfg.chapterStatus === "published";
    if (!canAuthorChapters(this.me) && !this.cfg.standalone) {
      // A secondary mount on a chapter page, for someone who cannot author:
      // render nothing at all. The page is a reading page first, and the
      // collaboration island beside it already offers sign-in to whoever is
      // signed out. Adding a second prompt here would duplicate it.
      return;
    }
    this.scaffold();
    this.renderAuthbar();
    if (!canAuthorChapters(this.me)) {
      // Signed in but not an author, or signed out: the authbar has already
      // said what to do. Never a disabled control with a mystery tooltip.
      if (this.me !== null) {
        this.body.append(el("p", "ab-chapter-denied ab-hint", DENIED_TEXT));
      }
      return;
    }
    if (this.cfg.chapterId === null) {
      this.openCreate();
    } else {
      await this.openEdit(this.cfg.chapterId);
    }
  }

  // ---- scaffolding ---------------------------------------------------------

  private scaffold(): void {
    this.textContent = "";
    const root = el("section", "ab-chapter-composer");
    root.setAttribute("aria-label", this.cfg.chapterId === null ? "New chapter" : "Edit chapter");

    const heading = el(
      "h2",
      "ab-chapter-heading",
      this.cfg.chapterId === null
        ? "New chapter"
        : this.cfg.chapterTitle === ""
          ? "Edit this chapter"
          : `Edit: ${this.cfg.chapterTitle}`,
    );
    this.authbar = el("div", "ab-authbar ab-chapter-authbar");
    this.body = el("div", "ab-chapter-body");
    this.statusLine = el("p", "ab-chapter-status");
    this.statusLine.setAttribute("role", "status");
    this.statusLine.setAttribute("aria-live", "polite");
    this.statusLine.hidden = true;
    this.errorLine = el("p", "ab-error ab-chapter-error");
    this.errorLine.setAttribute("role", "alert");
    this.errorLine.hidden = true;

    root.append(heading, this.authbar, this.body, this.errorLine, this.statusLine);
    this.append(root);
  }

  /**
   * Auth state, mirroring `collab-element.ts` exactly - including the
   * `.ab-devlogin` form's markup and class names, which the shared e2e helper
   * locates by selector.
   */
  private renderAuthbar(): void {
    this.authbar.textContent = "";
    if (!this.cfg.standalone) {
      // Chapter page: the collaboration island owns the auth bar. Reaching
      // here means the viewer may already author, so there is nothing to say.
      this.authbar.hidden = true;
      return;
    }
    if (this.me !== null) {
      this.authbar.append(el("p", "ab-me", `Signed in as ${this.me.actor.displayName}`));
      return;
    }
    if (this.cfg.devLogin) {
      this.authbar.append(this.buildDevLogin());
      return;
    }
    const signIn = el("a", "ab-signin", "Sign in with GitHub to write a chapter");
    signIn.href = this.api.signInUrl(window.location.href);
    this.authbar.append(
      el("p", "ab-hint", "Writing a chapter needs an editor or maintainer account."),
      signIn,
    );
  }

  private buildDevLogin(): HTMLFormElement {
    const form = el("form", "ab-devlogin");
    const loginLabel = el("label", "ab-field");
    loginLabel.append(el("span", "ab-field-label", "Dev login"));
    const login = el("input", "ab-input");
    login.type = "text";
    login.name = "login";
    login.required = true;
    login.autocomplete = "username";
    loginLabel.append(login);

    const roleLabel = el("label", "ab-field");
    roleLabel.append(el("span", "ab-field-label", "Role"));
    const role = el("select", "ab-input");
    for (const value of ["reader", "contributor", "editor", "maintainer"]) {
      const option = el("option", undefined, value);
      option.value = value;
      if (value === "editor") {
        option.selected = true;
      }
      role.append(option);
    }
    roleLabel.append(role);

    const submit = el("button", "ab-btn ab-primary", "Sign in (dev)");
    submit.type = "submit";
    const errorLine = el("p", "ab-error");
    errorLine.setAttribute("role", "alert");
    errorLine.hidden = true;
    form.append(loginLabel, roleLabel, submit, errorLine);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        submit.disabled = true;
        const result = await this.api.devLogin(login.value, role.value);
        submit.disabled = false;
        if (!result.ok) {
          errorLine.textContent = result.message;
          errorLine.hidden = false;
          return;
        }
        await this.start();
      })();
    });
    return form;
  }

  // ---- opening -------------------------------------------------------------

  private openCreate(): void {
    const stored = loadChapterDraft(sessionStorageOrNull(), this.cfg.project, null);
    this.dispatch({
      type: "open",
      draft: {
        chapterId: null,
        title: stored?.title ?? "",
        body: stored?.body ?? "",
        baseRevision: null,
      },
    });
    this.buildForm(stored?.caret ?? null, stored?.focus ?? null);
  }

  private async openEdit(chapterId: string): Promise<void> {
    this.dispatch({ type: "load" });
    this.setStatus("Reading the chapter…");
    const result: ApiResult<ChapterSource> = await this.api.chapterSource(chapterId);
    if (this.disposed) {
      return;
    }
    this.statusLine.hidden = true;
    if (!result.ok) {
      // NEVER fabricate content and never open an empty box: a revise replaces
      // the whole chapter, so editing from nothing would destroy it.
      const problem = result.problem?.["code"] ?? result.problem?.["type"];
      const isStateConflict =
        result.status === 409 ||
        (typeof problem === "string" && problem.includes("state-conflict"));
      this.dispatch({
        type: "load-failed",
        message: isStateConflict ? STATE_CONFLICT_TEXT : `${READ_FAILED_PREFIX}: ${result.message}`,
      });
      this.renderState();
      return;
    }
    const source = result.value;
    // The stored draft is the author's in-progress edit; the API answer is the
    // base it was taken from. Keep both.
    const stored = loadChapterDraft(sessionStorageOrNull(), this.cfg.project, chapterId);
    if (source.status !== "") {
      this.published = source.status === "published";
    }
    this.dispatch({
      type: "loaded",
      draft: {
        chapterId,
        title: stored?.title ?? source.title,
        body: stored?.body ?? source.body,
        baseRevision: source.revision,
      },
    });
    this.buildForm(stored?.caret ?? null, stored?.focus ?? null);
  }

  // ---- the form ------------------------------------------------------------

  private buildForm(caret: number | null, focus: "title" | "body" | null): void {
    const draft = this.state.draft;
    if (draft === null) {
      return;
    }
    this.body.textContent = "";
    this.body.append(el("p", "ab-chapter-help", HELP_TEXT));

    const form = el("form", "ab-chapter-form");

    const titleField = el("label", "ab-field ab-chapter-title-field");
    titleField.append(el("span", "ab-field-label", "Chapter title"));
    const title = el("input", "ab-input ab-chapter-title");
    title.type = "text";
    title.name = "title";
    // `aria-required` rather than `required`: the native constraint bubble is
    // transient and unstyleable, and it would suppress our own `role="alert"`
    // sentence, which is the one that actually explains what to do.
    title.setAttribute("aria-required", "true");
    title.autocomplete = "off";
    // Restored before the field is ever painted with an empty value.
    title.value = draft.title;
    titleField.append(title);

    const bodyField = el("label", "ab-field ab-chapter-body-field");
    bodyField.append(el("span", "ab-field-label", "Chapter text (Markdown)"));
    const body = el("textarea", "ab-input ab-textarea ab-chapter-text");
    body.name = "body";
    body.setAttribute("aria-required", "true");
    body.rows = 16;
    body.spellcheck = true;
    body.value = draft.body;
    bodyField.append(body);

    const actions = el("div", "ab-form-actions ab-chapter-actions");
    const save = el("button", "ab-btn ab-primary ab-chapter-save", "Save draft");
    save.type = "submit";
    actions.append(save);

    this.titleInput = title;
    this.bodyInput = body;
    this.saveBtn = save;

    title.addEventListener("input", () => {
      this.dispatch({ type: "set-title", title: title.value });
      this.persist("title");
    });
    title.addEventListener("blur", () => this.persist("title"));
    body.addEventListener("input", () => {
      this.dispatch({ type: "set-body", body: body.value });
      this.persist("body");
    });
    body.addEventListener("blur", () => this.persist("body"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.save();
    });

    form.append(titleField, bodyField, actions);
    this.body.append(form);

    // Publishing is a SEPARATE explicit action, outside the save form, so it
    // can never be triggered by submitting the composer.
    if (isMaintainer(this.me)) {
      this.body.append(this.buildPublishAction());
    }
    this.renderState();
    this.restoreFocus(caret, focus);
  }

  private restoreFocus(caret: number | null, focus: "title" | "body" | null): void {
    const field = focus === "title" ? this.titleInput : focus === "body" ? this.bodyInput : null;
    if (field === null) {
      return;
    }
    field.focus();
    if (caret === null) {
      return;
    }
    const clamped = Math.max(0, Math.min(caret, field.value.length));
    try {
      field.setSelectionRange(clamped, clamped);
    } catch {
      // Some field types refuse a selection range; the text is what matters.
    }
  }

  private buildPublishAction(): HTMLElement {
    const wrap = el("div", "ab-chapter-publish-actions");
    const button = el("button", "ab-btn ab-chapter-publish");
    button.type = "button";
    button.textContent = this.published ? "Unpublish" : "Publish";
    button.addEventListener("click", () => {
      void this.publish(this.published ? "unpublish" : "publish");
    });
    this.publishBtn = button;
    wrap.append(button);
    return wrap;
  }

  private persist(field: "title" | "body"): void {
    const draft = this.state.draft;
    if (draft === null) {
      return;
    }
    const node = field === "title" ? this.titleInput : this.bodyInput;
    saveChapterDraft(sessionStorageOrNull(), this.cfg.project, {
      // Keyed by the MOUNT's chapter (null in create mode) so a fresh create
      // never picks up an edit-in-progress draft or vice versa.
      chapterId: this.cfg.chapterId,
      title: this.titleInput?.value ?? draft.title,
      body: this.bodyInput?.value ?? draft.body,
      baseRevision: draft.baseRevision,
      caret: node?.selectionStart ?? null,
      focus: field,
    });
  }

  // ---- saving --------------------------------------------------------------

  private async save(): Promise<void> {
    const before = this.state;
    this.dispatch({ type: "save" });
    if (this.state.phase === "saving") {
      this.renderState();
    } else {
      // Validation refused it; say why, and put the caret where the fix is.
      this.renderState();
      this.focusInvalid();
      return;
    }
    const draft = before.draft as ChapterDraft;
    const title = draft.title.trim();
    const body = draft.body;
    const result: ApiResult<ChapterAccepted> =
      draft.chapterId === null || draft.baseRevision === null
        ? await this.api.createChapter({ title, body })
        : await this.api.reviseChapter({
            chapterId: draft.chapterId,
            baseRevision: draft.baseRevision,
            title,
            body,
          });
    if (this.disposed) {
      return;
    }
    if (!result.ok) {
      this.dispatch({
        type: "rejected",
        message:
          result.status === 409
            ? "This chapter changed since you opened it - reload to get the current text."
            : `Save failed: ${result.message}`,
      });
      this.renderState();
      return;
    }
    this.dispatch({
      type: "accepted",
      operationId: result.value.operationId,
      chapterId: result.value.chapterId,
    });
    this.renderState();
    this.pollOperation(result.value.operationId);
  }

  private focusInvalid(): void {
    const draft = this.state.draft;
    if (draft === null) {
      return;
    }
    if (draft.title.trim() === "") {
      this.titleInput?.focus();
    } else {
      this.bodyInput?.focus();
    }
  }

  private async publish(action: "publish" | "unpublish"): Promise<void> {
    const chapterId = this.state.draft?.chapterId;
    if (typeof chapterId !== "string") {
      return;
    }
    this.dispatch({ type: "publish", action });
    if (this.state.phase !== "publishing") {
      return;
    }
    this.renderState();
    const result: ApiResult<ChapterAccepted> =
      action === "publish"
        ? await this.api.publishChapter(chapterId)
        : await this.api.unpublishChapter(chapterId);
    if (this.disposed) {
      return;
    }
    if (!result.ok) {
      this.dispatch({
        type: "rejected",
        message: `${action === "publish" ? "Publish" : "Unpublish"} failed: ${result.message}`,
      });
      this.renderState();
      return;
    }
    this.dispatch({ type: "publish-accepted", operationId: result.value.operationId });
    this.renderState();
    this.pollOperation(result.value.operationId);
  }

  // ---- operation polling ---------------------------------------------------

  private pollOperation(operationId: string): void {
    const step = async (): Promise<void> => {
      if (this.disposed) {
        return;
      }
      const operation = await this.api.operation(operationId);
      if (operation !== null && (operation.state === "committed" || operation.state === "verified")) {
        this.onCommitted();
        return;
      }
      if (operation !== null && operation.state === "failed") {
        this.dispatch({
          type: "poll-failed",
          message: operation.error ?? "the chapter could not be committed",
        });
        this.renderState();
        return;
      }
      this.dispatch({ type: "poll-pending" });
      this.renderState();
      if (this.state.phase === "syncing") {
        this.pollTimer = window.setTimeout(() => void step(), pollDelayMs(this.state.polls));
      }
    };
    this.pollTimer = window.setTimeout(() => void step(), pollDelayMs(0));
  }

  private onCommitted(): void {
    const pending = this.state.pending;
    this.dispatch({ type: "poll-committed" });
    if (pending === "publish") {
      this.published = true;
    } else if (pending === "unpublish") {
      this.published = false;
    } else {
      // The chapter is safely in the repository: the local copy has done its
      // job (Phase 2b draft-preservation rule ends at "saved").
      clearChapterDraft(sessionStorageOrNull(), this.cfg.project, this.cfg.chapterId);
      void this.rebase();
    }
    this.renderState();
  }

  /**
   * Re-read the chapter's revision after a commit so a second save in the same
   * sitting is not a guaranteed 409. Failure is silent: the honest 409 message
   * is a perfectly good fallback.
   */
  private async rebase(): Promise<void> {
    const chapterId = this.state.draft?.chapterId;
    if (typeof chapterId !== "string") {
      return;
    }
    const result: ApiResult<ChapterSource> = await this.api.chapterSource(chapterId);
    if (this.disposed || !result.ok) {
      return;
    }
    this.dispatch({ type: "rebased", baseRevision: result.value.revision });
  }

  // ---- rendering -----------------------------------------------------------

  private dispatch(event: ChapterComposerEvent): void {
    this.state = chapterComposerReduce(this.state, event);
  }

  private renderState(): void {
    if (this.state.phase === "error") {
      // The chapter's text is unreadable: say so, and show no editable box.
      this.body.textContent = "";
      this.titleInput = null;
      this.bodyInput = null;
      this.saveBtn = null;
      this.publishBtn = null;
      this.showError(this.state.error ?? READ_FAILED_PREFIX);
      return;
    }
    const busy =
      this.state.phase === "saving" ||
      this.state.phase === "syncing" ||
      this.state.phase === "publishing";
    if (this.saveBtn !== null) {
      this.saveBtn.disabled = busy;
    }
    if (this.titleInput !== null) {
      this.titleInput.readOnly = busy;
    }
    if (this.bodyInput !== null) {
      this.bodyInput.readOnly = busy;
    }
    if (this.publishBtn !== null) {
      // Publishing needs a chapter that exists: in create mode that is only
      // true after a save has committed.
      const havePublishable =
        this.state.draft?.chapterId !== null && this.state.draft?.chapterId !== undefined;
      this.publishBtn.hidden = !havePublishable;
      this.publishBtn.disabled = busy;
      this.publishBtn.textContent = this.published ? "Unpublish" : "Publish";
    }

    if (this.state.error !== null) {
      this.showError(this.state.error);
    } else {
      this.hideError();
    }

    switch (this.state.phase) {
      case "saving":
        this.setStatus("Saving…");
        break;
      case "publishing":
        this.setStatus(this.published ? "Unpublishing…" : "Publishing…");
        break;
      case "syncing":
        this.setStatus("Syncing to the repository…");
        break;
      case "saved":
        this.setStatus(this.savedMessage());
        break;
      case "stale":
        this.setStatus(STALE_TEXT);
        break;
      default:
        this.statusLine.hidden = true;
        break;
    }
  }

  private savedMessage(): string {
    switch (this.state.pending) {
      case "publish":
        // The site's chapter URLs are slug-based and the slug is the server's
        // to choose, so no link is guessed here.
        return "Published. The chapter appears on the site the next time it is built.";
      case "unpublish":
        return "Back to draft. The chapter leaves the published site on the next build.";
      default:
        return "Saved as a draft.";
    }
  }

  private setStatus(text: string): void {
    this.statusLine.textContent = text;
    this.statusLine.hidden = false;
  }

  private showError(message: string): void {
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
  }

  private hideError(): void {
    this.errorLine.textContent = "";
    this.errorLine.hidden = true;
  }

  /** Exposed for tests: the bounded poll ceiling this composer honours. */
  static readonly maxPolls = MAX_OPERATION_POLLS;
}
