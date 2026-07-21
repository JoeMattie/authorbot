/**
 * `<authorbot-settings>` - the maintainer-only Settings view (Phase 6 §3.6).
 *
 * "A Settings view, visible only to maintainers, editing the same `book.yml`
 * that lives in Git - through the same outbox, coordinator, validation, and
 * attribution path as any other write." So this island is a form over
 * `GET/PATCH .../settings` and nothing more: no local configuration store, no
 * optimistic state. After every successful save it re-reads the document, so
 * what the maintainer sees is what was actually stored rather than what they
 * typed.
 *
 * Three ideas do most of the work here.
 *
 * **Never-editable fields are ABSENT, not disabled.** `id`,
 * `repository.default_branch`, `content.chapters_glob`, `content.raw_html` and
 * `publication.api_url` get no control of any kind - not a greyed one, not a
 * tooltip. A disabled input still says "this is a setting, and you are not
 * allowed to have it", which invites a workaround. The API ships
 * `readOnly.reasons` so the boundary can be *explained*; that is rendered as a
 * collapsed prose list containing no form controls and no values.
 *
 * **Governance is translated, not printed.** `human_maintainer_approvals >= 1`
 * is rendered as the sentence it means, with the reason it exists - see
 * `settings-model.ts`, where that language lives so it can be tested without a
 * browser.
 *
 * **Guarded fields state the consequence before the change is accepted.** The
 * consequence text comes from the API (`guarded[field].consequence`) and is
 * shown the moment the field is edited; the confirmation step then shows what
 * the API says breaks, and the maintainer must actively tick and press it. The
 * confirmation is never pre-ticked and never sent automatically - a
 * confirmation the client can give on the maintainer's behalf is not a
 * confirmation.
 *
 * Security: every API-sourced string reaches the DOM through `textContent`
 * (via `el`/`srOnly`). `innerHTML` is never used - the build test greps the
 * bundle for that literal - and inline styles are never set via
 * `setAttribute("style", …)`, so the contract §3 CSP holds.
 */
import { CollabApi, isMaintainer, type Me, type SettingsDocument, type SettingsPatch } from "./api.js";
import { el, srOnly } from "./dom.js";
import {
  GOVERNANCE_HEADING,
  HUMAN_MAINTAINER_LABEL,
  SUGGESTED_LICENSES,
  buildPatch,
  cloneSnapshot,
  conditionsOf,
  describeRule,
  hasHumanMaintainerClause,
  licenseSummary,
  patchIsEmpty,
  snapshotOf,
  sourceNotice,
  withConditions,
  withHumanMaintainerClause,
  type EditableRule,
  type SettingsSnapshot,
} from "./settings-model.js";

interface Config {
  apiBase: string;
  project: string;
  devLogin: boolean;
}

/**
 * `apiBase === ""` is valid (the API mounted at the site origin's root), so
 * only a MISSING attribute means "not a collab build" - in which case the
 * element stays inert and the page's static fallback survives.
 */
function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project } = host.dataset;
  if (apiBase === undefined || project === undefined) {
    return null;
  }
  return { apiBase, project, devLogin: host.dataset.devLogin === "true" };
}

/** Tri-state publication flag as a select value. */
function flagValue(flag: boolean | null): string {
  return flag === null ? "" : flag ? "true" : "false";
}

function parseFlag(value: string): boolean | null {
  return value === "" ? null : value === "true";
}

/** The `reasons` map out of the loosely-typed `readOnly` section. */
function reasonsOf(doc: SettingsDocument): string[] {
  const reasons = doc.readOnly?.["reasons"];
  if (reasons === null || typeof reasons !== "object") {
    return [];
  }
  return Object.values(reasons as Record<string, unknown>).filter(
    (reason): reason is string => typeof reason === "string" && reason.length > 0,
  );
}

/** `code` (or RFC 9457 `type`) of a problem body, whichever the API used. */
function problemCode(problem: Record<string, unknown> | undefined): string {
  const code = problem?.["code"];
  if (typeof code === "string") return code;
  const type = problem?.["type"];
  return typeof type === "string" ? type : "";
}

export class AuthorbotSettings extends HTMLElement {
  private api!: CollabApi;
  private cfg!: Config;
  private started = false;
  private me: Me | null = null;

  private authbar!: HTMLElement;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private error!: HTMLElement;

