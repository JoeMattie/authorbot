/**
 * Phase 7 exit criterion 2 - **the restore drill, as a test rather than a
 * paragraph.**
 *
 * The contract says: "destroy a database, rebuild the projection from Git,
 * confirm what returns and what does not (sessions, leases, and agent tokens
 * do not). The drill is a test, not a paragraph."
 *
 * ## What "destroy the database" means here
 *
 * Everything Authorbot knows lives in exactly two places: a Git repository
 * (durable, replicated, the record of the book) and an operational database
 * (D1 - a *projection* plus a small amount of genuinely operational state).
 * Phase 2 contract §5 and design §7.5 make the first the source of truth and
 * the second rebuildable from it.
 *
 * So the drill runs a real deployment through real HTTP endpoints until the
 * repository holds prose, annotations, replies, decisions, work items and
 * attribution; then it takes ONLY the git tree forward, throws the database
 * away, and stands a completely fresh deployment up on a brand-new empty
 * database whose sole input is that tree. No repository method is called to
 * seed the restored side, and no row is copied across.
 *
 * ## Why the ABSENCE assertions are the point
 *
 * It is easy to write a restore test that only checks what comes back. The
 * more valuable half is the other one. **A lease surviving a rebuild would be
 * a bug; so would a token.** A restored lease would let a vanished agent hold
 * work nobody can reclaim; a restored session or agent token would mean a
 * credential outliving the database that was supposed to be its only home.
 * The drill therefore asserts their absence *deliberately* - and asserts they
 * were PRESENT before the destruction, so the absence cannot pass vacuously.
 *
 * Absence is asserted twice for each: structurally (the table is empty) and
 * behaviourally (the actual credential is refused / the work item is
 * claimable again). A table can be empty for uninteresting reasons; a 401 on
 * a token that worked five lines earlier cannot.
 *
 * ## Determinism
 *
 * Nothing here touches the network, the filesystem beyond one read of
 * `examples/book-repo`, or a real git binary. The repository is the Phase 5
 * in-process fake, hashed with real git object hashing, driven through the
 * real `GitHubBookRepoReader`/`Writer` and the real `ProjectCoordinator`.
 * That is what makes this cheap enough to run in CI on every commit, which is
 * the only version of a restore drill anybody actually benefits from.
 */
import { describe, expect, it } from "vitest";
import { parseAttributionArtifact } from "@authorbot/repo-coordinator";
import {
  BRANCH,
  CHAPTER_1,
  CHAPTER_3,
  devLogin,
  jsonRequest,
  makeGitHubIntegrationApp,
  rangeSuggestionPayload,
  type GitHubIntegrationApp,
} from "./integration/phase5-helpers.js";
import { uuidv7 } from "../src/ids.js";

const ORIGINAL_C1 = "drift appeared on";
const REPLACEMENT_C1 = "anomaly surfaced on";

/** A range suggestion against chapter 3's first block. */
function chapter3SuggestionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "suggestion",
    scope: "range",
    chapterRevision: CHAPTER_3.revision,
    target: {
      blockId: "019d7c33-c1e0-70bf-a41b-b75d55ff7980",
      textPosition: { start: 9, end: 35 },
      textQuote: {
        exact: "stop blaming an instrument",
        prefix: "Once you ",
        suffix: ", you have to",
      },
    },
    body: "Tighten this line.",
    ...overrides,
  };
}

/**
 * Annotation → three qualifying votes → `ready` work item, through documented
 * endpoints only. The default rule (design §25 + Phase 6 §3.6) needs three
 * approvals, net score ≥ 2, and at least one human maintainer approval.
 */
