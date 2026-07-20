/**
 * ALLOWED_ORIGINS parsing and origin checks (Phase 2b contract §3): exact
 * origins only (no wildcard, no path), validated at boot; CSRF origin
 * matching for cookie-authenticated mutations; `return_to` validation for
 * the OAuth start route (exact origin prefix match — no open redirects).
 */

/**
 * Parse the comma-separated ALLOWED_ORIGINS value. Each entry must be an
 * exact origin (`scheme://host[:port]`, http or https) — anything else
 * (wildcards, paths, trailing slashes, credentials) throws at boot so a
 * misconfiguration can never widen CORS at runtime.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  const origins: string[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value.length === 0) {
      continue; // tolerate a trailing/duplicated comma
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(
        `ALLOWED_ORIGINS entry "${value}" is not a valid origin (expected scheme://host[:port])`,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`ALLOWED_ORIGINS entry "${value}" must use http or https`);
    }
    if (url.origin !== value) {
      throw new Error(
        `ALLOWED_ORIGINS entry "${value}" must be an exact origin with no path, ` +
          `trailing slash, credentials, query, or fragment (canonical form: ${url.origin})`,
      );
    }
    if (!origins.includes(value)) {
      origins.push(value);
    }
  }
  return origins;
}

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
 * CSRF check (contract §3): the request's Origin header — or, when absent,
 * the Referer's origin — must exactly match one of `allowedOrigins` or the
 * API's own origin. Missing both headers fails closed (a browser always sends
 * Origin on cross-origin credentialed mutations; non-browser cookie clients
 * must present one explicitly).
 */
export function csrfOriginAllowed(
  originHeader: string | undefined,
  refererHeader: string | undefined,
  apiOrigin: string,
  allowedOrigins: string[],
): boolean {
  // When Origin is present it is authoritative — never fall back to Referer
  // (an attacker-controlled page cannot forge Origin, but sends its own).
  const presented = originHeader ?? refererOrigin(refererHeader);
  if (presented === null || presented === undefined || presented === "null") {
    return false;
  }
  return presented === apiOrigin || allowedOrigins.includes(presented);
}

/**
 * Validate an OAuth `return_to` (contract §3): an absolute http(s) URL whose
 * origin is in ALLOWED_ORIGINS — or the API's own origin, mirroring
 * `csrfOriginAllowed`, because in the documented same-origin deployment
 * (site + API on one host, ALLOWED_ORIGINS unset) the site origin IS the API
 * origin (contract §2.4: "validates return_to against the site origin") — by
 * BOTH the parser's view (`URL.origin`) and a literal exact-origin-prefix
 * match on the raw string — the double check defeats parser-normalization
 * smuggling (backslashes, `user@host`, case tricks) and `javascript:`/`data:`
 * schemes alike.
 */
export function isValidReturnTo(
  returnTo: string,
  apiOrigin: string,
  allowedOrigins: string[],
): boolean {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (url.origin !== apiOrigin && !allowedOrigins.includes(url.origin)) {
    return false;
  }
  if (!returnTo.startsWith(url.origin)) {
    return false;
  }
  const rest = returnTo.slice(url.origin.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#");
}