  /** The document as loaded, and the working copy the form edits. */
  private original: SettingsSnapshot | null = null;
  private edited: SettingsSnapshot | null = null;
  private doc: SettingsDocument | null = null;

  private saveButton: HTMLButtonElement | null = null;
  private confirmWrap!: HTMLElement;

  connectedCallback(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const cfg = parseConfig(this);
    if (cfg === null) {
      return; // not a collab build: leave the static fallback in place
    }
    this.cfg = cfg;
    this.api = new CollabApi(cfg.apiBase, cfg.project);
    void this.start();
  }

  private async start(): Promise<void> {
    const auth = await this.api.meResult();
    if (!auth.ok) {
      // Unreachable API: render NOTHING (progressive enhancement, §2b §1).
      return;
    }
    this.me = auth.value;
    this.scaffold();
    this.renderAuthbar();
    if (this.me === null) {
      return;
    }
    if (!isMaintainer(this.me)) {
      // Explained in words rather than shown as an empty or disabled form: the
      // API enforces the same rule, and a maintainer-only surface that renders
      // a dead form teaches nothing about why.
      this.body.append(
        el(
          "p",
          "ab-settings-denied",
          "Book settings are maintainer-only. They change book.yml in this book's repository - the same file the site is built from - so only someone who can commit to the book can edit them here. Ask a maintainer if something needs changing.",
        ),
      );
      return;
    }
    await this.load(false);
  }

  private scaffold(): void {
    this.textContent = "";
    this.authbar = el("div", "ab-settings-authbar");
    this.status = el("p", "ab-settings-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.error = el("p", "ab-settings-error");
    this.error.setAttribute("role", "alert");
    this.error.hidden = true;
    this.body = el("div", "ab-settings-body");
    this.append(this.authbar, this.body, this.status, this.error);
  }

  // ---- auth ---------------------------------------------------------------

  /**
   * Structurally identical to the chapter island's auth bar (`.ab-devlogin`,
   * `input[name="login"]`, a `<select>`, `button[type="submit"]`, and `.ab-me`
   * reading "Signed in as …"), because the shared e2e helper drives exactly
   * those selectors. Divergence here would break sign-in for every settings
   * test without breaking anything a unit test can see.
   */
  private renderAuthbar(): void {
    this.authbar.textContent = "";
    if (this.me !== null) {
      this.authbar.append(el("p", "ab-me", `Signed in as ${this.me.actor.displayName}`));
      return;
    }
    if (this.cfg.devLogin) {
      this.authbar.append(this.devLoginForm());
      return;
    }
    const signIn = el("a", "ab-signin", "Sign in with GitHub to manage book settings");
    signIn.href = this.api.signInUrl(window.location.href);
    this.authbar.append(signIn);
  }

  private devLoginForm(): HTMLFormElement {
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
      if (value === "maintainer") {
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

  // ---- load ---------------------------------------------------------------

  private async load(keepStatus: boolean): Promise<void> {
    const result = await this.api.settings();
    if (!result.ok) {
      if (result.status === 0) {
        return; // unreachable: stay quiet
      }
      this.body.textContent = "";
      // `state-conflict` (book.yml not projected yet) carries a detail that
      // names exactly what the operator must do; anything else carries the
      // API's own explanation. Either way it is shown verbatim rather than
      // replaced with a guess about what went wrong.
      this.showError(result.message);
      return;
    }
    this.doc = result.value;
    this.original = snapshotOf(result.value);
    this.edited = cloneSnapshot(this.original);
    this.renderForm(result.value);
    if (!keepStatus) {
      this.status.textContent = "";
    }
  }

  private showError(message: string, issues: { path?: string; message?: string }[] = []): void {
    this.error.textContent = "";
    this.error.append(document.createTextNode(message));
    if (issues.length > 0) {
      const list = el("ul", "ab-settings-issues");
      for (const issue of issues) {
        const label = typeof issue.path === "string" && issue.path.length > 0 ? issue.path : "this change";
        list.append(el("li", "ab-settings-issue", `${label}: ${issue.message ?? "is not valid"}`));
      }
      this.error.append(list);
    }
    this.error.hidden = false;
  }

  // ---- form ---------------------------------------------------------------

  private renderForm(doc: SettingsDocument): void {
    this.body.textContent = "";
    this.saveButton = null;
    const form = el("form", "ab-settings-form");
    form.noValidate = true;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.save();
    });

    form.append(this.editableSection());
    form.append(this.governanceSection(doc));
    form.append(this.guardedSection(doc));

    this.confirmWrap = el("div", "ab-settings-confirm");
    this.confirmWrap.hidden = true;
    form.append(this.confirmWrap);

    if (doc.status === "pending_git") {
      // A previous settings commit is still in flight; the API refuses a second
      // one, so offering Save would only produce a confusing failure.
      form.append(
        el(
          "p",
          "ab-settings-pending",
          "A previous settings change has not been committed to Git yet. Saving is off until it lands - reload this page in a moment.",
        ),
      );
    } else {
      const actions = el("div", "ab-form-actions");
      const save = el("button", "ab-btn ab-primary ab-settings-save", "Save settings");
      save.type = "submit";
      this.saveButton = save;
      actions.append(save);
      form.append(actions);
    }

    this.body.append(form);
    const reasons = reasonsOf(doc);
    if (reasons.length > 0) {
      this.body.append(this.readOnlyExplainer(reasons));
    }
  }

  private section(className: string, heading: string): HTMLElement {
    const section = el("section", `ab-settings-section ${className}`);
    section.append(el("h2", "ab-settings-heading", heading));
    return section;
  }

  private textField(options: {
    id: string;
    name: string;
    label: string;
    value: string;
    hint?: string;
    className?: string;
  }): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = el("label", "ab-field ab-settings-field");
    wrap.htmlFor = options.id;
    wrap.append(el("span", "ab-field-label", options.label));
    const input = el("input", `ab-input ${options.className ?? ""}`.trim());
    input.type = "text";
    input.id = options.id;
    input.name = options.name;
    input.value = options.value;
    wrap.append(input);
    if (options.hint !== undefined) {
      const hint = el("span", "ab-field-hint", options.hint);
      hint.id = `${options.id}-hint`;
      input.setAttribute("aria-describedby", hint.id);
      wrap.append(hint);
    }
    return { wrap, input };
  }

