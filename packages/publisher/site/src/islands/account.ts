/**
 * `<authorbot-account>` - the account strip in the site header.
 *
 * WHY THIS EXISTS. Every auth and admin affordance was built for one place: a
 * reader looking at a chapter page of a populated book. Outside that, a book
 * had no way in and no way out.
 *
 * - Signing out was impossible. Not hidden - absent. The API had two routes to
 *   create a session and none to end one, so a reader on a shared machine
 *   stayed signed in until the cookie expired.
 * - A new book had no sign-in at all. The only "Sign in with GitHub" lives in
 *   the collab island, which renders only on chapter pages, and a new book has
 *   no chapters - while the wizard signs off by telling the author to sign in
 *   and press "New chapter".
 * - Settings and the work queue both served 200 and were linked from nowhere.
 *
 * One strip in the header fixes all three, because all three are the same
 * omission: the states every book passes through - empty, or signed in and
 * wanting out - had no chrome at all.
 *
 * WHAT IT SHOWS. Signed out: a sign-in link. Signed in: who you are, the
 * admin pages your role can actually use, and a way out. When the API cannot
 * be reached it renders nothing, exactly like the other islands - chrome that
 * leads nowhere is worse than no chrome.
 */
import { CollabApi, isMaintainer, roleOf, type Me } from "./api.js";
import { el } from "./dom.js";

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

export class AuthorbotAccount extends HTMLElement {
  private api!: CollabApi;
  private cfg!: Config;
  private started = false;

  connectedCallback(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const cfg = parseConfig(this);
    if (cfg === null) {
      return;
    }
    this.cfg = cfg;
    this.api = new CollabApi(cfg.apiBase, cfg.project);
    void this.start();
  }

  private async start(): Promise<void> {
    const probe = await this.api.meResult();
    if (!probe.ok) {
      // API unreachable: no chrome at all, rather than controls that fail.
      return;
    }
    this.render(probe.value);
  }

  private render(me: Me | null): void {
    this.textContent = "";
    const strip = el("div", "ab-account");

    if (me === null) {
      const signIn = el("a", "ab-account-signin", "Sign in with GitHub");
      signIn.href = this.api.signInUrl(window.location.href);
      strip.append(signIn);
      this.append(strip);
      return;
    }

    const who = el("span", "ab-account-who", me.actor.displayName);
    const role = roleOf(me);
    if (role !== null) {
      who.title = `Signed in as ${me.actor.displayName} (${role})`;
    }
    strip.append(who);

    // Only the pages this viewer can actually use. Settings is maintainer-only
    // (contract §3.6); the work queue is readable by any member.
    if (isMaintainer(me)) {
      strip.append(this.link(`${this.cfg.base}settings/`, "Settings"));
    }
    if (role !== null) {
      strip.append(this.link(`${this.cfg.base}work/`, "Work"));
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
    const ok = await this.api.signOut();
    if (!ok) {
      button.disabled = false;
      button.textContent = "Sign out failed - retry";
      return;
    }
    // Reload rather than re-render: every other island on the page is holding
    // its own view of a session that no longer exists, and asking each to
    // notice would be a lot of machinery to arrive where a reload already is.
    window.location.reload();
  }
}
