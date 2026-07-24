/**
 * `<authorbot-access>`, the author-facing access control surface (Phase 7
 * contract: Seeing, Restricting, Moderating, Revoking).
 *
 * Mounted beneath `<authorbot-settings>` on `/settings/`, and shipped as its
 * OWN bundle rather than inside `authorbot-collab.js`. The reader entry loads
 * on every chapter page, while a moderation queue nobody but a maintainer can
 * open belongs only on `/settings/`. See `buildIslands` in src/build.ts.
 *
 * Four ideas do most of the work.
 *
 * **The server's words, not ours.** Role consequences and policy meanings are
 * served alongside the lists they describe. The view prefers them over its own
 * fallbacks always, so the sentence an author reads about what `maintainer`
 * grants is generated from the same constant the API authorises with.
 *
 * **No confirmation is ever default-yes.** Every destructive action opens a
 * panel that states what actually happens, with an unticked checkbox and a
 * disabled confirm button. Two deliberate acts, and the easy escape ("Keep
 * access") is the safe one.
 *
 * **Removing someone is not erasing them.** Every one of those panels, and
 * every report of what a revocation did, carries `CONTRIBUTIONS_RETAINED`. The
 * contract says the interface must not imply otherwise, so the sentence is
 * structural rather than decorative, it comes from `access-model.ts`, where a
 * test asserts its presence.
 *
 * **Freeze is not a moderation setting.** It renders in its own visually
 * distinct block, described as stopping the author's own writes and as leaving
 * readers alone, and it is kept apart from pause-agents, which is a different
 * control for a different problem.
 *
 * Security: every API-sourced string, including annotation bodies, which are
 * untrusted user prose, reaches the DOM through `textContent` (via `el`).
 * `innerHTML` is never used; the build test greps the bundle for the literal.
 */
import { isMaintainer, type AnnotationPolicy, type Me, type Role } from "./api.js";
import {
  AccessApi,
  type AccessStateDoc,
  type AgentTokenMeta,
  type AuditEvent,
  type Collaborator,
  type PendingAnnotation,
} from "./access-api.js";
import { el, labeledButton, srOnly } from "./dom.js";
import {
  ANONYMOUS_NOTE,
  CANCEL_LABEL,
  POLICY_LABEL,
  POLICY_ORDER,
  FREEZE_MEANS,
  PAUSE_AGENTS_MEANS,
  QUEUE_NOT_DRAINED_NOTE,
  RESUME_AGENTS_MEANS,
  ROLE_ORDER,
  UNFREEZE_MEANS,
  auditActionText,
  auditActorName,
  auditActors,
  auditReason,
  authorHistorySentence,
  collaboratorName,
  describeRemoval,
  describeRevokeAll,
  formatWhen,
  policyMeans,
  removalConsequence,
  revokeAllConsequence,
  roleLabel,
  roleMeans,
  tokenRevocationConsequence,
  tokenStatus,
  tokenStatusLabel,
} from "./access-model.js";

interface Config {
  apiBase: string;
  project: string;
}

/** Everything one render needs, fetched together. */
interface AccessData {
  state: AccessStateDoc;
  collaborators: Collaborator[];
  roleConsequences: Record<string, string>;
  tokens: AgentTokenMeta[];
  queue: PendingAnnotation[];
  reviewCount: number;
  audit: AuditEvent[];
  /** The API's own account of each annotation policy mode, when it sends one. */
  policyOptions: Record<string, string>;
  /** True while a previous settings commit is still in flight. */
  settingsPending: boolean;
}

/**
 * `apiBase === ""` is valid (the API at the origin root), so only a MISSING
 * attribute means "not a collab build", the element then stays inert and the
 * page's static fallback survives.
 */
function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project } = host.dataset;
  if (apiBase === undefined || project === undefined) {
    return null;
  }
  return { apiBase, project };
}

function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? words.slice(0, 2).map((word) => word[0] ?? "")
      : value.slice(0, 2).split("");
  return letters.join("").toUpperCase();
}

interface CapabilityOption {
  readonly capability: string;
  readonly label: string;
  readonly description: string;
  /** A selected grant that deserves an explicit warning before saving. */
  readonly highImpact?: boolean;
  /** The project-role floor. It is a ceiling, never an implied grant. */
  readonly roleFloor: "reader" | "contributor" | "editor" | "maintainer";
}

interface CapabilityGroup {
  readonly name: string;
  readonly description: string;
  readonly options: readonly CapabilityOption[];
}

interface CapabilityPicker {
  readonly element: HTMLElement;
  selected(): string[];
}

/**
 * Exact editorial capabilities exposed by the deployed API.
 *
 * Identity, token, membership, settings, repository integration, deployment,
 * and other project-control authority is deliberately absent. A token may do
 * the same EDITORIAL work as a human only when a maintainer selects the exact
 * grant and the token actor's project role admits it.
 */
export const AGENT_CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  {
    name: "Read",
    description: "Choose each kind of book material the agent may inspect.",
    options: [
      { capability: "chapters:read", label: "Read chapters", description: "Read chapter prose and metadata.", roleFloor: "reader" },
      { capability: "comments:read", label: "Read comments", description: "Read comments and their replies.", roleFloor: "reader" },
      { capability: "suggestions:read", label: "Read suggested edits", description: "Read suggested edits, diffs, and their replies.", roleFloor: "reader" },
    ],
  },
  {
    name: "Discuss",
    description: "Comment, suggest, reply, vote, withdraw, or moderate.",
    options: [
      { capability: "comments:write", label: "Write comments", description: "Create block, range, and whole-chapter comments.", roleFloor: "contributor" },
      { capability: "suggestions:write", label: "Suggest edits", description: "Create block, range, and whole-chapter suggested edits.", roleFloor: "contributor" },
      { capability: "replies:write", label: "Reply", description: "Reply to comments or suggested edits it can read.", roleFloor: "contributor" },
      { capability: "comments:vote", label: "Vote on comments", description: "Approve, reject, abstain, or clear a vote on an open comment.", roleFloor: "contributor" },
      { capability: "suggestions:vote", label: "Vote on suggested edits", description: "Approve, reject, abstain, or clear a vote on an open suggested edit.", roleFloor: "contributor" },
      { capability: "feedback:withdraw-own", label: "Withdraw its own feedback", description: "Withdraw comments, suggestions, or replies created by this token.", roleFloor: "contributor" },
      { capability: "feedback:moderate", label: "Moderate feedback", description: "Approve queued feedback or change another contributor's feedback state.", highImpact: true, roleFloor: "maintainer" },
    ],
  },
  {
    name: "Work",
    description: "Use the shared Work queue and submit completed assignments.",
    options: [
      { capability: "work:read", label: "Read Work", description: "See Work items and non-secret lease state.", roleFloor: "editor" },
      { capability: "work:promote", label: "Promote feedback to Work", description: "Accept an open comment or suggested edit into the Work queue.", highImpact: true, roleFloor: "maintainer" },
      { capability: "work:claim", label: "Claim Work", description: "Claim, renew, recover, and release eligible Work items.", roleFloor: "editor" },
      { capability: "work:submit", label: "Submit completed Work", description: "Submit a patch while holding its valid lease.", roleFloor: "editor" },
      { capability: "work:cancel", label: "Cancel Work", description: "Cancel an eligible Work item with an audited reason.", highImpact: true, roleFloor: "maintainer" },
    ],
  },
  {
    name: "Chapters",
    description: "Create drafts, update summaries, and control publication.",
    options: [
      { capability: "summaries:write", label: "Update chapter summaries", description: "Submit a new summary for a chapter.", roleFloor: "contributor" },
      { capability: "chapters:write", label: "Write draft chapters", description: "Create or revise a draft through the chapter API.", roleFloor: "editor" },
      { capability: "chapters:publish", label: "Publish chapters", description: "Publish or unpublish a chapter and trigger its normal deployment path.", highImpact: true, roleFloor: "maintainer" },
    ],
  },
  {
    name: "Revisions",
    description: "Submit, read, and decide reviewable manuscript changes.",
    options: [
      { capability: "revisions:read", label: "Read proposed revisions", description: "Read proposal metadata, content, and diffs.", roleFloor: "editor" },
      { capability: "revisions:write", label: "Submit revisions", description: "Submit chapter or planning-document changes for review.", roleFloor: "editor" },
      { capability: "revisions:review", label: "Approve revisions", description: "Approve or reject revisions, including one-click direct edits with an audit trail.", highImpact: true, roleFloor: "maintainer" },
    ],
  },
  {
    name: "History",
    description: "Inspect prior chapter text without granting revision review.",
    options: [
      { capability: "history:read", label: "Read chapter history", description: "Browse removed, unpublished, and earlier chapter versions.", roleFloor: "editor" },
    ],
  },
] as const;