  private editableSection(): HTMLElement {
    const edited = this.edited as SettingsSnapshot;
    const section = this.section("ab-settings-basics", "About this book");

    const title = this.textField({
      id: "ab-set-title",
      name: "title",
      label: "Title",
      value: edited.title,
      className: "ab-settings-title",
    });
    title.input.addEventListener("input", () => {
      edited.title = title.input.value;
    });
    section.append(title.wrap);

    const language = this.textField({
      id: "ab-set-language",
      name: "language",
      label: "Language",
      value: edited.language,
      hint: "A language tag like en-US, fr, or pt-BR.",
      className: "ab-settings-language",
    });
    language.input.addEventListener("input", () => {
      edited.language = language.input.value;
    });
    section.append(language.wrap);

    const license = this.textField({
      id: "ab-set-license",
      name: "license",
      label: "Licence",
      value: edited.license ?? "",
      hint: "Leave blank to say nothing about reuse.",
      className: "ab-settings-license",
    });
    license.input.setAttribute("list", "ab-license-options");
    const options = el("datalist");
    options.id = "ab-license-options";
    for (const identifier of SUGGESTED_LICENSES) {
      const option = el("option");
      option.value = identifier;
      options.append(option);
    }
    const summary = el("p", "ab-license-summary");
    const paintSummary = (): void => {
      const text = licenseSummary(license.input.value.trim() === "" ? null : license.input.value);
      // An unrecognised identifier gets NO summary - never an invented one.
      summary.textContent = text ?? "";
      summary.hidden = text === null;
    };
    paintSummary();
    license.input.addEventListener("input", () => {
      const value = license.input.value.trim();
      edited.license = value === "" ? null : license.input.value;
      paintSummary();
    });
    section.append(license.wrap, options, summary);

    section.append(this.publicationFields());
    return section;
  }

