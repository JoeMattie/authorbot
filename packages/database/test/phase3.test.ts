/**
 * Phase 3 contract §2/§4/§5 database behavior: vote uniqueness and upsert,
 * append-only vote_events, SQL tallies across actor types, the decision
 * idempotency constraint (incl. simulated concurrent inserts and the
 * one-DB-batch abort path), work-item cursor pagination, and event id
 * monotonicity.
 */
import { describe, expect, it } from "vitest";
import { isConstraintError, isUniqueConstraintError } from "../src/sql.js";
import type {
  ActorRecord,
  ActorType,
  AnnotationRecord,
  DecisionRecord,
  VoteEventRecord,
  VoteRecord,
  VoteValue,
  WorkItemRecord,
} from "../src/records.js";
import { NOW, seedBasics, uuidv7, type Seeded } from "./helpers.js";

async function seedWithAnnotation(): Promise<Seeded & { annotation: AnnotationRecord }> {
  const seeded = await seedBasics();
  const annotation: AnnotationRecord = {
    id: uuidv7(),
    projectId: seeded.project.id,
    chapterId: seeded.chapter.id,
    kind: "suggestion",
    scope: "range",
    chapterRevision: 1,
    target: {
      blockId: "b-1",
      textPosition: { start: 0, end: 5 },
      textQuote: { exact: "hello", prefix: "", suffix: " world" },
    },
    authorActorId: seeded.actor.id,
    body: "Suggest tightening this sentence.",
    status: "open",
    gitOperationId: null,
    supersededBy: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await seeded.repos.annotations.insert(annotation);
  return { ...seeded, annotation };
}

function makeActor(type: ActorType, name: string): ActorRecord {
  return {
    id: uuidv7(),
    type,
    displayName: name,
    externalIdentity: null,
    ownerActorId: null,
    status: "active",
    createdAt: NOW,
  };
}

function makeVote(
  annotationId: string,
  projectId: string,
  actorId: string,
  value: VoteValue,
): VoteRecord {
  return {
    id: uuidv7(),
    projectId,
    annotationId,
    actorId,
    value,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeDecision(
  projectId: string,
  sourceAnnotationId: string,
  overrides?: Partial<DecisionRecord>,
): DecisionRecord {
  return {
    id: uuidv7(),
    projectId,
    sourceAnnotationId,
    actionType: "create_work_item",
    rule: "suggestion_to_work_item",
    ruleVersion: 1,
    metrics: { approvals: 3, net_score: 2, human_approvals: 1 },
    result: "create_work_item",
    supportChanged: false,
    overrideReason: null,
    workItemId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeWorkItem(
  projectId: string,
  sourceAnnotationId: string,
  chapterId: string,
  overrides?: Partial<WorkItemRecord>,
): WorkItemRecord {
  return {
    id: uuidv7(),
    projectId,
    type: "revise_range",
    status: "ready",
    sourceAnnotationId,
    chapterId,
    baseRevision: 1,
    target: { blockId: "b-1", textQuote: { exact: "hello" } },
    priority: "normal",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("votes (contract §2)", () => {
  it("upserts in place on re-vote, returning the previous value", async () => {
    const { db, repos, project, actor, annotation } = await seedWithAnnotation();
    const first = await repos.votes.upsert(
      makeVote(annotation.id, project.id, actor.id, "approve"),
    );
    expect(first).toBeNull();

    const second = await repos.votes.upsert(
      makeVote(annotation.id, project.id, actor.id, "reject"),
    );
    expect(second).toBe("approve");

    // Exactly one current row, updated in place (id and created_at kept).
    const rows = await repos.votes.listByAnnotation(annotation.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("reject");

    const cleared = await repos.votes.clear(annotation.id, actor.id);
    expect(cleared).toBe("reject");
    expect(await repos.votes.getCurrent(annotation.id, actor.id)).toBeNull();
    expect(await repos.votes.clear(annotation.id, actor.id)).toBeNull();
    db.close();
  });

  it("enforces the unique (annotation_id, actor_id) constraint in-schema", async () => {
    const { db, project, actor, annotation } = await seedWithAnnotation();
    const insert = (value: VoteValue) =>
      db
        .prepare(
          `INSERT INTO votes (id, project_id, annotation_id, actor_id, value,
                              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(uuidv7(), project.id, annotation.id, actor.id, value, NOW, NOW)
        .run();
    await insert("approve");
    await expect(insert("reject")).rejects.toSatisfy(isUniqueConstraintError);
    db.close();
  });

  /**
   * Phase 6 contract §3.6. The two maintainer metrics come from a LEFT JOIN
   * onto `project_memberships`, so what is being pinned here is that the join
   * reads the voter's *current* role and narrows correctly: a non-maintainer
   * voter must still count toward every other metric, and a revoked
   * maintainer's approval must stop counting as one.
   */
  it("splits maintainer approvals by role and actor type (Phase 6 §3.6)", async () => {
    const { db, repos, project, annotation } = await seedWithAnnotation();
    const authorHuman = makeActor("human", "Author");
    const authorAgent = makeActor("agent", "Author's agent");
    const reader = makeActor("human", "A reader");
    const formerMaintainer = makeActor("human", "Former maintainer");
    for (const a of [authorHuman, authorAgent, reader, formerMaintainer]) {
      await repos.actors.insert(a);
    }
    const member = async (
      actorId: string,
      role: string,
      revokedAt: string | null,
    ): Promise<void> => {
      await repos.projectMemberships.insert({
        id: uuidv7(),
        projectId: project.id,
        actorId,
        role: role as "maintainer" | "contributor",
        scopes: [],
        createdAt: NOW,
        revokedAt,
      });
    };
    await member(authorHuman.id, "maintainer", null);
    await member(authorAgent.id, "maintainer", null);
    await member(reader.id, "contributor", null);
    await member(formerMaintainer.id, "maintainer", NOW);

    for (const actorId of [authorHuman.id, authorAgent.id, reader.id, formerMaintainer.id]) {
      await repos.votes.upsert(makeVote(annotation.id, project.id, actorId, "approve"));
    }

    const tally = await repos.votes.tally(annotation.id);
    expect(tally.approvals).toBe(4);
    expect(tally.distinctVoters).toBe(4);
    // Human maintainer + agent maintainer. The revoked one does not count.
    expect(tally.maintainerApprovals).toBe(2);
    // Only the human maintainer.
    expect(tally.humanMaintainerApprovals).toBe(1);
    db.close();
  });

  it("a maintainer's reject contributes to no maintainer approval metric", async () => {
    const { db, repos, project, annotation } = await seedWithAnnotation();
    const author = makeActor("human", "Author");
    await repos.actors.insert(author);
    await repos.projectMemberships.insert({
      id: uuidv7(),
      projectId: project.id,
      actorId: author.id,
      role: "maintainer",
      scopes: [],
      createdAt: NOW,
      revokedAt: null,
    });
    await repos.votes.upsert(makeVote(annotation.id, project.id, author.id, "reject"));
    const tally = await repos.votes.tally(annotation.id);
    expect(tally.rejections).toBe(1);
    expect(tally.maintainerApprovals).toBe(0);
    expect(tally.humanMaintainerApprovals).toBe(0);
    db.close();
  });

  it("rejects vote values outside approve|reject|abstain", async () => {
    const { db, project, actor, annotation } = await seedWithAnnotation();
    await expect(
      db
        .prepare(
          `INSERT INTO votes (id, project_id, annotation_id, actor_id, value,
                              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(uuidv7(), project.id, annotation.id, actor.id, "veto", NOW, NOW)
        .run(),
    ).rejects.toSatisfy(isConstraintError);
    db.close();
  });

  it("computes tallies in SQL, split across actor types", async () => {
    const { db, repos, project, annotation } = await seedWithAnnotation();
    const humanA = makeActor("human", "Human A");
    const humanB = makeActor("human", "Human B");
    const agentA = makeActor("agent", "Agent A");
    const agentB = makeActor("agent", "Agent B");
    const system = makeActor("system", "System");
    for (const a of [humanA, humanB, agentA, agentB, system]) {
      await repos.actors.insert(a);
    }

    await repos.votes.upsert(makeVote(annotation.id, project.id, humanA.id, "approve"));
    await repos.votes.upsert(makeVote(annotation.id, project.id, humanB.id, "reject"));
    await repos.votes.upsert(makeVote(annotation.id, project.id, agentA.id, "approve"));
    await repos.votes.upsert(makeVote(annotation.id, project.id, agentB.id, "abstain"));
    await repos.votes.upsert(makeVote(annotation.id, project.id, system.id, "approve"));

    expect(await repos.votes.tally(annotation.id)).toEqual({
      approvals: 3,
      rejections: 1,
      abstentions: 1,
      netScore: 2,
      distinctVoters: 5,
      humanApprovals: 1,
      agentApprovals: 1,
      // No voter here holds a membership at all, let alone a maintainer one.
      maintainerApprovals: 0,
      humanMaintainerApprovals: 0,
    });

    // Re-vote replaces, never double-counts.
    await repos.votes.upsert(makeVote(annotation.id, project.id, humanB.id, "approve"));
    const after = await repos.votes.tally(annotation.id);
    expect(after.approvals).toBe(4);
    expect(after.rejections).toBe(0);
    expect(after.netScore).toBe(4);
    expect(after.distinctVoters).toBe(5);
    expect(after.humanApprovals).toBe(2);

    // Unvoted annotation tallies to all zeros.
    expect(await repos.votes.tally(uuidv7())).toEqual({
      approvals: 0,
      rejections: 0,
      abstentions: 0,
      netScore: 0,
      distinctVoters: 0,
      humanApprovals: 0,
      agentApprovals: 0,
      maintainerApprovals: 0,
      humanMaintainerApprovals: 0,
    });
    db.close();
  });
});

describe("vote_events (contract §2: append-only)", () => {
  it("appends and lists history; schema rejects UPDATE and DELETE", async () => {
    const { db, repos, project, actor, annotation } = await seedWithAnnotation();
    const event: VoteEventRecord = {
      id: uuidv7(),
      projectId: project.id,
      annotationId: annotation.id,
      actorId: actor.id,
      value: "approve",
      previousValue: null,
      createdAt: NOW,
    };
    await repos.voteEvents.insert(event);
    await repos.voteEvents.insert({
      ...event,
      id: uuidv7(),
      value: null,
      previousValue: "approve",
    });

    const listed = await repos.voteEvents.listByAnnotation(annotation.id);
    expect(listed).toHaveLength(2);
    // Same-millisecond UUIDv7 ids don't order deterministically; match by shape.
    const firstVote = listed.find((e) => e.previousValue === null);
    const clearedVote = listed.find((e) => e.previousValue === "approve");
    expect(firstVote?.value).toBe("approve");
    expect(clearedVote?.value).toBeNull();

    await expect(
      db.prepare(`UPDATE vote_events SET value = 'reject' WHERE id = ?`).bind(event.id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`DELETE FROM vote_events WHERE id = ?`).bind(event.id).run(),
    ).rejects.toThrow(/append-only/);
    db.close();
  });
});

describe("decisions (contract §4: idempotency)", () => {
  it("collapses simulated concurrent inserts: second gets already_decided", async () => {
    const { db, repos, project, annotation } = await seedWithAnnotation();
    const winner = makeDecision(project.id, annotation.id);
    const loser = makeDecision(project.id, annotation.id); // same key, new id

    const [first, second] = await Promise.all([
      repos.decisions.insert(winner),
      repos.decisions.insert(loser),
    ]);
    const outcomes = [first, second].map((r) => r.status).sort();
    expect(outcomes).toEqual(["already_decided", "inserted"]);

    const already = [first, second].find((r) => r.status === "already_decided");
    expect(already).toBeDefined();
    if (already?.status === "already_decided") {
      expect(already.existing.id).toBe(winner.id);
    }

    // Exactly one row for the key.
    const all = await repos.decisions.listByAnnotation(annotation.id);
    expect(all).toHaveLength(1);
    db.close();
  });

  it("scopes uniqueness to (source_annotation_id, action_type, rule_version) for non-create actions", async () => {
    const { db, repos, project, annotation } = await seedWithAnnotation();
    const base = makeDecision(project.id, annotation.id);
    expect((await repos.decisions.insert(base)).status).toBe("inserted");

    // Different action_type inserts (its own key space).
    const cancel = makeDecision(project.id, annotation.id, {
      actionType: "cancel_work_item",
      result: "overridden",
      overrideReason: "duplicate of another suggestion",
    });
    expect((await repos.decisions.insert(cancel)).status).toBe("inserted");

    // A reject_suggestion override (rule_version 0) also inserts.
    const reject = makeDecision(project.id, annotation.id, {
      actionType: "reject_suggestion",
      ruleVersion: 0,
      result: "rejected",
      overrideReason: "off-topic",
    });
    expect((await repos.decisions.insert(reject)).status).toBe("inserted");

    // Same triple again → already_decided.
    const dupe = await repos.decisions.insert(makeDecision(project.id, annotation.id));
    expect(dupe.status).toBe("already_decided");

    const stored = await repos.decisions.getByKey(annotation.id, "create_work_item", 1);
    expect(stored?.id).toBe(base.id);
    expect(stored?.metrics).toEqual({ approvals: 3, net_score: 2, human_approvals: 1 });
    db.close();
  });

  it("collapses work-item creation to one decision per annotation across rule_versions (contract §4)", async () => {
    const { db, repos, project, annotation } = await seedWithAnnotation();
    // A rule crossing (rule_version >= 1) creates the work-item decision.
    const crossing = makeDecision(project.id, annotation.id);
    expect((await repos.decisions.insert(crossing)).status).toBe("inserted");

    // A maintainer force-create (rule_version 0) shares the SAME single
    // work-item uniqueness domain: it must not create a second work item.
    const force = makeDecision(project.id, annotation.id, {
      ruleVersion: 0,
      overrideReason: "editorial call",
    });
    const forced = await repos.decisions.insert(force);
    expect(forced.status).toBe("already_decided");
    if (forced.status === "already_decided") {
      expect(forced.existing.id).toBe(crossing.id);
    }

    // Exactly one create_work_item decision exists, and the helper finds it.
    const all = (await repos.decisions.listByAnnotation(annotation.id)).filter(
      (d) => d.actionType === "create_work_item",
    );
    expect(all).toHaveLength(1);
    expect((await repos.decisions.getWorkItemCreation(annotation.id))?.id).toBe(crossing.id);
    db.close();
  });

  it("aborts the whole decision+work-item batch atomically on the unique key", async () => {
    const { db, repos, project, chapter, annotation } = await seedWithAnnotation();
    const first = makeDecision(project.id, annotation.id);
    await repos.decisions.insert(first);

    // A racing writer composes the contract §4 one-DB-batch; the decision
    // insert violates the idempotency key, so NOTHING from the batch lands.
    const racingWorkItem = makeWorkItem(project.id, annotation.id, chapter.id);
    let batchError: unknown;
    try {
      await db.batch([
        repos.decisions.insertStatement(makeDecision(project.id, annotation.id)),
        repos.workItems.insertStatement(racingWorkItem),
      ]);
    } catch (error) {
      batchError = error;
    }
    expect(batchError).toSatisfy(isUniqueConstraintError);
    expect(await repos.workItems.getById(racingWorkItem.id)).toBeNull();

    // The loser then resolves via the repository as already-decided.
    const resolved = await repos.decisions.insert(makeDecision(project.id, annotation.id));
    expect(resolved.status).toBe("already_decided");
    if (resolved.status === "already_decided") {
      expect(resolved.existing.id).toBe(first.id);
    }
    db.close();
  });

  it("flips and clears the sticky support_changed flag", async () => {
    const { db, repos, project, annotation } = await seedWithAnnotation();
    const decision = makeDecision(project.id, annotation.id);
    await repos.decisions.insert(decision);

    expect(await repos.decisions.setSupportChanged(decision.id, true, NOW)).toBe(true);
    expect((await repos.decisions.getById(decision.id))?.supportChanged).toBe(true);

    expect(await repos.decisions.setSupportChanged(decision.id, false, NOW)).toBe(true);
    expect((await repos.decisions.getById(decision.id))?.supportChanged).toBe(false);

    expect(await repos.decisions.setSupportChanged(uuidv7(), true, NOW)).toBe(false);
    db.close();
  });

  it("round-trips overrides and upserts for projection rebuild", async () => {
    const { db, repos, project, annotation } = await seedWithAnnotation();
    const decision = makeDecision(project.id, annotation.id, {
      ruleVersion: 0,
      result: "overridden",
      overrideReason: "force-created by maintainer",
      workItemId: uuidv7(),
    });
    await repos.decisions.insert(decision);
    const loaded = await repos.decisions.getById(decision.id);
    expect(loaded?.overrideReason).toBe("force-created by maintainer");
    expect(loaded?.workItemId).toBe(decision.workItemId);

    // Rebuild path: upsert over the existing row without a delete window.
    await repos.decisions.upsertStatement({ ...decision, supportChanged: true }).run();
    expect((await repos.decisions.getById(decision.id))?.supportChanged).toBe(true);
    const all = await repos.decisions.listByAnnotation(annotation.id);
    expect(all).toHaveLength(1);
    db.close();
  });
});

describe("work_items (contract §4)", () => {
  it("inserts, gets, updates status, and validates vocabulary in-schema", async () => {
    const { db, repos, project, chapter, annotation } = await seedWithAnnotation();
    const item = makeWorkItem(project.id, annotation.id, chapter.id);
    await repos.workItems.insert(item);

    const loaded = await repos.workItems.getById(item.id);
    expect(loaded?.status).toBe("ready");
    expect(loaded?.target).toEqual({ blockId: "b-1", textQuote: { exact: "hello" } });
    expect(loaded?.baseRevision).toBe(1);

    expect(await repos.workItems.updateStatus(item.id, "cancelled", NOW)).toBe(true);
    expect((await repos.workItems.getById(item.id))?.status).toBe("cancelled");
    expect(await repos.workItems.updateStatus(uuidv7(), "cancelled", NOW)).toBe(false);

    await expect(
      repos.workItems.insert(
        makeWorkItem(project.id, annotation.id, chapter.id, {
          type: "delete_chapter" as WorkItemRecord["type"],
        }),
      ),
    ).rejects.toSatisfy(isConstraintError);
    await expect(
      repos.workItems.insert(
        makeWorkItem(project.id, annotation.id, chapter.id, { baseRevision: 0 }),
      ),
    ).rejects.toSatisfy(isConstraintError);
    db.close();
  });

  it("lists with cursor pagination and status filter", async () => {
    const { db, repos, project, chapter, annotation } = await seedWithAnnotation();
    const items = [
      makeWorkItem(project.id, annotation.id, chapter.id),
      makeWorkItem(project.id, annotation.id, chapter.id),
      makeWorkItem(project.id, annotation.id, chapter.id, { status: "cancelled" }),
    ];
    for (const item of items) await repos.workItems.insert(item);
    const orderedIds = items.map((i) => i.id).sort();

    const pageOne = await repos.workItems.listByProject(project.id, { limit: 2 });
    expect(pageOne.map((i) => i.id)).toEqual(orderedIds.slice(0, 2));

    const cursor = pageOne[1]?.id;
    expect(cursor).toBeDefined();
    const pageTwo = await repos.workItems.listByProject(project.id, {
      limit: 2,
      afterId: cursor as string,
    });
    expect(pageTwo.map((i) => i.id)).toEqual(orderedIds.slice(2));

    const ready = await repos.workItems.listByProject(project.id, { status: "ready" });
    expect(ready).toHaveLength(2);
    expect(ready.every((i) => i.status === "ready")).toBe(true);

    const bySource = await repos.workItems.listBySourceAnnotation(annotation.id);
    expect(bySource).toHaveLength(3);
    db.close();
  });
});

describe("events (contract §5: monotonic feed)", () => {
  it("assigns strictly increasing ids and reads ranges after a cursor", async () => {
    const { db, repos, project } = await seedBasics();
    const appended = [];
    for (let i = 0; i < 5; i += 1) {
      appended.push(
        await repos.events.append({
          projectId: project.id,
          type: i % 2 === 0 ? "vote_aggregate" : "decision_created",
          payload: { seq: i },
          createdAt: NOW,
        }),
      );
    }

    // Strictly increasing, monotonic ids.
    for (let i = 1; i < appended.length; i += 1) {
      expect((appended[i]?.id ?? 0) > (appended[i - 1]?.id ?? 0)).toBe(true);
    }

    // Full read from cursor 0.
    const all = await repos.events.listAfter(project.id, 0);
    expect(all.map((e) => e.id)).toEqual(appended.map((e) => e.id));
    expect(all[0]?.payload).toEqual({ seq: 0 });

    // Resume strictly after a mid-stream cursor (Last-Event-ID semantics).
    const cursor = appended[2]?.id ?? 0;
    const resumed = await repos.events.listAfter(project.id, cursor);
    expect(resumed.map((e) => e.id)).toEqual(appended.slice(3).map((e) => e.id));

    expect(await repos.events.latestId(project.id)).toBe(appended[4]?.id);
    expect(await repos.events.latestId(uuidv7())).toBe(0);

    const single = await repos.events.getById(appended[1]?.id ?? -1);
    expect(single?.type).toBe("decision_created");
    db.close();
  });

  it("keeps ids monotonic within a batch append (the one-DB-batch flow)", async () => {
    const { db, repos, project } = await seedBasics();
    const before = await repos.events.append({
      projectId: project.id,
      type: "annotation_created",
      payload: {},
      createdAt: NOW,
    });

    const results = await db.batch([
      repos.events.appendStatement({
        projectId: project.id,
        type: "decision_created",
        payload: { decisionId: "d1" },
        createdAt: NOW,
      }),
      repos.events.appendStatement({
        projectId: project.id,
        type: "work_item_created",
        payload: { workItemId: "w1" },
        createdAt: NOW,
      }),
    ]);
    const batchIds = results.map((r) => r.lastRowId);
    expect(batchIds[0]).toBe(before.id + 1);
    expect(batchIds[1]).toBe(before.id + 2);

    const tail = await repos.events.listAfter(project.id, before.id);
    expect(tail.map((e) => e.type)).toEqual(["decision_created", "work_item_created"]);
    db.close();
  });
});
