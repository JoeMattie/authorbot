/** Lightweight story-page entry; the Milkdown implementation stays lazy. */
import { AuthorbotPlanningDocumentEditor } from "./planning-document-editor.js";

if (customElements.get("authorbot-planning-document-editor") === undefined) {
  customElements.define(
    "authorbot-planning-document-editor",
    AuthorbotPlanningDocumentEditor,
  );
}