  /**
   * The three display flags. Each is genuinely tri-state in the API - true,
   * false, or null meaning "not set, use the default" - so it is a select and
   * not a checkbox: a checkbox would quietly rewrite "not set" as "off" the
   * first time the form was saved, which is a change the author never made.
   */
  private publicationFields(): HTMLElement {
    const edited = this.edited as SettingsSnapshot;
    const group = el("fieldset", "ab-settings-publication");
    group.append(el("legend", "ab-settings-legend", "What readers see on each chapter"));
    const fields: { key: keyof SettingsSnapshot["publication"]; label: string; hint: string }[] = [
      {
        key: "show_revision",
        label: "Show the revision number",
        hint: "Which version of the chapter a reader is looking at.",
      },
      {
        key: "show_attribution",
        label: "Show who contributed",
        hint: "The attribution line naming the people and agents who worked on the chapter.",
      },
      {
        key: "show_public_annotations",
        label: "Show public annotations",
        hint: "Notes and suggestions readers have left, visible to everyone.",
      },
    ];
    for (const field of fields) {
      const id = `ab-set-${field.key}`;
      const label = el("label", "ab-field ab-settings-field");
      label.htmlFor = id;
      label.append(el("span", "ab-field-label", field.label));
      const select = el("select", "ab-input ab-settings-toggle");
      select.id = id;
      select.name = field.key;
      for (const [value, text] of [
        ["", "Use the default"],
        ["true", "Yes"],
        ["false", "No"],
      ] as const) {
        const option = el("option", undefined, text);
        option.value = value;
        select.append(option);
      }
      select.value = flagValue(edited.publication[field.key]);
      select.addEventListener("change", () => {
        edited.publication[field.key] = parseFlag(select.value);
      });
      const hint = el("span", "ab-field-hint", field.hint);
      hint.id = `${id}-hint`;
      select.setAttribute("aria-describedby", hint.id);
      label.append(select, hint);
      group.append(label);
    }
    return group;
  }

  // ---- governance ---------------------------------------------------------

  private governanceSection(doc: SettingsDocument): HTMLElement {
    const edited = this.edited as SettingsSnapshot;
    const section = this.section("ab-settings-governance", GOVERNANCE_HEADING);
    section.append(
      el(
        "p",
        "ab-governance-intro",
        "People (and agents) vote on suggestions. When a suggestion meets the requirements below, it stops being a suggestion and becomes a task in your work queue.",
      ),
    );
    const source = el("p", "ab-governance-source", sourceNotice(doc.governance.source));
    if (doc.governance.source === "bootstrap") {
      source.classList.add("ab-governance-bootstrap");
    }
    section.append(source);

    const names = Object.keys(edited.rules);
    if (names.length === 0) {
      section.append(
        el(
          "p",
          "ab-governance-empty",
          "This book has no voting rule, so no suggestion is ever promoted automatically. A maintainer can still promote one by hand.",
        ),
      );
      return section;
    }
    for (const name of names) {
      section.append(this.ruleBlock(name));
    }
    return section;
  }

