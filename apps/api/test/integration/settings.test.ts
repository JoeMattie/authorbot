/**
 * Phase 6 contract §3.6, the part only a real repository can prove:
 * **settings changes are commits.**
 *
 * The unit suite (`test/settings.test.ts`) covers the API's decisions. This one
 * runs against a real git work tree, drains the outbox through the real
 * processor, and then reads `book.yml` off disk - so what it asserts is that a
 * maintainer's edit becomes a commit whose file is still a valid
 * `authorbot.book/v1` document, attributed to the maintainer who made it.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { bookConfigSchema } from "@authorbot/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  CHAPTER_1,
  cloneExampleBookRepo,
  devLogin,
  jsonRequest,
  makeIntegrationApp,
  rangeSuggestionPayload,
  type BookRepoClone,
  type IntegrationApp,
} from "./helpers.js";

const exec = promisify(execFile);

/** Commit the work tree with an explicit identity (CI has no global one). */
async function commitWorkTree(cwd: string, message: string): Promise<void> {
  await exec(
    "git",
    [
      "-c",
      "user.name=Test Author",
      "-c",
      "user.email=author@example.com",
      "commit",
      "-am",
      message,
    ],
    { cwd },
  );
}

/** The work tree's most recent commit message, trailers included. */
async function gitLog(cwd: string): Promise<string> {
  const { stdout } = await exec("git", ["log", "-1", "--format=%B"], { cwd });
  return stdout;
}

