import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  annotationFilePath,
  createProcessor,
  decisionFilePath,
  LocalGitAdapter,
  parseDecisionArtifact,
  parseWorkItemArtifact,
  workItemFilePath,
  type Processor,
} from "../src/index.js";
import {
  enqueueDecisionCreate,
  enqueueDecisionUpdate,
  enqueueAnnotationCreate,
  enqueueWorkItemUpdate,
  git,
  initGitRepo,
  nowIso,
  setupDatabase,
  type SeededDatabase,
  type TempGitRepo,
} from "./helpers.js";

let seed: SeededDatabase;
let repo: TempGitRepo;
let processor: Processor;

beforeEach(async () => {
  seed = await setupDatabase();
  repo = await initGitRepo();
  processor = createProcessor({
    db: seed.db,
    writer: new LocalGitAdapter({ workTreePath: repo.dir }),
  });
});

afterEach(async () => {
  seed.db.close();
  await repo.cleanup();
});

async function commitCount(): Promise<number> {
  return Number(await git(repo.dir, "rev-list", "--count", "HEAD"));
}

describe("decision + work item as one crossing", () => {
  it("commits both artifacts for one crossing in a single commit", async () => {
    const crossing = await enqueueDecisionCreate(seed);

    // Two pending rows drain: the suggestion's annotation.create then the
    // crossing (decision.create). Both commit; the crossing is HEAD.
    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes.map((o) => o.result)).toEqual(["committed", "committed"]);
    // fixture initial + the annotation.create + the crossing = 3 commits.
    expect(await commitCount()).toBe(3);

    // Both artifacts landed in the same (HEAD) commit.
    const changed = (await git(repo.dir, "show", "--name-only", "--format=", "HEAD"))
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(changed).toEqual(
      [
        annotationFilePath(crossing.annotationId),
        decisionFilePath(crossing.decisionId),
        workItemFilePath(crossing.workItemId),
      ].sort(),
    );

    // Trailers name both the annotation and the work item (design §14.3).
    const message = await git(repo.dir, "log", "-1", "--format=%B");
    expect(message).toContain(`Authorbot-Annotation: ${crossing.annotationId}`);
    expect(message).toContain(`Authorbot-Work-Item: ${crossing.workItemId}`);
    expect(message).toContain(`Authorbot-Actor: system:rule-engine`);

    // Decision YAML parses; work item Markdown carries the annotation body.
    const decisionContent = await readFile(
      join(repo.dir, decisionFilePath(crossing.decisionId)),
      "utf8",
    );
    const decision = parseDecisionArtifact(decisionContent);
    expect(decision.result).toBe("create_work_item");
    expect(decision.supportChanged).toBe(false);

    const workItemContent = await readFile(
      join(repo.dir, workItemFilePath(crossing.workItemId)),
      "utf8",
    );
    const workItem = parseWorkItemArtifact(workItemContent);
    expect(workItem.record.status).toBe("ready");
    expect(workItem.sections.originalText).toContain("interferometer");
    expect(
      await readFile(join(repo.dir, annotationFilePath(crossing.annotationId)), "utf8"),
    ).toContain("status: work_item_created");

    const op = await seed.repos.gitOperations.getById(crossing.operationId);
    expect(op?.state).toBe("committed");
    expect((await seed.repos.outbox.getById(crossing.outboxId))?.status).toBe("done");
  });

  it("commits a force-create (rule_version 0) with override reason", async () => {
    const crossing = await enqueueDecisionCreate(seed, {
      decision: {
        ruleVersion: 0,
        result: "overridden",
        rule: "maintainer_force_create",
        overrideReason: "Editorial call before the freeze.",
        metrics: {},
      },
      payloadExtra: { actorId: seed.actorId, createdByActorId: seed.actorId },
    });

    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("committed");

    const decisionContent = await readFile(
      join(repo.dir, decisionFilePath(crossing.decisionId)),
      "utf8",
    );
    const doc = parse(decisionContent);
    expect(doc.rule_version).toBe(0);
    expect(doc.override_reason).toBe("Editorial call before the freeze.");

    // Force-create is credited to the maintainer, not system:rule-engine.
    const message = await git(repo.dir, "log", "-1", "--format=%B");
    expect(message).toContain(`Authorbot-Actor: ${seed.actorRef}`);
    const workItemContent = await readFile(
      join(repo.dir, workItemFilePath(crossing.workItemId)),
      "utf8",
    );
    expect(parseWorkItemArtifact(workItemContent).record.created_by).toBe(seed.actorRef);
  });

  it("commits a reasonless promoted comment with truthful work copy", async () => {
    const annotation = await enqueueAnnotationCreate(seed, {
      kind: "comment",
      body: "Resolve the loose ending before publication.",
    });
    const crossing = await enqueueDecisionCreate(seed, {
      annotationId: annotation.annotationId,
      decision: {
        ruleVersion: 0,
        result: "overridden",
        rule: "maintainer_override",
        overrideReason: null,
        metrics: {},
      },
      payloadExtra: { actorId: seed.actorId, createdByActorId: seed.actorId },
    });

    await processor.drain(seed.projectId);

    const decisionContent = await readFile(
      join(repo.dir, decisionFilePath(crossing.decisionId)),
      "utf8",
    );
    expect(parse(decisionContent)).not.toHaveProperty("override_reason");

    const workItemContent = await readFile(
      join(repo.dir, workItemFilePath(crossing.workItemId)),
      "utf8",
    );
    const workItem = parseWorkItemArtifact(workItemContent);
    expect(workItem.sections.context).toBe("Resolve the loose ending before publication.");
    expect(workItem.sections.requestedChange).toContain("Address the note in annotation");
    expect(workItem.sections.requestedChange).not.toContain("suggestion");
  });
});

