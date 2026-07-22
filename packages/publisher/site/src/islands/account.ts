/**
 * `<authorbot-account>`, the account strip in the site header.
 *
 * WHY THIS EXISTS. Every auth and admin affordance was built for one place: a
 * reader looking at a chapter page of a populated book. Outside that, a book
 * had no way in and no way out.
 *
 * - Signing out was impossible. Not hidden, absent. The API had two routes to
 *   create a session and none to end one, so a reader on a shared machine
 *   stayed signed in until the cookie expired.
 * - A new book had no sign-in at all. The only "Sign in with GitHub" lives in
 *   the collab island, which renders only on chapter pages, and a new book has
 *   no chapters, while the wizard signs off by telling the author to sign in
 *   and press "New chapter".
 * - Settings and the work queue both served 200 and were linked from nowhere.
 *
 * One strip in the header fixes all three, because all three are the same
 * omission: the states every book passes through, empty, or signed in and
 * wanting out, had no chrome at all.
 *
 * WHAT IT SHOWS. Signed out: a sign-in link. Signed in: who you are, the
 * admin pages your role can actually use, and a way out. When the API cannot
 * be reached it renders nothing, exactly like the other islands, chrome that
 * leads nowhere is worse than no chrome.
 */
import type { Me, Role } from "./api.js";
import { el } from "./dom.js";
import type { ProjectStore } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

interface Config {
  apiBase: string;
  project: string;
  /** Site base path, already prefixed by the layout. */
  base: string;
}

function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project, base } = host.dataset;
  // `data-api-base=""` is valid: the API mounted at the site origin's root.
  if (apiBase === undefined || project === undefined || base === undefined) {
    return null;
  }
  return { apiBase, project, base };
}

function roleOf(me: Me | null): Role | null {
  const role = me?.memberships?.[0]?.role;
  return role === "reader" || role === "contributor" || role === "editor" || role === "maintainer"
    ? role
    : null;
}

