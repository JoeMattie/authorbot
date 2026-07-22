import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Annotation,
  ChapterProjection,
  Me,
  Operation,
  Reply,
  TaskBundle,
  WorkItem,
} from "../site/src/islands/api.js";
import {
  createProjectStore,
  resetProjectStoresForTests,
  type ProjectStoreApi,
} from "../site/src/islands/project-store.js";

const PROJECT = "hollow-creek-anomaly";
const CHAPTER = "019cadfd-8900-7140-98fb-ceff64cada33";
const ANNOTATION = "019cadfd-8900-7140-98fb-ceff64cada34";
const WORK = "019cadfd-8900-7140-98fb-ceff64cada35";

const me: Me = {
  actor: { id: "actor-1", displayName: "Mara", externalIdentity: "github:mara" },
  scopes: ["annotations:write", "votes:write", "work:claim", "submissions:write"],
};

const chapter = (openSuggestions = 1): ChapterProjection => ({
  id: CHAPTER,
  projectId: PROJECT,
  path: "manuscript/chapter.md",
  slug: "chapter",
  title: "Chapter",
  status: "published",
  revision: 4,
  updatedAt: "2026-07-22T00:00:00Z",
  activity: {
    openSuggestions,
    openBlockComments: 0,
    openChapterComments: 0,
    openReplies: 0,
    openWorkItems: 1,
  },
});

const annotation = (): Annotation => ({
  id: ANNOTATION,
  chapterId: CHAPTER,
  kind: "suggestion",
  scope: "block",
  chapterRevision: 4,
  target: { blockId: "019cadfd-8900-7140-98fb-ceff64cada36" },
  authorActorId: "actor-2",
  body: "Tighten this.",
  status: "open",
  gitOperationId: null,
  createdAt: "2026-07-22T00:00:00Z",
});

const reply = (): Reply => ({
  id: "019cadfd-8900-7140-98fb-ceff64cada37",
  projectId: PROJECT,
  annotationId: ANNOTATION,
  parentReplyId: null,
  authorActorId: "actor-3",
  body: "One open reply.",
  status: "open",
  gitOperationId: null,
  createdAt: "2026-07-22T00:00:00Z",
  updatedAt: "2026-07-22T00:00:00Z",
});

const workItem = (): WorkItem => ({
  id: WORK,
  projectId: PROJECT,
  type: "revise_block",
  status: "ready",
  sourceAnnotationId: ANNOTATION,
  chapterId: CHAPTER,
  baseRevision: 4,
  target: null,
  priority: "normal",
  createdAt: "2026-07-22T00:00:00Z",
  updatedAt: "2026-07-22T00:00:00Z",
});

const taskBundle = (token = "secret-never-in-state"): TaskBundle => ({
  workItem: {
    id: WORK,
    type: "revise_block",
    acceptanceCriteria: [],
    priority: "normal",
  },
  lease: {
    id: "019cadfd-8900-7140-98fb-ceff64cada40",
    token,
    expiresAt: "2026-07-22T01:00:00Z",
    maxExpiresAt: "2026-07-22T04:00:00Z",
  },
  document: {
    chapterId: CHAPTER,
    revision: 4,
    contentHash: `sha256:${"a".repeat(64)}`,
    source: "Chapter prose",
  },
  context: { annotationBody: "", chapterSummary: "", storyRefs: [] },
  submissionSchema: "authorbot.submission/block-replacement/v1",
});

function baseApi(overrides: Partial<ProjectStoreApi> = {}): ProjectStoreApi {
  return {
    async meResult() {
      return { ok: true, value: me };
    },
    async chapters() {
      return { ok: true, value: [chapter()] };
    },
    async annotations() {
      return { ok: true, value: [annotation()] };
    },
    async replies() {
      return { ok: true, value: [] };
    },
    async workItems() {
      return { ok: true, value: { items: [workItem()], nextCursor: null } };
    },
    ...overrides,
  };
}

async function readyStore(api: ProjectStoreApi = baseApi()) {
  const store = createProjectStore({ apiBase: "", project: PROJECT }, api);
  await store.getState().ensureSession();
  await store.getState().ensureChapters();
  await store.getState().ensureAnnotations(CHAPTER);
  return store;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => resetProjectStoresForTests());