describe("support_changed re-render", () => {
  it("re-renders only the decision file when support changes and returns", async () => {
    const crossing = await enqueueDecisionCreate(seed);
    await processor.drain(seed.projectId);
    const original = await readFile(
      join(repo.dir, decisionFilePath(crossing.decisionId)),
      "utf8",
    );

    // Support drops: mark the row, enqueue a decision.update re-render.
    await seed.repos.decisions.setSupportChanged(crossing.decisionId, true, nowIso());
    await enqueueDecisionUpdate(seed, crossing.decisionId);
    await processor.drain(seed.projectId);

    const changedContent = await readFile(
      join(repo.dir, decisionFilePath(crossing.decisionId)),
      "utf8",
    );
    expect(parse(changedContent).result).toBe("support_changed");
    // Only the decision artifact changed in this commit; the work item did not.
    const changedFiles = (await git(repo.dir, "show", "--name-only", "--format=", "HEAD"))
      .split("\n")
      .filter(Boolean);
    expect(changedFiles).toEqual([decisionFilePath(crossing.decisionId)]);

    // Support returns: re-render restores byte-identical original YAML.
    await seed.repos.decisions.setSupportChanged(crossing.decisionId, false, nowIso());
    await enqueueDecisionUpdate(seed, crossing.decisionId);
    await processor.drain(seed.projectId);
    const restored = await readFile(
      join(repo.dir, decisionFilePath(crossing.decisionId)),
      "utf8",
    );
    expect(restored).toBe(original);
  });
});

describe("work_item.update re-render", () => {
  it("re-renders the work item Markdown with its new status", async () => {
    const crossing = await enqueueDecisionCreate(seed);
    await processor.drain(seed.projectId);

    await seed.repos.workItems.updateStatus(crossing.workItemId, "cancelled", nowIso());
    await enqueueWorkItemUpdate(seed, crossing.workItemId);
    await processor.drain(seed.projectId);

    const content = await readFile(join(repo.dir, workItemFilePath(crossing.workItemId)), "utf8");
    expect(parseWorkItemArtifact(content).record.status).toBe("cancelled");
    const changedFiles = (await git(repo.dir, "show", "--name-only", "--format=", "HEAD"))
      .split("\n")
      .filter(Boolean);
    expect(changedFiles).toEqual([workItemFilePath(crossing.workItemId)]);
  });
});

describe("decision without a work item", () => {
  it("commits the decision and transitioned annotation (e.g. a rejected suggestion)", async () => {
    const crossing = await enqueueDecisionCreate(seed, {
      workItem: false,
      decision: { result: "rejected", actionType: "reject_suggestion", metrics: {} },
    });
    const { outcomes } = await processor.drain(seed.projectId);
    expect(outcomes[0]?.result).toBe("committed");
    const changedFiles = (await git(repo.dir, "show", "--name-only", "--format=", "HEAD"))
      .split("\n")
      .filter(Boolean);
    expect(changedFiles.sort()).toEqual(
      [annotationFilePath(crossing.annotationId), decisionFilePath(crossing.decisionId)].sort(),
    );
  });
});