async function endSession(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/v1/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: "{}",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class AuthorbotAccount extends HTMLElement {
  private store!: ProjectStore;
  private cfg!: Config;
  private mount = 0;
  private unsubscribe: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private renderedSession: Me | null | undefined;

  connectedCallback(): void {
    const mount = ++this.mount;
    const cfg = parseConfig(this);
    if (cfg === null) {
      return;
    }
    this.cfg = cfg;
    window.addEventListener("resize", this.onResize);
    this.onResize();
    void this.connectStore(cfg, mount);
  }

  private async connectStore(cfg: Config, mount: number): Promise<void> {
    let store: ProjectStore;
    try {
      store = await loadProjectStore(cfg);
    } catch {
      // A missing lazy chunk is a progressive-enhancement failure: keep the
      // account strip empty, with no rejected promise escaping this mount.
      return;
    }
    if (!this.isConnected || mount !== this.mount) return;
    this.store = store;
    this.unsubscribe = store.subscribe(() => this.syncFromStore());
    await this.start(mount, store);
  }

  disconnectedCallback(): void {
    this.mount += 1;
    window.removeEventListener("resize", this.onResize);
    this.unsubscribe?.();
    this.unsubscribe = null;
    const release = this.releaseConnection;
    this.releaseConnection = null;
    release?.();
    this.renderedSession = undefined;
  }

  private readonly onResize = (): void => {
    window.requestAnimationFrame(() => this.revealActiveNavigation());
  };

  /** Center the active item inside the compact, horizontally scrolling nav. */
  private revealActiveNavigation(): void {
    const nav = document.querySelector<HTMLElement>(".site-nav");
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]')?.closest<HTMLElement>("li");
    if (nav === null || active === undefined || active === null) {
      return;
    }
    const navRect = nav.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const activeLeft = activeRect.left - navRect.left + nav.scrollLeft;
    nav.scrollLeft = Math.max(0, activeLeft - (nav.clientWidth - activeRect.width) / 2);
  }

  private async start(mount: number, store: ProjectStore): Promise<void> {
    await store.getState().ensureSession();
    if (!this.isConnected || mount !== this.mount) return;
    const state = store.getState();
    if (state.sessionStatus !== "ready") {
      // API unreachable: no chrome at all, rather than controls that fail.
      return;
    }
    this.syncFromStore();
  }

  /** Reconcile account identity and the Work badge after any credential change. */
  private syncFromStore(): void {
    const state = this.store.getState();
    if (state.sessionStatus !== "ready") {
      if (state.sessionStatus === "error") {
        this.renderedSession = undefined;
        this.textContent = "";
        const release = this.releaseConnection;
        this.releaseConnection = null;
        release?.();
        this.syncGlobalWorkCount(0);
      }
      return;
    }
    if (state.session !== this.renderedSession) {
      this.renderedSession = state.session;
      this.render(state.session);
      this.onResize();
    }
    const canReadWork = state.session?.scopes.includes("work:read") === true;
    if (!canReadWork) {
      const release = this.releaseConnection;
      this.releaseConnection = null;
      release?.();
      this.syncGlobalWorkCount(0);
      return;
    }
    if (state.workItemsStatus === "idle") {
      void state.ensureWorkItems();
    }
    if (this.releaseConnection === null) {
      // `retainConnection()` publishes "connecting" synchronously. Install a
      // sentinel before that notification so this subscriber cannot recurse.
      this.releaseConnection = () => {};
      this.releaseConnection = state.retainConnection();
    }
    this.syncGlobalWorkCount(
      state.workItemsStatus === "ready" ? state.workItemIds.length : 0,
    );
  }

  /** Keep the top-bar Work badge useful on every page, not only /work/. */
  private syncGlobalWorkCount(count: number): void {
    let changed = false;
    for (const badge of document.querySelectorAll<HTMLElement>("[data-work-count]")) {
      const text = String(count);
      const hidden = count === 0;
      changed ||= badge.textContent !== text || badge.hidden !== hidden;
      badge.textContent = text;
      badge.hidden = hidden;
    }
    // The badge changes the active Work row's width on compact navigation.
    // Recenter only when that geometry actually changed.
    if (changed) this.onResize();
  }

  private render(me: Me | null): void {
    this.textContent = "";
    const strip = el("div", "ab-account");

    if (me === null) {
      const signIn = el("a", "ab-account-signin", "Sign in with GitHub");
      signIn.href = `${this.cfg.apiBase}/v1/auth/github?return_to=${encodeURIComponent(window.location.href)}`;
      strip.append(signIn);
      this.append(strip);
      return;
    }

    const role = roleOf(me);
    const identity = el("span", "ab-account-identity");
    const avatar = el(
      "span",
      "ab-account-avatar",
      me.actor.displayName.trim().slice(0, 2).toUpperCase(),
    );
    avatar.setAttribute("aria-hidden", "true");
    const identityCopy = el("span", "ab-account-identity-copy");
    const who = el("span", "ab-account-who", me.actor.displayName);
    if (role !== null) {
      who.title = `Signed in as ${me.actor.displayName} (${role})`;
    }
    identityCopy.append(who);
    if (role !== null) identityCopy.append(el("span", "ab-account-role", role));
    identity.append(avatar, identityCopy);
    strip.append(identity);

    // Settings remains an account action because it is maintainer-only. Work
    // now lives in the primary navigation, so repeating it here would give
    // every signed-in desktop user two links to the same page.
    if (role === "maintainer") {
      strip.append(this.link(`${this.cfg.base}settings/`, "Settings"));
    }

    const signOut = el("button", "ab-account-signout", "Sign out");
    signOut.type = "button";
    signOut.addEventListener("click", () => {
      void this.signOut(signOut);
    });
    strip.append(signOut);
    this.append(strip);
  }

  private link(href: string, text: string): HTMLAnchorElement {
    const anchor = el("a", "ab-account-link", text);
    anchor.href = href;
    return anchor;
  }

  private async signOut(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const ok = await endSession(this.cfg.apiBase);
    if (!ok) {
      button.disabled = false;
      button.textContent = "Sign out failed, retry";
      return;
    }
    // Reload rather than re-render: every other island on the page is holding
    // its own view of a session that no longer exists, and asking each to
    // notice would be a lot of machinery to arrive where a reload already is.
    window.location.reload();
  }
}
