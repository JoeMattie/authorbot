/**
 * `<authorbot-work-queue>` — the `/work/` island. Phase 3 shipped the
 * read-only queue of **ready** work items; Phase 4 (contract §7) adds the
 * claim-and-edit flow on top: a Claim button for actors holding `work:claim`,
 * the §15.3 task bundle rendered as an edit view (`work-claim.ts`), a live
 * lease countdown with renewal prompt and release, and the honest
 * `submit → syncing → completed | conflict` ladder.
 *
 * Progressive enhancement (§2b §1): the page ships a static fallback inside
 * the mount; this element replaces it only after the API answers. With JS off,
 * or the API unreachable, the fallback message stays and nothing errors.
 *
 * Security: every API string reaches the DOM through `textContent`; the only
 * markup is the chapter link, whose href comes from the build-time chapter map
 * (trusted), never from API data. The lease token is never rendered.
 */
import { CollabApi, type Me, type TaskBundle, type WorkItem } from "./api.js";
import { el, srOnly } from "./dom.js";
import { tallyOrEmpty, tallySummary } from "./vote-view.js";
import { ClaimPanel, typeLabel, type ChapterRef } from "./work-claim.js";
import {
  clearClaim,
  leaseStatus,
  loadClaim,
  prefillFor,
  saveClaim,
  toStoredClaim,
  type StoredClaim,
} from "./work-state.js";

interface WorkConfig {
  apiBase: string;
  project: string;
  chapters: Map<string, ChapterRef>;
}

function parseConfig(host: HTMLElement): WorkConfig | null {
  const { apiBase, project } = host.dataset;
  if (apiBase === undefined || project === undefined) {
    return null;
  }
  const chapters = new Map<string, ChapterRef>();
  try {
    const raw = JSON.parse(host.dataset.chapters ?? "{}") as Record<string, ChapterRef>;
    for (const [id, ref] of Object.entries(raw)) {
      if (typeof ref?.title === "string" && typeof ref?.href === "string") {
        chapters.set(id, ref);
      }
    }
  } catch {
    // malformed map: fall back to bare chapter ids
  }
  return { apiBase, project, chapters };
}