async function openWorkItem(
  app: GitHubIntegrationApp,
  chapterId: string,
  payload: Record<string, unknown>,
  voters: readonly string[],
): Promise<{ annotationId: string; workItemId: string }> {
  const author = await devLogin(app, `${voters[0] as string}-author`, "contributor");
  const created = await app.app.request(
    `/v1/projects/${app.projectId}/chapters/${chapterId}/annotations`,
    jsonRequest("POST", payload, { Cookie: author }),
  );
  expect(created.status).toBe(202);
  const { annotationId } = (await created.json()) as { annotationId: string };

  for (const [index, login] of voters.entries()) {
    const voter = await devLogin(app, login, index === 0 ? "maintainer" : "contributor");
    const voted = await app.app.request(
      `/v1/projects/${app.projectId}/annotations/${annotationId}/vote`,
      jsonRequest("PUT", { value: "approve" }, { Cookie: voter }),
    );
    expect(voted.status).toBeLessThan(300);
  }

  const workItems = await app.repos.workItems.listBySourceAnnotation(annotationId);
  expect(workItems).toHaveLength(1);
  const workItem = workItems[0]!;
  expect(workItem.status).toBe("ready");
  return { annotationId, workItemId: workItem.id };
}

async function countRows(app: GitHubIntegrationApp, table: string): Promise<number> {
  const rows = await app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all();
  return Number(rows[0]?.["n"] ?? -1);
}

