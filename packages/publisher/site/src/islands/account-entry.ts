/** Lightweight account-only entry for read-only story pages. */
import { AuthorbotAccount } from "./account.js";

if (customElements.get("authorbot-account") === undefined) {
  customElements.define("authorbot-account", AuthorbotAccount);
}
