/**
 * `<authorbot-new-chapter>` — the Phase 6 §3.5 "New chapter" button: a single
 * link to the `/write/` page, "visible only to actors who may use it".
 *
 * That last clause is taken literally. When the API is unreachable, when the
 * viewer is signed out, or when their role cannot author chapters, this
 * element renders NOTHING — no greyed-out button, no teaser, no explanation of
 * a door that is not theirs. The `/write/` page itself explains the role
 * requirement to anyone who reaches it directly.
 *
 * It is a real `<a>`, so it is keyboard-native and behaves like every other
 * link on the page (open in a new tab, copy the address, and so on).
 */
import { CollabApi, canAuthorChapters } from "./api.js";
import { el } from "./dom.js";

interface Config {
  apiBase: string;
  project: string;
  /** The `/write/` URL, already base-path-prefixed by the Astro page. */
  href: string;
}

function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project, href } = host.dataset;
  // `data-api-base=""` is valid (a same-origin deployment, ADR-0019).
  if (apiBase === undefined || project === undefined || href === undefined || href === "") {
    return null;
  }
  return { apiBase, project, href };
}

export class AuthorbotNewChapter extends HTMLElement {
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
      return; // misconfigured build: render nothing
    }
    this.cfg = cfg;
    this.api = new CollabApi(cfg.apiBase, cfg.project);
    void this.start();
  }

  private async start(): Promise<void> {
    const auth = await this.api.meResult();
    if (!auth.ok) {
      return; // unreachable API: no collaboration chrome at all
    }
    if (!canAuthorChapters(auth.value)) {
      return;
    }
    const link = el("a", "ab-new-chapter ab-btn ab-primary", "New chapter");
    link.href = this.cfg.href;
    this.textContent = "";
    this.append(link);
  }
}
