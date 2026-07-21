/**
 * Step 1 of ADR-0021 §3: resolve the current pin against the target release,
 * and work out what that move implies.
 *
 * Resolution is deliberately conservative. `upgrade` with no arguments never
 * crosses a major version, because a major is exactly where a previously
 * valid book may stop being valid; crossing one is a decision the author
 * makes by naming the version (`--to 2.0.0`), not a default they discover
 * afterwards in a diff.
 */

import { selectMigrations, type BookRepoMigration, type SelectedMigration } from "./migrations.js";
import { UpgradeRepoError, readPin, CLI_PACKAGE, type PinLocation } from "./repo.js";
import type { UpgradeFs, ReleasesPort } from "./ports.js";
import {
  compareVersions,
  isPrerelease,
  maxVersion,
  parseVersion,
  type SemVer,
} from "./semver.js";

export interface UpgradePlan {
  readonly repoPath: string;
  readonly pinLocation: PinLocation;
  readonly current: SemVer;
  readonly target: SemVer;
  /** True when `target` is strictly newer than `current`. */
  readonly upgradeAvailable: boolean;
  readonly migrations: SelectedMigration[];
  /**
   * A newer major exists but was not chosen. Reported so an author on a
   * dead-ended minor is not left thinking they are current.
   */
  readonly newerMajor?: SemVer;
  /** Every published stable release, newest first. */
  readonly available: SemVer[];
}

export interface ResolveOptions {
  readonly repoPath: string;
  /** An explicit target; overrides the conservative default. */
  readonly to?: string;
}

export async function resolvePlan(
  deps: { fs: UpgradeFs; releases: ReleasesPort; migrations: readonly BookRepoMigration[] },
  options: ResolveOptions,
): Promise<UpgradePlan> {
  const pinLocation = await readPin(deps.fs, options.repoPath);
  const current = pinLocation.pin.version;

  let published: string[];
  try {
    published = await deps.releases.listVersions(CLI_PACKAGE);
  } catch (error) {
    throw new UpgradeRepoError(
      `could not list published releases of ${CLI_PACKAGE}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const available = published
    .map((raw) => parseVersion(raw))
    .filter((version): version is SemVer => version !== undefined)
    .sort((a, b) => compareVersions(b, a));

  const target = resolveTarget(pinLocation, current, available, options.to);
  const upgradeAvailable = compareVersions(target, current) > 0;
  const migrations = upgradeAvailable ? selectMigrations(deps.migrations, current, target) : [];

  const newerMajor = maxVersion(
    available.filter((version) => version.major > target.major && !isPrerelease(version)),
  );

  const plan: UpgradePlan = {
    repoPath: options.repoPath,
    pinLocation,
    current,
    target,
    upgradeAvailable,
    migrations,
    available,
    ...(newerMajor === undefined ? {} : { newerMajor }),
  };
  return plan;
}

function resolveTarget(
  pinLocation: PinLocation,
  current: SemVer,
  available: readonly SemVer[],
  requested: string | undefined,
): SemVer {
  if (requested !== undefined) {
    const wanted = parseVersion(requested);
    if (wanted === undefined) {
      throw new UpgradeRepoError(`--to expects a version like 1.5.0, got "${requested}"`);
    }
    const match = available.find((version) => compareVersions(version, wanted) === 0);
    if (match === undefined) {
      throw new UpgradeRepoError(
        `${CLI_PACKAGE}@${wanted.raw} is not published; ` +
          `latest is ${available[0]?.raw ?? "unknown"}`,
      );
    }
    return match;
  }

  // No explicit target: stay inside the compatibility promise. A caret pin
  // tracks the major, a tilde pin tracks the minor, and an exact pin is
  // treated as a caret for the purpose of *finding* an upgrade (the pin
  // itself stays exact when it is rewritten).
  const tildePinned = pinLocation.pin.kind === "channel" && pinLocation.pin.spec.startsWith("~");
  const candidates = available.filter((version) => {
    if (isPrerelease(version)) {
      return false;
    }
    if (version.major !== current.major) {
      return false;
    }
    if (tildePinned && version.minor !== current.minor) {
      return false;
    }
    return compareVersions(version, current) > 0;
  });
  return maxVersion(candidates) ?? current;
}