const CAPABILITY_OPTIONS = AGENT_CAPABILITY_GROUPS.flatMap((group) => group.options);
const CAPABILITY_NAMES = CAPABILITY_OPTIONS.map(({ capability }) => capability);
const MINT_DEFAULT_CAPABILITIES = ["chapters:read"] as const;

const CAPABILITY_PRESETS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Critic", ["chapters:read", "comments:read", "suggestions:read", "comments:write", "suggestions:write", "replies:write", "comments:vote", "suggestions:vote", "feedback:withdraw-own"]],
  ["Reviewer", ["chapters:read", "comments:read", "suggestions:read", "revisions:read", "history:read"]],
  ["Drafter", ["chapters:read", "comments:read", "suggestions:read", "work:read", "work:claim", "work:submit", "summaries:write", "chapters:write", "revisions:read", "revisions:write"]],
  ["Work contributor", ["chapters:read", "comments:read", "suggestions:read", "work:read", "work:claim", "work:submit", "revisions:write"]],
];

const POLICY_DISPLAY_LABEL: Readonly<Record<AnnotationPolicy, string>> = Object.freeze({
  open: "Open",
  "approval-gated": "Approval required",
  "collaborators-only": "Collaborators only",
  locked: "Locked",
});

export class AuthorbotAccess extends HTMLElement {
  private api!: AccessApi;
  private started = false;
  private me: Me | null = null;

  private body!: HTMLElement;
  private status!: HTMLElement;
  private error!: HTMLElement;

  private data: AccessData | null = null;
  /** The audit actor filter, kept across reloads so a refresh does not lose it. */
  private auditActor = "";
  /** Ids ticked in the moderation queue, for the bulk actions. */
  private selected = new Set<string>();

  connectedCallback(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const cfg = parseConfig(this);
    if (cfg === null) {
      return; // not a collab build: leave the static fallback in place
    }
    this.api = new AccessApi(cfg.apiBase, cfg.project);
    void this.start();
  }

  private async start(): Promise<void> {
    const auth = await this.api.meResult();
    if (!auth.ok) {
      // Unreachable API: render NOTHING (progressive enhancement, 2b §1).
      return;
    }
    this.me = auth.value;
    /**
     * Signed out, or signed in without the maintainer role: render nothing at
     * all. The settings island directly above this one already explains that
     * this page is maintainer-only, and saying it twice would read as two
     * different refusals rather than one boundary.
     */
    if (this.me === null || !isMaintainer(this.me)) {
      return;
    }
    this.scaffold();
    await this.load();
  }

  private scaffold(): void {
    this.textContent = "";
    this.status = el("p", "ab-access-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.error = el("p", "ab-access-error");
    this.error.setAttribute("role", "alert");
    this.error.hidden = true;
    this.body = el("div", "ab-access-body");
    this.append(this.body, this.status, this.error);
  }

  // ---- load ---------------------------------------------------------------

  private async load(): Promise<void> {
    const [state, collaborators, tokens, audit, settings] = await Promise.all([
      this.api.accessState(),
      this.api.collaborators(),
      this.api.agentTokens(),
      this.api.audit({ actor: this.auditActor, limit: 50 }),
      // For the policy picker's descriptions and for `pending_git`: the policy
      // lives in book.yml, so changing it is a commit like any other settings
      // change, and offering the picker while one is in flight would only
      // produce a confusing failure.
      this.api.settings(),
    ]);
    if (!state.ok) {
      if (state.status === 0) return; // unreachable: stay quiet
      this.showError(state.message);
      return;
    }
    // The queue is only fetched when the policy actually gates anything: under
    // any other mode there is nothing queued and asking would be a request
    // whose answer is always empty.
    const queue = state.value.requiresApproval
      ? await this.api.moderationQueue()
      : { ok: true as const, value: { items: [], nextCursor: null, pendingCount: 0 } };

    this.data = {
      state: state.value,
      collaborators: collaborators.ok ? collaborators.value.items : [],
      roleConsequences: collaborators.ok ? collaborators.value.roleConsequences : {},
      tokens: tokens.ok ? tokens.value.items : [],
      queue: queue.ok ? queue.value.items : [],
      reviewCount: queue.ok
        ? queue.value.pendingCount
        : (state.value.pendingModerationCount ?? 0),
      audit: audit.ok ? audit.value.items : [],
      policyOptions: settings.ok ? (settings.value.settings.collaboration?.options ?? {}) : {},
      settingsPending: settings.ok && settings.value.status === "pending_git",
    };
    // Ticks referring to rows that are no longer queued would silently bulk-act
    // on nothing; drop them at every reload.
    const live = new Set(this.data.queue.map((row) => row.id));
    for (const id of [...this.selected]) {
      if (!live.has(id)) this.selected.delete(id);
    }
    this.render();
  }

  /** Reload from the API and repaint, keeping a status line the caller set. */
  private async refresh(message?: string): Promise<void> {
    await this.load();
    if (message !== undefined) {
      this.status.textContent = message;
    }
  }

  private showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
  }

  private clearMessages(): void {
    this.error.hidden = true;
    this.error.textContent = "";
    this.status.textContent = "";
  }

  /** Report a list of sentences as the live status region. */
  private report(lines: string[]): void {
    this.status.textContent = "";
    const list = el("ul", "ab-access-report");
    for (const line of lines) {
      list.append(el("li", "ab-access-report-line", line));
    }
    this.status.append(list);
  }

  // ---- render -------------------------------------------------------------

  private render(): void {
    const data = this.data;
    if (data === null) return;
    this.body.textContent = "";
    this.body.append(this.policySection(data));
    this.body.append(this.moderationSection(data));
    this.body.append(this.emergencySection(data));
    this.body.append(this.collaboratorsSection(data));
    this.body.append(this.tokensSection(data));
    this.body.append(this.auditSection(data));
    this.syncConsole(data);
  }

  private section(className: string, heading: string, intro?: string): HTMLElement {
    const section = el("section", `ab-access-section ${className}`);
    const meta: Record<string, { key: string; eyebrow: string }> = {
      "ab-access-policy": { key: "policy", eyebrow: "People & access" },
      "ab-access-collaborators": { key: "collaborators", eyebrow: "People & access" },
      "ab-access-tokens": { key: "tokens", eyebrow: "People & access" },
      "ab-access-emergency": { key: "emergency", eyebrow: "Safety" },
      "ab-access-moderation": { key: "moderation", eyebrow: "Safety" },
      "ab-access-audit": { key: "activity", eyebrow: "Record" },
    };
    const details = meta[className] ?? { key: className, eyebrow: "Book settings" };
    section.dataset["consoleSection"] = details.key;
    section.append(
      el("p", `ab-section-eyebrow${details.key === "emergency" ? " ab-section-eyebrow-danger" : ""}`, details.eyebrow),
      el("h1", "ab-access-heading", heading),
    );
    if (intro !== undefined) {
      section.append(el("p", "ab-access-intro", intro));
    }
    return section;
  }

  private syncConsole(data: AccessData): void {
    const console = this.closest<HTMLElement>("[data-settings-console]");
    if (console === null) return;
    const active = console.dataset["activeSection"] ?? "governance";
    for (const panel of console.querySelectorAll<HTMLElement>("[data-console-section]")) {
      panel.hidden = panel.dataset["consoleSection"] !== active;
    }
    const badge = console.querySelector<HTMLElement>("[data-settings-badge='moderation']");
    if (badge !== null) {
      badge.textContent = String(data.reviewCount);
      badge.hidden = !data.state.requiresApproval;
    }
  }

  // ---- restricting: the annotation policy ---------------------------------

