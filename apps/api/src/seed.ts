/**
 * First-boot idempotent seed (Phase 2 contract §6): create the project row
 * and the initial maintainer actor + membership. Safe to run on every boot;
 * only missing rows are created.
 *
 * Conflict-tolerant: two isolates cold-starting concurrently may both observe
 * a missing row and both insert it. The loser's INSERT hits the unique index
 * (projects.slug / actors.external_identity / memberships (project, actor));
 * that violation is swallowed and the winner's row re-read, so a seed race
 * can never fail bootstrap.
 */
import { isUniqueConstraintError, type Repositories, type ProjectRecord } from "@authorbot/database";
import { roleScopes, toTimestamp } from "@authorbot/domain";
import type { AppConfig, Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";

/** Run `insert`; on a unique-constraint violation re-read via `reread`. */
async function insertOrReread<T>(
  insert: () => Promise<void>,
  reread: () => Promise<T | null>,
  what: string,
): Promise<T | null> {
  try {
    await insert();
    return null;
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = await reread();
    if (existing === null) {
      throw new Error(`seed: lost ${what} insert race but found no existing row`);
    }
    return existing;
  }
}

export async function seedProject(
  repos: Repositories,
  config: AppConfig,
  clock: Clock,
): Promise<ProjectRecord> {
  const now = toTimestamp(clock.now());

  let project = await repos.projects.getBySlug(config.projectSlug);
  if (project === null) {
    const fresh: ProjectRecord = {
      id: uuidv7(clock.now()),
      slug: config.projectSlug,
      repoProvider: "github",
      repo: config.projectRepo,
      defaultBranch: config.defaultBranch ?? "main",
      status: "active",
      // Phase 5 §6 defaults: a fresh project has never been projected, is not
      // stale, and has not diverged. Matches the migration column defaults.
      projectionStale: false,
      projectedCommit: null,
      divergenceReason: null,
      divergedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const raced = await insertOrReread(
      () => repos.projects.insert(fresh),
      () => repos.projects.getBySlug(config.projectSlug),
      "project",
    );
    project = raced ?? fresh;
  }

  let maintainer = await repos.actors.getByExternalIdentity(config.initialMaintainer);
  if (maintainer === null) {
    const fresh = {
      id: uuidv7(clock.now()),
      type: "human" as const,
      displayName: config.initialMaintainer.slice(config.initialMaintainer.indexOf(":") + 1),
      externalIdentity: config.initialMaintainer,
      ownerActorId: null,
      status: "active",
      createdAt: now,
    };
    const raced = await insertOrReread(
      () => repos.actors.insert(fresh),
      () => repos.actors.getByExternalIdentity(config.initialMaintainer),
      "maintainer actor",
    );
    maintainer = raced ?? fresh;
  }

  const membership = await repos.projectMemberships.getByProjectAndActor(
    project.id,
    maintainer.id,
  );
  if (membership === null) {
    const inserted = await insertOrReread(
      () =>
        repos.projectMemberships.insert({
          id: uuidv7(clock.now()),
          projectId: project.id,
          actorId: maintainer.id,
          role: "maintainer",
          scopes: [...roleScopes("maintainer")],
          createdAt: now,
          revokedAt: null,
        }),
      () => repos.projectMemberships.getByProjectAndActor(project.id, maintainer.id),
      "maintainer membership",
    );
    if (inserted === null) {
      // We won the membership insert: record the one-time seed audit event.
      await repos.auditEvents.insert({
        id: uuidv7(clock.now()),
        projectId: project.id,
        actorId: null,
        action: "project.seed",
        targetType: "project",
        targetId: project.id,
        correlationId: uuidv7(clock.now()),
        metadata: { initialMaintainer: config.initialMaintainer },
        createdAt: now,
      });
    }
  }

  return project;
}
