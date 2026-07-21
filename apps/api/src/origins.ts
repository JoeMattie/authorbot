/**
 * Origin checks for the same-origin deployment (ADR-0019, superseding the
 * cross-origin provisions of Phase 2b contract §3): CSRF origin matching for
 * cookie-authenticated mutations, and `return_to` validation for the OAuth
 * start route (no open redirects).
 *
 * There is no allow-list any more. The API is served from the same origin as
 * the site it collaborates with, so "allowed" means exactly one thing: the
 * API's own origin. CORS is gone entirely - see `ADR-0019` §1.
 */

/** The origin of a Referer URL, or null when absent/unparseable. */
export function refererOrigin(referer: string | undefined): string | null {
  if (referer === undefined) {
    return null;
  }
  try {
    const url = new URL(referer);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * CSRF check (ADR-0019 §3 - the check STAYS after CORS is removed; same-origin
 * is not the same as no CSRF risk): the request's `Origin` header - or, when
 * absent, the `Referer`'s origin - must exactly match the API's own origin.
 * Missing both headers fails closed (a browser always sends Origin on
 * cross-origin credentialed mutations; non-browser cookie clients must present
 * one explicitly).
 */
export function csrfOriginAllowed(
  originHeader: string | undefined,
  refererHeader: string | undefined,
  apiOrigin: string,
): boolean {
  // When Origin is present it is authoritative - never fall back to Referer
  // (an attacker-controlled page cannot forge Origin, but sends its own).
  const presented = originHeader ?? refererOrigin(refererHeader);
  if (presented === null || presented === undefined || presented === "null") {
    return false;
  }
  return presented === apiOrigin;
}

/**
 * Validate an OAuth `return_to` (ADR-0019 §4): an absolute http(s) URL within
 * the API's own origin - checked by BOTH the parser's view (`URL.origin`) and
 * a literal exact-origin-prefix match on the raw string. The double check
 * defeats parser-normalization smuggling (backslashes, `user@host`, case
 * tricks) and `javascript:`/`data:` schemes alike.
 */
export function isValidReturnTo(returnTo: string, apiOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (url.origin !== apiOrigin) {
    return false;
  }
  if (!returnTo.startsWith(url.origin)) {
    return false;
  }
  const rest = returnTo.slice(url.origin.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#");
}
