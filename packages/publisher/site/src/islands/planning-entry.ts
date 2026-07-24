/** Lightweight story-page entry; the Milkdown implementation stays lazy. */
import { AuthorbotPlanningDocumentEditor } from "./planning-document-editor.js";
import "./story-view-tabs.js";
import { loadLazyModule } from "./lazy-module.js";

if (customElements.get("authorbot-planning-document-editor") === undefined) {
  customElements.define(
    "authorbot-planning-document-editor",
    AuthorbotPlanningDocumentEditor,
  );
}

if (
  document.querySelector("authorbot-outline-summaries") !== null &&
  customElements.get("authorbot-outline-summaries") === undefined
) {
  // Timeline and Character pages share this entry but never need the private
  // Outline projection. Keep it in a retryable page-only chunk.
  void loadLazyModule(() => import("./outline-summaries.js"))
    .then(({ AuthorbotOutlineSummaries }) => {
      if (customElements.get("authorbot-outline-summaries") === undefined) {
        customElements.define("authorbot-outline-summaries", AuthorbotOutlineSummaries);
      }
    })
    .catch(() => {
      // Progressive enhancement: the published-only static section remains.
    });
}