  private ruleBlock(name: string): HTMLElement {
    const edited = this.edited as SettingsSnapshot;
    const block = el("div", "ab-rule");
    block.dataset["rule"] = name;
    const clauses = el("ul", "ab-rule-clauses");
    const lead = el("p", "ab-rule-lead");
    const outcome = el("p", "ab-rule-outcome");

    const paint = (): void => {
      const rule = edited.rules[name] as EditableRule;
      const language = describeRule(name, rule);
      lead.textContent = language.lead;
      outcome.textContent = language.outcome;
      clauses.textContent = "";
      language.clauses.forEach((clause, index) => {
        const item = el("li", "ab-rule-clause");
        item.append(el("span", "ab-clause-text", clause.text));
        const id = `ab-rule-${name}-${index}`;
        const label = el("label", "ab-field ab-clause-field");
        label.htmlFor = id;
        label.append(el("span", "ab-field-label", "How many"));
        const input = el("input", "ab-input ab-rule-threshold");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.id = id;
        input.name = `rule.${name}.${index}`;
        input.value = String(clause.condition.value);
        input.addEventListener("input", () => {
          const value = Number(input.value);
          if (!Number.isFinite(value)) {
            return;
          }
          const current = edited.rules[name] as EditableRule;
          const conditions = conditionsOf(current).map((condition, position) =>
            position === index ? { ...condition, value } : condition,
          );
          edited.rules[name] = withConditions(current, conditions);
          // Only the sentence changes, so it is retyped in place: re-rendering
          // the clause list would take focus out of the number the maintainer
          // is still typing.
          const item2 = describeRule(name, edited.rules[name] as EditableRule).clauses[index];
          if (item2 !== undefined) {
            const text = item.querySelector<HTMLElement>(".ab-clause-text");
            if (text !== null) text.textContent = item2.text;
          }
        });
        label.append(input);
        item.append(label);
        item.append(el("p", "ab-clause-explain", clause.explain));
        clauses.append(item);
      });
    };

    const rule = edited.rules[name] as EditableRule;
    const heading = el("h3", "ab-rule-name", describeRule(name, rule).label);
    block.append(heading, lead, clauses, outcome);

    // The human-maintainer requirement as a labelled choice: the contract makes
    // it both editable AND removable, so it is a real toggle rather than a
    // clause the maintainer has to know how to delete.
    const toggleId = `ab-rule-${name}-human-maintainer`;
    const toggleLabel = el("label", "ab-field-check ab-human-maintainer-field");
    toggleLabel.htmlFor = toggleId;
    const toggle = el("input", "ab-require-human-maintainer");
    toggle.type = "checkbox";
    toggle.id = toggleId;
    toggle.name = `rule.${name}.require_human_maintainer`;
    toggle.checked = hasHumanMaintainerClause(rule);
    toggleLabel.append(toggle, el("span", "ab-field-label", HUMAN_MAINTAINER_LABEL));
    toggle.addEventListener("change", () => {
      edited.rules[name] = withHumanMaintainerClause(
        edited.rules[name] as EditableRule,
        toggle.checked,
      );
      paint();
    });
    block.append(toggleLabel);
    block.append(
      el(
        "p",
        "ab-human-maintainer-note",
        "Turn this off only if you are happy for a suggestion to become work without any human maintainer approving it.",
      ),
    );
    paint();
    return block;
  }

  // ---- guarded ------------------------------------------------------------

  private guardedSection(doc: SettingsDocument): HTMLElement {
    const edited = this.edited as SettingsSnapshot;
    const original = this.original as SettingsSnapshot;
    const section = this.section("ab-settings-guarded", "Addresses (changing these breaks links)");

    const slugField = this.textField({
      id: "ab-set-slug",
      name: "slug",
      label: "Book slug",
      value: edited.slug,
      className: "ab-settings-slug ab-guarded-input",
    });
    const slugConsequence = el(
      "p",
      "ab-guarded-consequence",
      // Server-supplied: the UI does not keep its own copy of what breaks.
      doc.guarded?.["slug"]?.consequence ?? "",
    );
    slugConsequence.hidden = true;
    slugField.input.addEventListener("input", () => {
      edited.slug = slugField.input.value;
      // Stated as soon as the field is modified - before the change is
      // accepted, not after it has been attempted.
      slugConsequence.hidden = edited.slug === original.slug;
    });
    section.append(slugField.wrap, slugConsequence);

    const urlField = this.textField({
      id: "ab-set-chapter-url",
      name: "chapter_url",
      label: "Chapter address template",
      value: edited.chapterUrl ?? "",
      hint: "Leave blank to use this book's default chapter addresses.",
      className: "ab-settings-chapter-url ab-guarded-input",
    });
    const urlConsequence = el(
      "p",
      "ab-guarded-consequence",
      doc.guarded?.["publication.chapter_url"]?.consequence ?? "",
    );
    urlConsequence.hidden = true;
    urlField.input.addEventListener("input", () => {
      const value = urlField.input.value.trim();
      edited.chapterUrl = value === "" ? null : urlField.input.value;
      urlConsequence.hidden = edited.chapterUrl === original.chapterUrl;
    });
    section.append(urlField.wrap, urlConsequence);
    return section;
  }

  /**
   * The never-editable boundary, EXPLAINED. Prose only: no inputs, no values,
   * nothing bound to anything. It is collapsed because it answers a question
   * most maintainers will not ask, and absent entirely when the API sends no
   * reasons.
   */
  private readOnlyExplainer(reasons: string[]): HTMLElement {
    const details = el("details", "ab-settings-readonly");
    const summary = el("summary", "ab-readonly-summary", "Why can't everything be changed here?");
    details.append(summary);
    details.append(
      el(
        "p",
        "ab-readonly-intro",
        "A few things about this book are fixed outside the browser. They are changed in a reviewed commit, or not at all:",
      ),
    );
    const list = el("ul", "ab-readonly-list");
    for (const reason of reasons) {
      list.append(el("li", "ab-readonly-reason", reason));
    }
    details.append(list);
    return details;
  }

