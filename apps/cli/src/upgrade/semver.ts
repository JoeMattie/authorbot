/**
 * The small slice of semver `authorbot upgrade` needs (ADR-0021 §1).
 *
 * Deliberately hand-rolled rather than pulled from npm: the CLI resolves one
 * kind of version string (a release of `@authorbot/cli`) against one kind of
 * pin (what a book repository's package.json records), and a dependency for
 * that would be more surface than substance.
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers, empty for a stable release. */
  readonly prerelease: readonly string[];
  /** The version as written, without a leading `v`. */
  readonly raw: string;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a semver string; returns `undefined` for anything unparseable. */
export function parseVersion(input: string): SemVer | undefined {
  const match = VERSION_RE.exec(input.trim());
  if (match === null) {
    return undefined;
  }
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined || prerelease === "" ? [] : prerelease.split("."),
    raw: input.trim().replace(/^v/, ""),
  };
}

/** Parse or throw — for callers that already know the string is a version. */
export function mustParseVersion(input: string): SemVer {
  const parsed = parseVersion(input);
  if (parsed === undefined) {
    throw new Error(`not a semantic version: ${input}`);
  }
  return parsed;
}

export function isPrerelease(version: SemVer): boolean {
  return version.prerelease.length > 0;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // Semver §11: a version with a prerelease sorts BEFORE the same version
  // without one, and identifiers compare numerically when both are numeric.
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) {
      return -1;
    }
    if (right === undefined) {
      return 1;
    }
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** Standard semver ordering: negative when `a` precedes `b`. */
export function compareVersions(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function versionsEqual(a: SemVer, b: SemVer): boolean {
  return compareVersions(a, b) === 0;
}

export function maxVersion(versions: readonly SemVer[]): SemVer | undefined {
  let best: SemVer | undefined;
  for (const version of versions) {
    if (best === undefined || compareVersions(version, best) > 0) {
      best = version;
    }
  }
  return best;
}

/** How a book repository's package.json pins `@authorbot/cli`. */
export type PinKind = "exact" | "channel";

export interface Pin {
  /** The dependency range exactly as written, e.g. `0.1.0` or `^1.2.3`. */
  readonly spec: string;
  readonly kind: PinKind;
  /** The version the range is anchored to. */
  readonly version: SemVer;
}

/**
 * Parse a book repository's `@authorbot/cli` dependency range.
 *
 * Only the two shapes ADR-0021 §1 sanctions are understood: an exact tag
 * (the default and the recommendation) and a caret/tilde channel that tracks
 * compatible releases. Anything else — a URL, a git ref, `*`, a range union —
 * is rejected rather than guessed at, because guessing wrong here means
 * upgrading a book to a release its author did not choose.
 */
export function parsePin(spec: string): Pin | undefined {
  const trimmed = spec.trim();
  if (trimmed === "") {
    return undefined;
  }
  const channelMatch = /^([\^~])\s*(.+)$/.exec(trimmed);
  if (channelMatch !== null) {
    const body = channelMatch[2];
    if (body === undefined) {
      return undefined;
    }
    const version = parseVersion(body);
    return version === undefined ? undefined : { spec: trimmed, kind: "channel", version };
  }
  const version = parseVersion(trimmed);
  return version === undefined ? undefined : { spec: trimmed, kind: "exact", version };
}

/**
 * Render a dependency range that keeps the pin's *kind* while moving it to a
 * new version: an exact pin stays exact, a channel stays a channel.
 */
export function renderPin(pin: Pin, version: SemVer): string {
  if (pin.kind === "exact") {
    return version.raw;
  }
  const prefix = pin.spec.startsWith("~") ? "~" : "^";
  return `${prefix}${version.raw}`;
}
