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
import { AuthorbotNewChapter } from "./new-chapter-button.js";

const ELEMENTS: ReadonlyArray<readonly [string, CustomElementConstructor]> = [
  ["authorbot-collab", AuthorbotCollab],
  // The header strip: sign in, sign out, and the way into Settings and Work.
  ["authorbot-account", AuthorbotAccount],
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

function defineLazyElement(
  selector: string,
  tag: string,
  request: () => Promise<CustomElementConstructor>,
): void {
  if (document.querySelector(selector) === null) return;
  void loadLazyModule(request)
    .then((constructor) => {
      if (customElements.get(tag) === undefined) customElements.define(tag, constructor);
    })
    .catch(() => undefined);
}

// History exists only on chapter pages and has its own second, click-lazy
// panel chunk. Keep even its small capability-gated launcher out of the shared
// reader entry used by the home, Work, Write, and Revisions pages.
defineLazyElement("authorbot-chapter-history", "authorbot-chapter-history", () =>
  import("./chapter-history-entry.js").then((module) => module.AuthorbotChapterHistory),
);

// The launcher handles authorization and source loading, but it is still
// chapter-only behavior. The much larger Milkdown surface remains behind the
// launcher's explicit Edit or Notes activation.
defineLazyElement("authorbot-manuscript-editor", "authorbot-manuscript-editor", () =>
  import("./manuscript-editor-element.js").then((module) => module.AuthorbotManuscriptEditor),
);

// The claim editor is substantial and appears only on /work/. Keep it out of
// every chapter reader's entry payload while preserving the same custom
// element contract on the page that mounts it.
defineLazyElement("authorbot-work-queue", "authorbot-work-queue", () =>
  import("./work-queue.js").then((module) => module.AuthorbotWorkQueue),
);

// The diff queue is maintainer-only and substantially larger than the reader
// islands. Load it only on /revisions/, preserving the chapter bundle budget.
defineLazyElement("authorbot-revision-review", "authorbot-revision-review", () =>
  import("./revision-review.js").then((module) => module.AuthorbotRevisionReview),
);
