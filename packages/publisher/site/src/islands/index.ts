/**
 * Islands entry (Phase 2b contract §1, Phase 3 contract §6): defines the
 * collaboration custom elements. One bundle serves every island; chapter
 * pages mount `<authorbot-collab>` and the `/work/` page mounts
 * `<authorbot-work-queue>`. Emitted only for builds given an API base.
 */
import { AuthorbotCollab } from "./collab-element.js";
import { AuthorbotWorkQueue } from "./work-queue.js";

if (customElements.get("authorbot-collab") === undefined) {
  customElements.define("authorbot-collab", AuthorbotCollab);
}

if (customElements.get("authorbot-work-queue") === undefined) {
  customElements.define("authorbot-work-queue", AuthorbotWorkQueue);
}