/** sessionStorage, or null where it is unavailable (privacy modes, SSR). */
function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export class AuthorbotWorkQueue extends HTMLElement {
  private api!: CollabApi;
  private cfg!: WorkConfig;
  private started = false;
  private list!: HTMLElement;
  private status!: HTMLElement;
  private live!: HTMLElement;
  private moreWrap!: HTMLElement;
  private panel: ClaimPanel | null = null;
  private cursor: string | null = null;
  private count = 0;
  private me: Me | null = null;

  /** Injected by tests; `Date.now` in the browser. */
  now: () => number = () => Date.now();

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
    this.panel?.destroy();
  }

  private async start(): Promise<void> {
    const auth = await this.api.meResult();
    if (!auth.ok) {
      // Unreachable API: leave the static fallback (progressive enhancement).
      return;
    }
    this.me = auth.value;
    this.scaffold();
    // A claim survives a refresh (contract §7 / Phase 2b draft preservation).
    const stored = loadClaim(sessionStorageOrNull(), this.cfg.project);
    if (stored !== null) {
      if (leaseStatus(stored.lease, this.now()).expired) {
        clearClaim(sessionStorageOrNull(), this.cfg.project);
        this.announce("Your lease expired while you were away; the work item is back in the queue.");
      } else {
        this.openPanel(stored, true);
      }
    }
    await this.load(true);
  }

  private canClaim(): boolean {
    return this.me !== null && this.me.scopes.includes("work:claim");
  }

  /**
   * Whether this tab already holds a live claim. Read from storage (not just
   * panel visibility) so it stays correct across a refresh, and treated as
   * inactive once the lease has expired — the server has already returned
   * that item to the queue.
   */
  private hasActiveClaim(): boolean {
    const stored = loadClaim(sessionStorageOrNull(), this.cfg.project);
    return stored !== null && !leaseStatus(stored.lease, this.now()).expired;
  }

  private async load(first: boolean): Promise<void> {
    const result = await this.api.workItems(this.cursor ?? undefined);
    if (!result.ok) {
      if (result.status === 0) {
        return;
      }
      this.status.hidden = false;
      this.status.textContent =
        result.status === 401 || result.status === 403
          ? "Sign in with an editor (or higher) role to view the work queue."
          : `Work queue unavailable: ${result.message}`;
      this.moreWrap.hidden = true;
      return;
    }
    if (first) {
      this.list.textContent = "";
      this.count = 0;
    }
    for (const item of result.value.items) {
      this.list.append(this.buildItem(item));
      this.count += 1;
    }
    this.cursor = result.value.nextCursor;
    this.moreWrap.hidden = this.cursor === null;
    this.status.hidden = this.count > 0;
    if (this.count === 0) {
      this.status.hidden = false;
      this.status.textContent = "No work items are ready.";
    }
  }

  /** Re-read the queue from the top (after a claim, release, or completion). */
  private async reload(): Promise<void> {
    this.cursor = null;
    await this.load(true);
  }

  private scaffold(): void {
    this.textContent = "";
    this.status = el("p", "ab-work-status");
    this.status.setAttribute("role", "status");
    this.status.hidden = true;
    this.live = el("p", "ab-sr ab-work-live");
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");
    this.list = el("ul", "ab-work-list");
    this.moreWrap = el("div", "ab-work-more");
    this.moreWrap.hidden = true;
    const more = el("button", "ab-btn", "Load more");
    more.type = "button";
    more.addEventListener("click", () => {
      more.disabled = true;
      void this.load(false).finally(() => {
        more.disabled = false;
      });
    });
    this.moreWrap.append(more);

    this.panel = new ClaimPanel({
      api: this.api,
      project: this.cfg.project,
      storage: sessionStorageOrNull(),
      chapters: this.cfg.chapters,
      now: () => this.now(),
      announce: (message) => this.announce(message),
      onExit: (reason) => {
        if (reason === "released") {
          this.panel?.hide();
        }
        void this.reload();
      },
    });

    this.append(this.live, this.panel.root, this.status, this.list, this.moreWrap);
  }

  private announce(message: string): void {
    this.live.textContent = message;
  }

  private openPanel(claim: StoredClaim, restored: boolean): void {
    this.panel?.show(claim, { restored });
    this.panel?.root.scrollIntoView({ block: "start", behavior: "auto" });
  }

  private buildItem(item: WorkItem): HTMLElement {
    const li = el("li", "ab-work-item");
    li.dataset["workItemId"] = item.id;
    const chapter = this.cfg.chapters.get(item.chapterId);

    const head = el("div", "ab-work-head");
    head.append(el("span", "ab-chip", typeLabel(item.type)));
    if (chapter !== undefined) {
      const link = el("a", "ab-work-chapter", chapter.title);
      link.href = chapter.href;
      head.append(link);
    } else {
      head.append(el("span", "ab-work-chapter", `Chapter ${item.chapterId}`));
    }
    li.append(head);

    const quote = item.target?.textQuote?.exact;
    if (typeof quote === "string" && quote.length > 0) {
      li.append(el("blockquote", "ab-quote", quote.length > 160 ? `${quote.slice(0, 159)}…` : quote));
    }

    const meta = el("p", "ab-work-meta");
    meta.append(
      el("span", "ab-work-base", `Base revision ${item.baseRevision}`),
      document.createTextNode(" · "),
      el("span", "ab-work-support", tallySummary(tallyOrEmpty(item.support))),
    );
    li.append(meta);

    li.append(this.buildClaimAction(item));
    li.append(srOnly(`Ready work item: ${typeLabel(item.type)} on ${chapter?.title ?? item.chapterId}`));
    return li;
  }

  /**
   * The claim affordance (contract §7): a real button for actors with
   * `work:claim`, an honest hint otherwise — never a disabled mystery.
   */
  private buildClaimAction(item: WorkItem): HTMLElement {
    const wrap = el("div", "ab-work-actions");
    // One claim at a time per tab. Stored claims are keyed per PROJECT, and
    // the lease token comes back exactly once, so claiming a second item
    // overwrote the first token irrecoverably and replaced the in-progress
    // draft with no warning — leaving the first item stuck `leased` until it
    // expired, with no way to renew, release, or submit it from this UI.
    // Refusing the second claim is the honest fix; the panel is the one place
    // a claim lives (contract §7 draft preservation).
    if (this.hasActiveClaim()) {
      wrap.append(
        el(
          "p",
          "ab-work-hint",
          "You already have a work item claimed. Submit or release it before claiming another.",
        ),
      );
      return wrap;
    }
    if (!this.canClaim()) {
      wrap.append(
        el(
          "p",
          "ab-work-hint",
          this.me === null
            ? "Sign in with an editor (or higher) role to claim work."
            : "Your role cannot claim work items.",
        ),
      );
      return wrap;
    }
    const button = el("button", "ab-btn ab-primary ab-claim-btn", "Claim");
    button.type = "button";
    button.setAttribute("aria-label", `Claim ${typeLabel(item.type)} work item`);
    const error = el("p", "ab-error ab-claim-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    button.addEventListener("click", () => {
      button.disabled = true;
      error.hidden = true;
      void this.claim(item, error).finally(() => {
        button.disabled = false;
      });
    });
    wrap.append(button, error);
    return wrap;
  }

  private async claim(item: WorkItem, error: HTMLElement): Promise<void> {
    const result = await this.api.claim(item.id);
    if (!result.ok) {
      // 409 `lease-held` carries the holder's display name only — no token,
      // no actor id (contract §2).
      const holder = result.problem?.["holder"];
      error.textContent =
        result.status === 409 && typeof holder === "string"
          ? `Already claimed by ${holder}.`
          : `Claim failed: ${result.message}`;
      // The message stays put: reloading the list here would wipe the very
      // explanation the reader needs.
      error.hidden = false;
      return;
    }
    const claim = storedClaimFor(result.value);
    // Persist immediately: the token is returned exactly once, so a refresh
    // between claiming and submitting must not strand the lease.
    saveClaim(sessionStorageOrNull(), this.cfg.project, claim);
    const bundle = result.value;
    this.announce(`Claimed. ${typeLabel(bundle.workItem.type)} — your lease is running.`);
    this.openPanel(claim, false);
    await this.reload();
  }
}

/**
 * The task bundle as the edit view's working state: the textarea starts
 * prefilled with the target (contract §7), so the writer edits the existing
 * prose instead of retyping it.
 */
export function storedClaimFor(bundle: TaskBundle): StoredClaim {
  const draft = prefillFor({
    workItem: bundle.workItem,
    document: bundle.document,
    target: bundle.target ?? null,
  });
  return toStoredClaim(bundle, draft);
}
