/**
 * Base-path support (ADR-0019 §6). A book may be served under a subpath of a
 * larger site - `example.com/my-book/` - with its API under the same prefix,
 * so `API_BASE_PATH=/my-book` makes the routes live at `/my-book/v1/*`.
 *
 * This is what makes "same origin only" tolerable: the constraint is one
 * ORIGIN, not the root of a domain. The publisher's `publication.api_url`
 * carries the mirror-image value (`/my-book`), and the islands build every
 * request URL from it.
 */

/** One path segment: no slashes, no encoding tricks, no dot-segments. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/**
 * Normalize and validate `API_BASE_PATH`. Returns `""` (mounted at the origin
 * root) for absent, empty, or `"/"` input; otherwise a leading-slash,
 * no-trailing-slash path such as `/my-book` or `/books/hollow-creek`.
 *
 * Invalid input throws at boot rather than silently serving the API somewhere
 * the site is not looking for it - a base path that is wrong by one character
 * produces a site whose every collaboration call 404s.
 */
export function normalizeBasePath(raw: string | undefined): string {
  if (raw === undefined) {
    return "";
  }
  const value = raw.trim();
  if (value === "" || value === "/") {
    return "";
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new Error(
      `API_BASE_PATH "${raw}" must be a root-relative path such as "/my-book", not an absolute URL (ADR-0019)`,
    );
  }
  if (!value.startsWith("/")) {
    throw new Error(`API_BASE_PATH "${raw}" must start with "/" (e.g. "/my-book")`);
  }
  if (value.includes("?") || value.includes("#")) {
    throw new Error(`API_BASE_PATH "${raw}" must not contain a query string or fragment`);
  }
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed === "") {
    return ""; // "//" and friends: still the origin root.
  }
  const segments = trimmed.slice(1).split("/");
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new Error(
        `API_BASE_PATH "${raw}" has an invalid segment "${segment}" ` +
          `(expected path segments of [A-Za-z0-9._~-], no empty or dot segments)`,
      );
    }
  }
  return `/${segments.join("/")}`;
}
