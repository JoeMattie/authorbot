/**
 * Islands entry (Phase 2b contract §1, Phase 3 contract §6, Phase 6 contract
 * §3.5-§3.6): defines the collaboration custom elements. One bundle serves
 * every island; chapter pages mount `<authorbot-collab>`, the `/work/` page
 * mounts `<authorbot-work-queue>`, `/write/` and chapter pages mount the
 * chapter composer. The settings and access consoles have page-only bundles,
 * keeping their administration code off reader pages.
 * Emitted only for builds given an API base.
 */
import { AuthorbotAccount } from "./account.js";
import { AuthorbotChapterActivity } from "./chapter-activity.js";
import { AuthorbotChapterComposer } from "./chapter-composer.js";
import { AuthorbotCollab } from "./collab-element.js";
import { AuthorbotDraftChapters } from "./draft-chapters.js";
import { AuthorbotNewChapter } from "./new-chapter-button.js";
import { AuthorbotWorkQueue } from "./work-queue.js";

const ELEMENTS: ReadonlyArray<readonly [string, CustomElementConstructor]> = [
  ["authorbot-collab", AuthorbotCollab],
  // The header strip: sign in, sign out, and the way into Settings and Work.
  ["authorbot-account", AuthorbotAccount],
  ["authorbot-work-queue", AuthorbotWorkQueue],
  ["authorbot-chapter-activity", AuthorbotChapterActivity],
  ["authorbot-chapter-composer", AuthorbotChapterComposer],
  ["authorbot-draft-chapters", AuthorbotDraftChapters],
  ["authorbot-new-chapter", AuthorbotNewChapter],
];

for (const [tag, constructor] of ELEMENTS) {
  if (customElements.get(tag) === undefined) {
    customElements.define(tag, constructor);
  }
}
