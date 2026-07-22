/** Settings-only entry, loaded by /settings/ and never by reader pages. */
import { AuthorbotSettings } from "./settings-view.js";

if (customElements.get("authorbot-settings") === undefined) {
  customElements.define("authorbot-settings", AuthorbotSettings);
}