describe("book settings round trip through Git (contract §3.6)", () => {
  let repo: BookRepoClone;
  let app: IntegrationApp;
  let maintainer: string;

  const settingsPath = (): string => `/v1/projects/${app.projectId}/settings`;
  const readBookYml = (): unknown =>
    parseYaml(readFileSync(join(repo.workTreePath, "book.yml"), "utf8"));
  const commit = async (message: string): Promise<void> =>
    await commitWorkTree(repo.workTreePath, message);
  const patch = async (body: unknown, cookie = maintainer): Promise<Response> =>
    await app.app.request(settingsPath(), jsonRequest("PATCH", body, { Cookie: cookie }));

  beforeEach(async () => {
    repo = await cloneExampleBookRepo();
    app = await makeIntegrationApp({ workTreePath: repo.workTreePath });
    maintainer = await devLogin(app, "maeve", "maintainer");
  });
  afterEach(async () => {
    app.close();
    await repo.cleanup();
  });

  it("projects the repository's book.yml on boot", async () => {
    const row = await app.repos.bookConfigs.get(app.projectId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("committed");
    // Exactly what the file says - this is a projection, not a second store.
    expect(row?.config).toEqual(readBookYml());
  });

  it("a title change lands as a commit whose book.yml is still valid", async () => {
    const before = bookConfigSchema.parse(readBookYml());

    const res = await patch({ title: "Hollow Creek: An Anomaly" });
    expect(res.status).toBe(202);
    await app.mirror.drain(app.projectId);

    const after = readBookYml();
    // Still a valid authorbot.book/v1 document - the whole point of routing
    // this through the same validation path as any other write.
    const parsed = bookConfigSchema.parse(after);
    expect(parsed.title).toBe("Hollow Creek: An Anomaly");
    // Nothing else moved. A settings edit is a minimal diff, not a rewrite.
    expect(parsed.id).toBe(before.id);
    expect(parsed.slug).toBe(before.slug);
    expect(parsed.content).toEqual(before.content);
    expect(parsed.planning).toEqual(before.planning);

    const row = await app.repos.bookConfigs.get(app.projectId);
    expect(row?.status).toBe("committed");
    expect(row?.config).toEqual(after);
  });

  it("credits the maintainer in the commit trailer and the audit trail", async () => {
    await patch({ license: "CC-BY-SA-4.0" });
    await app.mirror.drain(app.projectId);
    expect(bookConfigSchema.parse(readBookYml()).license).toBe("CC-BY-SA-4.0");

    // Attribution is on the commit itself, not only in the database.
    const message = await gitLog(repo.workTreePath);
    expect(message).toMatch(/Update book settings \(license\)/);
    expect(message).toMatch(/Authorbot-Actor: .*maeve/);

    const events = await app.repos.auditEvents.listByProject(app.projectId, { limit: 100 });
    const event = events.find((e) => e.action === "book_config.update");
    expect(event).toBeDefined();
    expect(event?.actorId).not.toBeNull();
  });

  it("a later projection pass agrees with what was committed (no flip-flop)", async () => {
    await patch({ title: "Stable" });
    await app.mirror.drain(app.projectId);
    // Re-read the repository from scratch, as the webhook would.
    await app.api.reconcile();
    const row = await app.repos.bookConfigs.get(app.projectId);
    expect((row?.config as { title: string }).title).toBe("Stable");
    expect(row?.status).toBe("committed");
  });

  it("a projection pass never reverts a settings change still in the outbox", async () => {
    // MIRROR_MODE=queue, so the commit stays queued and the repository still
    // holds the OLD title. A pass that wrote back what it read would silently
    // undo the maintainer's edit while its commit sat in the queue - which is
    // what `pending_git` deference exists to prevent. (This is also the live
    // deployment's mirror mode, so it is not a hypothetical.)
    const queued = await makeIntegrationApp({
      workTreePath: repo.workTreePath,
      config: { mirrorMode: "queue" },
    });
    try {
      const cookie = await devLogin(queued, "maeve", "maintainer");
      const res = await queued.app.request(
        `/v1/projects/${queued.projectId}/settings`,
        jsonRequest("PATCH", { title: "Not yet committed" }, { Cookie: cookie }),
      );
      expect(res.status).toBe(202);
      expect(bookConfigSchema.parse(readBookYml()).title).not.toBe("Not yet committed");

      await queued.api.reconcile();
      const row = await queued.repos.bookConfigs.get(queued.projectId);
      expect((row?.config as { title: string }).title).toBe("Not yet committed");
      expect(row?.status).toBe("pending_git");

      // And once it drains, the file and the projection agree.
      await queued.mirror.drain(queued.projectId);
      expect(bookConfigSchema.parse(readBookYml()).title).toBe("Not yet committed");
      await queued.api.reconcile();
      expect((await queued.repos.bookConfigs.get(queued.projectId))?.status).toBe("committed");
    } finally {
      queued.close();
    }
  });

  it("a confirmed slug change commits; an unconfirmed one does not touch the file", async () => {
    const original = bookConfigSchema.parse(readBookYml()).slug;

    expect((await patch({ slug: "renamed-book" })).status).toBe(409);
    await app.mirror.drain(app.projectId);
    expect(bookConfigSchema.parse(readBookYml()).slug).toBe(original);

    expect((await patch({ slug: "renamed-book", confirm: ["slug"] })).status).toBe(202);
    await app.mirror.drain(app.projectId);
    expect(bookConfigSchema.parse(readBookYml()).slug).toBe("renamed-book");
  });

  it("a governance rule adopted in settings is committed to book.yml and governs the next vote", async () => {
    const res = await patch({
      governance: {
        rules: {
          suggestion_to_work_item: {
            when: { all: [{ metric: "approvals", operator: "gte", value: 1 }] },
            action: { type: "create_work_item", work_type: "revise_range" },
          },
        },
      },
    });
    expect(res.status).toBe(202);
    await app.mirror.drain(app.projectId);

    // It is in the file, versioned and diffable - the reason §3.6 moved rules
    // out of RULES_JSON in the first place.
    const committed = bookConfigSchema.parse(readBookYml());
    const rule = committed.governance?.rules?.["suggestion_to_work_item"];
    expect(rule?.version).toBe(3);
    expect(rule?.when).toEqual({ all: [{ metric: "approvals", operator: "gte", value: 1 }] });

    // And it governs: one approval now crosses.
    const author = await devLogin(app, "avery", "contributor");
    const created = await app.app.request(
      `/v1/projects/${app.projectId}/chapters/${CHAPTER_1.id}/annotations`,
      jsonRequest("POST", rangeSuggestionPayload(), { Cookie: author }),
    );
    expect(created.status).toBe(202);
    const { annotationId } = (await created.json()) as { annotationId: string };
    await app.mirror.drain(app.projectId);

    const voted = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${annotationId}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: author }),
    );
    expect(voted.status).toBe(200);
    const workItems = await app.repos.workItems.listBySourceAnnotation(annotationId);
    expect(workItems).toHaveLength(1);

    const decisions = await app.repos.decisions.listByAnnotation(annotationId);
    // The decision records the version the edit assigned, keeping Phase 3's
    // uniqueness key coherent across the rule change.
    expect(decisions[0]?.ruleVersion).toBe(3);
  });

  it("survives a rebuild: a fresh projection reads the committed governance back", async () => {
    await patch({
      governance: {
        rules: {
          suggestion_to_work_item: {
            when: { all: [{ metric: "approvals", operator: "gte", value: 7 }] },
            action: { type: "create_work_item", work_type: "revise_range" },
          },
        },
      },
    });
    await app.mirror.drain(app.projectId);

    // A brand-new database over the same work tree - the rebuildability
    // property every other artifact has.
    const fresh = await makeIntegrationApp({ workTreePath: repo.workTreePath });
    try {
      const row = await fresh.repos.bookConfigs.get(fresh.projectId);
      const rule = (
        row?.config as { governance: { rules: Record<string, { when: { all: unknown[] } }> } }
      ).governance.rules["suggestion_to_work_item"];
      expect(rule?.when.all).toEqual([{ metric: "approvals", operator: "gte", value: 7 }]);
    } finally {
      fresh.close();
    }
  });

  /**
   * Regression (§3.6 "never editable"). The PATCH is a read-modify-write of
   * the `book_configs` projection, and the commit used to be a whole-file
   * render of that projection - so a title edit re-committed every other key
   * from a possibly-stale copy, including the three the module documents as
   * never editable. An author who closed an XSS hole with a reviewed commit
   * (`content.raw_html: false`, exactly the path IMMUTABLE_FIELDS tells them
   * to use) would have it silently reopened by a maintainer renaming the book.
   */
  it("never reverts a never-editable field from a stale projection", async () => {
    const committed = bookConfigSchema.parse(readBookYml());
    expect(committed.content?.raw_html).toBe(false);

    // The projection goes stale in the dangerous direction. This is a state
    // the system reaches on its own: `projectBookConfig` returns early on a
    // diverged project and keeps the previous row on an `invalid` outcome, so
    // the row can sit frozen at a copy Git has since moved past - while
    // `book_config.update` still drains, because it is not a prose kind.
    const row = await app.repos.bookConfigs.get(app.projectId);
    await app.repos.bookConfigs.upsert({
      projectId: app.projectId,
      config: {
        ...committed,
        content: { ...committed.content, raw_html: true, chapters_glob: "stale/*.md" },
        repository: { default_branch: "stale-branch" },
      },
      status: "committed",
      gitOperationId: null,
      sourceCommit: row?.sourceCommit ?? null,
      createdAt: row?.createdAt ?? "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });

    // A maintainer renames the book in the browser.
    expect((await patch({ title: "A Renamed Book" })).status).toBe(202);
    await app.mirror.drain(app.projectId);

    const after = bookConfigSchema.parse(readBookYml());
    expect(after.title).toBe("A Renamed Book");
    // The title edit carried nothing else with it. Reverting raw_html would
    // have reopened an XSS surface the author closed in a reviewed commit.
    expect(after.content?.raw_html).toBe(false);
    expect(after.content?.chapters_glob).toBe(committed.content?.chapters_glob);
    expect(after.repository?.default_branch).toBe(committed.repository?.default_branch);
  });

  /**
   * Regression (§3.6 "Settings changes are commits: diffable"). Rendering the
   * whole file from the projection destroyed every comment the author wrote in
   * their own book.yml and buried the one changed line in a whole-file diff.
   */
  it("keeps the author's comments in book.yml across a settings change", async () => {
    const path = join(repo.workTreePath, "book.yml");
    writeFileSync(
      path,
      `# The title is what readers see first.\n${readFileSync(path, "utf8")}`,
    );
    await commit("Annotate the config");

    expect((await patch({ title: "Commented Book" })).status).toBe(202);
    await app.mirror.drain(app.projectId);

    const raw = readFileSync(path, "utf8");
    expect(raw).toContain("# The title is what readers see first.");
    expect(bookConfigSchema.parse(parseYaml(raw)).title).toBe("Commented Book");
  });

  /**
   * Regression (Phase 5 §6 / design §14.5). A diverged project is one whose
   * projection we know we mis-model, so the document a PATCH would re-commit
   * is by definition one we know to be wrong. Every other route that rewrites
   * a file the author also edits in Git applies this gate; settings did not.
   */
  it("refuses a settings change while the project is diverged", async () => {
    await app.repos.projects
      .markDivergedStatement({
        projectId: app.projectId,
        reason: { findings: [] },
        at: "2026-07-20T00:00:00Z",
      })
      .run();

    const response = await patch({ title: "Written While Diverged" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>)["type"]).toContain(
      "project-diverged",
    );
    // And nothing was queued behind it.
    const row = await app.db
      .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'book_config.update'`)
      .first();
    expect(Number(row?.["n"])).toBe(0);
  });
});
