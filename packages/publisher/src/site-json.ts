import type { SiteModel } from "./model.js";

/**
 * File name of the site-data JSON the build writes next to `index.html`
 * (base-path nested, so a book-authored page under `public/` can fetch it
 * relatively at any base path). Reserved against `public/` shadowing by the
 * validate gate.
 */
export const SITE_JSON_FILENAME = "authorbot-site.json";

/**
 * Schema id of the emitted document. The shape is {@link SiteModel} minus
 * `localDev`, plus this discriminator. Additive changes keep v1; a breaking
 * change bumps to `authorbot.site/v2` (Phase 1 contract).
 */
export const SITE_JSON_SCHEMA = "authorbot.site/v1";

/**
 * Serialize the site model for book-authored custom pages. The same object
 * the generated pages embed, so the JSON and the rendered site are
 * consistent by construction; `localDev` never leaves the dev server.
 */
export function serializeSiteJson(model: SiteModel): string {
  const { localDev: _localDev, ...rest } = model;
  return `${JSON.stringify({ schema: SITE_JSON_SCHEMA, ...rest }, null, 2)}\n`;
}
