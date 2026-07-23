/**
 * Select and start the CLI release which must own an upgrade.
 *
 * `npx authorbot` prefers a book's local binary. That is normally desirable,
 * but an interrupted or blocked install can leave package.json pinned to a
 * newer release while node_modules still contains an older executable. More
 * importantly, a forward upgrade must run the target release's migrations,
 * not the migration registry compiled into the release being replaced.
 *
 * This module decides which exact helper is suitable. The node port decides
 * whether to use an installed copy or acquire one in a throwaway directory.
 */

import path from "node:path";
import type { CliIo } from "../cli.js";
import { resolvePlan, type UpgradePlan } from "./plan.js";
import type { UpgradeDeps } from "./ports.js";
import { CLI_PACKAGE, readPin, type PinLocation } from "./repo.js";
import { compareVersions, parseVersion, type Pin, type SemVer } from "./semver.js";

export interface BootstrapOptions {
  readonly repoPath: string;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly finish: boolean;
  readonly to?: string;
  readonly rollback?: string;
}

function objectField(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[field];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pinAllows(pin: Pin, version: SemVer): boolean {
  if (compareVersions(version, pin.version) < 0) {
    return false;
  }
  if (pin.kind === "exact") {
    return compareVersions(version, pin.version) === 0;
  }
  if (pin.spec.startsWith("~")) {
    return version.major === pin.version.major && version.minor === pin.version.minor;
  }
  if (pin.version.major > 0) {
    return version.major === pin.version.major;
  }
  if (pin.version.minor > 0) {
    return version.major === 0 && version.minor === pin.version.minor;
  }
  return (
    version.major === 0 &&
    version.minor === 0 &&
    version.patch === pin.version.patch
  );
}

/**
 * Prefer the exact version recorded in package-lock.json when it still
 * satisfies the manifest pin. This matters for channel pins: `^1.2.0` may
 * correctly have 1.4.3 locked, and `--finish` should use 1.4.3 rather than
 * reinstalling the range's lower bound.
 */
async function currentToolchainVersion(
  deps: Pick<UpgradeDeps, "fs">,
  repoPath: string,
  location: PinLocation,
): Promise<SemVer> {
  const lockPath = path.join(repoPath, "package-lock.json");
  if (!(await deps.fs.exists(lockPath))) {
    return location.pin.version;
  }
  try {
    const parsed: unknown = JSON.parse(await deps.fs.readFile(lockPath));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return location.pin.version;
    }
    const packages = objectField(parsed as Record<string, unknown>, "packages");
    const root = packages === undefined ? undefined : objectField(packages, "");
    const rootSpec =
      root === undefined
        ? undefined
        : objectField(root, location.field)?.[CLI_PACKAGE];
    const lockedRaw =
      packages === undefined
        ? undefined
        : objectField(packages, `node_modules/${CLI_PACKAGE}`)?.["version"];
    if (rootSpec !== location.pin.spec || typeof lockedRaw !== "string") {
      return location.pin.version;
    }
    const locked = parseVersion(lockedRaw);
    return locked !== undefined && pinAllows(location.pin, locked)
      ? locked
      : location.pin.version;
  } catch {
    return location.pin.version;
  }
}

/** Exact helper required by the manifest and coherent committed lock evidence. */
export async function currentUpgradeToolchainVersion(
  deps: Pick<UpgradeDeps, "fs">,
  repoPath: string,
): Promise<SemVer> {
  const location = await readPin(deps.fs, repoPath);
  return currentToolchainVersion(deps, repoPath, location);
}

async function desiredBootstrapVersion(
  options: BootstrapOptions,
  deps: UpgradeDeps,
): Promise<{ readonly desired: SemVer; readonly selection?: UpgradePlan }> {
  // Rollback decisions and post-merge deploys belong to the toolchain already
  // pinned by this checkout. Starting the older rollback target would discard
  // the newer helper's migration and validation knowledge.
  if (options.finish || options.rollback !== undefined) {
    return {
      desired: await currentUpgradeToolchainVersion(deps, options.repoPath),
    };
  }

  // Target selection does not require this running release's migration
  // registry. Passing an empty registry avoids treating an older helper's
  // partial knowledge as authoritative before the handoff.
  const plan = await resolvePlan(
    { fs: deps.fs, releases: deps.releases, migrations: [] },
    {
      repoPath: options.repoPath,
      ...(options.to === undefined ? {} : { to: options.to }),
    },
  );
  const current = await currentToolchainVersion(
    deps,
    options.repoPath,
    plan.pinLocation,
  );
  return {
    desired: compareVersions(plan.target, plan.current) > 0 ? plan.target : current,
    selection: plan,
  };
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function windowsCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@=+\\-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}

/** Render the one-time exact-package recovery command for the caller's shell. */
export function renderTransientBootstrapCommand(
  version: string,
  originalArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const render = platform === "win32" ? windowsCommandArgument : shellArgument;
  return [
    "npx",
    "--yes",
    `@authorbot/cli@${version}`,
    "upgrade",
    ...originalArgs.map(render),
  ].join(" ");
}

/**
 * Return the pinned release selection when this process is the suitable
 * helper and target metadata was consulted, or `undefined` when no selection
 * is needed. Otherwise return the delegated child exit code (or a fail-closed
 * local error code).
 */
export async function ensureUpgradeBootstrap(
  options: BootstrapOptions,
  originalArgs: readonly string[],
  io: CliIo,
  deps: UpgradeDeps,
): Promise<number | UpgradePlan | undefined> {
  const bootstrap = deps.bootstrap;
  if (bootstrap === undefined) {
    return undefined;
  }
  const { desired, selection } = await desiredBootstrapVersion(options, deps);

  if (
    bootstrap.requestedVersion !== undefined &&
    bootstrap.requestedVersion !== bootstrap.runningVersion
  ) {
    io.err(
      `authorbot: bootstrap requested @authorbot/cli@${bootstrap.requestedVersion}, ` +
        `but npm started ${bootstrap.runningVersion}. Refusing to recurse or change the repository.`,
    );
    return 2;
  }

  if (bootstrap.runningVersion === desired.raw) {
    return selection;
  }

  if (bootstrap.requestedVersion !== undefined) {
    io.err(
      `authorbot: bootstrapped @authorbot/cli@${bootstrap.runningVersion}, but this checkout ` +
        `requires ${desired.raw}. Refusing a second handoff or any repository change.`,
    );
    return 2;
  }

  const notice =
    `authorbot: running helper ${bootstrap.runningVersion} is not the safe helper for this ` +
    `operation; handing off to @authorbot/cli@${desired.raw} before changing anything`;
  if (options.json) {
    io.err(notice);
  } else {
    io.out(notice);
  }

  try {
    const result = await bootstrap.handoff({
      targetVersion: desired.raw,
      repoPath: options.repoPath,
      cwd: process.cwd(),
      args: originalArgs,
    });
    if (result.warning !== undefined) {
      io.err(`authorbot: bootstrap warning: ${result.warning}`);
    }
    return result.exitCode;
  } catch (error) {
    io.err(
      `authorbot: could not start @authorbot/cli@${desired.raw}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    io.err(
      "authorbot: target-helper execution never began, so bootstrap acquisition did not " +
        "change book source, package.json, package-lock.json, or node_modules. Connect to npm " +
        "or make the release available in your npm cache, then launch it transiently:",
    );
    io.err(
      `  ${renderTransientBootstrapCommand(desired.raw, originalArgs)}`,
    );
    return 1;
  }
}
