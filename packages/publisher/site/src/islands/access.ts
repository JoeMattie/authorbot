/**
 * Entry for the access-control island (Phase 7 contract, "Author-facing access
 * control"). Bundled SEPARATELY from `authorbot-collab.js` and loaded only by
 * `/settings/`.
 *
 * The separation is deliberate. Phase 2b §1 budgets the collaboration islands
 * at 35 KB gzipped because that bundle is what every reader downloads on every
 * chapter page. A collaborator table, a token list, an audit log and a
 * moderation queue are maintainer-only and belong in none of those page loads,
 * so they ship as their own entry with their own budget. Emitted only for
 * builds given an API base, exactly like the collab bundle, so an api-url-less
 * build stays byte-identically script-free.
 */
import { AuthorbotAccess } from "./access-view.js";

if (customElements.get("authorbot-access") === undefined) {
  customElements.define("authorbot-access", AuthorbotAccess);
}