describe("Phase 7 exit criterion 2: the restore drill", () => {
  it("destroys the database, rebuilds from Git, and proves what returns and what deliberately does not", async () => {
    const before = await makeGitHubIntegrationApp();
    let after: GitHubIntegrationApp | null = null;
    try {
      // =====================================================================
      // 1. Run a real deployment until the repository holds a real history.
      // =====================================================================

      // (a) A suggestion that becomes work, is claimed, submitted, and applied
      //     - so the repository carries a chapter revision bump, a decision, a
      //     completed work item, an accepted annotation, and an attribution
      //     entry that Authorbot itself wrote.
      const { annotationId: appliedAnnotationId, workItemId: appliedWorkItemId } =
        await openWorkItem(before, CHAPTER_1.id, rangeSuggestionPayload(), [
          "drill-mona",
          "drill-ravi",
          "drill-iris",
        ]);

      const editor = await devLogin(before, "drill-editor", "editor");
      const claimed = await before.app.request(
        `/v1/projects/${before.projectId}/work-items/${appliedWorkItemId}/claim`,
        jsonRequest("POST", {}, { Cookie: editor }),
      );
      expect(claimed.status).toBe(201);
      const bundle = (await claimed.json()) as {
        lease: { id: string; token: string };
        document: { revision: number; contentHash: string };
        target: { exact: string };
      };
      expect(bundle.target.exact).toBe(ORIGINAL_C1);

      const submitted = await before.app.request(
        `/v1/projects/${before.projectId}/work-items/${appliedWorkItemId}/submissions`,
        jsonRequest(
          "POST",
          {
            leaseId: bundle.lease.id,
            leaseToken: bundle.lease.token,
            type: "range_replacement",
            baseRevision: bundle.document.revision,
            baseContentHash: bundle.document.contentHash,
            content: REPLACEMENT_C1,
            summary: "Reword the opening clause.",
          },
          { Cookie: editor },
        ),
      );
      expect(submitted.status).toBe(202);

      // (b) A comment with a reply - the durable conversation, not just the
      //     governance trail.
      const commenter = await devLogin(before, "drill-commenter", "contributor");
      const comment = await before.app.request(
        `/v1/projects/${before.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest(
          "POST",
          { kind: "comment", scope: "chapter", chapterRevision: 4, body: "Reads much better." },
          { Cookie: commenter },
        ),
      );
      expect(comment.status).toBe(202);
      const { annotationId: commentId } = (await comment.json()) as { annotationId: string };

      const replier = await devLogin(before, "drill-replier", "contributor");
      const reply = await before.app.request(
        `/v1/projects/${before.projectId}/annotations/${commentId}/replies`,
        jsonRequest("POST", { body: "Agreed - the cadence lands now." }, { Cookie: replier }),
      );
      expect(reply.status).toBe(202);
      const { replyId } = (await reply.json()) as { replyId: string };

      // (c) A SECOND work item, claimed and left LEASED at the moment of
      //     destruction. This is the lease whose survival would be a bug.
      const { workItemId: leasedWorkItemId } = await openWorkItem(
        before,
        CHAPTER_3.id,
        chapter3SuggestionPayload(),
        ["drill-nils", "drill-opal", "drill-pia"],
      );
      const holder = await devLogin(before, "drill-holder", "editor");
      const heldClaim = await before.app.request(
        `/v1/projects/${before.projectId}/work-items/${leasedWorkItemId}/claim`,
        jsonRequest("POST", {}, { Cookie: holder }),
      );
      expect(heldClaim.status).toBe(201);
      const heldLease = (await heldClaim.json()) as { lease: { id: string } };

      // (d) An agent token, live and working, so its later refusal is a
      //     change of behaviour rather than an untested guess.
      const maintainer = await devLogin(before, "drill-maintainer", "maintainer");
      const minted = await before.app.request(
        `/v1/projects/${before.projectId}/agent-tokens`,
        jsonRequest(
          "POST",
          { name: "drill-agent", scopes: ["annotations:read", "work:claim"] },
          { Cookie: maintainer },
        ),
      );
      expect(minted.status).toBe(201);
      const { token: agentToken } = (await minted.json()) as { token: string };

      // The credentials demonstrably WORK before the database is destroyed.
      const tokenWorksBefore = await before.app.request(
        `/v1/projects/${before.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        { headers: { Authorization: `Bearer ${agentToken}` } },
      );
      expect(tokenWorksBefore.status).toBe(200);
      const sessionWorksBefore = await before.app.request("/v1/me", {
        headers: { Cookie: maintainer },
      });
      expect(sessionWorksBefore.status).toBe(200);

      // …and the operational tables are demonstrably NON-empty, so every
      // absence assertion below is a real change of state.
      expect(await countRows(before, "human_sessions")).toBeGreaterThan(0);
      expect(await countRows(before, "agent_tokens")).toBeGreaterThan(0);
      expect(await countRows(before, "leases")).toBeGreaterThan(0);
      expect(await countRows(before, "submissions")).toBeGreaterThan(0);
      const leasesActiveBefore = await before.db
        .prepare(
          `SELECT COUNT(*) AS n FROM leases WHERE released_at IS NULL AND revoked_at IS NULL`,
        )
        .all();
      expect(Number(leasesActiveBefore[0]?.["n"])).toBe(1);

      // Everything committed: the repository is now the whole record.
      const head = before.fake.state.getRef(BRANCH) as string;
      expect(head).toBeTruthy();
      const tree = before.fake.state.readFiles(head);

      // Sanity: the durable artifacts really are in the tree we carry forward.
      expect(tree[`.authorbot/annotations/${appliedAnnotationId}/annotation.md`]).toBeDefined();
      expect(tree[`.authorbot/annotations/${commentId}/annotation.md`]).toBeDefined();
      expect(
        tree[`.authorbot/annotations/${commentId}/replies/${replyId}.md`],
      ).toBeDefined();
      expect(tree[`.authorbot/work-items/${appliedWorkItemId}.md`]).toBeDefined();
      expect(tree[`.authorbot/work-items/${leasedWorkItemId}.md`]).toBeDefined();
      expect(tree[`.authorbot/attribution/${CHAPTER_1.id}.yml`]).toBeDefined();

      const decisionPaths = Object.keys(tree).filter((path) =>
        path.startsWith(".authorbot/decisions/"),
      );
      expect(decisionPaths.length).toBeGreaterThanOrEqual(2);

      const projectedBefore = {
        chapter1: await before.repos.chapters.getById(CHAPTER_1.id),
        annotation: await before.repos.annotations.getById(appliedAnnotationId),
        comment: await before.repos.annotations.getById(commentId),
        reply: await before.repos.replies.getById(replyId),
        appliedWorkItem: await before.repos.workItems.getById(appliedWorkItemId),
        decisions: await before.db
          .prepare(`SELECT id, action_type, result FROM decisions ORDER BY id`)
          .all(),
      };
      expect(projectedBefore.chapter1?.revision).toBe(4);
      expect(projectedBefore.appliedWorkItem?.status).toBe("completed");

      // =====================================================================
      // 2. DESTROY. A brand-new deployment: new empty database (migrations
      //    only), new repository host seeded with exactly the tree above.
      //    Nothing else crosses this line.
      // =====================================================================
      before.close();
      after = await makeGitHubIntegrationApp({ files: tree });

      // The database really is new: a different project row, so no id below
      // can have been carried over by accident.
      expect(after.projectId).not.toBe(before.projectId);

      // Table counts are taken HERE, before the restored deployment is used
      // at all. Anything asserted empty must be empty because the restore did
      // not produce it, not because the test happened not to look later.
      const emptyAtRestore = {
        humanSessions: await countRows(after, "human_sessions"),
        agentTokens: await countRows(after, "agent_tokens"),
        leases: await countRows(after, "leases"),
        submissions: await countRows(after, "submissions"),
        outbox: await countRows(after, "outbox"),
        gitOperations: await countRows(after, "git_operations"),
        idempotencyKeys: await countRows(after, "idempotency_keys"),
        webhookDeliveries: await countRows(after, "webhook_deliveries"),
        voteEvents: await countRows(after, "vote_events"),
        votes: await countRows(after, "votes"),
      };

      // =====================================================================
      // 3. WHAT RETURNS - everything whose durable record is the prose or
      //    `.authorbot/`.
      // =====================================================================

      // --- prose ----------------------------------------------------------
      const chapter1 = await after.repos.chapters.getById(CHAPTER_1.id);
      expect(chapter1).not.toBeNull();
      expect(chapter1?.revision).toBe(4);
      expect(chapter1?.contentHash).toBe(projectedBefore.chapter1?.contentHash);
      expect(chapter1?.blockIds).toEqual(projectedBefore.chapter1?.blockIds);
      const restoredSource = await after.git.reader.readTextFile?.(CHAPTER_1.path);
      expect(restoredSource).toContain(REPLACEMENT_C1);
      expect(restoredSource).not.toContain(ORIGINAL_C1);

      // --- annotations ----------------------------------------------------
      const restoredAnnotation = await after.repos.annotations.getById(appliedAnnotationId);
      expect(restoredAnnotation).not.toBeNull();
      expect(restoredAnnotation?.body).toBe(projectedBefore.annotation?.body);
      expect(restoredAnnotation?.kind).toBe("suggestion");
      expect(restoredAnnotation?.status).toBe(projectedBefore.annotation?.status);

      const restoredComment = await after.repos.annotations.getById(commentId);
      expect(restoredComment?.body).toBe("Reads much better.");
      expect(restoredComment?.scope).toBe("chapter");

      // --- replies --------------------------------------------------------
      const restoredReply = await after.repos.replies.getById(replyId);
      expect(restoredReply).not.toBeNull();
      expect(restoredReply?.body).toBe("Agreed - the cadence lands now.");
      expect(restoredReply?.annotationId).toBe(commentId);

      // --- attribution of authorship --------------------------------------
      // Actor ROWS are recreated with new ids (they are a projection detail);
      // the durable fact is the external identity recorded in the artifact,
      // and that is what must survive.
      const replyAuthor = await after.repos.actors.getById(restoredReply?.authorActorId ?? "");
      expect(replyAuthor?.externalIdentity).toBe("github:drill-replier");
      const commentAuthor = await after.repos.actors.getById(restoredComment?.authorActorId ?? "");
      expect(commentAuthor?.externalIdentity).toBe("github:drill-commenter");

      // --- decisions ------------------------------------------------------
      const restoredDecisions = await after.db
        .prepare(`SELECT id, action_type, result FROM decisions ORDER BY id`)
        .all();
      expect(restoredDecisions).toEqual(projectedBefore.decisions);
      expect(restoredDecisions.length).toBeGreaterThanOrEqual(2);

      // --- work items -----------------------------------------------------
      const restoredApplied = await after.repos.workItems.getById(appliedWorkItemId);
      expect(restoredApplied).not.toBeNull();
      expect(restoredApplied?.status).toBe("completed");
      expect(restoredApplied?.chapterId).toBe(CHAPTER_1.id);
      expect(restoredApplied?.sourceAnnotationId).toBe(appliedAnnotationId);
      expect(restoredApplied?.baseRevision).toBe(projectedBefore.appliedWorkItem?.baseRevision);

      // --- chapter attribution artifact ------------------------------------
      // Attribution has no projection table: `.authorbot/attribution/<id>.yml`
      // IS the record (Phase 4 contract §6). Its survival is therefore a
      // property of the repository, and the restored deployment must be able
      // to read it back through the ordinary reader.
      const attributionYaml = await after.git.reader.readTextFile?.(
        `.authorbot/attribution/${CHAPTER_1.id}.yml`,
      );
      expect(attributionYaml).toBeTruthy();
      const attribution = parseAttributionArtifact(attributionYaml as string);
      expect(attribution.chapter_id).toBe(CHAPTER_1.id);
      // The three fixture revisions plus the one this drill produced.
      expect(attribution.entries.map((entry) => entry.revision)).toEqual([1, 2, 3, 4]);
      expect(attribution.entries.at(-1)?.actor).toBe("github:drill-editor");

      // --- and it is all SERVED, not merely stored -------------------------
      const reader = await devLogin(after, "drill-inspector", "reader");
      const listed = await after.app.request(
        `/v1/projects/${after.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        { headers: { Cookie: reader } },
      );
      expect(listed.status).toBe(200);
      const page = (await listed.json()) as { items: { id: string; body: string }[] };
      expect(page.items.map((item) => item.id).sort()).toEqual(
        [appliedAnnotationId, commentId].sort(),
      );

      // =====================================================================
      // 4. WHAT DOES NOT RETURN - by design, asserted as deliberate.
      // =====================================================================

      // --- human sessions --------------------------------------------------
      // Structural: the table was empty the instant the restore finished.
      expect(emptyAtRestore.humanSessions).toBe(0);
      // Behavioural: the cookie that authenticated a maintainer moments ago is
      // now simply an unknown credential. A session surviving would mean an
      // authenticated identity outliving its only store.
      const staleSession = await after.app.request("/v1/me", {
        headers: { Cookie: maintainer },
      });
      expect(staleSession.status).toBe(401);
      expect(((await staleSession.json()) as { code: string }).code).toBe("unauthorized");

      // --- agent tokens ----------------------------------------------------
      expect(emptyAtRestore.agentTokens).toBe(0);
      const staleToken = await after.app.request(
        `/v1/projects/${after.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        { headers: { Authorization: `Bearer ${agentToken}` } },
      );
      expect(staleToken.status).toBe(401);
      // A token is a bearer credential: it must die with the database that
      // held its hash, or a leaked token would outlive every revocation.
      const staleTokenWrite = await after.app.request(
        `/v1/projects/${after.projectId}/work-items/${leasedWorkItemId}/claim`,
        jsonRequest("POST", {}, { Authorization: `Bearer ${agentToken}` }),
      );
      expect(staleTokenWrite.status).toBe(401);

      // --- leases ----------------------------------------------------------
      expect(emptyAtRestore.leases).toBe(0);
      // The work item that was LEASED comes back `ready`: its artifact records
      // the queue state, and a claim is operational. That is the correct
      // outcome - nobody is holding it, so nobody may block it.
      const restoredLeased = await after.repos.workItems.getById(leasedWorkItemId);
      expect(restoredLeased?.status).toBe("ready");
      // Behavioural: a different actor can claim it immediately. A surviving
      // lease would have made this 409 `lease-held` on a lease whose holder no
      // longer exists - work stranded for up to its full maximum duration.
      const freshHolder = await devLogin(after, "drill-successor", "editor");
      const reclaim = await after.app.request(
        `/v1/projects/${after.projectId}/work-items/${leasedWorkItemId}/claim`,
        jsonRequest("POST", {}, { Cookie: freshHolder }),
      );
      expect(reclaim.status).toBe(201);
      const reclaimed = (await reclaim.json()) as { lease: { id: string } };
      expect(reclaimed.lease.id).not.toBe(heldLease.lease.id);

      // --- the rest of the operational-only state --------------------------
      // Named explicitly so a future migration that starts mirroring one of
      // these has to change this list on purpose.
      //
      // `submissions` is the notable one: a submission's `content` is DB-only
      // by design (Phase 4 contract §6 retention), so an in-flight edit that
      // had not yet been applied to a chapter is genuinely LOST by a restore.
      // The drill records that as a deliberate property rather than hiding it
      // - see docs/runbook.md, "What a restore does not bring back".
      expect(emptyAtRestore.submissions).toBe(0);
      expect(emptyAtRestore.outbox).toBe(0);
      expect(emptyAtRestore.gitOperations).toBe(0);
      expect(emptyAtRestore.idempotencyKeys).toBe(0);
      expect(emptyAtRestore.webhookDeliveries).toBe(0);
      // Votes are tallied into the decision that used them; the decision is
      // durable, the raw ballots are not. So a restored book keeps every
      // decision its votes produced and loses the ability to re-tally them.
      expect(emptyAtRestore.voteEvents).toBe(0);
      expect(emptyAtRestore.votes).toBe(0);
    } finally {
      after?.close();
    }
  });

  it("is idempotent: restoring twice from the same tree yields the same projection", async () => {
    // A drill you can only run once is a drill you will not run. The restore
    // procedure must be safe to repeat - an operator who is unsure whether the
    // first attempt worked must be able to simply do it again.
    const origin = await makeGitHubIntegrationApp();
    let first: GitHubIntegrationApp | null = null;
    let second: GitHubIntegrationApp | null = null;
    try {
      const author = await devLogin(origin, "idem-author", "contributor");
      const created = await origin.app.request(
        `/v1/projects/${origin.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: author }),
      );
      expect(created.status).toBe(202);
      const tree = origin.fake.state.readFiles(origin.fake.state.getRef(BRANCH) as string);
      origin.close();

      first = await makeGitHubIntegrationApp({ files: tree });
      // Rebuild again on the same instance, then stand a THIRD instance up:
      // repeated rebuilds and repeated restores must both converge.
      await first.coordinator.refreshProjection();
      second = await makeGitHubIntegrationApp({ files: tree });

      const shape = async (app: GitHubIntegrationApp): Promise<unknown> => ({
        chapters: (await app.repos.chapters.listByProject(app.projectId))
          .map((chapter) => ({
            id: chapter.id,
            revision: chapter.revision,
            contentHash: chapter.contentHash,
            blockIds: chapter.blockIds,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
        annotations: await app.db
          .prepare(`SELECT id, kind, scope, status, body FROM annotations ORDER BY id`)
          .all(),
        replies: await app.db.prepare(`SELECT id, body FROM replies ORDER BY id`).all(),
        decisions: await app.db
          .prepare(`SELECT id, action_type, result FROM decisions ORDER BY id`)
          .all(),
        workItems: await app.db
          .prepare(`SELECT id, type, status, base_revision FROM work_items ORDER BY id`)
          .all(),
      });

      expect(await shape(second)).toEqual(await shape(first));
    } finally {
      first?.close();
      second?.close();
    }
  });

  it("a restore does not resurrect an idempotency key, so a replayed command is a real command", async () => {
    // Idempotency keys are operational: they exist to make ONE deployment's
    // retries safe, not to deduplicate across a database's lifetime. An
    // operator replaying a client request after a restore must get a real
    // execution rather than a cached 202 for a git operation that no longer
    // exists - the cached response would name an operationId with no row
    // behind it.
    const origin = await makeGitHubIntegrationApp();
    let restored: GitHubIntegrationApp | null = null;
    try {
      const cookie = await devLogin(origin, "idem-key-author", "contributor");
      const key = uuidv7();
      const first = await origin.app.request(
        `/v1/projects/${origin.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie, "Idempotency-Key": key }),
      );
      expect(first.status).toBe(202);
      const replay = await origin.app.request(
        `/v1/projects/${origin.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), { Cookie: cookie, "Idempotency-Key": key }),
      );
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(await first.clone().json());

      const tree = origin.fake.state.readFiles(origin.fake.state.getRef(BRANCH) as string);
      origin.close();

      restored = await makeGitHubIntegrationApp({ files: tree });
      expect(await countRows(restored, "idempotency_keys")).toBe(0);

      const afterCookie = await devLogin(restored, "idem-key-author", "contributor");
      const afterRestore = await restored.app.request(
        `/v1/projects/${restored.projectId}/chapters/${CHAPTER_1.id}/annotations`,
        jsonRequest("POST", rangeSuggestionPayload(), {
          Cookie: afterCookie,
          "Idempotency-Key": key,
        }),
      );
      expect(afterRestore.status).toBe(202);
      const replayedBody = (await afterRestore.json()) as { annotationId: string };
      const originalBody = (await first.json()) as { annotationId: string };
      // A NEW annotation, not the cached one: the key carries no meaning here.
      expect(replayedBody.annotationId).not.toBe(originalBody.annotationId);
    } finally {
      restored?.close();
    }
  });
});