describe("project-scoped editorial store", () => {
  it("normalizes annotations, replies, and a paged Work queue", async () => {
    let secondPage = false;
    const api = baseApi({
      async workItems(cursor) {
        if (cursor === undefined) {
          return {
            ok: true,
            value: { items: [workItem()], nextCursor: "next" },
          };
        }
        secondPage = true;
        return {
          ok: true,
          value: {
            items: [{ ...workItem(), id: `${WORK}-2` }],
            nextCursor: null,
          },
        };
      },
    });
    const store = await readyStore(api);
    await store.getState().ensureReplies(ANNOTATION);
    await store.getState().ensureWorkItems();

    expect(store.getState().annotationIdsByChapter[CHAPTER]).toEqual([ANNOTATION]);
    expect(store.getState().replyIdsByAnnotation[ANNOTATION]).toEqual([]);
    expect(store.getState().workItemIds).toEqual([WORK, `${WORK}-2`]);
    expect(secondPage).toBe(true);
  });

  it("fails a malformed or unbounded Work pagination chain within a fixed read budget", async () => {
    let repeatedReads = 0;
    const repeated = createProjectStore(
      { apiBase: "", project: `${PROJECT}-repeated` },
      baseApi({
        async workItems() {
          repeatedReads += 1;
          return { ok: true, value: { items: [], nextCursor: "same-cursor" } };
        },
      }),
    );
    await repeated.getState().ensureWorkItems();
    expect(repeatedReads).toBe(2);
    expect(repeated.getState()).toMatchObject({
      workItemsStatus: "error",
      workItemsError: "work queue pagination returned a repeated cursor",
    });

    let longReads = 0;
    const unbounded = createProjectStore(
      { apiBase: "", project: `${PROJECT}-unbounded` },
      baseApi({
        async workItems() {
          longReads += 1;
          return {
            ok: true,
            value: { items: [], nextCursor: `cursor-${longReads}` },
          };
        },
      }),
    );
    await unbounded.getState().ensureWorkItems();
    expect(longReads).toBe(10);
    expect(unbounded.getState()).toMatchObject({
      workItemsStatus: "error",
      workItemsError: "work queue exceeded 10 pages",
    });
  });

  it("replaces an accepted pending reply from its exact thread when the operation settles", async () => {
    const replyId = "019cadfd-8900-7140-98fb-ceff64cada38";
    const operationId = "019cadfd-8900-7140-98fb-ceff64cada39";
    let authoritativeReplies: Reply[] = [];
    let replyReads = 0;
    const committed: Operation = {
      id: operationId,
      projectId: PROJECT,
      correlationId: "reply-correlation",
      state: "committed",
      attempts: 1,
      error: null,
      commitSha: "b".repeat(40),
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:00:01Z",
    };
    const store = await readyStore(
      baseApi({
        async replies(requestedAnnotationId) {
          expect(requestedAnnotationId).toBe(ANNOTATION);
          replyReads += 1;
          return { ok: true, value: authoritativeReplies };
        },
        async createReply() {
          authoritativeReplies = [
            {
              ...reply(),
              id: replyId,
              body: "Pending reply",
              status: "pending_git",
              gitOperationId: operationId,
            },
          ];
          return {
            ok: true,
            value: {
              replyId,
              operationId,
              correlationId: committed.correlationId,
              status: "queued",
            },
          };
        },
        async operation(requestedOperationId) {
          expect(requestedOperationId).toBe(operationId);
          return committed;
        },
      }),
    );
    await store.getState().ensureReplies(ANNOTATION);

    const accepted = await store.getState().createReply(ANNOTATION, "Pending reply");
    expect(accepted.ok).toBe(true);
    expect(store.getState().repliesById[replyId]).toMatchObject({
      body: "Pending reply",
      status: "pending_git",
    });

    authoritativeReplies = [
      {
        ...reply(),
        id: replyId,
        body: "Committed reply",
        status: "open",
        gitOperationId: null,
        updatedAt: committed.updatedAt,
      },
    ];
    await store.getState().refreshOperation(operationId);

    await vi.waitFor(() => {
      expect(store.getState().repliesById[replyId]).toMatchObject({
        body: "Committed reply",
        status: "open",
        gitOperationId: null,
      });
    });
    expect(replyReads).toBe(3);
  });

  it("consumes a cached terminal operation when its accepted response arrives later", async () => {
    const replyId = "019cadfd-8900-7140-98fb-ceff64cada81";
    const operationId = "019cadfd-8900-7140-98fb-ceff64cada82";
    let resolve!: (
      value: Awaited<ReturnType<NonNullable<ProjectStoreApi["createReply"]>>>,
    ) => void;
    const response = new Promise<
      Awaited<ReturnType<NonNullable<ProjectStoreApi["createReply"]>>>
    >((done) => {
      resolve = done;
    });
    const failed: Operation = {
      id: operationId,
      projectId: PROJECT,
      correlationId: "terminal-before-response",
      state: "failed",
      attempts: 1,
      error: "repository write failed",
      commitSha: null,
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:00:01Z",
    };
    const store = await readyStore(
      baseApi({
        async replies() {
          // The failed operation never made the optimistic reply authoritative.
          return { ok: true, value: [] };
        },
        createReply: async () => response,
        async operation(requestedOperationId) {
          expect(requestedOperationId).toBe(operationId);
          return failed;
        },
      }),
    );
    await store.getState().ensureReplies(ANNOTATION);

    const action = store.getState().createReply(ANNOTATION, "This write will fail.");
    store.getState().reconcileEvent({
      id: 19,
      type: "operation_completed",
      payload: { operationId },
    });
    await vi.waitFor(() => expect(store.getState().operationsById[operationId]).toEqual(failed));

    resolve({
      ok: true,
      value: {
        replyId,
        operationId,
        correlationId: failed.correlationId,
        status: "queued",
      },
    });
    await expect(action).resolves.toMatchObject({ ok: true });

    expect(store.getState().pendingMutations).toEqual({});
    expect(store.getState().replyIdsByAnnotation[ANNOTATION]).toEqual([]);
    expect(store.getState().repliesById[replyId]).toBeUndefined();
  });

  it("increments activity immediately, then normalizes the accepted annotation", async () => {
    const acceptedId = "019cadfd-8900-7140-98fb-ceff64cada99";
    let authoritativeAnnotations = [annotation()];
    let resolve!: (value: Awaited<ReturnType<NonNullable<ProjectStoreApi["createAnnotation"]>>>) => void;
    const pending = new Promise<
      Awaited<ReturnType<NonNullable<ProjectStoreApi["createAnnotation"]>>>
    >((done) => {
      resolve = done;
    });
    const api = baseApi({
      async annotations() {
        return { ok: true, value: authoritativeAnnotations };
      },
      createAnnotation: async () => pending,
    });
    const store = await readyStore(api);
    const action = store.getState().createAnnotation(CHAPTER, {
      kind: "suggestion",
      scope: "block",
      chapterRevision: 4,
      target: { blockId: "019cadfd-8900-7140-98fb-ceff64cada36" },
      body: "Replace this.",
    });

    expect(store.getState().chaptersById[CHAPTER]?.activity?.openSuggestions).toBe(2);
    expect(store.getState().annotationIdsByChapter[CHAPTER]).toHaveLength(2);
    authoritativeAnnotations = [
      annotation(),
      {
        ...annotation(),
        id: acceptedId,
        authorActorId: me.actor.id,
        body: "Replace this.",
        status: "pending_git",
      },
    ];
    resolve({
      ok: true,
      value: {
        outcome: "queued_git",
        annotationId: acceptedId,
        operationId: "019cadfd-8900-7140-98fb-ceff64cada98",
        correlationId: "corr",
        status: "queued",
      },
    });
    await action;

    expect(store.getState().chaptersById[CHAPTER]?.activity?.openSuggestions).toBe(2);
    expect(store.getState().annotationIdsByChapter[CHAPTER]).toContain(
      acceptedId,
    );
    expect(JSON.stringify(store.getState().pendingMutations)).not.toContain("local:");
  });

  it("rolls a deterministic rejection back without leaving an activity delta", async () => {
    const store = await readyStore(
      baseApi({
        async createAnnotation() {
          return { ok: false, status: 403, message: "read only" };
        },
      }),
    );
    const result = await store.getState().createAnnotation(CHAPTER, {
      kind: "suggestion",
      scope: "block",
      chapterRevision: 4,
      body: "Nope.",
    });

    expect(result).toMatchObject({ ok: false, kind: "rejected", status: 403 });
    expect(store.getState().annotationIdsByChapter[CHAPTER]).toEqual([ANNOTATION]);
    expect(store.getState().chaptersById[CHAPTER]?.activity?.openSuggestions).toBe(1);
    expect(Object.keys(store.getState().pendingMutations)).toHaveLength(0);
  });

  it("rebases a later optimistic activity delta when an earlier concurrent write rejects", async () => {
    type CreateResult = Awaited<
      ReturnType<NonNullable<ProjectStoreApi["createAnnotation"]>>
    >;
    const resolutions: Array<(result: CreateResult) => void> = [];
    const store = await readyStore(
      baseApi({
        createAnnotation: async () =>
          new Promise<CreateResult>((resolve) => resolutions.push(resolve)),
      }),
    );
    const first = store.getState().createAnnotation(CHAPTER, {
      kind: "suggestion",
      scope: "block",
      chapterRevision: 4,
      body: "First concurrent suggestion.",
    });
    const second = store.getState().createAnnotation(CHAPTER, {
      kind: "suggestion",
      scope: "block",
      chapterRevision: 4,
      body: "Second concurrent suggestion.",
    });
    expect(store.getState().chaptersById[CHAPTER]?.activity?.openSuggestions).toBe(3);

    resolutions[0]?.({ ok: false, status: 403, message: "first rejected" });
    await first;
    expect(store.getState().chaptersById[CHAPTER]?.activity?.openSuggestions).toBe(2);

    resolutions[1]?.({ ok: false, status: 403, message: "second rejected" });
    await second;
    expect(store.getState().chaptersById[CHAPTER]?.activity?.openSuggestions).toBe(1);
  });

  it("removes a provisional card when approval-gated creation returns pending review", async () => {
    const store = await readyStore(
      baseApi({
        async createAnnotation() {
          return {
            ok: true,
            value: {
              outcome: "pending_review",
              pendingId: "019cadfd-8900-7140-98fb-ceff64cada97",
              annotationId: null,
              correlationId: "corr",
              status: "pending_review",
              moderation: { state: "pending", message: "Awaiting review." },
            },
          };
        },
      }),
    );
    const result = await store.getState().createAnnotation(CHAPTER, {
      kind: "comment",
      scope: "chapter",
      chapterRevision: 4,
      body: "Please review.",
    });

    expect(result).toMatchObject({ ok: true, value: { outcome: "pending_review" } });
    expect(store.getState().annotationIdsByChapter[CHAPTER]).toEqual([ANNOTATION]);
    expect(store.getState().chaptersById[CHAPTER]?.activity?.openChapterComments).toBe(0);
  });

  it("replays an ambiguous command with the same idempotency key", async () => {
    const keys: string[] = [];
    let calls = 0;
    const store = await readyStore(
      baseApi({
        async createAnnotation(_chapter, _command, options) {
          calls += 1;
          keys.push(options?.idempotencyKey ?? "");
          return {
            ok: false,
            status: 0,
            message: "response lost",
            ambiguous: true,
          };
        },
      }),
    );
    const result = await store.getState().createAnnotation(CHAPTER, {
      kind: "suggestion",
      scope: "block",
      chapterRevision: 4,
      body: "Maybe landed.",
    });

    expect(result).toMatchObject({ ok: false, kind: "ambiguous" });
    expect(calls).toBe(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(store.getState().annotationIdsByChapter[CHAPTER]).toEqual([ANNOTATION]);
  });

  it("retains an ambiguous command key across generic reads until same-key replay proves it", async () => {
    const keys: string[] = [];
    let annotationReads = 0;
    let readsRecover = false;
    let writeSucceeds = false;
    const command = {
      kind: "suggestion" as const,
      scope: "block" as const,
      chapterRevision: 4,
      body: "One logical command.",
    };
    const store = await readyStore(
      baseApi({
        async annotations() {
          annotationReads += 1;
          if (annotationReads === 1 || readsRecover) {
            return { ok: true, value: [annotation()] };
          }
          return { ok: false, status: 503, message: "read unavailable" };
        },
        async createAnnotation(_chapter, _command, options) {
          keys.push(options?.idempotencyKey ?? "");
          if (writeSucceeds) {
            return {
              ok: true,
              value: {
                outcome: "pending_review",
                pendingId: "019cadfd-8900-7140-98fb-ceff64cada97",
                annotationId: null,
                correlationId: "same-key-proof",
                status: "pending_review",
                moderation: { state: "pending", message: "Awaiting review." },
              },
            };
          }
          return { ok: false, status: 0, message: "response lost", ambiguous: true };
        },
      }),
    );

    await store.getState().createAnnotation(CHAPTER, command);
    await store.getState().createAnnotation(CHAPTER, command);
    expect(new Set(keys).size).toBe(1);
    expect(Object.values(store.getState().pendingMutations)).toMatchObject([
      { phase: "ambiguous", idempotencyKey: keys[0] },
    ]);

    readsRecover = true;
    await store.getState().createAnnotation(CHAPTER, command);
    expect(new Set(keys).size).toBe(1);
    expect(Object.keys(store.getState().pendingMutations)).toHaveLength(1);

    writeSucceeds = true;
    await store.getState().createAnnotation(CHAPTER, command);
    expect(new Set(keys).size).toBe(1);
    expect(Object.keys(store.getState().pendingMutations)).toHaveLength(0);

    await store.getState().createAnnotation(CHAPTER, command);
    expect(keys.at(-1)).not.toBe(keys[0]);
  });

  it("does not double-apply an optimistic badge when the event read wins the response race", async () => {
    const acceptedId = "019cadfd-8900-7140-98fb-ceff64cada88";
    let serverCount = 1;
    let serverAnnotations = [annotation()];
    let resolve!: (
      result: Awaited<ReturnType<NonNullable<ProjectStoreApi["createAnnotation"]>>>,
    ) => void;
    const response = new Promise<
      Awaited<ReturnType<NonNullable<ProjectStoreApi["createAnnotation"]>>>
    >((done) => {
      resolve = done;
    });
    const store = await readyStore(
      baseApi({
        async chapters() {
          return { ok: true, value: [chapter(serverCount)] };
        },
        async annotations() {
          return { ok: true, value: serverAnnotations };
        },
        createAnnotation: async () => response,
      }),
    );
    const action = store.getState().createAnnotation(CHAPTER, {
      kind: "suggestion",
      scope: "block",
      chapterRevision: 4,
      body: "Event lands first.",
    });
    expect(store.getState().chaptersById[CHAPTER]?.activity?.openSuggestions).toBe(2);

    serverCount = 2;
    serverAnnotations = [
      annotation(),
      {
        ...annotation(),
        id: acceptedId,
        authorActorId: me.actor.id,
        body: "Event lands first.",
        status: "open",
      },
    ];
    store.getState().reconcileEvent({
      id: 40,
      type: "annotation_created",
      payload: { chapterId: CHAPTER, annotationId: acceptedId },
    });
    await vi.waitFor(() => expect(store.getState().annotationsById[acceptedId]).toBeDefined());
    expect(store.getState().chaptersById[CHAPTER]?.activity?.openSuggestions).toBe(2);

    resolve({
      ok: true,
      value: {
        outcome: "queued_git",
        annotationId: acceptedId,
        operationId: "019cadfd-8900-7140-98fb-ceff64cada89",
        correlationId: "race-correlation",
        status: "queued",
      },
    });
    await action;
    expect(store.getState().chaptersById[CHAPTER]?.activity?.openSuggestions).toBe(2);
    expect(store.getState().annotationsById[acceptedId]?.status).toBe("open");
  });

  it("keeps a claimed lease token outside serializable Zustand state", async () => {
    const task = taskBundle();
    const store = await readyStore(
      baseApi({
        async claim() {
          return { ok: true, value: task };
        },
      }),
    );
    await store.getState().ensureWorkItems();
    const result = await store.getState().claimWork(WORK);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(store.getState())).not.toContain("secret-never-in-state");
    expect(store.getState().activeClaimsByWorkItem[WORK]?.lease.id).toBe(task.lease.id);
  });

  it("settles its own submission when the feed lands but both HTTP responses are lost", async () => {
    type SubmitResult = Awaited<
      ReturnType<NonNullable<ProjectStoreApi["submitWork"]>>
    >;
    let resolve!: (value: SubmitResult) => void;
    const response = new Promise<SubmitResult>((done) => {
      resolve = done;
    });
    let requestCorrelation: string | null = null;
    const store = await readyStore(
      baseApi({
        async claim() {
          return { ok: true, value: taskBundle() };
        },
        async submitWork(_workItemId, _command, options) {
          requestCorrelation = options?.correlationId ?? null;
          return response;
        },
      }),
    );
    await store.getState().ensureWorkItems();
    await expect(store.getState().claimWork(WORK)).resolves.toMatchObject({ ok: true });

    const action = store.getState().submitClaim(WORK, {
      type: "block_replacement",
      baseRevision: 4,
      baseContentHash: `sha256:${"a".repeat(64)}`,
      content: "Revised chapter prose.",
    });
    expect(requestCorrelation).toMatch(/^[0-9a-f-]{36}$/u);

    store.getState().reconcileEvent({
      id: 50,
      type: "submission_received",
      payload: {
        workItemId: WORK,
        submissionId: "submission-own",
        operationId: "operation-own",
        correlationId: requestCorrelation,
      },
    });
    store.getState().reconcileEvent({
      id: 51,
      type: "work_item_completed",
      payload: { workItemId: WORK, submissionId: "submission-own" },
    });

    expect(store.getState().activeClaimsByWorkItem[WORK]).toBeUndefined();
    expect(store.getState().claimInvalidationsByWorkItem[WORK]).toBeUndefined();
    expect(store.getState().submissionAcceptancesByWorkItem[WORK]).toMatchObject({
      submissionId: "submission-own",
      operationId: "operation-own",
      correlationId: requestCorrelation,
    });

    resolve({
      ok: false,
      status: 0,
      message: "both accepted responses were lost",
      ambiguous: true,
    });
    await expect(action).resolves.toMatchObject({ ok: true });
    expect(store.getState().activeClaimsByWorkItem[WORK]).toBeUndefined();

    // A later replay or unrelated terminal event cannot manufacture a stale
    // invalidation after this tab has already consumed its claim.
    store.getState().reconcileEvent({
      id: 52,
      type: "work_item_completed",
      payload: { workItemId: WORK, submissionId: "submission-other" },
    });
    expect(store.getState().claimInvalidationsByWorkItem[WORK]).toBeUndefined();
  });

  it("invalidates a live claim for a submission from another session", async () => {
    const store = await readyStore(
      baseApi({
        async claim() {
          return { ok: true, value: taskBundle() };
        },
      }),
    );
    await store.getState().ensureWorkItems();
    await store.getState().claimWork(WORK);

    store.getState().reconcileEvent({
      id: 53,
      type: "submission_received",
      payload: {
        workItemId: WORK,
        submissionId: "submission-other",
        correlationId: "correlation-other",
      },
    });

    expect(store.getState().activeClaimsByWorkItem[WORK]).toBeUndefined();
    expect(store.getState().claimInvalidationsByWorkItem[WORK]).toContain("another session");
  });

  it("keeps a same-key retry row when both claim responses are lost", async () => {
    const keys: string[] = [];
    let claimCalls = 0;
    let workReads = 0;
    let eventPolls = 0;
    const full = taskBundle("replacement-secret");
    const { token: _token, ...redactedLease } = full.lease;
    const store = await readyStore(
      baseApi({
        async workItems() {
          workReads += 1;
          return {
            ok: true,
            value: {
              items: workReads === 1 ? [workItem()] : [],
              nextCursor: null,
            },
          };
        },
        eventsUrl() {
          return "https://api.test/events";
        },
        async pollEvents() {
          eventPolls += 1;
          return { ok: true, value: { items: [], latestId: 12 } };
        },
        async claim(_workItemId, options) {
          claimCalls += 1;
          keys.push(options?.idempotencyKey ?? "");
          if (claimCalls <= 2) {
            return {
              ok: false,
              status: 0,
              message: "claim response lost",
              ambiguous: true,
            };
          }
          return {
            ok: true,
            value: {
              ...full,
              lease: { ...redactedLease, tokenRedacted: true as const },
            },
          };
        },
        async recoverLease() {
          return {
            ok: true,
            value: {
              workItemId: WORK,
              lease: {
                ...redactedLease,
                token: "rotated-after-lost-response",
                renewalCount: 0,
                renewalPromptAt: "2026-07-22T00:55:00Z",
              },
              correlationId: "recovered-lost-claim",
            },
          };
        },
      }),
    );
    await store.getState().ensureWorkItems();

    await expect(store.getState().claimWork(WORK)).resolves.toMatchObject({
      ok: false,
      kind: "ambiguous",
    });
    expect(new Set(keys).size).toBe(1);
    expect(store.getState().workItemIds).toContain(WORK);
    expect(Object.values(store.getState().pendingMutations)).toMatchObject([
      { kind: "work.claim", phase: "ambiguous", workItemId: WORK },
    ]);

    // Even an event-driven authoritative refresh cannot erase the only
    // affordance capable of replaying the original idempotency key.
    await store.getState().refreshWorkItems();
    expect(store.getState().workItemIds).toContain(WORK);

    const release = store.getState().retainConnection();
    await vi.waitFor(() => expect(store.getState().connection.status).toBe("live"));
    expect(eventPolls).toBeGreaterThanOrEqual(2);
    expect(store.getState().workItemIds).toContain(WORK);
    expect(Object.values(store.getState().pendingMutations)).toMatchObject([
      { kind: "work.claim", phase: "ambiguous", workItemId: WORK },
    ]);
    release();

    await expect(store.getState().claimWork(WORK)).resolves.toMatchObject({ ok: true });
    expect(new Set(keys).size).toBe(1);
    expect(store.getState().activeClaimsByWorkItem[WORK]).toBeDefined();
    expect(store.getState().workItemIds).not.toContain(WORK);
    expect(store.getState().pendingMutations).toEqual({});
    expect(JSON.stringify(store.getState())).not.toContain("rotated-after-lost-response");
  });

  it("refetches after rejection when a newer vote event wins the response race", async () => {
    type VoteApiResult = Awaited<
      ReturnType<NonNullable<ProjectStoreApi["castVote"]>>
    >;
    let resolve!: (
      result: VoteApiResult,
    ) => void;
    const response = new Promise<VoteApiResult>((done) => {
      resolve = done;
    });
    const newer = {
      approvals: 7,
      rejections: 1,
      abstentions: 0,
      netScore: 6,
      distinctVoters: 8,
      humanApprovals: 6,
      agentApprovals: 1,
    };
    let authoritative = annotation();
    const store = await readyStore(
      baseApi({
        async annotations() {
          return { ok: true, value: [authoritative] };
        },
        castVote: async () => response,
      }),
    );

    const action = store.getState().setVote(ANNOTATION, "approve");
    authoritative = { ...annotation(), votes: newer };
    store.getState().reconcileEvent({
      id: 31,
      type: "vote_aggregate",
      payload: { annotationId: ANNOTATION, votes: newer },
    });
    expect(store.getState().annotationsById[ANNOTATION]?.votes?.approvals).toBe(7);

    resolve({ ok: false, status: 403, message: "vote permission changed" });
    await expect(action).resolves.toMatchObject({ ok: false, kind: "rejected" });
    expect(store.getState().annotationsById[ANNOTATION]?.votes).toEqual(newer);
  });

  it("keeps its own recovered token but invalidates a recovery from another session", async () => {
    const task = taskBundle("not-used-by-recovery");
    const { token: _token, ...safeLease } = task.lease;
    const store = await readyStore(
      baseApi({
        async recoverLease() {
          return {
            ok: true,
            value: {
              workItemId: WORK,
              lease: {
                ...task.lease,
                token: "rotated-secret-never-in-state",
                renewalCount: 0,
                renewalPromptAt: "2026-07-22T00:55:00Z",
              },
              correlationId: "recovery-own",
            },
          };
        },
      }),
    );
    const recovered = await store.getState().recoverClaim({ ...task, lease: safeLease });
    expect(recovered.ok).toBe(true);

    store.getState().reconcileEvent({
      id: 20,
      type: "lease_recovered",
      payload: { workItemId: WORK, correlationId: "recovery-own" },
    });
    expect(store.getState().activeClaimsByWorkItem[WORK]).toBeDefined();

    store.getState().reconcileEvent({
      id: 21,
      type: "lease_recovered",
      payload: { workItemId: WORK, correlationId: "recovery-other" },
    });
    expect(store.getState().activeClaimsByWorkItem[WORK]).toBeUndefined();
    expect(store.getState().claimInvalidationsByWorkItem[WORK]).toContain("another session");
    expect(JSON.stringify(store.getState())).not.toContain("rotated-secret-never-in-state");
  });

  it("accepts a delayed event from either recovery rotation attempted by this tab", async () => {
    const task = taskBundle("not-used-by-recovery");
    const { token: _token, ...safeLease } = task.lease;
    const correlations: string[] = [];
    const store = await readyStore(
      baseApi({
        async recoverLease(_workItemId, _leaseId, options) {
          const correlation = options?.correlationId ?? "";
          correlations.push(correlation);
          if (correlations.length === 1) {
            return {
              ok: false,
              status: 0,
              message: "first rotation response lost",
              ambiguous: true,
            };
          }
          return {
            ok: true,
            value: {
              workItemId: WORK,
              lease: {
                ...task.lease,
                token: "second-rotation-secret",
                renewalCount: 1,
                renewalPromptAt: "2026-07-22T00:55:00Z",
              },
              correlationId: correlation,
            },
          };
        },
      }),
    );

    await expect(
      store.getState().recoverClaim({ ...task, lease: safeLease }),
    ).resolves.toMatchObject({ ok: true });
    expect(correlations).toHaveLength(2);
    expect(new Set(correlations).size).toBe(2);

    store.getState().reconcileEvent({
      id: 22,
      type: "lease_recovered",
      payload: { workItemId: WORK, correlationId: correlations[0] },
    });
    expect(store.getState().activeClaimsByWorkItem[WORK]).toBeDefined();
    store.getState().reconcileEvent({
      id: 23,
      type: "lease_recovered",
      payload: { workItemId: WORK, correlationId: correlations[1] },
    });
    expect(store.getState().activeClaimsByWorkItem[WORK]).toBeDefined();
  });

  it("ignores a claim response that completes after the browser credential changes", async () => {
    type ClaimResult = Awaited<ReturnType<NonNullable<ProjectStoreApi["claim"]>>>;
    let currentMe: Me | null = me;
    let resolveClaim!: (result: ClaimResult) => void;
    const pendingClaim = new Promise<ClaimResult>((resolve) => {
      resolveClaim = resolve;
    });
    const store = await readyStore(
      baseApi({
        async meResult() {
          return { ok: true, value: currentMe };
        },
        claim: async () => pendingClaim,
      }),
    );
    await store.getState().ensureWorkItems();
    const action = store.getState().claimWork(WORK);

    currentMe = {
      actor: { id: "actor-reader", displayName: "Reader", externalIdentity: "github:reader" },
      scopes: ["chapters:read"],
      memberships: [{ role: "reader" }],
    };
    await store.getState().refreshSession(true);
    resolveClaim({ ok: true, value: taskBundle("old-credential-secret") });

    await expect(action).resolves.toMatchObject({ ok: false, status: 409 });
    expect(store.getState().activeClaimsByWorkItem).toEqual({});
    expect(JSON.stringify(store.getState())).not.toContain("old-credential-secret");
  });

  it("purges permission-scoped state and capabilities when the credential changes", async () => {
    let currentMe: Me | null = me;
    let authorized = true;
    const task = taskBundle("credential-bound-secret");
    const store = await readyStore(
      baseApi({
        async meResult() {
          return { ok: true, value: currentMe };
        },
        async annotations() {
          return authorized
            ? { ok: true, value: [annotation()] }
            : { ok: false, status: 403, message: "comments hidden" };
        },
        async replies() {
          return authorized
            ? { ok: true, value: [reply()] }
            : { ok: false, status: 403, message: "replies hidden" };
        },
        async workItems() {
          return authorized
            ? { ok: true, value: { items: [workItem()], nextCursor: null } }
            : { ok: false, status: 403, message: "Work hidden" };
        },
        async claim() {
          return { ok: true, value: task };
        },
      }),
    );
    await store.getState().ensureReplies(ANNOTATION);
    await store.getState().ensureWorkItems();
    await store.getState().claimWork(WORK);
    expect(store.getState().activeClaimsByWorkItem[WORK]).toBeDefined();

    authorized = false;
    currentMe = {
      actor: { id: "actor-reader", displayName: "Reader", externalIdentity: "github:reader" },
      scopes: ["chapters:read"],
      memberships: [{ role: "reader" }],
    };
    await store.getState().refreshSession(true);

    expect(store.getState().session?.actor.id).toBe("actor-reader");
    expect(store.getState().annotationsById).toEqual({});
    expect(store.getState().repliesById).toEqual({});
    expect(store.getState().workItemsById).toEqual({});
    expect(store.getState().activeClaimsByWorkItem).toEqual({});
    expect(store.getState().claimInvalidationsByWorkItem[WORK]).toContain(
      "signed-in credential changed",
    );
    await expect(store.getState().renewClaim(WORK)).resolves.toMatchObject({
      ok: false,
      status: 501,
    });
  });

  it("transfers feedback and reply activity into Work, then rolls back a rejection", async () => {
    let resolve!: (
      value: Awaited<ReturnType<NonNullable<ProjectStoreApi["promoteToWork"]>>>,
    ) => void;
    const pending = new Promise<
      Awaited<ReturnType<NonNullable<ProjectStoreApi["promoteToWork"]>>>
    >((done) => {
      resolve = done;
    });
    const api = baseApi({
      async chapters() {
        const value = chapter();
        value.activity = { ...value.activity, openReplies: 1 };
        return { ok: true, value: [value] };
      },
      async replies() {
        return { ok: true, value: [reply()] };
      },
      promoteToWork: async () => pending,
    });
    const store = await readyStore(api);
    await store.getState().ensureReplies(ANNOTATION);
    const action = store.getState().promoteAnnotation(ANNOTATION);

    expect(store.getState().annotationsById[ANNOTATION]?.status).toBe("work_item_created");
    expect(store.getState().chaptersById[CHAPTER]?.activity).toMatchObject({
      openSuggestions: 0,
      openReplies: 0,
      openWorkItems: 2,
    });

    resolve({ ok: false, status: 403, message: "maintainer required" });
    await expect(action).resolves.toMatchObject({ ok: false, kind: "rejected" });
    expect(store.getState().annotationsById[ANNOTATION]?.status).toBe("open");
    expect(store.getState().chaptersById[CHAPTER]?.activity).toMatchObject({
      openSuggestions: 1,
      openReplies: 1,
      openWorkItems: 1,
    });
  });

  it("reconciles feed notifications through authoritative loaded-resource reads", async () => {
    let chapterReads = 0;
    let annotationReads = 0;
    let workReads = 0;
    const store = await readyStore(
      baseApi({
        async chapters() {
          chapterReads += 1;
          return { ok: true, value: [chapter()] };
        },
        async annotations() {
          annotationReads += 1;
          return { ok: true, value: [annotation()] };
        },
        async workItems() {
          workReads += 1;
          return { ok: true, value: { items: [workItem()], nextCursor: null } };
        },
      }),
    );
    await store.getState().ensureWorkItems();
    const before = { chapterReads, annotationReads, workReads };

    store.getState().reconcileEvent({
      id: 12,
      type: "work_item_created",
      payload: { chapterId: CHAPTER, annotationId: ANNOTATION },
    });

    await vi.waitFor(() => {
      expect(chapterReads).toBeGreaterThan(before.chapterReads);
      expect(annotationReads).toBeGreaterThan(before.annotationReads);
      expect(workReads).toBeGreaterThan(before.workReads);
    });
  });

  it("coalesces an event burst into one in-flight and one trailing read per resource", async () => {
    let chapterReads = 0;
    let annotationReads = 0;
    let replyReads = 0;
    let workReads = 0;
    let blockRefresh = false;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const pauseFirstRefresh = async (read: number): Promise<void> => {
      if (blockRefresh && read === 2) await refreshGate;
    };
    const store = await readyStore(
      baseApi({
        async chapters() {
          chapterReads += 1;
          await pauseFirstRefresh(chapterReads);
          return { ok: true, value: [chapter()] };
        },
        async annotations() {
          annotationReads += 1;
          await pauseFirstRefresh(annotationReads);
          return { ok: true, value: [annotation()] };
        },
        async replies() {
          replyReads += 1;
          await pauseFirstRefresh(replyReads);
          return { ok: true, value: [reply()] };
        },
        async workItems() {
          workReads += 1;
          await pauseFirstRefresh(workReads);
          return { ok: true, value: { items: [workItem()], nextCursor: null } };
        },
      }),
    );
    await store.getState().ensureReplies(ANNOTATION);
    await store.getState().ensureWorkItems();
    blockRefresh = true;

    for (let id = 100; id < 110; id += 1) {
      store.getState().reconcileEvent({
        id,
        type: "annotation_updated",
        payload: { chapterId: CHAPTER, annotationId: ANNOTATION },
      });
    }
    expect({ chapterReads, annotationReads, replyReads, workReads }).toEqual({
      chapterReads: 2,
      annotationReads: 2,
      replyReads: 2,
      workReads: 2,
    });

    releaseRefresh();
    await vi.waitFor(() => {
      expect({ chapterReads, annotationReads, replyReads, workReads }).toEqual({
        chapterReads: 3,
        annotationReads: 3,
        replyReads: 3,
        workReads: 3,
      });
    });
  });

  it("retries a terminal operation refresh that transiently fails before settling", async () => {
    vi.useFakeTimers();
    const acceptedId = "019cadfd-8900-7140-98fb-ceff64cada99";
    const operationId = "019cadfd-8900-7140-98fb-ceff64cada98";
    let annotationReads = 0;
    const authoritative = [
      annotation(),
      {
        ...annotation(),
        id: acceptedId,
        authorActorId: me.actor.id,
        body: "Retry settlement.",
        status: "open",
      },
    ];
    const committed: Operation = {
      id: operationId,
      projectId: PROJECT,
      correlationId: "retry-settlement",
      state: "committed",
      attempts: 1,
      error: null,
      commitSha: "c".repeat(40),
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:00:01Z",
    };
    try {
      const store = await readyStore(
        baseApi({
          async annotations() {
            annotationReads += 1;
            if (annotationReads === 3) {
              return { ok: false, status: 503, message: "projection temporarily stale" };
            }
            return { ok: true, value: annotationReads === 1 ? [annotation()] : authoritative };
          },
          async createAnnotation() {
            return {
              ok: true,
              value: {
                outcome: "queued_git",
                annotationId: acceptedId,
                operationId,
                correlationId: committed.correlationId,
                status: "queued",
              },
            };
          },
          async operation() {
            return committed;
          },
        }),
      );
      await store.getState().createAnnotation(CHAPTER, {
        kind: "suggestion",
        scope: "block",
        chapterRevision: 4,
        body: "Retry settlement.",
      });
      expect(Object.values(store.getState().pendingMutations)).toMatchObject([
        { phase: "accepted" },
      ]);

      await store.getState().refreshOperation(operationId);
      expect(annotationReads).toBe(3);
      expect(Object.keys(store.getState().pendingMutations)).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersToNextTimerAsync();
      await flushMicrotasks();
      expect(annotationReads).toBe(4);
      expect(store.getState().pendingMutations).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches every loaded projection after an event-stream reconnect", async () => {
    const holder: { source: {
      onopen: ((event: unknown) => void) | null;
      onerror: ((event: unknown) => void) | null;
    } | null } = { source: null };
    class FakeEventSource {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor(_url: string) {
        holder.source = this;
      }
      addEventListener(): void {}
      close(): void {}
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    });
    let chapterReads = 0;
    let annotationReads = 0;
    let workReads = 0;
    try {
      const store = await readyStore(
        baseApi({
          async chapters() {
            chapterReads += 1;
            return { ok: true, value: [chapter()] };
          },
          async annotations() {
            annotationReads += 1;
            return { ok: true, value: [annotation()] };
          },
          async workItems() {
            workReads += 1;
            return { ok: true, value: { items: [workItem()], nextCursor: null } };
          },
          eventsUrl() {
            return "https://api.test/events";
          },
          async pollEvents() {
            return { ok: true, value: { items: [], latestId: 9 } };
          },
        }),
      );
      await store.getState().ensureWorkItems();
      const release = store.getState().retainConnection();
      await vi.waitFor(() => expect(holder.source).not.toBeNull());
      holder.source?.onopen?.({});
      const before = { chapterReads, annotationReads, workReads };
      holder.source?.onerror?.({});
      holder.source?.onopen?.({});

      await vi.waitFor(() => {
        expect(chapterReads).toBeGreaterThan(before.chapterReads);
        expect(annotationReads).toBeGreaterThan(before.annotationReads);
        expect(workReads).toBeGreaterThan(before.workReads);
      });
      release();
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "EventSource");
      } else {
        Object.defineProperty(globalThis, "EventSource", original);
      }
    }
  });

  it("retries a transient initial feed bootstrap while a consumer remains", async () => {
    vi.useFakeTimers();
    const holder: {
      source: {
        onopen: ((event: unknown) => void) | null;
        onerror: ((event: unknown) => void) | null;
      } | null;
    } = { source: null };
    class FakeEventSource {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor(_url: string) {
        holder.source = this;
      }
      addEventListener(): void {}
      close(): void {}
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    });
    let polls = 0;
    let release: (() => void) | null = null;
    try {
      const store = await readyStore(
        baseApi({
          eventsUrl() {
            return "https://api.test/events";
          },
          async pollEvents() {
            polls += 1;
            return polls === 1
              ? { ok: false, status: 503, message: "temporary outage" }
              : { ok: true, value: { items: [], latestId: 14 } };
          },
        }),
      );
      release = store.getState().retainConnection();
      await flushMicrotasks();

      expect(polls).toBe(1);
      expect(holder.source).toBeNull();
      expect(store.getState().connection).toMatchObject({
        status: "offline",
        lastError: "temporary outage",
      });
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersToNextTimerAsync();
      await flushMicrotasks();
      expect(polls).toBe(2);
      expect(holder.source).not.toBeNull();
      expect(store.getState().connection.status).toBe("connecting");

      holder.source?.onopen?.({});
      expect(store.getState().connection).toMatchObject({
        transport: "sse",
        status: "live",
        cursor: 14,
        lastError: null,
      });
    } finally {
      release?.();
      vi.useRealTimers();
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "EventSource");
      } else {
        Object.defineProperty(globalThis, "EventSource", original);
      }
    }
  });

  it("discards an old event bootstrap and restarts it for the refreshed credential", async () => {
    const holder: { starts: number } = { starts: 0 };
    class FakeEventSource {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor(_url: string) {
        holder.starts += 1;
      }
      addEventListener(): void {}
      close(): void {}
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    });
    type PollResult = Awaited<ReturnType<NonNullable<ProjectStoreApi["pollEvents"]>>>;
    let resolveOldBootstrap!: (result: PollResult) => void;
    const oldBootstrap = new Promise<PollResult>((resolve) => {
      resolveOldBootstrap = resolve;
    });
    let polls = 0;
    let currentMe: Me | null = me;
    let release: (() => void) | null = null;
    try {
      const store = await readyStore(
        baseApi({
          async meResult() {
            return { ok: true, value: currentMe };
          },
          eventsUrl() {
            return "https://api.test/events";
          },
          async pollEvents() {
            polls += 1;
            return polls === 1
              ? oldBootstrap
              : { ok: true, value: { items: [], latestId: 7 } };
          },
        }),
      );
      release = store.getState().retainConnection();
      await vi.waitFor(() => expect(polls).toBe(1));

      currentMe = {
        actor: { id: "actor-editor-2", displayName: "New editor", externalIdentity: "github:new" },
        scopes: me.scopes,
        memberships: [{ role: "editor" }],
      };
      await store.getState().refreshSession(true);
      resolveOldBootstrap({ ok: true, value: { items: [], latestId: 99 } });

      await vi.waitFor(() => expect(polls).toBe(2));
      await vi.waitFor(() => expect(holder.starts).toBe(1));
      expect(store.getState().connection.cursor).toBe(7);
    } finally {
      release?.();
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "EventSource");
      } else {
        Object.defineProperty(globalThis, "EventSource", original);
      }
    }
  });

  it("does not report live until every required authoritative read recovers", async () => {
    vi.useFakeTimers();
    const holder: {
      source: {
        onopen: ((event: unknown) => void) | null;
        onerror: ((event: unknown) => void) | null;
      } | null;
    } = { source: null };
    class FakeEventSource {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor(_url: string) {
        holder.source = this;
      }
      addEventListener(): void {}
      close(): void {}
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    });
    let chapterReads = 0;
    let polls = 0;
    let release: (() => void) | null = null;
    try {
      const store = await readyStore(
        baseApi({
          async chapters() {
            chapterReads += 1;
            return chapterReads === 2
              ? { ok: false, status: 503, message: "chapters unavailable" }
              : { ok: true, value: [chapter()] };
          },
          eventsUrl() {
            return "https://api.test/events";
          },
          async pollEvents() {
            polls += 1;
            return { ok: true, value: { items: [], latestId: 22 } };
          },
        }),
      );
      release = store.getState().retainConnection();
      await flushMicrotasks();

      expect(polls).toBe(1);
      expect(chapterReads).toBe(2);
      expect(holder.source).toBeNull();
      expect(store.getState().connection.status).toBe("offline");
      expect(store.getState().connection.lastError).toContain("chapters");
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersToNextTimerAsync();
      await flushMicrotasks();
      expect(polls).toBe(2);
      expect(chapterReads).toBe(3);
      expect(holder.source).not.toBeNull();
      expect(store.getState().connection.status).toBe("connecting");

      holder.source?.onopen?.({});
      expect(store.getState().connection.status).toBe("live");
    } finally {
      release?.();
      vi.useRealTimers();
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "EventSource");
      } else {
        Object.defineProperty(globalThis, "EventSource", original);
      }
    }
  });

  it("does not relabel an undeployed chapter as published", async () => {
    let published = false;
    const operation: Operation = {
      id: "019cadfd-8900-7140-98fb-ceff64cada90",
      projectId: PROJECT,
      correlationId: "corr",
      state: "committed",
      attempts: 1,
      error: null,
      commitSha: "a".repeat(40),
      createdAt: "2026-07-22T00:00:00Z",
      updatedAt: "2026-07-22T00:00:01Z",
    };
    const store = await readyStore(
      baseApi({
        async chapters() {
          return {
            ok: true,
            value: [{ ...chapter(), status: published ? "published" : "draft" }],
          };
        },
        async publishChapter() {
          return {
            ok: true,
            value: {
              chapterId: CHAPTER,
              operationId: operation.id,
              correlationId: operation.correlationId,
              status: "queued",
            },
          };
        },
        async operation() {
          return operation;
        },
      }),
    );

    await expect(store.getState().setChapterPublication(CHAPTER, true)).resolves.toMatchObject({
      ok: true,
    });
    expect(store.getState().chaptersById[CHAPTER]?.status).toBe("draft");

    published = true;
    await store.getState().refreshOperation(operation.id);
    await vi.waitFor(() =>
      expect(store.getState().chaptersById[CHAPTER]?.status).toBe("published"),
    );
  });
});
