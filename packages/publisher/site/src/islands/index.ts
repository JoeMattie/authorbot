/**
 * Islands entry (Phase 2b contract §1, Phase 3 contract §6, Phase 6 contract
 * §3.5-§3.6): defines the collaboration custom elements. One bundle serves
 * every island; chapter pages mount `<authorbot-collab>`, the `/work/` page
 * mounts `<authorbot-work-queue>`, `/write/` mounts the legacy chapter
 * composer, and chapter pages mount the lightweight in-place editor launcher.
 * The settings and access consoles have page-only bundles, keeping their
 * administration code off reader pages.
 * Emitted only for builds given an API base.
 */
import { AuthorbotAccount } from "./account.js";
import { AuthorbotChapterActivity } from "./chapter-activity.js";
import { AuthorbotChapterComposer } from "./chapter-composer.js";
import { AuthorbotCollab } from "./collab-element.js";
import { AuthorbotDraftChapters } from "./draft-chapters.js";
import { loadLazyModule } from "./lazy-module.js";
import { AuthorbotManuscriptEditor } from "./manuscript-editor-element.js";
import { AuthorbotNewChapter } from "./new-chapter-button.js";

const ELEMENTS: ReadonlyArray<readonly [string, CustomElementConstructor]> = [
  ["authorbot-collab", AuthorbotCollab],
  // The header strip: sign in, sign out, and the way into Settings and Work.
  ["authorbot-account", AuthorbotAccount],
  ["authorbot-chapter-activity", AuthorbotChapterActivity],
  ["authorbot-chapter-composer", AuthorbotChapterComposer],
  ["authorbot-draft-chapters", AuthorbotDraftChapters],
  ["authorbot-manuscript-editor", AuthorbotManuscriptEditor],
  ["authorbot-new-chapter", AuthorbotNewChapter],
];

for (const [tag, constructor] of ELEMENTS) {
  if (customElements.get(tag) === undefined) {
    customElements.define(tag, constructor);
  }
}

// The claim editor is substantial and appears only on /work/. Keep it out of
// every chapter reader's entry payload while preserving the same custom
// element contract on the page that mounts it.
if (document.querySelector("authorbot-work-queue") !== null) {
  void loadLazyModule(() => import("./work-queue.js"))
    .then(({ AuthorbotWorkQueue }) => {
      if (customElements.get("authorbot-work-queue") === undefined) {
        customElements.define("authorbot-work-queue", AuthorbotWorkQueue);
      }
    })
    .catch(() => {
      // The mount already contains the progressive-enhancement fallback. A
      // permanent chunk failure must stay handled and leave that copy intact.
    });
}

// The diff queue is maintainer-only and substantially larger than the reader
// islands. Load it only on /revisions/, preserving the chapter bundle budget.
if (document.querySelector("authorbot-revision-review") !== null) {
  void loadLazyModule(() => import("./revision-review.js"))
    .then(({ AuthorbotRevisionReview }) => {
      if (customElements.get("authorbot-revision-review") === undefined) {
        customElements.define("authorbot-revision-review", AuthorbotRevisionReview);
      }
    })
    .catch(() => {
      // The mount's fallback remains visible after a terminal chunk failure.
    });
}
