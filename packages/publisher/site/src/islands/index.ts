/**
 * Islands entry (Phase 2b contract §1): defines the collaboration custom
 * element. Bundled by the Astro pipeline; emitted only on chapter pages of a
 * build that was given an API base.
 */
import { AuthorbotCollab } from "./collab-element.js";

if (customElements.get("authorbot-collab") === undefined) {
  customElements.define("authorbot-collab", AuthorbotCollab);
}