  // ---- save ---------------------------------------------------------------

  private async save(): Promise<void> {
    if (this.original === null || this.edited === null) {
      return;
    }
    this.error.hidden = true;
    this.confirmWrap.hidden = true;
    this.confirmWrap.textContent = "";
    const patch = buildPatch(this.original, this.edited);
    if (patchIsEmpty(patch)) {
      // No commit for a form nobody changed.
      this.status.textContent = "Nothing to save - these are the settings already stored.";
      return;
    }
    await this.send(patch, null);
  }

  private async send(patch: SettingsPatch, confirm: string[] | null): Promise<void> {
    const body: SettingsPatch = confirm === null ? patch : { ...patch, confirm };
    if (this.saveButton !== null) this.saveButton.disabled = true;
    this.status.textContent = "Saving…";
    const result = await this.api.patchSettings(body);
    if (this.saveButton !== null) this.saveButton.disabled = false;

    if (!result.ok) {
      this.status.textContent = "";
      this.handleFailure(result.status, result.message, result.problem, patch);
      return;
    }
    this.confirmWrap.hidden = true;
    this.confirmWrap.textContent = "";
    this.status.textContent =
      result.value.status === "unchanged"
        ? "Nothing changed - these settings were already stored."
        : "Saved. Your change is being committed to this book's repository now.";
    // Round-trip: show what was actually stored, not what was typed.
    await this.load(true);
  }

  private handleFailure(
    status: number,
    message: string,
    problem: Record<string, unknown> | undefined,
    patch: SettingsPatch,
  ): void {
    const code = problemCode(problem);
    if (code.includes("settings-confirmation-required")) {
      this.renderConfirmation(problem, patch);
      return;
    }
    if (code.includes("validation-failed")) {
      const issues = Array.isArray(problem?.["issues"])
        ? (problem["issues"] as { path?: string; message?: string }[])
        : [];
      this.showError(message, issues);
      return;
    }
    if (status === 0) {
      this.showError("The API could not be reached, so nothing was saved. Try again in a moment.");
      return;
    }
    this.showError(message);
  }

  /**
   * The explicit confirmation step. Everything shown here is the API's own
   * account of what breaks; the checkbox starts unticked and the confirm button
   * starts disabled, so the resend can only happen after two deliberate acts.
   */
  private renderConfirmation(problem: Record<string, unknown> | undefined, patch: SettingsPatch): void {
    const fields = Array.isArray(problem?.["fields"])
      ? (problem["fields"] as { field?: string; breaks?: string }[])
      : [];
    const confirmWith = Array.isArray(problem?.["confirmWith"])
      ? (problem["confirmWith"] as unknown[]).filter((value): value is string => typeof value === "string")
      : fields.map((field) => field.field ?? "").filter((field) => field !== "");

    this.confirmWrap.textContent = "";
    this.confirmWrap.hidden = false;
    this.confirmWrap.append(el("h3", "ab-confirm-heading", "Not saved yet - please confirm"));
    for (const field of fields) {
      if (typeof field.breaks === "string" && field.breaks.length > 0) {
        this.confirmWrap.append(el("p", "ab-confirm-breaks", field.breaks));
      }
    }
    const checkId = "ab-confirm-check";
    const label = el("label", "ab-field-check ab-confirm-field");
    label.htmlFor = checkId;
    const check = el("input", "ab-confirm-check");
    check.type = "checkbox";
    check.id = checkId;
    check.name = "confirm";
    check.checked = false; // never pre-ticked
    label.append(check, el("span", "ab-field-label", "I understand what this breaks."));

    const confirmButton = el("button", "ab-btn ab-primary ab-confirm-btn", "Save anyway");
    confirmButton.type = "button";
    confirmButton.disabled = true;
    check.addEventListener("change", () => {
      confirmButton.disabled = !check.checked;
    });
    confirmButton.addEventListener("click", () => {
      confirmButton.disabled = true;
      void this.send(patch, confirmWith);
    });
    this.confirmWrap.append(label, confirmButton);
    this.confirmWrap.append(
      srOnly("This change needs your confirmation before it can be saved."),
    );
    this.status.textContent = "This change needs your confirmation before it can be saved.";
  }
}
