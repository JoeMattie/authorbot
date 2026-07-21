/**
 * Slug derivation (Phase 6 contract §3.2: slug is "derived from the title,
 * editable, and explained as 'part of your URLs'").
 *
 * The target is Phase 0's `[a-z0-9][a-z0-9-]*` — no dots, no slashes, so a
 * slug can never escape a path segment.
 */

/** Long enough for any real title; short enough to stay a usable URL segment. */
const MAX_LENGTH = 64;

/**
 * Best-effort slug for `title`. Returns "" when the title has no characters
 * that survive (e.g. a title that is entirely emoji), which callers must treat
 * as "ask the author" rather than inventing a name for their book.
 */
export function deriveSlug(title: string): string {
  const folded = title
    .normalize("NFKD")
    // Strip combining marks so "Café" becomes "cafe" rather than losing the e.
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

  const hyphenated = folded
    // Apostrophes join rather than split: "Dune's Edge" -> "dunes-edge".
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (hyphenated.length <= MAX_LENGTH) {
    return hyphenated;
  }
  // Truncate on a word boundary where one is nearby, so a long title does not
  // end mid-word; then re-trim in case the cut landed on a hyphen.
  const cut = hyphenated.slice(0, MAX_LENGTH);
  const lastHyphen = cut.lastIndexOf("-");
  const trimmed = lastHyphen > MAX_LENGTH / 2 ? cut.slice(0, lastHyphen) : cut;
  return trimmed.replace(/^-|-$/g, "");
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Returns an error message for an unusable slug, or null when it is valid.
 * The messages are author-facing: they say what to type, not which regex
 * failed.
 */
export function validateSlug(slug: string): string | null {
  if (slug.length === 0) {
    return "A slug is required — it becomes part of your book's web address.";
  }
  if (slug.length > MAX_LENGTH) {
    return `That slug is ${String(slug.length)} characters; keep it to ${String(MAX_LENGTH)} or fewer.`;
  }
  if (!SLUG_RE.test(slug)) {
    return "Use lowercase letters, numbers, and hyphens only, starting with a letter or number.";
  }
  return null;
}

/**
 * Worker names share the slug alphabet but are a separate Cloudflare-side
 * namespace, so they get their own check with their own message.
 */
export function validateWorkerName(name: string): string | null {
  if (name.length === 0) {
    return "A name is required — it becomes part of your site's default address.";
  }
  if (name.length > 63) {
    return "Cloudflare Worker names are at most 63 characters.";
  }
  if (!SLUG_RE.test(name)) {
    return "Use lowercase letters, numbers, and hyphens only, starting with a letter or number.";
  }
  return null;
}