  /**
   * Who may comment and suggest, and whether it appears immediately.
   *
   * Rendered as four radio buttons rather than a dropdown, because the four
   * modes are a PROGRESSION from public to private workspace and an author
   * choosing between them should be able to see all four at once, each with
   * what it actually means. A `<select>` hides three of the four behind a
   * click, which is precisely the wrong shape for a decision this consequential
   *, and for `locked`, which is the one most likely to be misread as "turn
   * collaboration off" and which therefore has the most to say for itself.
   *
   * Unlike freeze and pause, this is a `book.yml` change: it commits, it is
   * diffable and revertable, and it takes a moment to land.
   */
  private policySection(data: AccessData): HTMLElement {
    const current = data.state.annotationPolicy;
    const section = this.section(
      "ab-access-policy",
      "Who may comment and suggest",
      "Four modes, from a public book to a private workspace. Move up and down them as freely as you like, nothing is lost either way, and your collaborators keep their membership and their history in every mode.",
    );
    section.append(el("p", "ab-access-note ab-policy-anonymous", ANONYMOUS_NOTE));

    const group = el("fieldset", "ab-policy-choices");
    group.append(el("legend", "ab-sr", "Annotation policy"));

    let chosen: AnnotationPolicy = current;
    const apply = el("button", "ab-btn ab-primary ab-policy-apply", "Change the policy");
    apply.type = "button";
    apply.disabled = true;
    const changedNote = el(
      "span",
      "ab-policy-change-note",
      "Saves as a commit and takes effect within a few seconds.",
    );
    changedNote.hidden = true;
    const cards: { policy: AnnotationPolicy; card: HTMLElement; radio: HTMLInputElement }[] = [];

    for (const policy of POLICY_ORDER) {
      const id = `ab-policy-${policy}`;
      const choice = el("div", "ab-policy-choice");
      if (policy === current) choice.classList.add("ab-policy-current");
      const label = el("label", "ab-field-check ab-policy-label");
      label.htmlFor = id;
      const radio = el("input", "ab-policy-radio");
      radio.type = "radio";
      radio.name = "ab-annotation-policy";
      radio.id = id;
      radio.value = policy;
      radio.checked = policy === current;
      const describedBy = `${id}-means`;
      radio.setAttribute("aria-describedby", describedBy);
      const dot = el("span", "ab-policy-radio-dot");
      label.append(radio, dot, el("span", "ab-field-label", POLICY_DISPLAY_LABEL[policy]));
      choice.append(label);
      if (policy === current) {
        choice.append(el("span", "ab-badge ab-badge-role ab-current-pill", "Current"));
      }
      // The server's own words about the mode, so the sentence an author reads
      // is generated from the constant the API enforces with.
      const means = el("p", "ab-policy-means", policyMeans(policy, data.policyOptions));
      means.id = describedBy;
      choice.append(means);
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        chosen = policy;
        apply.disabled = policy === current;
        changedNote.hidden = policy === current;
        for (const row of cards) {
          row.card.classList.toggle("is-selected", row.radio.checked);
        }
      });
      cards.push({ policy, card: choice, radio });
      choice.classList.toggle("is-selected", radio.checked);
      group.append(choice);
    }
    section.append(group);

    if (data.settingsPending) {
      // A previous settings commit has not landed; the API refuses a second.
      section.append(
        el(
          "p",
          "ab-policy-pending",
          "A previous settings change has not been committed to your repository yet. Changing the policy is off until it lands, reload this page in a moment.",
        ),
      );
      return section;
    }

    apply.addEventListener("click", () => {
      void this.applyPolicy(chosen);
    });
    const actions = el("div", "ab-policy-actions");
    actions.append(apply, changedNote);
    section.append(actions);

    if (current === "approval-gated") {
      section.append(el("p", "ab-access-note ab-policy-queue-note", QUEUE_NOT_DRAINED_NOTE));
    }
    return section;
  }

  private async applyPolicy(policy: AnnotationPolicy): Promise<void> {
    this.clearMessages();
    const result = await this.api.patchSettings({ collaboration: { annotation_policy: policy } });
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    /**
     * Honest about the delay. The policy lives in `book.yml`, so the change is
     * a commit: the API has accepted it, but the projection the enforcement
     * gate reads updates when that commit lands. Claiming the new mode is
     * already in force would be a lie for the seconds in between, and those
     * are exactly the seconds an author would spend testing it.
     */
    await this.load();
    this.report([
      `Saved: ${POLICY_LABEL[policy]}.`,
      "The change is being committed to your book's repository now, and takes effect as soon as that lands, usually within a few seconds.",
      policy === "locked"
        ? "Your collaborators keep their membership and everything they have contributed. You and your maintainers, including any agent you have granted the maintainer role, can still write."
        : "Your collaborators keep their membership and everything they have contributed.",
    ]);
  }

  // ---- restricting: freeze + pause agents ---------------------------------

  /**
   * Freeze and pause-agents, in their own visually distinct block. They are
   * neighbours because both are "stop something now" and they are clearly
   * SEPARATE controls because they stop different populations: the contract
   * makes pause-agents explicitly "a separate control from freeze", so that an
   * author can stop a misbehaving fleet without dismantling their human
   * collaboration.
   */
  private emergencySection(data: AccessData): HTMLElement {
    const frozen = data.state.freeze.state === "frozen";
    const paused = data.state.agents.state === "paused";
    const section = this.section(
      "ab-access-emergency",
      "Emergency controls",
      "Two different stops, for two different problems. Neither changes who your collaborators are, and neither affects readers.",
    );
    if (frozen) {
      section.classList.add("ab-access-is-frozen");
    }

    // --- freeze ---
    const freeze = el("div", "ab-access-control ab-access-freeze");
    const freezeIcon = el("span", "ab-emergency-icon ab-freeze-icon");
    freezeIcon.setAttribute("aria-hidden", "true");
    freeze.append(freezeIcon);
    freeze.append(el("h4", "ab-access-control-name", frozen ? "This book is frozen" : "Freeze the book"));
    freeze.append(el("p", "ab-access-control-means", frozen ? UNFREEZE_MEANS : FREEZE_MEANS));
    if (frozen) {
      const since = formatWhen(data.state.freeze.since, "an unrecorded time");
      freeze.append(el("p", "ab-access-since", `Frozen since ${since}.`));
      const reason = data.state.freeze.reason;
      if (typeof reason === "string" && reason.length > 0) {
        freeze.append(el("p", "ab-access-reason", `Reason given: ${reason}`));
      }
      const lift = el("button", "ab-btn ab-access-unfreeze", "Lift the freeze");
      lift.type = "button";
      lift.addEventListener("click", () => {
        void this.applyFreeze(false, "");
      });
      freeze.append(lift);
    } else {
      const button = el("button", "ab-btn ab-danger ab-access-freeze-btn", "Freeze the book");
      button.type = "button";
      const slot = el("div", "ab-access-confirm-slot");
      button.addEventListener("click", () => {
        this.openConfirm({
          slot,
          trigger: button,
          heading: "Freeze this book?",
          consequences: [
            "Every write stops immediately, including yours. Readers are unaffected.",
            "Your collaborators keep their membership and all existing work.",
          ],
          acknowledgement: "I understand this stops every writer, including me.",
          confirmLabel: "Freeze the book",
          reason: {
            id: "ab-freeze-reason",
            label: "Why are you freezing the book?",
            required: true,
          },
          run: (reason) => this.applyFreeze(true, reason),
        });
      });
      freeze.append(button, slot);
    }
    section.append(freeze);

    // --- pause agents ---
    const agents = el("div", "ab-access-control ab-access-agents");
    const agentsIcon = el("span", "ab-emergency-icon ab-pause-icon");
    agentsIcon.setAttribute("aria-hidden", "true");
    agents.append(agentsIcon);
    agents.append(
      el("h4", "ab-access-control-name", paused ? "All agents are paused" : "Pause all agents"),
    );
    agents.append(
      el("p", "ab-access-control-means", paused ? RESUME_AGENTS_MEANS : PAUSE_AGENTS_MEANS),
    );
    if (paused) {
      const since = formatWhen(data.state.agents.since, "an unrecorded time");
      agents.append(el("p", "ab-access-since", `Paused since ${since}.`));
      const reason = data.state.agents.reason;
      if (typeof reason === "string" && reason.length > 0) {
        agents.append(el("p", "ab-access-reason", `Reason given: ${reason}`));
      }
      const resume = el("button", "ab-btn ab-access-resume-agents", "Let agents work again");
      resume.type = "button";
      resume.addEventListener("click", () => {
        void this.applyPause(false, "");
      });
      agents.append(resume);
    } else {
      const button = el("button", "ab-btn ab-access-pause-btn", "Pause all agents");
      button.type = "button";
      const slot = el("div", "ab-access-confirm-slot");
      button.addEventListener("click", () => {
        this.openConfirm({
          slot,
          trigger: button,
          heading: "Pause all agents?",
          consequences: [
            "Every agent token is suspended immediately. Your human collaborators keep working.",
            "Nothing is revoked. Resuming restores every token with its name, scopes, expiry, and history intact.",
          ],
          acknowledgement: "I understand every agent will pause immediately.",
          confirmLabel: "Pause all agents",
          reason: {
            id: "ab-pause-reason",
            label: "Why are you pausing the agents?",
            required: true,
          },
          run: (reason) => this.applyPause(true, reason),
        });
      });
      agents.append(button, slot);
    }
    section.append(agents);
    return section;
  }

  private async applyFreeze(frozen: boolean, reason: string): Promise<void> {
    this.clearMessages();
    const result = await this.api.setFreeze(frozen, reason);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    await this.refresh(
      frozen
        ? "The book is frozen. Every write is refused, including yours. Readers are unaffected."
        : "The freeze is lifted. Writing has resumed for everyone your policy allows.",
    );
  }

  private async applyPause(paused: boolean, reason: string): Promise<void> {
    this.clearMessages();
    const result = await this.api.setAgentsPaused(paused, reason);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    const affected = result.value.affectedTokens;
    await this.refresh(
      paused
        ? `All agents are paused${typeof affected === "number" ? ` (${affected} tokens)` : ""}. Your human collaborators are unaffected, and nothing was revoked.`
        : "Agents may work again. Nothing was lost while they were paused.",
    );
  }

  // ---- seeing + restricting + revoking: collaborators ---------------------

  private collaboratorsSection(data: AccessData): HTMLElement {
    const section = this.section(
      "ab-access-collaborators",
      "Collaborators",
      "Everyone with access, what their role lets them do, and when they last did anything.",
    );
    if (data.collaborators.length === 0) {
      section.append(
        el("p", "ab-access-empty", "Nobody but you has access to this book."),
      );
      return section;
    }
    const list = el("ul", "ab-access-list");
    for (const row of data.collaborators) {
      list.append(this.collaboratorRow(row, data));
    }
    section.append(list);
    return section;
  }

  private collaboratorRow(row: Collaborator, data: AccessData): HTMLElement {
    const item = el("li", "ab-access-row ab-collaborator");
    item.dataset["actor"] = row.actorId;
    const name = collaboratorName(row);

    const header = el("div", "ab-access-row-head");
    header.append(
      el(
        "span",
        `ab-collaborator-avatar${row.isAgent ? " is-agent" : ""}`,
        initials(name),
      ),
    );
    const identity = el("div", "ab-collaborator-identity");
    const nameLine = el("div", "ab-collaborator-name-line");
    nameLine.append(el("span", "ab-collaborator-name", name));
    if (row.actorId === this.me?.actor.id) {
      nameLine.append(el("span", "ab-collaborator-self", "that's you"));
    }
    identity.append(nameLine);
    if (row.isAgent) {
      // An agent actor is a token's identity, not a person's. Said plainly
      // rather than shown as a machine sitting silently among the humans.
      identity.append(el("span", "ab-badge ab-badge-agent", "Agent"));
    }
    identity.append(el("span", "ab-badge ab-badge-role", roleLabel(row.role)));
    header.append(identity);
    item.append(header);

    const facts = el("dl", "ab-access-facts");
    const fact = (term: string, value: string): void => {
      const pair = el("div", "ab-fact");
      pair.append(el("dt", "ab-fact-term", term), el("dd", "ab-fact-value", value));
      facts.append(pair);
    };
    fact("Joined", formatWhen(row.joinedAt, "at an unrecorded time"));
    // Genuinely unknown for a membership older than this feature: `null` is the
    // honest answer, and a plausible guess would be worse than a blank in a
    // view whose whole purpose is vetting.
    fact(
      "Added by",
      row.addedByActorId === null
        ? "Not recorded, this membership predates access logging"
        : this.actorLabel(row.addedByActorId, data),
    );
    fact("Last acted", formatWhen(row.lastActedAt, "Never, they have done nothing on this book"));
    item.append(facts);

    item.append(el("p", "ab-role-means", roleMeans(row.role, data.roleConsequences)));

    const actions = el("div", "ab-access-row-actions");

    // --- change a role ---
    const roleWrap = el("div", "ab-role-change");
    const selectId = `ab-role-${row.actorId}`;
    const label = el("label", "ab-field ab-role-field");
    label.htmlFor = selectId;
    label.append(el("span", "ab-field-label", `Role for ${name}`));
    const select = el("select", "ab-input ab-role-select");
    select.id = selectId;
    for (const role of ROLE_ORDER) {
      const option = el("option", undefined, roleLabel(role));
      option.value = role;
      option.selected = role === row.role;
      select.append(option);
    }
    label.append(select);
    const preview = el("p", "ab-role-preview");
    preview.hidden = true;
    const apply = el("button", "ab-btn ab-role-apply", "Change role");
    apply.type = "button";
    apply.disabled = true;
    select.addEventListener("change", () => {
      const chosen = select.value as Role;
      const changed = chosen !== row.role;
      apply.disabled = !changed;
      // The consequence in plain language, BEFORE the change: the author reads
      // what the new role may do, not the scope names it maps to.
      preview.textContent = changed
        ? `As ${roleLabel(chosen)}: ${roleMeans(chosen, data.roleConsequences)}`
        : "";
      preview.hidden = !changed;
    });
    apply.addEventListener("click", () => {
      void this.applyRole(row, select.value as Role, name);
    });
    roleWrap.append(label, preview, apply);
    actions.append(roleWrap);

    // --- remove ---
    const removeWrap = el("div", "ab-access-remove");
    const remove = el("button", "ab-btn ab-danger ab-remove-collaborator", `Remove ${name}`);
    remove.type = "button";
    const confirmSlot = el("div", "ab-access-confirm-slot");
    remove.addEventListener("click", () => {
      this.openConfirm({
        slot: confirmSlot,
        trigger: remove,
        heading: `Remove ${name} from this book?`,
        consequences: removalConsequence(name),
        acknowledgement: "I understand what this does, and what it leaves in place.",
        confirmLabel: `Remove ${name}`,
        reason: {
          id: `ab-remove-reason-${row.actorId}`,
          label: "Reason (optional, recorded in the activity log)",
        },
        run: (reason) => this.applyRemoval(row, name, reason),
      });
    });
    removeWrap.append(remove, confirmSlot);
    actions.append(removeWrap);

    item.append(actions);
    return item;
  }

  private async applyRole(row: Collaborator, role: Role, name: string): Promise<void> {
    this.clearMessages();
    const result = await this.api.changeRole(row.actorId, role);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    await this.refresh(
      result.value.changed
        ? `${name} is now ${roleLabel(role)}. ${result.value.roleMeans}`
        : `${name} already had that role, so nothing changed.`,
    );
  }

  private async applyRemoval(row: Collaborator, name: string, reason: string): Promise<void> {
    this.clearMessages();
    const result = await this.api.removeCollaborator(row.actorId, reason);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    const lines = describeRemoval(name, result.value);
    await this.load();
    this.report(lines);
  }

  /** A display name for an actor id, resolved against the lists we already have. */
  private actorLabel(actorId: string, data: AccessData): string {
    const member = data.collaborators.find((row) => row.actorId === actorId);
    if (member !== undefined) return collaboratorName(member);
    const event = data.audit.find((row) => row.actorId === actorId);
    if (event !== undefined) return auditActorName(event);
    return "someone no longer listed here";
  }

  // ---- seeing + revoking: agent tokens ------------------------------------

  private tokensSection(data: AccessData): HTMLElement {
    const section = this.section(
      "ab-access-tokens",
      "Agent tokens",
      "What each token is called, what it may do, who minted it, and when it was last used. A token's value is shown once, when it is minted, and can never be displayed again, not here, and not by any other part of Authorbot.",
    );
    const active = data.tokens.filter((token) => tokenStatus(token) === "active");

    // Before the empty-list check, deliberately. A book with no tokens is
    // exactly the book whose maintainer is looking for a way to make one, and
    // the early return below used to end the section right here, so the one
    // state that needs this control most was the one state that never showed
    // it.
    section.append(this.mintControl());

    if (data.tokens.length === 0) {
      section.append(el("p", "ab-access-empty", "This book has no agent tokens yet."));
      return section;
    }

    const list = el("ul", "ab-access-list");
    for (const token of data.tokens) {
      list.append(this.tokenRow(token));
    }
    section.append(list);

    if (active.length > 0) {
      // Revoke-all lives at the bottom of the token list, apart from the
      // per-token buttons: it is the "suspected leak" control, and it should
      // not sit where someone means to click one row's Revoke.
      const bulk = el("div", "ab-access-control ab-access-revoke-all");
      bulk.append(el("h4", "ab-access-control-name", "Revoke every token at once"));
      bulk.append(
        el(
          "p",
          "ab-access-control-means",
          "For a suspected leak: if you do not know which token got out, this stops all of them. Your human collaborators keep working.",
        ),
      );
      const button = el("button", "ab-btn ab-danger ab-revoke-all", "Revoke all agent tokens");
      button.type = "button";
      const slot = el("div", "ab-access-confirm-slot");
      button.addEventListener("click", () => {
        this.openConfirm({
          slot,
          trigger: button,
          heading: "Revoke every agent token?",
          consequences: revokeAllConsequence(active.length),
          acknowledgement: "I understand every agent will stop working immediately.",
          confirmLabel: "Revoke all tokens",
          reason: {
            id: "ab-revoke-all-reason",
            label: "Why? (required, this is the one you will want explained later)",
            required: true,
          },
          run: (reason) => this.applyRevokeAll(reason),
        });
      });
      bulk.append(button, slot);
      section.append(bulk);
    }
    return section;
  }

  /** Build the exact-capability picker shared by create and edit. */
  private capabilityPicker(
    idPrefix: string,
    initial: readonly string[],
    roleCeiling: readonly string[],
  ): CapabilityPicker {
    const wrapper = el("div", "ab-capability-picker");
    const boxes = new Map<string, HTMLInputElement>();
    const knownInitial = new Set(initial.filter((name) => CAPABILITY_NAMES.includes(name)));
    const ceiling = new Set(roleCeiling);

    const presets = el("fieldset", "ab-capability-presets");
    presets.append(el("legend", "ab-access-field", "Start with a preset (optional)"));
    const presetButtons = el("div", "ab-capability-preset-buttons");
    for (const [name, capabilities] of CAPABILITY_PRESETS) {
      const button = el("button", "ab-btn ab-capability-preset", name) as HTMLButtonElement;
      button.type = "button";
      button.addEventListener("click", () => {
        const selected = new Set(capabilities);
        for (const [capability, box] of boxes) {
          box.checked = selected.has(capability);
        }
        paintSummary();
      });
      presetButtons.append(button);
    }
    const clear = el("button", "ab-btn ab-capability-preset", "Clear") as HTMLButtonElement;
    clear.type = "button";
    clear.addEventListener("click", () => {
      for (const box of boxes.values()) box.checked = false;
      paintSummary();
    });
    presetButtons.append(clear);
    presets.append(presetButtons);
    wrapper.append(presets);

    const groups = el("div", "ab-capability-groups");
    for (const group of AGENT_CAPABILITY_GROUPS) {
      const fieldset = el("fieldset", "ab-access-scopes ab-capability-group");
      fieldset.append(el("legend", "ab-access-field", group.name));
      fieldset.append(el("p", "ab-capability-group-intro", group.description));
      for (const option of group.options) {
        const row = el("label", "ab-access-scope");
        const box = el("input", "ab-capability-checkbox") as HTMLInputElement;
        box.type = "checkbox";
        box.id = `${idPrefix}-${option.capability.replace(":", "-")}`;
        box.value = option.capability;
        box.checked = knownInitial.has(option.capability);
        box.addEventListener("change", paintSummary);
        boxes.set(option.capability, box);
        const label = el("span", "ab-access-scope-name", option.label);
        const description = el("span", "ab-access-scope-means", option.description);
        row.append(box, label, description);
        if (option.highImpact === true) {
          row.append(el("span", "ab-badge ab-capability-impact", "High impact"));
        }
        fieldset.append(row);
      }
      groups.append(fieldset);
    }
    wrapper.append(groups);

    const summary = el("section", "ab-capability-summary");
    summary.setAttribute("aria-live", "polite");
    wrapper.append(summary);

    const selected = (): string[] =>
      CAPABILITY_NAMES.filter((capability) => boxes.get(capability)?.checked === true);

    function paintSummary(): void {
      const grants = selected();
      summary.textContent = "";
      summary.append(el("h5", "ab-capability-summary-heading", "This token can"));
      if (grants.length === 0) {
        summary.append(
          el(
            "p",
            "ab-capability-summary-empty",
            "Nothing yet. It will authenticate, but it will have no editorial access until you add a capability.",
          ),
        );
        return;
      }

      const list = el("ul", "ab-capability-summary-list");
      for (const capability of grants) {
        const option = CAPABILITY_OPTIONS.find((candidate) => candidate.capability === capability);
        if (option !== undefined) {
          list.append(el("li", "ab-capability-summary-item", `${option.label}: ${option.description}`));
        }
      }
      summary.append(list);

      const inactive = grants.filter((capability) => !ceiling.has(capability));
      if (inactive.length > 0) {
        summary.append(
          el(
            "p",
            "ab-capability-inactive",
            `Inactive at the current project role: ${inactive.join(", ")}. The grants stay selected, but the API will deny them until a human maintainer raises this agent's role.`,
          ),
        );
      }
      const impactful = grants.filter(
        (capability) =>
          CAPABILITY_OPTIONS.find((candidate) => candidate.capability === capability)?.highImpact ===
          true,
      );
      if (impactful.length > 0) {
        summary.append(
          el(
            "p",
            "ab-capability-impact-note",
            `High-impact grants selected: ${impactful.join(", ")}. These can moderate, promote or cancel Work, publish chapters, or approve revisions when the agent also has the required role.`,
          ),
        );
      }
    }

    paintSummary();
    return { element: wrapper, selected };
  }

  /**
   * Minting starts with chapter read only. Every write, vote, Work action,
   * review, and sensitive-history read is an explicit maintainer choice.
   */
  private mintControl(): HTMLElement {
    const control = el("div", "ab-access-control ab-access-mint");
    control.append(el("h4", "ab-access-control-name", "Create an agent token"));
    control.append(
      el(
        "p",
        "ab-access-control-means",
        "A credential for a software agent that writes with you. Its value is shown once, here, and never again, Authorbot keeps only a hash.",
      ),
    );

    const form = el("form", "ab-access-mint-form") as HTMLFormElement;

    const nameLabel = el("label", "ab-access-field", "Name");
    const name = el("input", "ab-input") as HTMLInputElement;
    name.type = "text";
    name.required = true;
    name.maxLength = 60;
    name.placeholder = "drafting-agent";
    nameLabel.append(name);

    const daysLabel = el("label", "ab-access-field", "Expires in (days)");
    const days = el("input", "ab-input ab-input-narrow") as HTMLInputElement;
    days.type = "number";
    days.min = "1";
    days.max = "90";
    days.value = "30";
    daysLabel.append(days);

    const editorCeiling = CAPABILITY_OPTIONS.filter(
      ({ roleFloor }) => roleFloor !== "maintainer",
    ).map(({ capability }) => capability);
    const picker = this.capabilityPicker(
      "ab-mint-capability",
      MINT_DEFAULT_CAPABILITIES,
      editorCeiling,
    );

    const submit = el(
      "button",
      "ab-btn ab-primary ab-create-token",
      "Create token",
    ) as HTMLButtonElement;
    submit.type = "submit";
    const slot = el("div", "ab-access-mint-slot");

    form.append(nameLabel, daysLabel, picker.element, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit.disabled = true;
      void this.applyMint(name.value.trim(), picker.selected(), Number(days.value), slot).finally(
        () => {
          submit.disabled = false;
        },
      );
    });

    control.append(form, slot);
    return control;
  }

  /**
   * Mints, then shows the value once.
   *
   * The token is put on the page rather than into a message line, because it
   * has to be selectable and copyable and it is the only time it will ever
   * exist outside the agent that uses it. `load()` refreshes the list around
   * it, and the panel deliberately survives that refresh: re-rendering the
   * section out from under a token nobody has copied yet would destroy the one
   * thing this control exists to produce.
   */
  private async applyMint(
    name: string,
    capabilities: readonly string[],
    expiresInDays: number,
    slot: HTMLElement,
  ): Promise<void> {
    this.clearMessages();
    const result = await this.api.mintAgentToken(name, capabilities, expiresInDays);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }

    const minted = result.value;
    await this.load();

    const panel = el("div", "ab-access-token-once");
    panel.append(el("h4", "ab-access-control-name", `Token for ${minted.name}`));
    panel.append(
      el(
        "p",
        "ab-access-control-means",
        "Copy it now. This is the only time it is ever shown, and nothing in Authorbot can display it again, if it is lost, revoke it and make another.",
      ),
    );
    const value = el("code", "ab-access-token-value", minted.token);
    value.tabIndex = 0;
    panel.append(value);

    const copy = el("button", "ab-btn", "Copy") as HTMLButtonElement;
    copy.type = "button";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(minted.token).then(
        () => {
          copy.textContent = "Copied";
        },
        () => {
          // Clipboard access can be refused; the value is on the page and
          // selectable, so this is a downgrade rather than a failure.
          copy.textContent = "Select it and copy";
        },
      );
    });
    panel.append(copy);

    // Appended after `load()` re-rendered everything, so it is not swept away
    // by its own refresh.
    const target = this.body.querySelector<HTMLElement>(".ab-access-mint-slot") ?? slot;
    target.replaceChildren(panel);
    value.focus();
  }

  private tokenRow(token: AgentTokenMeta): HTMLElement {
    const item = el("li", "ab-access-row ab-token");
    item.dataset["token"] = token.id;
    const state = tokenStatus(token);

    const header = el("div", "ab-access-row-head");
    header.append(el("span", "ab-token-name", token.name));
    header.append(el("span", `ab-badge ab-badge-${state}`, tokenStatusLabel(token)));
    item.append(header);

    const facts = el("dl", "ab-access-facts");
    const fact = (term: string, value: string): void => {
      const pair = el("div", "ab-fact");
      pair.append(el("dt", "ab-fact-term", term), el("dd", "ab-fact-value", value));
      facts.append(pair);
    };
    fact("Owner", token.owner?.displayName ?? "Not recorded");
    /** Both halves matter: selected grants intersect the current role ceiling. */
    fact("Membership role", token.role === null ? "No membership, it can do nothing" : roleLabel(token.role as Role));
    const granted = token.grantedCapabilities ?? token.scopes;
    const effective = token.effectiveCapabilities ?? token.scopes;
    const effectiveSet = new Set(effective);
    const inactive = granted.filter((capability) => !effectiveSet.has(capability));
    fact(
      "Permission mode",
      token.capabilityMode === "legacy" ? "Legacy compatibility" : "Exact capabilities",
    );
    fact("Granted", granted.length === 0 ? "None" : granted.join(", "));
    fact("Effective now", effective.length === 0 ? "None" : effective.join(", "));
    fact("Inactive at this role", inactive.length === 0 ? "None" : inactive.join(", "));
    if ((token.legacyEffectiveActions?.length ?? 0) > 0) {
      fact(
        "Legacy-only actions",
        token.legacyEffectiveActions
          ?.map(({ action, sourceScope }) => `${action} via ${sourceScope}`)
          .join(", ") ?? "None",
      );
    }
    fact("Created", formatWhen(token.createdAt, "at an unrecorded time"));
    fact("Last used", formatWhen(token.lastUsedAt, "Never used"));
    fact("Expires", formatWhen(token.expiresAt, "Not recorded"));
    item.append(facts);

    if (state === "active") {
      const actions = el("div", "ab-access-row-actions ab-token-actions");
      const edit = labeledButton(
        "ab-btn ab-edit-token-capabilities",
        "Edit permissions",
        "pencil",
      );
      const revoke = el("button", "ab-btn ab-danger ab-revoke-token", `Revoke “${token.name}”`);
      revoke.type = "button";
      const revokeSlot = el("div", "ab-access-confirm-slot");
      const editSlot = el("div", "ab-token-capability-slot");
      edit.addEventListener("click", () => {
        this.openTokenCapabilityEditor(token, edit, editSlot);
      });
      revoke.addEventListener("click", () => {
        this.openConfirm({
          slot: revokeSlot,
          trigger: revoke,
          heading: `Revoke the token “${token.name}”?`,
          consequences: tokenRevocationConsequence(token.name),
          acknowledgement: "I understand this agent will stop working immediately.",
          confirmLabel: "Revoke this token",
          run: () => this.applyTokenRevocation(token),
        });
      });
      actions.append(edit, revoke);
      item.append(actions, editSlot, revokeSlot);
    }
    return item;
  }

  private openTokenCapabilityEditor(
    token: AgentTokenMeta,
    trigger: HTMLButtonElement,
    slot: HTMLElement,
  ): void {
    if (slot.childElementCount > 0) return;
    trigger.disabled = true;
    const form = el("form", "ab-token-capability-editor") as HTMLFormElement;
    form.append(el("h4", "ab-access-control-name", `Permissions for ${token.name}`));
    if (token.capabilityMode === "legacy") {
      form.append(
        el(
          "p",
          "ab-access-note ab-capability-legacy-note",
          "This token still uses legacy umbrella permissions. Saving converts it to exact capabilities. Any legacy-only action disappears unless you select its named capability here.",
        ),
      );
    }
    const roleCeiling =
      token.roleCapabilityCeiling ??
      CAPABILITY_OPTIONS.filter(
        ({ roleFloor }) => token.role === "maintainer" || roleFloor !== "maintainer",
      ).map(({ capability }) => capability);
    const picker = this.capabilityPicker(
      `ab-token-${token.id}`,
      token.grantedCapabilities ?? [],
      roleCeiling,
    );
    form.append(picker.element);

    const actions = el("div", "ab-access-row-actions");
    const save = el(
      "button",
      "ab-btn ab-primary ab-save-token-capabilities",
      "Save permissions",
    ) as HTMLButtonElement;
    save.type = "submit";
    const cancel = el(
      "button",
      "ab-btn ab-cancel-token-capabilities",
      "Cancel",
    ) as HTMLButtonElement;
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      slot.textContent = "";
      trigger.disabled = false;
      trigger.focus();
    });
    actions.append(save, cancel);
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      save.disabled = true;
      cancel.disabled = true;
      void this.applyTokenCapabilities(token, picker.selected()).finally(() => {
        save.disabled = false;
        cancel.disabled = false;
      });
    });
    slot.append(form);
    form.querySelector<HTMLInputElement>("input")?.focus();
  }

  private async applyTokenCapabilities(
    token: AgentTokenMeta,
    capabilities: readonly string[],
  ): Promise<void> {
    this.clearMessages();
    const result = await this.api.updateTokenCapabilities(token.id, capabilities);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    await this.load();
    this.report([
      `Permissions for “${token.name}” were updated without rotating its secret.`,
      "The exact capability set takes effect on the token's next request and the before/after change is in the audit log.",
    ]);
  }

  private async applyTokenRevocation(token: AgentTokenMeta): Promise<void> {
    this.clearMessages();
    const result = await this.api.revokeToken(token.id);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    await this.load();
    this.report([
      `The token “${token.name}” is revoked and stops working on its next request.`,
      "Anything that agent had claimed has been released back to the queue.",
      "Everything it already contributed stays exactly as it is.",
    ]);
  }

  private async applyRevokeAll(reason: string): Promise<void> {
    this.clearMessages();
    const result = await this.api.revokeAllTokens(reason);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    const lines = describeRevokeAll(result.value);
    await this.load();
    this.report(lines);
  }

  // ---- moderating: the approval queue -------------------------------------

  private moderationSection(data: AccessData): HTMLElement {
    const section = this.section(
      "ab-access-moderation",
      "Review queue",
      data.state.requiresApproval
        ? "Comments and suggestions from people outside your collaborators wait here. Nothing queued has reached your repository, and nothing queued can be voted on or turn into work."
        : "Nothing waits here under the current comment policy. If you switch to Approval required, new public comments and suggestions will stay here until you approve or reject them.",
    );
    if (data.state.requiresApproval) {
      section.append(el("p", "ab-access-note", QUEUE_NOT_DRAINED_NOTE));
    }

    if (data.queue.length === 0) {
      section.append(el("p", "ab-access-empty ab-queue-empty", "Nothing is waiting for review."));
      return section;
    }

    const list = el("ul", "ab-access-list ab-queue");
    for (const pending of data.queue) {
      list.append(this.pendingRow(pending));
    }
    section.append(list);
    section.append(this.bulkBar(data));
    return section;
  }

  private pendingRow(pending: PendingAnnotation): HTMLElement {
    const item = el("li", "ab-access-row ab-pending");
    item.dataset["pending"] = pending.id;
    const author = pending.author?.displayName ?? "an account with no recorded name";

    const header = el("div", "ab-access-row-head");
    const tickId = `ab-pick-${pending.id}`;
    const tickLabel = el("label", "ab-field-check ab-pending-pick");
    tickLabel.htmlFor = tickId;
    const tick = el("input", "ab-pending-check");
    tick.type = "checkbox";
    tick.id = tickId;
    tick.checked = this.selected.has(pending.id);
    tick.addEventListener("change", () => {
      if (tick.checked) this.selected.add(pending.id);
      else this.selected.delete(pending.id);
      this.paintBulkBar();
    });
    tickLabel.append(tick, srOnly(`Select this ${pending.kind} by ${author} for a bulk action`));
    header.append(tickLabel);
    header.append(
      el("span", "ab-badge ab-pending-kind", pending.kind === "suggestion" ? "Suggestion" : "Comment"),
      el("span", "ab-pending-who", `by ${author}`),
    );
    header.append(
      el("span", "ab-pending-when", formatWhen(pending.createdAt, "at an unrecorded time")),
    );
    item.append(header);

    /**
     * The comment itself. UNTRUSTED prose written by someone who is, by
     * definition, not yet trusted, rendered as plain text through
     * `textContent`, never as markup, and never treated as an instruction.
     */
    const quote = el("blockquote", "ab-pending-body", pending.body);
    item.append(quote);

    // Its target passage, so a moderator can see what it is about without
    // leaving the page, and a link to go and look properly.
    const target = el("p", "ab-pending-target");
    const chapterTitle = pending.chapter?.title;
    target.textContent =
      chapterTitle === undefined || chapterTitle === null
        ? "On a chapter that is no longer in this book."
        : `On “${chapterTitle}”${pending.target?.textQuote?.exact !== undefined ? `, about: “${pending.target.textQuote.exact}”` : pending.scope === "chapter" ? ", about the chapter as a whole" : ""}.`;
    item.append(target);

    item.append(el("p", "ab-pending-history", authorHistorySentence(pending.authorHistory)));

    const actions = el("div", "ab-access-row-actions");
    const approve = el("button", "ab-btn ab-primary ab-approve", "Approve");
    approve.type = "button";
    approve.addEventListener("click", () => {
      void this.applyApproval(pending);
    });

    const reject = el("button", "ab-btn ab-reject", "Reject");
    reject.type = "button";
    const slot = el("div", "ab-access-confirm-slot");
    reject.addEventListener("click", () => {
      this.openConfirm({
        slot,
        trigger: reject,
        heading: "Reject this comment?",
        consequences: [
          "It never appears publicly and never reaches your repository, there is nothing in Git to remove.",
          "Its author is not notified.",
          "The record is kept here, so a mistake is recoverable and a pattern of abuse stays visible.",
        ],
        acknowledgement: "I have read the comment and want to reject it.",
        confirmLabel: "Reject",
        reason: {
          id: `ab-reject-reason-${pending.id}`,
          label: "Reason (optional, kept for your own records, the author is not told)",
        },
        run: (reason) => this.applyRejection(pending, reason),
      });
    });

    actions.append(approve, reject);
    item.append(actions, slot);
    return item;
  }

  /**
   * Bulk approve / bulk reject, "because a moderation queue nobody can clear
   * is a moderation queue nobody uses". Both are disabled until something is
   * ticked, and bulk reject goes through the same confirmation as a single one.
   */
  private bulkBar(data: AccessData): HTMLElement {
    const bar = el("div", "ab-access-bulk");
    const count = el("p", "ab-bulk-count");
    count.setAttribute("role", "status");
    count.setAttribute("aria-live", "polite");

    const all = el("button", "ab-btn ab-bulk-select-all", "Select all waiting");
    all.type = "button";
    all.addEventListener("click", () => {
      for (const pending of data.queue) this.selected.add(pending.id);
      this.render();
    });

    const none = el("button", "ab-btn ab-bulk-select-none", "Clear selection");
    none.type = "button";
    none.addEventListener("click", () => {
      this.selected.clear();
      this.render();
    });

    const approve = el("button", "ab-btn ab-primary ab-bulk-approve", "Approve selected");
    approve.type = "button";
    approve.addEventListener("click", () => {
      void this.applyBulk("approve", "");
    });

    const reject = el("button", "ab-btn ab-reject ab-bulk-reject", "Reject selected");
    reject.type = "button";
    const slot = el("div", "ab-access-confirm-slot");
    reject.addEventListener("click", () => {
      const chosen = this.selected.size;
      this.openConfirm({
        slot,
        trigger: reject,
        heading: chosen === 1 ? "Reject the selected comment?" : `Reject ${chosen} selected comments?`,
        consequences: [
          "None of them ever appears publicly, and none reaches your repository.",
          "Their authors are not notified.",
          "The records are kept here, so a mistake is recoverable.",
        ],
        acknowledgement: "I want to reject everything I have selected.",
        confirmLabel: "Reject selected",
        reason: {
          id: "ab-bulk-reject-reason",
          label: "Reason for all of them (optional, for your own records)",
        },
        run: (reason) => this.applyBulk("reject", reason),
      });
    });

    bar.append(count, all, none, approve, reject, slot);
    // Painted once the bar is in the document, so the count and the disabled
    // states are right on first render rather than only after the first tick.
    queueMicrotask(() => this.paintBulkBar());
    return bar;
  }

  /** Keep the bulk bar's count and disabled states in step with the ticks. */
  private paintBulkBar(): void {
    const chosen = this.selected.size;
    const count = this.querySelector<HTMLElement>(".ab-bulk-count");
    if (count !== null) {
      count.textContent =
        chosen === 0
          ? "Nothing selected."
          : chosen === 1
            ? "1 comment selected."
            : `${chosen} comments selected.`;
    }
    for (const selector of [".ab-bulk-approve", ".ab-bulk-reject"]) {
      const button = this.querySelector<HTMLButtonElement>(selector);
      if (button !== null) button.disabled = chosen === 0;
    }
  }

  private async applyApproval(pending: PendingAnnotation): Promise<void> {
    this.clearMessages();
    const result = await this.api.approvePending(pending.id);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    await this.load();
    this.report([
      "Approved. The comment is now an ordinary annotation: it appears to readers and is being committed to your repository.",
    ]);
  }

  private async applyRejection(pending: PendingAnnotation, reason: string): Promise<void> {
    this.clearMessages();
    const result = await this.api.rejectPending(pending.id, reason);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    await this.load();
    this.report([
      "Rejected. Nothing was written to your repository and nobody was notified.",
      "The record is kept here in case you change your mind.",
    ]);
  }

  private async applyBulk(action: "approve" | "reject", reason: string): Promise<void> {
    this.clearMessages();
    const ids = [...this.selected];
    if (ids.length === 0) return;
    const result = await this.api.bulkModeration(action, ids, reason);
    if (!result.ok) {
      this.showError(result.message);
      return;
    }
    const { approved, rejected, results } = result.value;
    // Per-item outcomes rather than all-or-nothing: one row a co-maintainer
    // already reviewed must not read as a failure of the other ninety-nine.
    const skipped = results.filter((row) => row.outcome !== "approved" && row.outcome !== "rejected");
    const lines: string[] = [];
    if (approved > 0) {
      lines.push(
        approved === 1
          ? "1 comment approved, it is being committed to your repository now."
          : `${approved} comments approved, they are being committed to your repository now.`,
      );
    }
    if (rejected > 0) {
      lines.push(
        rejected === 1
          ? "1 comment rejected. Nothing was written to your repository."
          : `${rejected} comments rejected. Nothing was written to your repository.`,
      );
    }
    if (skipped.length > 0) {
      lines.push(
        `${skipped.length} were skipped because someone had already reviewed them.`,
      );
    }
    if (lines.length === 0) {
      lines.push("Nothing changed, every comment you selected had already been reviewed.");
    }
    this.selected.clear();
    await this.load();
    this.report(lines);
  }

  // ---- seeing: the audit view ---------------------------------------------

  /**
   * "Who changed this and when", answerable without a runbook.
   *
   * The contract puts this here rather than in Phase 9 for a specific reason:
   * "Vetting is guesswork without it." Deciding whether to keep someone means
   * looking at what they have actually done, which is one filter away.
   */
  private auditSection(data: AccessData): HTMLElement {
    const section = this.section(
      "ab-access-audit",
      "Activity log",
      "Everything that has happened to this book's access and content, newest first. Filter by person to see what one collaborator has done.",
    );

    const filterId = "ab-audit-actor";
    const label = el("label", "ab-field ab-audit-filter");
    label.htmlFor = filterId;
    label.append(el("span", "ab-field-label", "Show only"));
    const select = el("select", "ab-input ab-audit-actor");
    select.id = filterId;
    const everyone = el("option", undefined, "Everyone");
    everyone.value = "";
    select.append(everyone);

    // Offer everyone with access, plus anyone the current page shows who is no
    // longer a member, a removed collaborator's history is exactly what an
    // author is looking for after they remove them.
    const offered = new Map<string, string>();
    for (const row of data.collaborators) {
      offered.set(row.actor?.externalIdentity ?? row.actorId, collaboratorName(row));
    }
    for (const actor of auditActors(data.audit)) {
      if (!offered.has(actor.value)) offered.set(actor.value, actor.label);
    }
    for (const [value, text] of offered) {
      const option = el("option", undefined, text);
      option.value = value;
      option.selected = value === this.auditActor;
      select.append(option);
    }
    select.addEventListener("change", () => {
      this.auditActor = select.value;
      void this.load();
    });
    label.append(select);
    section.append(label);

    if (data.audit.length === 0) {
      section.append(
        el(
          "p",
          "ab-access-empty ab-audit-empty",
          this.auditActor === ""
            ? "Nothing has been recorded for this book yet."
            : "This person has done nothing recorded on this book.",
        ),
      );
      return section;
    }

    const list = el("ol", "ab-access-list ab-audit-list");
    for (const event of data.audit) {
      const item = el(
        "li",
        `ab-audit-event${event.actorType === "agent" ? " is-agent" : ""}`,
      );
      const what = el("span", "ab-audit-what");
      what.append(
        el("strong", "ab-audit-actor", auditActorName(event)),
        document.createTextNode(` ${auditActionText(event)}`),
      );
      item.append(what);
      item.append(el("span", "ab-audit-when", formatWhen(event.at, "at an unrecorded time")));
      const reason = auditReason(event);
      if (reason !== null) {
        item.append(el("p", "ab-audit-reason", `Reason given: ${reason}`));
      }
      list.append(item);
    }
    section.append(list);
    return section;
  }

  // ---- shared controls ----------------------------------------------------

  private reasonField(options: {
    id: string;
    label: string;
    hint?: string;
    required?: boolean;
  }): { wrap: HTMLElement; input: HTMLTextAreaElement } {
    const wrap = el("label", "ab-field ab-reason-field");
    wrap.htmlFor = options.id;
    wrap.append(el("span", "ab-field-label", options.label));
    const input = el("textarea", "ab-input ab-reason-input");
    input.id = options.id;
    input.rows = 2;
    if (options.required === true) input.required = true;
    wrap.append(input);
    if (options.hint !== undefined) {
      const hint = el("span", "ab-field-hint", options.hint);
      hint.id = `${options.id}-hint`;
      input.setAttribute("aria-describedby", hint.id);
      wrap.append(hint);
    }
    return { wrap, input };
  }

  /**
   * The destructive-action confirmation, used by every irreversible control on
   * this surface.
   *
   * Never default-yes. The panel states what actually happens, including, in
   * every case, that the person's existing contributions and attribution
   * remain, then requires a deliberate tick before the confirm button becomes
   * usable. The cancel button is labelled for the safe outcome ("Keep access")
   * rather than a bare "Cancel", so the escape reads as a decision rather than
   * as a dismissal, and it takes focus first.
   */
  private openConfirm(options: {
    slot: HTMLElement;
    trigger: HTMLButtonElement;
    heading: string;
    consequences: string[];
    acknowledgement: string;
    confirmLabel: string;
    reason?: { id: string; label: string; required?: boolean };
    run: (reason: string) => Promise<void>;
  }): void {
    options.slot.textContent = "";
    options.slot.classList.add("is-open");
    options.slot.setAttribute("role", "presentation");
    const panel = el("div", "ab-access-confirm");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", options.heading);
    panel.addEventListener("click", (event) => event.stopPropagation());
    // Not a heading element: the panel is already announced as a labelled
    // group (role + aria-label above), and a heading here would land at a
    // different depth depending on which control opened it, h5 under
    // "Revoke every token at once", h4 under a collaborator row. A paragraph
    // styled as a heading gives one consistent structure and no phantom level.
    panel.append(el("p", "ab-confirm-heading", options.heading));

    const list = el("ul", "ab-confirm-consequences");
    for (const line of options.consequences) {
      list.append(el("li", "ab-confirm-consequence", line));
    }
    panel.append(list);

    let reasonInput: HTMLTextAreaElement | null = null;
    if (options.reason !== undefined) {
      const field = this.reasonField({
        id: options.reason.id,
        label: options.reason.label,
        ...(options.reason.required === true ? { required: true } : {}),
      });
      reasonInput = field.input;
      panel.append(field.wrap);
    }

    const checkId = `${options.trigger.className.replace(/\s+/g, "-")}-ack-${Math.random().toString(36).slice(2, 8)}`;
    const ackLabel = el("label", "ab-field-check ab-confirm-field");
    ackLabel.htmlFor = checkId;
    const ack = el("input", "ab-confirm-check");
    ack.type = "checkbox";
    ack.id = checkId;
    ack.checked = false; // never pre-ticked
    ackLabel.append(ack, el("span", "ab-field-label", options.acknowledgement));
    panel.append(ackLabel);

    const actions = el("div", "ab-confirm-actions");
    const cancel = el("button", "ab-btn ab-confirm-cancel", CANCEL_LABEL);
    cancel.type = "button";
    const close = (): void => {
      options.slot.textContent = "";
      options.slot.classList.remove("is-open");
      options.trigger.hidden = false;
      options.trigger.focus();
    };
    cancel.addEventListener("click", close);
    options.slot.addEventListener("click", close, { once: true });

    const confirm = el("button", "ab-btn ab-danger ab-confirm-go", options.confirmLabel);
    confirm.type = "button";
    confirm.disabled = true;
    const refreshEnabled = (): void => {
      const reasonOk =
        options.reason?.required !== true || (reasonInput?.value.trim() ?? "") !== "";
      confirm.disabled = !ack.checked || !reasonOk;
    };
    ack.addEventListener("change", refreshEnabled);
    reasonInput?.addEventListener("input", refreshEnabled);
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      options.slot.textContent = "";
      options.slot.classList.remove("is-open");
      options.trigger.hidden = false;
      void options.run(reasonInput?.value.trim() ?? "");
    });

    actions.append(cancel, confirm);
    panel.append(actions);
    options.slot.append(panel);
    // The trigger is hidden while its own confirmation is open, so the same
    // button cannot be pressed twice into two overlapping panels.
    options.trigger.hidden = true;
    cancel.focus();
  }
}
